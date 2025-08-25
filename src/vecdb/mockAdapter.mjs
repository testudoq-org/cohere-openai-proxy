import { VectorDBAdapter } from './adapter.mjs';

export class MockVectorDBAdapter extends VectorDBAdapter {
  constructor() { super(); this.store = new Map(); }
  async upsert(docs) {
    for (const d of docs) this.store.set(d.id, d);
    return { upserted: docs.length };
  }
  async query({ queryVector, topK = 10 }) {
    // naive: return first topK
    const results = Array.from(this.store.values()).slice(0, topK).map((d) => ({ id: d.id, score: 1.0, metadata: d.metadata }));
    return results;
  }
  async delete(ids) {
    for (const id of ids) this.store.delete(id);
    return { deleted: ids.length };
  }
  async stats() { return { count: this.store.size }; }
}
