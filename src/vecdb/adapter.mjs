// minimal interface for a vector DB adapter
export class VectorDBAdapter {
  // upsert documents: [{ id, vector, metadata }]
  async upsert(docs) { throw new Error('NotImplemented'); }
  // query embeddings: { queryVector, topK }
  async query({ queryVector, topK = 10 }) { throw new Error('NotImplemented'); }
  async delete(ids) { throw new Error('NotImplemented'); }
  async stats() { return { count: 0 }; }
}
