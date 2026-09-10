import {FORMAT, VERSION, uid, clone, compareStamp, sameStamp, validateOp, validateSnapshot, validateValues, MAX_RECORDS} from './schema.js';
import {createRichText, applyTextOperation, mergeRichText, richString, richAtoms, textReplacement, minimalTextDiff} from './richtext.js';

/** Scene-register CRDT + character-level text. Transport and renderer independent. */
export class DocumentStore {
  constructor(actor = uid('actor')) {
    this.actor = actor; this.clock = 0; this.records = new Map(); this.listeners = new Set();
    this.undoStack = []; this.redoStack = []; this.batch = null; this.revision = 0;
    this.canWrite = () => true; this.structureVersion = 0; this.parentCache = null;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(event) { this.revision++; for (const fn of this.listeners) fn(event); }
  get(id) { const r = this.records.get(id); return r && !r.deleted ? r : null; }
  all(entity = 'node') { return [...this.records.values()].filter(r => !r.deleted && r.entity === entity); }

  /** Deterministic tree projection. Concurrent cycles/orphans cannot hide a subtree. */
  effectiveParents() {
    if (this.parentCache?.version === this.structureVersion) return this.parentCache.parents;
    const nodes = this.all(), ids = new Set(nodes.map(n => n.id)), parents = new Map();
    for (const n of nodes) parents.set(n.id, n.parent && ids.has(n.parent) && n.parent !== n.id ? n.parent : '');
    const done = new Set(), conflicts = [];
    for (const start of [...ids].sort()) {
      if (done.has(start)) continue;
      const chain = [], positions = new Map(); let id = start;
      while (id && !done.has(id)) {
        if (positions.has(id)) {
          const cycle = chain.slice(positions.get(id));
          const cut = [...cycle].sort()[0]; parents.set(cut, ''); conflicts.push({kind: 'cycle', nodes: cycle, root: cut}); break;
        }
        positions.set(id, chain.length); chain.push(id); id = parents.get(id) || '';
      }
      for (const item of chain) done.add(item);
    }
    this.parentCache = {version: this.structureVersion, parents, conflicts};
    return parents;
  }
  children(parent = '') { const parents = this.effectiveParents(); return this.all().filter(n => parents.get(n.id) === parent).sort((a, b) => (a.order || 0) - (b.order || 0) || a.id.localeCompare(b.id)); }
  descendants(id) {
    const nodes = this.all(), parents = this.effectiveParents(), byParent = new Map();
    for (const n of nodes) { const parent = parents.get(n.id); if (!byParent.has(parent)) byParent.set(parent, []); byParent.get(parent).push(n); }
    const result = [], stack = [...(byParent.get(id) || [])].reverse(), seen = new Set([id]);
    while (stack.length) { const n = stack.pop(); if (seen.has(n.id)) continue; seen.add(n.id); result.push(n); stack.push(...(byParent.get(n.id) || []).reverse()); }
    return result;
  }
  isAncestor(a, b) { const parents = this.effectiveParents(), seen = new Set(); let p = parents.get(b); while (p && !seen.has(p)) { if (p === a) return true; seen.add(p); p = parents.get(p); } return false; }
  apply(op) {
    validateOp(op); this.clock = Math.max(this.clock, op.stamp[0]);
    let record = this.records.get(op.id);
    if (!record) {
      if (this.records.size >= MAX_RECORDS) throw Error('Document record limit reached');
      record = {id: op.id, _stamps: Object.create(null)}; this.records.set(op.id, record); this.structureVersion++;
    }
    if (op.kind === 'text') {
      const state = record.richText ? clone(record.richText) : createRichText(op.seed);
      const changed = applyTextOperation(state, op), text = richString(state);
      if (text.length > 20000) throw Error('Text exceeds 20,000 characters');
      if (changed || !record.richText) {
        record.richText = state; record.text = text;
        for (const key of ['richText', 'text']) if (compareStamp(op.stamp, record._stamps[key]) > 0) record._stamps[key] = [...op.stamp];
      }
      return changed;
    }
    let changed = false;
    for (const [key, value] of Object.entries(op.values)) {
      if (key === 'richText' && value) {
        const state = record.richText ? clone(record.richText) : createRichText(value.base);
        changed = mergeRichText(state, value) || changed;
        record.richText = state; record.text = richString(state);
        if (compareStamp(op.stamp, record._stamps.richText) > 0) record._stamps.richText = [...op.stamp];
        continue;
      }
      if (key === 'richText' && record.richText && value === null) continue; // History is never reset by a late register write.
      if (key === 'text' && record.richText) continue;
      if (compareStamp(op.stamp, record._stamps[key]) > 0) {
        record[key] = clone(value); record._stamps[key] = [...op.stamp]; changed = true;
        if (['parent', 'deleted', 'entity', 'order'].includes(key)) this.structureVersion++;
      }
    }
    if (record.richText) { record.text = richString(record.richText); if (!record._stamps.text) record._stamps.text = [...op.stamp]; }
    return changed;
  }
  receive(ops) {
    for (const op of ops) validateOp(op);
    const old = new Map(), clock = this.clock; let changed = false;
    try {
      for (const op of ops) {
        if (!old.has(op.id)) old.set(op.id, this.records.has(op.id) ? clone(this.records.get(op.id)) : null);
        changed = this.apply(op) || changed;
      }
    } catch (error) { for (const [id, record] of old) record ? this.records.set(id, record) : this.records.delete(id); this.clock = clock; this.structureVersion++; throw error; }
    if (changed) this.emit({local: false, ops});
    return changed;
  }
  transact(label, fn, {history = true} = {}) {
    if (this.batch) return fn();
    const batch = {label, ops: [], inverse: new Map(), clock: this.clock}; this.batch = batch;
    try { fn(); } catch (error) {
      for (const [id, old] of batch.inverse) old === null ? this.records.delete(id) : this.records.set(id, old);
      this.clock = batch.clock; this.structureVersion++; this.batch = null; throw error;
    }
    this.batch = null;
    if (!batch.ops.length) return;
    if (history) {
      const changes = [];
      for (const [id, old] of batch.inverse) {
        const now = this.records.get(id), fields = {}, text = [];
        for (const op of batch.ops.filter(o => o.id === id && o.kind !== 'text')) {
          for (const key of Object.keys(op.values)) fields[key] = {before: old?.[key] ?? null, after: clone(now[key]), stamp: [...now._stamps[key]]};
        }
        if (batch.ops.some(o => o.id === id && o.kind === 'text')) {
          const before = old?.richText || createRichText(now.richText.base);
          for (const atom of Object.values(now.richText.chars)) {
            const previous = before.chars[atom.id], marks = {};
            for (const key of Object.keys(atom.ms)) if (!sameStamp(atom.ms[key], previous?.ms[key])) marks[key] = {before: previous?.marks[key] ?? null, after: atom.marks[key], stamp: [...atom.ms[key]]};
            const visibility = !previous || !sameStamp(atom.ds, previous.ds) ? {before: previous ? previous.deleted : true, after: atom.deleted, stamp: [...atom.ds]} : null;
            if (visibility || Object.keys(marks).length) text.push({id: atom.id, visibility, marks});
          }
        }
        changes.push({id, created: old === null, fields, text});
      }
      this.undoStack.push({label, changes}); if (this.undoStack.length > 120) this.undoStack.shift(); this.redoStack = [];
    }
    this.emit({local: true, label, ops: batch.ops});
  }
  remember(id) { if (!this.batch.inverse.has(id)) this.batch.inverse.set(id, this.records.has(id) ? clone(this.records.get(id)) : null); }
  set(id, values) {
    if (!this.batch) return this.transact('Edit element', () => this.set(id, values));
    validateValues(values);
    if (!this.canWrite(id, values)) throw Error('Your role does not allow this change');
    const record = this.records.get(id), copy = {...values};
    if(record?.type==='path'&&('w' in copy||'h' in copy)){if(!record.pathW&&!('pathW' in copy))copy.pathW=record.w;if(!record.pathH&&!('pathH' in copy))copy.pathH=record.h;}
    let textEdit = null;
    if (typeof copy.text === 'string' && record?.entity === 'node' && ['text', 'button', 'input'].includes(record.type) && !copy.richText) {
      if (copy.text !== record.text) textEdit = minimalTextDiff(record.text || '', copy.text);
      delete copy.text;
    }
    if (copy.parent && (copy.parent === id || this.isAncestor(id, copy.parent))) throw Error('A group cannot contain itself');
    const diff = {};
    for (const [key, value] of Object.entries(copy)) if (JSON.stringify(record?.[key]) !== JSON.stringify(value)) diff[key] = value;
    if (Object.keys(diff).length) { this.remember(id); const op = {id, values: clone(diff), stamp: [++this.clock, this.actor]}; this.apply(op); this.batch.ops.push(op); }
    if (textEdit) this.editText(id, textEdit.start, textEdit.count, textEdit.text);
  }
  textOperation(id, parts) {
    if (!this.batch) return this.transact('Edit rich text', () => this.textOperation(id, parts));
    const record = this.get(id);
    if (!record || record.entity !== 'node' || !['text', 'button', 'input'].includes(record.type)) throw Error('Select a text element');
    if (!this.canWrite(id, {text: record.text})) throw Error('Your role does not allow text editing');
    this.remember(id);
    const seed = record.richText?.base ?? record.text ?? '', stamp = [++this.clock, this.actor];
    const op = typeof parts === 'function' ? parts(record.richText || createRichText(seed), stamp) : {kind: 'text', id, seed, stamp, ...parts};
    if (!(op.insert?.length || op.visibility?.length || op.format?.length)) return;
    this.apply(op); this.batch.ops.push(op);
  }
  editText(id, start, count, text, marks = null) {
    this.textOperation(id, (state, stamp) => {
      const atoms = richAtoms(state), inherited = marks ?? atoms[Math.max(0, start - 1)]?.marks ?? {};
      return textReplacement(state, id, start, count, text, inherited, stamp);
    });
  }
  formatText(id, start, count, marks) {
    this.textOperation(id, (state, stamp) => ({kind: 'text', id, stamp, seed: state.base, format: richAtoms(state).slice(start, start + count).map(atom => ({id: atom.id, marks}))}));
  }
  add(values, id = uid(values.entity === 'comment' ? 'c' : 'n')) { this.set(id, values); return id; }
  delete(id) { this.transact('Delete', () => { for (const n of this.descendants(id)) this.set(n.id, {deleted: true}); this.set(id, {deleted: true}); }); }
  historyStep(source, destination, direction) {
    const entry = source.pop(); if (!entry) return 0;
    let count = 0; const next = [], undo = direction === 'undo';
    try {
      this.transact(`${undo ? 'Undo' : 'Redo'} ${entry.label}`, () => {
        for (const change of entry.changes) {
          const record = this.records.get(change.id); if (!record) continue;
          const values = {}, fields = {}, text = [];
          if (change.created) {
            if (undo) { if (Object.entries(change.fields).some(([key, f]) => !sameStamp(record._stamps[key], f.stamp))) continue; values.deleted = true; }
            else { if (!sameStamp(record._stamps.deleted, change.deleteStamp)) continue; values.deleted = false; }
          } else for (const [key, field] of Object.entries(change.fields)) if (sameStamp(record._stamps[key], field.stamp)) values[key] = undo ? field.before : field.after;
          if (Object.keys(values).length) {
            this.set(change.id, values); count++;
            const updated = this.records.get(change.id);
            for (const [key, field] of Object.entries(change.fields)) {
              if (change.created) fields[key] = {...field, stamp: key === 'deleted' ? [...updated._stamps[key]] : [...field.stamp]};
              else if (Object.hasOwn(values, key)) fields[key] = {...field, stamp: [...updated._stamps[key]]};
            }
          }
          if (!change.created && change.text?.length && record.richText) {
            const visibility = [], format = [];
            for (const item of change.text) {
              const atom = record.richText.chars[item.id]; if (!atom) continue;
              const nextItem = {id: item.id, visibility: null, marks: {}}, marks = {};
              if (item.visibility && sameStamp(atom.ds, item.visibility.stamp)) { visibility.push({id: atom.id, deleted: undo ? item.visibility.before : item.visibility.after}); nextItem.visibility = item.visibility; }
              for (const [key, field] of Object.entries(item.marks)) if (sameStamp(atom.ms[key], field.stamp)) { marks[key] = undo ? field.before : field.after; nextItem.marks[key] = field; }
              if (Object.keys(marks).length) format.push({id: atom.id, marks});
              if (nextItem.visibility || Object.keys(nextItem.marks).length) text.push(nextItem);
            }
            if (visibility.length || format.length) {
              this.textOperation(change.id, {visibility, format}); count++;
              for (const item of text) { const atom = this.get(change.id).richText.chars[item.id]; if (item.visibility) item.visibility = {...item.visibility, stamp: [...atom.ds]}; for (const key of Object.keys(item.marks)) item.marks[key] = {...item.marks[key], stamp: [...atom.ms[key]]}; }
            }
          }
          if (Object.keys(fields).length || change.created && Object.keys(values).length || text.length) next.push({...change, fields, text, deleteStamp: this.records.get(change.id)._stamps.deleted});
        }
      }, {history: false});
    } catch (error) { source.push(entry); throw error; }
    destination.push({label: entry.label, changes: next}); return count;
  }
  undo() { return this.historyStep(this.undoStack, this.redoStack, 'undo'); }
  redo() { return this.historyStep(this.redoStack, this.undoStack, 'redo'); }
  snapshot() { return {format: FORMAT, version: VERSION, clock: this.clock, records: clone(Object.fromEntries(this.records))}; }
  load(snapshot) {
    validateSnapshot(snapshot); this.records = new Map(Object.entries(clone(snapshot.records))); this.clock = 0;
    for (const record of this.records.values()) {
      for (const stamp of Object.values(record._stamps)) this.clock = Math.max(this.clock, stamp[0]);
      if (record.richText) { record.text = richString(record.richText); for (const atom of Object.values(record.richText.chars)) { if (atom.born) this.clock = Math.max(this.clock, atom.born[0]); this.clock = Math.max(this.clock, atom.ds[0], ...Object.values(atom.ms).map(s => s[0])); } }
    }
    this.undoStack = []; this.redoStack = []; this.structureVersion++; this.emit({local: false, load: true});
  }
  merge(snapshot) {
    validateSnapshot(snapshot); const ops = [];
    for (const record of Object.values(snapshot.records)) for (const [key, stamp] of Object.entries(record._stamps)) ops.push({id: record.id, stamp, values: {[key]: record[key]}});
    return this.receive(ops);
  }
}
