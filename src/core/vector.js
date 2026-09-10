/** Standalone cubic-path and polygon-arrangement kernel. All coordinates are doubles.
 * Boolean curves are adaptively flattened at an explicit document-space tolerance.
 * No browser APIs; the same implementation runs in workers and Node tests.
 */
export function createVectorKernel() {
  const TAU = Math.PI * 2, EPS = 1e-10;
  const point = (x, y) => ({x, y});
  const lerp = (a, b, t) => point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const sub = (a, b) => point(a.x - b.x, a.y - b.y);
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const transformPoint = (p, m) => point(m[0] * p.x + m[2] * p.y + m[4], m[1] * p.x + m[3] * p.y + m[5]);
  const anchor = (x, y, mode = 'corner') => ({x, y, inX: x, inY: y, outX: x, outY: y, mode});
  const numeric = n => { if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw Error('Invalid path coordinate'); return n; };
  const fmt = n => String(Math.round(numeric(n) * 1e6) / 1e6);
  function arcCubics(start, rx, ry, phi, large, sweep, end) {
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (distance(start, end) < EPS) return [];
    if (!rx || !ry) return [{c1: start, c2: end, end}];
    const rad = phi * Math.PI / 180, cp = Math.cos(rad), sp = Math.sin(rad);
    const dx = (start.x - end.x) / 2, dy = (start.y - end.y) / 2;
    const xp = cp * dx + sp * dy, yp = -sp * dx + cp * dy;
    const lambda = xp * xp / (rx * rx) + yp * yp / (ry * ry);
    if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
    const denom = rx * rx * yp * yp + ry * ry * xp * xp;
    const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - denom) / Math.max(EPS, denom)));
    const cxp = factor * rx * yp / ry, cyp = -factor * ry * xp / rx;
    const cx = cp * cxp - sp * cyp + (start.x + end.x) / 2, cy = sp * cxp + cp * cyp + (start.y + end.y) / 2;
    const u = point((xp - cxp) / rx, (yp - cyp) / ry), v = point((-xp - cxp) / rx, (-yp - cyp) / ry);
    let theta = Math.atan2(u.y, u.x), delta = Math.atan2(cross(u, v), u.x * v.x + u.y * v.y);
    if (!sweep && delta > 0) delta -= TAU;
    if (sweep && delta < 0) delta += TAU;
    const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2))), step = delta / count, result = [];
    const map = (x, y) => point(cx + cp * rx * x - sp * ry * y, cy + sp * rx * x + cp * ry * y);
    for (let i = 0; i < count; i++) {
      const a = theta + step * i, b = a + step, k = 4 / 3 * Math.tan((b - a) / 4);
      result.push({c1: map(Math.cos(a) - k * Math.sin(a), Math.sin(a) + k * Math.cos(a)), c2: map(Math.cos(b) + k * Math.sin(b), Math.sin(b) - k * Math.cos(b)), end: i === count - 1 ? end : map(Math.cos(b), Math.sin(b))});
    }
    return result;
  }
  function parse(path) {
    if (typeof path !== 'string' || path.length > 200000) throw Error('Path exceeds 200,000 characters');
    const tokens = path.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) || [];
    if (path.replace(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?|[\s,]/g, '')) throw Error('Invalid path syntax');
    let i = 0, command = '', current = point(0, 0), start = point(0, 0), previous = '', cubicControl = null, quadraticControl = null, part = null;
    const parts = [], number = () => { if (i >= tokens.length || /^[a-z]$/i.test(tokens[i])) throw Error('Incomplete path command'); return numeric(Number(tokens[i++])); };
    const add = (end, c1 = current, c2 = end) => {
      if (!part) throw Error('Start a path with M');
      const last = part.points.at(-1); last.outX = c1.x; last.outY = c1.y;
      const next = anchor(end.x, end.y); next.inX = c2.x; next.inY = c2.y; part.points.push(next); current = end;
    };
    while (i < tokens.length) {
      if (/^[a-z]$/i.test(tokens[i])) command = tokens[i++];
      if (!command || !'MLHVCSQTAZ'.includes(command.toUpperCase())) throw Error('Unsupported SVG path command');
      const kind = command.toUpperCase(), relative = command !== kind, origin = {...current};
      const xy = () => point(number() + (relative ? origin.x : 0), number() + (relative ? origin.y : 0));
      if (kind === 'M') { current = xy(); start = {...current}; part = {closed: false, points: [anchor(current.x, current.y)]}; parts.push(part); command = relative ? 'l' : 'L'; }
      else if (kind === 'L') add(xy());
      else if (kind === 'H') add(point(number() + (relative ? origin.x : 0), current.y));
      else if (kind === 'V') add(point(current.x, number() + (relative ? origin.y : 0)));
      else if (kind === 'C') { const c1 = xy(), c2 = xy(), end = xy(); add(end, c1, c2); cubicControl = c2; }
      else if (kind === 'S') { const c1 = 'CS'.includes(previous) && cubicControl ? point(2 * current.x - cubicControl.x, 2 * current.y - cubicControl.y) : current, c2 = xy(), end = xy(); add(end, c1, c2); cubicControl = c2; }
      else if (kind === 'Q' || kind === 'T') { const control = kind === 'Q' ? xy() : 'QT'.includes(previous) && quadraticControl ? point(2 * current.x - quadraticControl.x, 2 * current.y - quadraticControl.y) : current; const end = xy(); add(end, lerp(current, control, 2 / 3), lerp(end, control, 2 / 3)); quadraticControl = control; }
      else if (kind === 'A') { const rx = number(), ry = number(), phi = number(), large = number(), sweep = number(), end = xy(); if (![0, 1].includes(large) || ![0, 1].includes(sweep)) throw Error('Arc flags must be 0 or 1'); for (const c of arcCubics(current, rx, ry, phi, !!large, !!sweep, end)) add(c.end, c.c1, c.c2); }
      else if (kind === 'Z') {
        if (!part) throw Error('Close requires a path'); part.closed = true;
        if (part.points.length > 1 && distance(part.points.at(-1), part.points[0]) < 1e-8) {
          const last = part.points.pop(); part.points[0].inX = last.inX; part.points[0].inY = last.inY;
        }
        current = {...start}; command = '';
      }
      if (!'CS'.includes(kind)) cubicControl = null;
      if (!'QT'.includes(kind)) quadraticControl = null;
      previous = kind;
      if (parts.reduce((n, p) => n + p.points.length, 0) > 10000) throw Error('Path exceeds 10,000 anchors');
    }
    return parts;
  }
  function serialize(parts) {
    let result = '';
    for (const part of parts) {
      if (!part.points.length) continue;
      const first = part.points[0]; result += `M ${fmt(first.x)} ${fmt(first.y)} `;
      const count = part.points.length + (part.closed ? 1 : 0);
      for (let i = 1; i < count; i++) {
        const a = part.points[i - 1], b = part.points[i % part.points.length];
        if (distance(a, point(a.outX, a.outY)) < 1e-8 && distance(b, point(b.inX, b.inY)) < 1e-8) result += `L ${fmt(b.x)} ${fmt(b.y)} `;
        else result += `C ${fmt(a.outX)} ${fmt(a.outY)} ${fmt(b.inX)} ${fmt(b.inY)} ${fmt(b.x)} ${fmt(b.y)} `;
      }
      if (part.closed) result += 'Z ';
    }
    return result.trim();
  }
  function transform(parts, matrix) {
    return parts.map(part => ({closed: part.closed, points: part.points.map(a => {
      const p = transformPoint(a, matrix), incoming = transformPoint(point(a.inX, a.inY), matrix), outgoing = transformPoint(point(a.outX, a.outY), matrix);
      return {...a, ...p, inX: incoming.x, inY: incoming.y, outX: outgoing.x, outY: outgoing.y};
    })}));
  }
  function splitCubic(p0, p1, p2, p3, t = .5) {
    const a = lerp(p0, p1, t), b = lerp(p1, p2, t), c = lerp(p2, p3, t), d = lerp(a, b, t), e = lerp(b, c, t), middle = lerp(d, e, t);
    return [[p0, a, d, middle], [middle, e, c, p3]];
  }
  function splitSegment(part, index, t = .5) {
    if (!Number.isInteger(index) || index < 0 || index >= part.points.length - (part.closed ? 0 : 1) || !(t > 0 && t < 1)) throw Error('Select a segment to split');
    const a = part.points[index], b = part.points[(index + 1) % part.points.length], [left, right] = splitCubic(a, point(a.outX, a.outY), point(b.inX, b.inY), b, t);
    a.outX = left[1].x; a.outY = left[1].y; b.inX = right[2].x; b.inY = right[2].y;
    const middle = {...anchor(left[3].x, left[3].y, 'smooth'), inX: left[2].x, inY: left[2].y, outX: right[1].x, outY: right[1].y};
    part.points.splice(index + 1, 0, middle); return index + 1;
  }
  function cubicAt(p0, p1, p2, p3, t) { const s = 1 - t; return point(s ** 3 * p0.x + 3 * s * s * t * p1.x + 3 * s * t * t * p2.x + t ** 3 * p3.x, s ** 3 * p0.y + 3 * s * s * t * p1.y + 3 * s * t * t * p2.y + t ** 3 * p3.y); }
  function cubicExtrema(a, b, c, d) {
    const A = -a + 3 * b - 3 * c + d, B = 2 * (a - 2 * b + c), C = b - a;
    if (Math.abs(A) < EPS) return Math.abs(B) < EPS ? [] : [-C / B].filter(t => t > 0 && t < 1);
    const disc = B * B - 4 * A * C; if (disc < 0) return [];
    return [(-B + Math.sqrt(disc)) / (2 * A), (-B - Math.sqrt(disc)) / (2 * A)].filter(t => t > 0 && t < 1);
  }
  function bounds(parts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const accept = p => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); };
    for (const part of parts) {
      for (const p of part.points) accept(p);
      const count = part.points.length - (part.closed ? 0 : 1);
      for (let i = 0; i < count; i++) {
        const a = part.points[i], b = part.points[(i + 1) % part.points.length], p1 = point(a.outX, a.outY), p2 = point(b.inX, b.inY);
        for (const t of new Set([...cubicExtrema(a.x, p1.x, p2.x, b.x), ...cubicExtrema(a.y, p1.y, p2.y, b.y)])) accept(cubicAt(a, p1, p2, b, t));
      }
    }
    return minX === Infinity ? {x: 0, y: 0, w: 0, h: 0} : {x: minX, y: minY, w: maxX - minX, h: maxY - minY};
  }
  function flatten(parts, tolerance = .25, limit = 24000) {
    if (!Number.isFinite(tolerance) || tolerance < .0001 || tolerance > 100) throw Error('Choose a path tolerance between 0.0001 and 100');
    let total = 0;
    const flat = (a, b, c, d) => {
      const chord = sub(d, a), length = Math.hypot(chord.x, chord.y);
      if (length < EPS) return Math.max(distance(a, b), distance(a, c)) <= tolerance;
      return Math.max(Math.abs(cross(sub(b, a), chord)), Math.abs(cross(sub(c, a), chord))) / length <= tolerance && distance(a, b) + distance(b, c) + distance(c, d) - length <= tolerance * 2;
    };
    return parts.map(part => {
      if (!part.points.length) return [];
      const ring = [point(part.points[0].x, part.points[0].y)], count = part.points.length - (part.closed ? 0 : 1);
      for (let i = 0; i < count; i++) {
        const a = part.points[i], b = part.points[(i + 1) % part.points.length], stack = [[a, point(a.outX, a.outY), point(b.inX, b.inY), b, 0]];
        while (stack.length) {
          const [p0, p1, p2, p3, depth] = stack.pop();
          if (flat(p0, p1, p2, p3) || depth >= 20) {
            if (distance(ring.at(-1), p3) > EPS) ring.push(point(p3.x, p3.y));
            if (++total > limit) throw Error('Path tessellation quota exceeded; increase the tolerance');
          } else { const [left, right] = splitCubic(p0, p1, p2, p3); stack.push([...right, depth + 1], [...left, depth + 1]); }
        }
      }
      if (part.closed && ring.length > 1 && distance(ring[0], ring.at(-1)) < EPS) ring.pop();
      return ring;
    });
  }
  function signedArea(ring) { let sum = 0; for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; sum += a.x * b.y - b.x * a.y; } return sum / 2; }
  function contains(rings, p, rule = 'nonzero') {
    let winding = 0;
    for (const ring of rings) for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], side = cross(sub(b, a), sub(p, a));
      if (a.y <= p.y && b.y > p.y && side > 0) winding++;
      else if (a.y > p.y && b.y <= p.y && side < 0) winding--;
    }
    return rule === 'evenodd' ? Math.abs(winding) % 2 === 1 : winding !== 0;
  }
  function boolean(operands, operation = 'union', tolerance = .25) {
    if (!Array.isArray(operands) || operands.length < 2 || operands.length > 64 || !['union', 'intersection', 'difference', 'xor'].includes(operation)) throw Error('Choose 2–64 filled paths and a Boolean operation');
    const shapes = operands.map(o => ({rings: o.rings || flatten(typeof o.path === 'string' ? parse(o.path) : o.path, tolerance), rule: o.fillRule || 'nonzero'}));
    const segments = [], allPoints = shapes.flatMap(shape => shape.rings.flat());
    if (allPoints.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 1e9 || Math.abs(p.y) > 1e9)) throw Error('Invalid Boolean coordinates');
    const extent = allPoints.reduce((v, p) => Math.max(v, Math.abs(p.x), Math.abs(p.y)), 1), epsilon = Math.max(1e-8, tolerance * 1e-5, extent * 1e-12);
    for (const shape of shapes) for (const ring of shape.rings) if (ring.length >= 3) for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length]; if (distance(a, b) <= epsilon) continue;
      segments.push({a, b, ts: [0, 1], minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y)});
    }
    if (segments.length > 24000) throw Error('Boolean operation exceeds 24,000 edges');
    const addT = (s, t) => { if (t >= -1e-9 && t <= 1 + 1e-9) s.ts.push(Math.min(1, Math.max(0, t))); };
    let checks = 0;
    const sorted = [...segments].sort((a, b) => a.minX - b.minX), active = [];
    for (const s of sorted) {
      for (let i = active.length - 1; i >= 0; i--) if (active[i].maxX < s.minX - epsilon) active.splice(i, 1);
      for (const t of active) {
        if (s.maxY < t.minY - epsilon || t.maxY < s.minY - epsilon) continue;
        if (++checks > 2500000) throw Error('Boolean intersection budget exceeded');
        const r = sub(s.b, s.a), v = sub(t.b, t.a), q = sub(t.a, s.a), det = cross(r, v), lr = distance(s.a, s.b), lv = distance(t.a, t.b);
        if (Math.abs(det) > epsilon * Math.max(lr, lv)) {
          const u = cross(q, v) / det, w = cross(q, r) / det;
          if (u >= -1e-9 && u <= 1 + 1e-9 && w >= -1e-9 && w <= 1 + 1e-9) { addT(s, u); addT(t, w); }
        } else if (Math.abs(cross(q, r)) <= epsilon * lr) {
          const dot = (p, d) => p.x * d.x + p.y * d.y;
          addT(s, dot(q, r) / (lr * lr)); addT(s, dot(sub(t.b, s.a), r) / (lr * lr));
          addT(t, dot(sub(s.a, t.a), v) / (lv * lv)); addT(t, dot(sub(s.b, t.a), v) / (lv * lv));
        }
      }
      active.push(s);
    }
    const truth = p => { const inside = shapes.map(shape => contains(shape.rings, p, shape.rule)); return operation === 'union' ? inside.some(Boolean) : operation === 'intersection' ? inside.every(Boolean) : operation === 'difference' ? inside[0] && !inside.slice(1).some(Boolean) : inside.filter(Boolean).length % 2 === 1; };
    const key = p => Math.round(p.x / epsilon) + ',' + Math.round(p.y / epsilon), vertices = new Map(), edges = new Map();
    const vertex = p => { const id = key(p); if (!vertices.has(id)) vertices.set(id, p); return id; };
    for (const s of segments) {
      const ts = [...new Set(s.ts.map(t => Math.round(t * 1e12) / 1e12))].sort((a, b) => a - b);
      for (let i = 1; i < ts.length; i++) {
        let a = lerp(s.a, s.b, ts[i - 1]), b = lerp(s.a, s.b, ts[i]); const length = distance(a, b); if (length <= epsilon) continue;
        const middle = lerp(a, b, .5), offset = Math.min(length * .001, epsilon * 8), normal = point(-(b.y - a.y) / length * offset, (b.x - a.x) / length * offset);
        const left = truth(point(middle.x + normal.x, middle.y + normal.y)), right = truth(point(middle.x - normal.x, middle.y - normal.y));
        if (left === right) continue;
        if (!left) [a, b] = [b, a];
        const from = vertex(a), to = vertex(b); if (from === to) continue;
        const id = from + '>' + to; if (!edges.has(id)) edges.set(id, {id, from, to});
      }
    }
    const outgoing = new Map();
    for (const edge of edges.values()) { if (!outgoing.has(edge.from)) outgoing.set(edge.from, []); outgoing.get(edge.from).push(edge); }
    const unused = new Set(edges.keys()), rings = [];
    for (const first of edges.values()) {
      if (!unused.has(first.id)) continue;
      const ring = [], start = first.from; let edge = first, closed = false;
      for (let guard = 0; guard <= edges.size; guard++) {
        unused.delete(edge.id); ring.push(vertices.get(edge.from));
        if (edge.to === start) { closed = true; break; }
        const candidates = (outgoing.get(edge.to) || []).filter(next => unused.has(next.id));
        if (!candidates.length) break;
        const v = vertices.get(edge.to), previous = vertices.get(edge.from), back = Math.atan2(previous.y - v.y, previous.x - v.x);
        candidates.sort((a, b) => { const angle = next => { const p = vertices.get(next.to); return (back - Math.atan2(p.y - v.y, p.x - v.x) + TAU) % TAU; }; return angle(a) - angle(b); });
        edge = candidates[0];
      }
      if (!closed) throw Error('A Boolean boundary could not be closed; use a coarser tolerance or simplify coincident geometry');
      const clean = ring.filter((p, i) => { const a = ring[(i + ring.length - 1) % ring.length], b = ring[(i + 1) % ring.length]; return Math.abs(cross(sub(p, a), sub(b, p))) > epsilon * Math.max(distance(p, a), distance(b, p)); });
      if (clean.length >= 3 && Math.abs(signedArea(clean)) > epsilon * epsilon) rings.push(clean);
    }
    const parts = rings.map(ring => ({closed: true, points: ring.map(p => anchor(p.x, p.y))}));
    return {path: serialize(parts), parts, rings, bounds: bounds(parts), area: Math.abs(rings.reduce((sum, ring) => sum + signedArea(ring), 0)), edges: edges.size, tolerance, fillRule: 'evenodd'};
  }
  function shapePath(n) {
    if (n.type === 'path') return n.path || '';
    const w = n.w, h = n.h, r = Math.min(n.radius || 0, w / 2, h / 2);
    if (n.type === 'ellipse') return `M ${w} ${h / 2} A ${w / 2} ${h / 2} 0 1 1 0 ${h / 2} A ${w / 2} ${h / 2} 0 1 1 ${w} ${h / 2} Z`;
    if (n.type === 'line') return `M 0 0 L ${w} ${h}`;
    if (!['rect', 'frame', 'button', 'input'].includes(n.type)) throw Error('Select rectangles, ellipses, or vector paths');
    if (!r) return `M 0 0 H ${w} V ${h} H 0 Z`;
    return `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
  }
  function nodeParts(n) { return transform(parse(shapePath(n)), [n.type === 'path' ? n.w / (n.pathW || n.w) : 1, 0, 0, n.type === 'path' ? n.h / (n.pathH || n.h) : 1, 0, 0]); }
  function normalizeNode(n, parts) {
    const box = bounds(parts), w = Math.max(.1, box.w), h = Math.max(.1, box.h), angle = (n.rotation || 0) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const ox = n.x + n.w / 2 - c * n.w / 2 + s * n.h / 2 + c * box.x - s * box.y;
    const oy = n.y + n.h / 2 - s * n.w / 2 - c * n.h / 2 + s * box.x + c * box.y;
    return {type: 'path', path: serialize(transform(parts, [1, 0, 0, 1, -box.x, -box.y])), pathW: w, pathH: h, w, h, x: ox - w / 2 + c * w / 2 - s * h / 2, y: oy - h / 2 + s * w / 2 + c * h / 2};
  }
  function reverse(part) { part.points.reverse(); for (const p of part.points) [p.inX, p.inY, p.outX, p.outY] = [p.outX, p.outY, p.inX, p.inY]; return part; }
  function smooth(part, index, mode = 'smooth') {
    const p = part.points[index]; if (!p) return;
    p.mode = mode;
    if (mode === 'corner') { p.inX = p.outX = p.x; p.inY = p.outY = p.y; return; }
    const prev = part.points[(index - 1 + part.points.length) % part.points.length], next = part.points[(index + 1) % part.points.length], d = sub(next, prev), length = Math.hypot(d.x, d.y) || 1;
    let incoming = distance(p, prev) / 3, outgoing = distance(p, next) / 3;
    if (mode === 'symmetric') incoming = outgoing = Math.min(incoming, outgoing);
    p.inX = p.x - d.x / length * incoming; p.inY = p.y - d.y / length * incoming; p.outX = p.x + d.x / length * outgoing; p.outY = p.y + d.y / length * outgoing;
  }
  return {parse, serialize, transform, flatten, bounds, splitSegment, splitCubic, cubicAt, signedArea, contains, boolean, shapePath, nodeParts, normalizeNode, reverse, smooth, anchor};
}
export const Vector = createVectorKernel();
export function vectorWorkerSource() {
  return `const Vector=(${createVectorKernel.toString()})();self.onmessage=e=>{try{self.postMessage({id:e.data.id,result:Vector.boolean(e.data.operands,e.data.operation,e.data.tolerance)})}catch(error){self.postMessage({id:e.data.id,error:error.message})}};`;
}
export class VectorWorker {
  constructor() { this.jobs = new Map(); this.sequence = 0; this.worker = null; }
  run(operands, operation, tolerance = .25) {
    if (typeof Worker === 'undefined') return Promise.resolve(Vector.boolean(operands, operation, tolerance));
    if (!this.worker) {
      const url = URL.createObjectURL(new Blob([vectorWorkerSource()], {type: 'text/javascript'})); this.worker = new Worker(url); URL.revokeObjectURL(url);
      this.worker.onmessage = ({data}) => { const job = this.jobs.get(data.id); if (!job) return; clearTimeout(job.timer); this.jobs.delete(data.id); data.error ? job.reject(Error(data.error)) : job.resolve(data.result); };
      this.worker.onerror = () => this.cancel('Vector worker failed');
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.jobs.set(id, {resolve, reject, timer: setTimeout(() => this.cancel('Vector calculation exceeded its resource budget'), 15000)}); this.worker.postMessage({id, operands, operation, tolerance}); });
  }
  cancel(message = 'Vector calculation cancelled') { this.worker?.terminate(); this.worker = null; for (const job of this.jobs.values()) { clearTimeout(job.timer); job.reject(Error(message)); } this.jobs.clear(); }
}
