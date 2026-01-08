import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { supportsTools, parseEnvList } from '../../src/utils/cohereModelCapabilities.mjs';

describe('cohereModelCapabilities', () => {
  let OLD_FORCE;
  let OLD_LIST;

  beforeEach(() => {
    OLD_FORCE = process.env.COHERE_FORCE_STRIP_TOOLS;
    OLD_LIST = process.env.COHERE_TOOL_CAPABLE_MODELS;
    delete process.env.COHERE_FORCE_STRIP_TOOLS;
    delete process.env.COHERE_TOOL_CAPABLE_MODELS;
  });
  afterEach(() => {
    process.env.COHERE_FORCE_STRIP_TOOLS = OLD_FORCE;
    process.env.COHERE_TOOL_CAPABLE_MODELS = OLD_LIST;
  });

  it('detects command-r models as tool-capable', () => {
    expect(supportsTools('command-r-08-2024')).toBe(true);
    expect(supportsTools('command-r-plus-08-2024')).toBe(true);
    expect(supportsTools('command-r')).toBe(true);
  });

  it('rejects vision models by default', () => {
    expect(supportsTools('command-a-vision-07-2025')).toBe(false);
  });

  it('honors COHERE_FORCE_STRIP_TOOLS', () => {
    process.env.COHERE_FORCE_STRIP_TOOLS = 'true';
    expect(supportsTools('command-r-08-2024')).toBe(false);
  });

  it('honors COHERE_TOOL_CAPABLE_MODELS exact match', () => {
    process.env.COHERE_TOOL_CAPABLE_MODELS = 'command-a-vision-07-2025, custom-model';
    expect(supportsTools('command-a-vision-07-2025')).toBe(true);
    expect(supportsTools('custom-model')).toBe(true);
    expect(supportsTools('something-else')).toBe(false);
  });

  it('honors COHERE_TOOL_CAPABLE_MODELS wildcard patterns', () => {
    process.env.COHERE_TOOL_CAPABLE_MODELS = 'cmd-*,custom-*';
    expect(supportsTools('cmd-123')).toBe(true);
    expect(supportsTools('custom-foo')).toBe(true);
    expect(supportsTools('no-match')).toBe(false);
  });
});