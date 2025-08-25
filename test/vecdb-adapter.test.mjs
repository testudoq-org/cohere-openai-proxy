import { describe, it, expect } from 'vitest';
import { MockVectorDBAdapter } from '../src/vecdb/mockAdapter.mjs';

describe('MockVectorDBAdapter', () => {
  it('upserts and queries', async () => {
    const db = new MockVectorDBAdapter();
    await db.upsert([{ id: 'a', vector: [0.1], metadata: { text: 'a' } }]);
    const stats = await db.stats();
    expect(stats.count).toBe(1);
    const res = await db.query({ queryVector: [0.1], topK: 1 });
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe('a');
  });
});
