export function sanitizePreambleForModel(preamble, allowToolSyntax = false) {
  if (allowToolSyntax) return { sanitized: preamble, changed: false };
  if (!preamble || typeof preamble !== 'string') return { sanitized: preamble, changed: false };

  const orig = preamble;
  let cleaned = orig.replace(/<execute_command>[\s\S]*?<\/execute_command>/gi, '[REDACTED: tool example removed]');
  cleaned = cleaned.replace(/<list_files\/?[^>]*>/gi, '[REDACTED: tool tag removed]');
  cleaned = cleaned.replace(/<\/?[a-z0-9_]+_command[^>]*>/gi, '[REDACTED: tool tag removed]');

  return { sanitized: cleaned, changed: cleaned !== orig };
}

export default { sanitizePreambleForModel };