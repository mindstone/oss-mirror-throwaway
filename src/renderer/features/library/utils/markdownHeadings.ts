export type MarkdownHeading = {
  level: number;
  text: string;
  lineIndex: number;
};

export function extractHeadings(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = content.split('\n');
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    // Track fenced code blocks (``` or ~~~) — headings inside code are not real
    if (/^(`{3,}|~{3,})/.test(lines[i])) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        lineIndex: i
      });
    }
  }

  return headings;
}

export function getCharPositionOfLine(content: string, lineIndex: number): number {
  const lines = content.split('\n');
  let pos = 0;

  for (let i = 0; i < lineIndex && i < lines.length; i++) {
    pos += lines[i].length + 1; // +1 for newline character
  }

  return pos;
}

