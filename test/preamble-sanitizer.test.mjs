import { describe, it, expect } from 'vitest';
import { sanitizePreambleForModel } from '../src/utils/preambleSanitizer.mjs';

describe('preambleSanitizer', () => {
  it('removes execute_command blocks when model does not support tools', () => {
    const pre = 'Intro\n```text\n<execute_command>\n<command>[REDACTED_COMMAND]</command>\n</execute_command>\nMore';
    const { sanitized, changed } = sanitizePreambleForModel(pre, false);
    expect(changed).toBe(true);
    expect(sanitized).not.toContain('<execute_command>');
    expect(sanitized).toContain('[REDACTED: tool example removed]');
  });

  it('does not modify preamble when model supports tools', () => {
    const pre = 'Intro\n<execute_command>\n<command>[REDACTED_EXAMPLE]</command>\n</execute_command>\nEnd';
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

  it('removes read_file blocks and tags with attributes for non-tool models', () => {
    const pre = 'Intro\n<read_file path="d:/foo/bar.txt">file content</read_file>\nEnd';
    const { sanitized, changed } = sanitizePreambleForModel(pre, false);
    expect(changed).toBe(true);
    expect(sanitized).not.toContain('<read_file');
    expect(sanitized).toContain('[REDACTED: tool example removed]');
  });

  it('does not modify preamble with tool tags when allowToolSyntax is true', () => {
    const pre = '<read_file path="d:/foo/bar.txt">x</read_file>';
    const { sanitized, changed } = sanitizePreambleForModel(pre, true);
    expect(changed).toBe(false);
    expect(sanitized).toBe(pre);
  });

  it('removes multi-line list_files blocks for non-tool models', () => {
    const pre = 'Files:\n<list_files path="d:/proj" recursive="true">\n<file>index.js</file>\n</list_files>\nEnd';
    const { sanitized, changed } = sanitizePreambleForModel(pre, false);
    expect(changed).toBe(true);
    expect(sanitized).not.toContain('<list_files');
    expect(sanitized).toContain('[REDACTED: tool example removed]');
  });

  it('removes code fences that contain tool-like commands', () => {
    const pre = 'Example:\n```bash\n# run\n<execute_command>\n<command>echo "Hello World!"</command>\n</execute_command>\n```\nend';
    const { sanitized, changed } = sanitizePreambleForModel(pre, false);
    expect(changed).toBe(true);
    expect(sanitized).not.toContain('echo "Hello World!"');
    expect(sanitized).toContain('[REDACTED: tool example removed]');
  });

  it('removes self-closing read_file tags with attributes', () => {
    const pre = 'Check <read_file path="d:/x.txt" /> more';
    const { sanitized, changed } = sanitizePreambleForModel(pre, false);
    expect(changed).toBe(true);
    expect(sanitized).not.toContain('<read_file');
    expect(sanitized).toContain('[REDACTED: tool tag removed]');
  });

  it('preserves code fences when allowToolSyntax is true', () => {
    const pre = 'Example:\n```bash\n<execute_command>\n<command>echo "Hello"</command>\n</execute_command>\n```';
    const { sanitized, changed } = sanitizePreambleForModel(pre, true);
    expect(changed).toBe(false);
    expect(sanitized).toBe(pre);
  });
});