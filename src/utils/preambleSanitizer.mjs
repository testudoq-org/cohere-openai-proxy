export function sanitizePreambleForModel(preamble, allowToolSyntax = false) {
  if (allowToolSyntax) return { sanitized: preamble, changed: false };
  if (!preamble || typeof preamble !== 'string') return { sanitized: preamble, changed: false };

  const orig = preamble;
  let cleaned = orig;

  // Remove common tool block tags (execute_command, run_command, shell_command)
  cleaned = cleaned.replace(/<\s*(execute_command|run_command|shell_command)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '[REDACTED: tool example removed]');

  // Remove list/read block tags (list_files, read_file, list_dir, read_dir) with content
  cleaned = cleaned.replace(/<\s*(list_files|read_file|list_dir|read_dir)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '[REDACTED: tool example removed]');

  // Remove self-closing or simple tags like <list_files/> or <read_file path="..."/>
  cleaned = cleaned.replace(/<\s*(list_files|read_file|list_dir|read_dir)[^>]*\/\s*>/gi, '[REDACTED: tool tag removed]');

  // Finally, remove any remaining tags whose name suggests tool use (read|list|exec|command|file)
  cleaned = cleaned.replace(/<\s*\/?\s*(?:[a-z0-9_-]*\b(?:read|list|exec|command|file)[a-z0-9_-]*)[^>]*>/gi, '[REDACTED: tool tag removed]');

  return { sanitized: cleaned, changed: cleaned !== orig };
}

export default { sanitizePreambleForModel };