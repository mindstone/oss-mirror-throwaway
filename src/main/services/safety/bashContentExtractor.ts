const MAX_COMMAND_LENGTH = 10_000;

const QUOTED_LITERAL_PATTERN = `(?:"(?:\\\\.|[^"\\\\])*"|'[^']*')`;
const REDIRECT_TARGET_PATTERN = `(?:"(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\s;&|]+)`;

const ECHO_REDIRECT_PATTERN = new RegExp(
  `^\\s*echo(?:\\s+(-[^\\s]+))?\\s+(${QUOTED_LITERAL_PATTERN})\\s*>\\s*${REDIRECT_TARGET_PATTERN}\\s*$`
);

const PRINTF_REDIRECT_PATTERN = new RegExp(
  `^\\s*printf\\s+(${QUOTED_LITERAL_PATTERN})\\s*>\\s*${REDIRECT_TARGET_PATTERN}\\s*$`
);

function stripQuotedSegments(command: string): string {
  return command
    .replace(/'[^']*'/g, '')
    .replace(/"(?:\\.|[^"\\])*"/g, '');
}

function containsDynamicSyntax(content: string): boolean {
  return content.includes('$') || content.includes('`');
}

function unwrapQuotedLiteral(quotedValue: string): string | null {
  const quote = quotedValue[0];
  if ((quote !== '"' && quote !== '\'') || quotedValue[quotedValue.length - 1] !== quote) {
    return null;
  }
  return quotedValue.slice(1, -1);
}

function containsNullByte(content: string): boolean {
  return content.includes('\0');
}

function extractEchoRedirect(command: string): string | null {
  const match = command.match(ECHO_REDIRECT_PATTERN);
  if (!match) return null;

  const [, flags, quotedContent] = match;

  // NARROWED SCOPE: only plain `echo "..." > file` / `echo '...' > file`.
  // Any flags are rejected to avoid shell-specific semantics.
  if (flags) return null;

  const content = unwrapQuotedLiteral(quotedContent);
  if (content === null) return null;
  if (containsDynamicSyntax(content)) return null;
  if (containsNullByte(content)) return null;

  // echo always appends a trailing newline
  return content + '\n';
}

function containsPrintfFormatSpecifier(content: string): boolean {
  const withoutEscapedPercent = content.replace(/%%/g, '');
  return /%(?:\d+\$)?[-+#0 ]*\d*(?:\.\d+)?[a-zA-Z]/.test(withoutEscapedPercent);
}

function unescapePrintfLiteral(content: string): string {
  let result = '';

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (char !== '\\' || i === content.length - 1) {
      result += char;
      continue;
    }

    const next = content[i + 1];
    if (next === 'n') {
      result += '\n';
      i += 1;
      continue;
    }
    if (next === 't') {
      result += '\t';
      i += 1;
      continue;
    }
    if (next === '0') {
      result += '\0';
      i += 1;
      continue;
    }
    if (next === '\\') {
      result += '\\';
      i += 1;
      continue;
    }

    result += `\\${next}`;
    i += 1;
  }

  return result;
}

function extractPrintfRedirect(command: string): string | null {
  const match = command.match(PRINTF_REDIRECT_PATTERN);
  if (!match) return null;

  const [, quotedContent] = match;
  const rawContent = unwrapQuotedLiteral(quotedContent);
  if (rawContent === null) return null;
  if (containsDynamicSyntax(rawContent)) return null;

  // NARROWED SCOPE: only literal strings; reject format processing.
  if (/%[bs]/i.test(rawContent)) return null;
  if (containsPrintfFormatSpecifier(rawContent)) return null;

  const content = unescapePrintfLiteral(rawContent);
  if (containsNullByte(content)) return null;

  return content;
}

/**
 * Extract the source file path from a Bash command that copies an existing file.
 * Covers `cp`, `cat file > dest`, and `cat file | tee dest`.
 * Returns the source path so the caller can read its content for inspection.
 * Returns null for anything we can't safely parse (compound commands, dynamic
 * syntax, recursive copies, multi-source, transforms).
 */
export function extractBashCopySource(command: string): string | null {
  if (!command || command.length > MAX_COMMAND_LENGTH) return null;

  const withoutQuoted = stripQuotedSegments(command);

  // Reject compound commands
  if (withoutQuoted.includes('&&') || withoutQuoted.includes('||') || withoutQuoted.includes(';')) return null;

  // Reject dynamic syntax
  if (containsDynamicSyntax(withoutQuoted)) return null;

  // Pattern 1: `cp src dest` (simple single-file copy)
  const cpMatch = command.match(/^\s*cp\s+(.+?)\s*$/);
  if (cpMatch) {
    const argsStr = cpMatch[1].trim();
    const args: string[] = [];
    const argRegex = /(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
    for (const argMatch of argsStr.matchAll(argRegex)) {
      const arg = argMatch[1] ?? argMatch[2] ?? argMatch[3];
      if (!arg) continue;
      // Reject recursive flags -- directory copies are not single-file inspectable
      if (arg === '-r' || arg === '-R' || arg === '-a') return null;
      if (!arg.startsWith('-')) args.push(arg);
    }
    if (args.length === 2) return args[0];
    return null;
  }

  // Pattern 2: `cat file > dest` (redirect-based copy)
  // Match: cat [optional flags] file > dest
  const catRedirectMatch = command.match(
    /^\s*cat\s+(?:-[a-zA-Z]*\s+)*(?:"([^"]+)"|'([^']+)'|([^\s>|&]+))\s*>\s*(?:"[^"]+"|'[^']+'|[^\s]+)\s*$/
  );
  if (catRedirectMatch) {
    const source = catRedirectMatch[1] ?? catRedirectMatch[2] ?? catRedirectMatch[3];
    // Reject if source looks like a flag or stdin marker
    if (source && !source.startsWith('-')) return source;
  }

  return null;
}

export function extractBashWriteContent(command: string): string | null {
  if (!command || command.length > MAX_COMMAND_LENGTH) return null;

  const withoutQuoted = stripQuotedSegments(command);

  // Reject compound commands — only the write portion would be staged.
  if (withoutQuoted.includes('&&') || withoutQuoted.includes('||') || withoutQuoted.includes(';')) return null;

  // Reject append patterns.
  if (withoutQuoted.includes('>>') || withoutQuoted.includes('&>>')) return null;

  // Reject tee, ANSI-C quotes, and dynamic command-level expressions.
  if (/\btee\b/.test(withoutQuoted)) return null;
  if (/\$'/.test(command)) return null;
  if (containsDynamicSyntax(withoutQuoted)) return null;

  const echoContent = extractEchoRedirect(command);
  if (echoContent !== null) return echoContent;

  const printfContent = extractPrintfRedirect(command);
  if (printfContent !== null) return printfContent;

  return null;
}

/**
 * Extract content from a Bash heredoc write command.
 *
 * Only supports simple overwrite patterns where the heredoc body IS the
 * full file content:
 *   cat > file << 'MARKER'\ncontent\nMARKER
 *   cat > file << "MARKER"\ncontent\nMARKER
 *   cat > file << MARKER\ncontent\nMARKER
 *   tee file << 'MARKER'\ncontent\nMARKER
 *
 * Returns null (falls back to blocking approval) for:
 *   - Append redirections (>>, &>>, tee -a) -- staging would overwrite
 *   - <<- (strip-leading-tabs) -- we can't faithfully reproduce tab stripping
 *   - Non-heredoc commands (piped, redirected, variable-based)
 *
 * @internal Exported for testing
 */
export function extractBashHeredocContent(command: string): string | null {
  if (!command) return null;

  // Reject append patterns -- staging writes the full file, which would
  // corrupt an append operation. Check before heredoc extraction.
  if (/(?:>>|&>>)/.test(command)) return null;
  if (/\btee\s+(?:.*\s)?-a\b/.test(command)) return null;

  // Reject <<- (strip-leading-tabs variant). We can't faithfully reproduce
  // Bash's tab-stripping semantics, so fall back to blocking approval.
  if (/<<-/.test(command)) return null;

  // Match heredoc operator followed by optional quotes around the delimiter.
  // The newline after the delimiter marks the start of content.
  const heredocMatch = command.match(/<<\s*(?:'([^']+)'|"([^"]+)"|(\S+))\s*\n/);
  if (!heredocMatch) return null;

  const marker = heredocMatch[1] ?? heredocMatch[2] ?? heredocMatch[3];
  if (!marker) return null;

  const startIndex = command.indexOf(heredocMatch[0]) + heredocMatch[0].length;
  const remaining = command.slice(startIndex);

  // Find the closing marker on its own line (possibly with trailing whitespace)
  const lines = remaining.split('\n');
  const contentLines: string[] = [];
  for (const line of lines) {
    if (line.trim() === marker) {
      return contentLines.join('\n');
    }
    contentLines.push(line);
  }

  return null; // No closing marker found
}

// Re-export the SINGLE shared write-target enumerator from core. This used to be
// a near-duplicate copy that drifted from the core/tool-safety one (the core copy
// normalized; this one returned raw), which created a latent raw-string-guard
// evasion. Both subsystems now share one implementation (returns RAW); see
// docs/plans/260614_investigate-bashwritetargets/PLAN.md and the docstring on the
// core function. Re-exported here to preserve existing import paths
// (`./bashContentExtractor` and the `memoryWriteHook` re-export).
export { extractBashWriteTargets } from '@core/services/safety/bashTargetSpace';
