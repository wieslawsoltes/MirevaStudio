/**
 * Mireva sequence CRDT: immutable RGA insertions, LWW visibility and range marks.
 * No DOM, transport, or storage dependency. Characters are Unicode code points.
 * Tombstones retain insertion anchors, including when packets arrive out of order.
 */
const MARKS = new Set(['bold', 'italic', 'underline', 'strike', 'color', 'highlight', 'fontSize', 'fontFamily', 'link']);
const ROOT = '';
const SEED = [0, 'seed'];
export const MAX_TEXT_ATOMS = 100000;
const copy = value => JSON.parse(JSON.stringify(value));
const compare = (a, b) => !b ? 1 : !a ? -1 : a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
const validKey = id => typeof id === 'string' && /^[\w-]{1,100}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
const validStamp = s => Array.isArray(s) && s.length === 2 && Number.isSafeInteger(s[0]) && s[0] >= 0 && validKey(s[1]);
export function textHash(text) {
  let hash = 14695981039346656037n;
  for (const char of text) { hash ^= BigInt(char.codePointAt(0)); hash = BigInt.asUintN(64, hash * 1099511628211n); }
  return hash.toString(36);
}
export function validateMarks(marks) {
  if (!marks || typeof marks !== 'object' || Array.isArray(marks) || Object.keys(marks).length > MARKS.size) throw Error('Invalid text marks');
  for (const [key, value] of Object.entries(marks)) {
    if (!MARKS.has(key)) throw Error('Unsupported text mark: ' + key);
    if (value === null) continue;
    if (['bold', 'italic', 'underline', 'strike'].includes(key) && typeof value !== 'boolean') throw Error('Invalid text emphasis');
    if (['color', 'highlight'].includes(key) && (typeof value !== 'string' || !/^(#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|transparent)$/i.test(value))) throw Error('Invalid text color');
    if (key === 'fontSize' && (!Number.isFinite(value) || value < 1 || value > 512)) throw Error('Font size must be 1–512');
    if (key === 'fontFamily' && (typeof value !== 'string' || !/^[\w ,"'-]{1,100}$/.test(value))) throw Error('Invalid font family');
    if (key === 'link' && (typeof value !== 'string' || value.length > 2048 || !/^(https?:\/\/|mailto:)/i.test(value))) throw Error('Use an HTTPS, HTTP, or mailto link');
  }
  return marks;
}
export function validateTextOperation(op) {
  if (op.kind !== 'text' || !validKey(op.id) || !validStamp(op.stamp) || typeof op.seed !== 'string' || op.seed.length > 20000) throw Error('Invalid text operation');
  let count = 0;
  if (op.insert !== undefined) {
    if (!Array.isArray(op.insert) || op.insert.length > 20000) throw Error('Text insertion is too large');
    const seen = new Set();
    for (const item of op.insert) {
      if (!item || !validKey(item.id) || (item.left !== ROOT && !validKey(item.left)) || item.id === item.left || typeof item.ch !== 'string' || [...item.ch].length !== 1 || seen.has(item.id)) throw Error('Invalid text character');
      if (item.marks) validateMarks(item.marks);
      seen.add(item.id); count++;
    }
  }
  for (const field of ['visibility', 'format']) {
    if (op[field] === undefined) continue;
    if (!Array.isArray(op[field]) || op[field].length > 20000) throw Error('Too many text changes');
    for (const item of op[field]) {
      if (!item || !validKey(item.id)) throw Error('Invalid character reference');
      if (field === 'visibility' && typeof item.deleted !== 'boolean') throw Error('Invalid text visibility');
      if (field === 'format') validateMarks(item.marks);
      count++;
    }
  }
  if (!count || count > 60000) throw Error('Empty or oversized text operation');
  return op;
}
export function createRichText(text = '') {
  if (typeof text !== 'string' || text.length > 20000) throw Error('Text is too large');
  const state = {version: 1, base: text, chars: Object.create(null)};
  let left = ROOT, index = 0;
  const prefix = 's_' + textHash(text) + '_';
  for (const ch of text) {
    const id = prefix + (index++).toString(36);
    state.chars[id] = {id, left, ch, born: [...SEED], deleted: false, ds: [...SEED], marks: {}, ms: {}};
    left = id;
  }
  return state;
}
export function validateRichText(state) {
  if (!state || state.version !== 1 || typeof state.base !== 'string' || state.base.length > 20000 || !state.chars || typeof state.chars !== 'object' || Array.isArray(state.chars)) throw Error('Invalid rich text state');
  if (Object.keys(state.chars).length > MAX_TEXT_ATOMS) throw Error('Text history quota exceeded');
  for (const [id, atom] of Object.entries(state.chars)) {
    if (!validKey(id) || !atom || atom.id !== id || typeof atom.deleted !== 'boolean' || !validStamp(atom.ds)) throw Error('Invalid text atom');
    if (atom.born !== null && (!validStamp(atom.born) || (atom.left !== ROOT && !validKey(atom.left)) || atom.left === id || typeof atom.ch !== 'string' || [...atom.ch].length !== 1)) throw Error('Invalid text insertion');
    if (atom.born === null && (atom.ch !== null || atom.left !== null)) throw Error('Invalid pending text atom');
    validateMarks(atom.marks);
    if (!atom.ms || typeof atom.ms !== 'object' || Object.keys(atom.ms).some(k => !MARKS.has(k) || !validStamp(atom.ms[k]))) throw Error('Invalid text mark clocks');
    if (Object.keys(atom.marks).some(k => !atom.ms[k])) throw Error('A text mark needs a clock');
  }
  return state;
}
function placeholder(id) { return {id, left: null, ch: null, born: null, deleted: false, ds: [...SEED], marks: {}, ms: {}}; }
function atomFor(state, id) {
  if (!state.chars[id]) {
    state.chars[id] = placeholder(id);
  }
  return state.chars[id];
}
function putMarks(atom, marks, stamp) {
  let changed = false;
  for (const [key, value] of Object.entries(marks)) if (compare(stamp, atom.ms[key]) > 0) {
    atom.marks[key] = value; atom.ms[key] = [...stamp]; changed = true;
  }
  return changed;
}
export function applyTextOperation(state, op) {
  validateTextOperation(op);
  if (state.base !== op.seed) throw Error('Text seed mismatch; reload the document before editing');
  const future = new Set(Object.keys(state.chars));
  for(const list of [op.insert,op.visibility,op.format])for(const item of list||[])future.add(item.id);
  if(future.size>MAX_TEXT_ATOMS)throw Error('Text history quota exceeded');
  let changed = false;
  for (const item of op.insert || []) {
    const atom = atomFor(state, item.id);
    if (atom.born && (atom.left !== item.left || atom.ch !== item.ch || compare(atom.born, op.stamp) !== 0)) throw Error('A character identity cannot be rewritten');
    if (!atom.born) {
      atom.left = item.left; atom.ch = item.ch; atom.born = [...op.stamp];
      if (compare(op.stamp, atom.ds) > 0) { atom.deleted = false; atom.ds = [...op.stamp]; }
      changed = true;
    }
    changed = putMarks(atom, item.marks || {}, op.stamp) || changed;
  }
  for (const item of op.visibility || []) {
    const atom = atomFor(state, item.id);
    if (compare(op.stamp, atom.ds) > 0) { atom.deleted = item.deleted; atom.ds = [...op.stamp]; changed = true; }
  }
  for (const item of op.format || []) changed = putMarks(atomFor(state, item.id), item.marks, op.stamp) || changed;
  return changed;
}
export function mergeRichText(target, incoming) {
  validateRichText(incoming);
  if (target.base !== incoming.base) throw Error('Incompatible text histories');
  if(new Set([...Object.keys(target.chars),...Object.keys(incoming.chars)]).size>MAX_TEXT_ATOMS)throw Error('Text history quota exceeded');
  let changed = false;
  for (const source of Object.values(incoming.chars)) {
    const atom = atomFor(target, source.id);
    if (source.born) {
      if (atom.born && (source.ch !== atom.ch || source.left !== atom.left || compare(source.born, atom.born) !== 0)) throw Error('Conflicting text insertion identity');
      if (!atom.born) { atom.ch = source.ch; atom.left = source.left; atom.born = [...source.born]; changed = true; }
    }
    if (compare(source.ds, atom.ds) > 0) { atom.ds = [...source.ds]; atom.deleted = source.deleted; changed = true; }
    for (const key of Object.keys(source.marks)) if (compare(source.ms[key], atom.ms[key]) > 0) {
      atom.marks[key] = source.marks[key]; atom.ms[key] = [...source.ms[key]]; changed = true;
    }
  }
  return changed;
}
export function richAtoms(state, includeDeleted = false) {
  if (!state) return [];
  const children = new Map();
  for (const atom of Object.values(state.chars)) if (atom.born) {
    let siblings = children.get(atom.left);
    if (!siblings) children.set(atom.left, siblings = []);
    siblings.push(atom);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => -compare(a.born, b.born) || (a.id < b.id ? -1 : 1));
  const stack = [...(children.get(ROOT) || [])].reverse(), result = [], seen = new Set();
  while (stack.length) {
    const atom = stack.pop();
    if (seen.has(atom.id)) continue;
    seen.add(atom.id);
    if (!atom.deleted || includeDeleted) result.push(atom);
    const next = children.get(atom.id);
    if (next) for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]);
  }
  return result;
}
export function richString(state) { return richAtoms(state).map(atom => atom.ch).join(''); }
export function richRuns(node) {
  const atoms = node.richText ? richAtoms(node.richText) : [...(node.text || '')].map(ch => ({ch, marks: {}}));
  const runs = [];
  for (const atom of atoms) {
    const marks = Object.fromEntries(Object.entries(atom.marks).filter(([, value]) => value !== null));
    const signature = JSON.stringify(Object.entries(marks).sort(([a], [b]) => a.localeCompare(b)));
    const previous = runs[runs.length - 1];
    if (previous?.signature === signature) previous.text += atom.ch;
    else runs.push({text: atom.ch, marks, signature});
  }
  return runs;
}
export function textReplacement(state, id, start, count, text, marks, stamp) {
  const atoms = richAtoms(state), chars = [...text];
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > atoms.length || atoms.length - count + chars.length > 20000) throw Error('Invalid text edit range');
  validateMarks(marks || {});
  let left = atoms[start - 1]?.id || ROOT;
  const prefix = 'c_' + textHash(stamp[1]) + '_' + stamp[0].toString(36) + '_';
  const insert = chars.map((ch, i) => { const item = {id: prefix + i.toString(36), left, ch, marks: copy(marks || {})}; left = item.id; return item; });
  return {kind: 'text', id, stamp, seed: state.base, insert, visibility: atoms.slice(start, start + count).map(atom => ({id: atom.id, deleted: true}))};
}
export function relativeTextPosition(atoms, index) { return {left: atoms[index - 1]?.id || '', right: atoms[index]?.id || ''}; }
export function resolveTextPosition(state, position) {
  const visible = richAtoms(state), positions = new Map(visible.map((atom, i) => [atom.id, i]));
  if (position.right && positions.has(position.right)) return positions.get(position.right);
  if (position.left && positions.has(position.left)) return positions.get(position.left) + 1;
  if (!position.left) return 0;
  let count = 0;
  for (const atom of richAtoms(state, true)) { if (atom.id === position.left) return count; if (!atom.deleted) count++; }
  return visible.length;
}
export function minimalTextDiff(before, after) {
  const a = [...before], b = [...after]; let start = 0, suffix = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (suffix < a.length - start && suffix < b.length - start && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return {start, count: a.length - start - suffix, text: b.slice(start, b.length - suffix).join('')};
}
