/**
 * Strip sections marked with <!-- council: exclude --> from the rendered system prompt.
 * Sections are delimited by `## [` headers. A section with the exclude marker is removed
 * entirely (header + body) up to the next `## [` header or end of string.
 *
 * This gives AGENTS.md authors control over what subagents see, right at the source.
 * New sections are included by default — only explicitly excluded sections are stripped.
 */
export function buildSubagentMemberContext(renderedSystemPrompt: string): string {
  if (!renderedSystemPrompt) return '';

  // Split on section headers (## [SECTION_NAME] with optional <!-- council: exclude -->)
  // Capture the header line and body separately so we can filter by the marker.
  const sectionPattern = /^(## \[.+\].*)$/gm;
  const headers: { index: number; line: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = sectionPattern.exec(renderedSystemPrompt)) !== null) {
    headers.push({ index: match.index, line: match[1] });
  }

  if (headers.length === 0) return renderedSystemPrompt;

  // Build output: content before the first header + non-excluded sections
  const parts: string[] = [];
  const preamble = renderedSystemPrompt.slice(0, headers[0].index);
  if (preamble.trim()) parts.push(preamble.trimEnd());

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const nextStart = i + 1 < headers.length ? headers[i + 1].index : renderedSystemPrompt.length;
    if (header.line.includes('<!-- council: exclude -->')) continue;
    parts.push(renderedSystemPrompt.slice(header.index, nextStart).trimEnd());
  }

  return parts.join('\n\n');
}
