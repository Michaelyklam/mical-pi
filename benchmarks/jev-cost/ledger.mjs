import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Single-process writer. Acquire lock before the first network request; never auto-clear stale locks.
export class Ledger {
  constructor(file, cap = 50) {
    if (!Number.isFinite(cap) || cap <= 0 || cap > 50) throw Error('Cap must be in (0, 50].');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file; this.lock = file + '.lock';
    this.fd = fs.openSync(this.lock, 'wx', 0o600);
    this.cap = cap;
    try {
      this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, cap, entries: [] };
      if (this.data.cap !== cap) throw Error('Existing ledger cap differs.');
      this.save();
    } catch (error) { this.close(); throw error; }
  }
  save() { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
  committed() { return this.data.entries.reduce((s, e) => s + (e.status === 'settled' ? e.charged : e.reserved), 0); }
  reserve(label, maximum, billing) {
    if (!Number.isFinite(maximum) || maximum <= 0) throw Error('Invalid reservation.');
    if (this.committed() + maximum > this.cap) throw Error(`Budget stop: cannot reserve $${maximum.toFixed(4)} for ${label}.`);
    const id = randomUUID(); this.data.entries.push({ id, label, billing, reserved: maximum, status: 'pending', at: new Date().toISOString() }); this.save(); return id;
  }
  settle(id, charged, details = {}) {
    const e = this.data.entries.find(e => e.id === id);
    if (!e || e.status !== 'pending') throw Error('Unknown/already settled reservation.');
    if (!Number.isFinite(charged) || charged < 0) throw Error('Missing/invalid cost; reservation retained.');
    Object.assign(e, { status: 'settled', charged, details }); this.save();
    if (charged > e.reserved || this.committed() > this.cap) throw Error('Cost exceeded reservation; stop immediately.');
  }
  close() { if (this.fd !== undefined) { fs.closeSync(this.fd); fs.unlinkSync(this.lock); this.fd = undefined; } }
}
