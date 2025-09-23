// test/utils/cohereClient.mjs

import { vi } from 'vitest';

/**
 * Creates a mock CohereClient constructor with custom behavior.
 * @param {Function} impl - Implementation for the constructor.
 * @returns {Function} The mock constructor.
 */
export function createMockCohereCtor(impl) {
  return vi.fn(impl);
}

/**
 * Dynamically mocks the 'cohere-ai' module with a provided CohereClient constructor.
 * @param {Function} ctor - The mock constructor to use.
 */
export function mockCohereModule(ctor) {
  vi.doMock('cohere-ai', () => ({ CohereClient: ctor }), { virtual: true });
}