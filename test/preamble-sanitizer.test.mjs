import { describe, it, expect } from 'vitest';
import { sanitizePreambleForModel } from '../src/utils/preambleSanitizer.mjs';

describe('preambleSanitizer', () => {
  it('removes execute_command blocks when model does not support tools', () => {
    const pre = 'Intro\n```text\n<execute_command>\n<command>echo "Hello, World!"</command>\n</execute_command>\nMore';
    const { sanitized, changed } = sanitizePreambleForModel(pre, false);
    expect(changed).toBe(true);
    expect(sanitized).not.toContain('<execute_command>');
    expect(sanitized).toContain('[REDACTED: tool example removed]');
  });

  it('does not modify preamble when model supports tools', () => {
    const pre = 'Intro\n<execute_command>\n<command>echo "Hello"</command>\n</execute_command>\nEnd';
    const { sanitized, changed } = sanitizePreambleForModel(pre, true);
    expect(changed).toBe(false);
    expect(sanitized).toBe(pre);
  });

  it('removes self-closing list_files tags', () => {
    const pre = 'Context: <list_files/> \n more text';
    const { sanitized, changed } = sanitizePreambleForModel(pre, false);
    expect(changed).toBe(true);
    expect(sanitized).not.toContain('<list_files');
    expect(sanitized).toContain('[REDACTED: tool tag removed]');
  });
});