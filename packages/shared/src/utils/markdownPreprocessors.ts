export const parseCollapseBlock = (
  content: string,
): { summary: string; body: string } => {
  const trimmed = content.trim();
  const lines = trimmed.split('\n');
  const firstLine = lines[0]?.trim() || '';
  const summary = firstLine || 'Details';
  const body = lines.slice(1).join('\n').trim();
  return { summary, body };
};

export const isCollapseLanguage = (
  className: string | undefined,
): { isCollapse: boolean; defaultOpen: boolean } => {
  if (!className) return { isCollapse: false, defaultOpen: false };
  const tokens = className.split(/\s+/);
  if (tokens.includes('language-collapse')) {
    return { isCollapse: true, defaultOpen: false };
  }
  if (tokens.includes('language-collapse-open')) {
    return { isCollapse: true, defaultOpen: true };
  }
  return { isCollapse: false, defaultOpen: false };
};

const HTML_DETAILS_REGEX =
  /<details\b([^>]*)>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;

export const convertHtmlDetailsToCollapse = (content: string): string => {
  if (!content.toLowerCase().includes('<details')) return content;

  const codeBlocks: string[] = [];
  let processed = content.replace(/```[\s\S]*?```/g, (match) => {
    const index = codeBlocks.length;
    codeBlocks.push(match);
    return `__DETAILS_CODE_BLOCK_${index}__`;
  });

  processed = processed.replace(
    HTML_DETAILS_REGEX,
    (_match, attrs: string, rawSummary: string, body: string) => {
      const isOpen = /\bopen\b/i.test(attrs);
      const fence = isOpen ? '```collapse-open' : '```collapse';
      const summary = rawSummary.replace(/<[^>]+>/g, '').trim() || 'Details';
      const trimmedBody = body.trim();

      return `${fence}\n${summary}\n${trimmedBody}\n\`\`\``;
    },
  );

  processed = processed.replace(/__DETAILS_CODE_BLOCK_(\d+)__/g, (_, index) => {
    return codeBlocks[parseInt(index, 10)];
  });

  return processed;
};

const MARKDOWN_LINK_WITH_SPACE_REGEX =
  /(!?\[[^\]]*\])\(([^)]*? [^)]*)\)/g;
const LINK_TITLE_REGEX = /^(.*?)\s+(["'])(.*)\2\s*$/;

/**
 * @deprecated Prefer `preprocessMarkdownForRender` from `@rebel/shared` which
 * wires `encodeSpacesInMarkdownLinks` + `remarkGfm` + the default plugin list
 * in one call. Direct callers risk drifting from the shared pipeline
 * (I10 consolidation). Kept exported for tests that exercise the preprocessor
 * in isolation — new surfaces should not call this directly.
 */
export const encodeSpacesInMarkdownLinks = (content: string): string => {
  if (!content.includes('](')) return content;

  const codeBlocks: string[] = [];
  let processed = content.replace(/```[\s\S]*?```/g, (match) => {
    const index = codeBlocks.length;
    codeBlocks.push(match);
    return `__SPACE_CODE_BLOCK_${index}__`;
  });

  const inlineCodes: string[] = [];
  processed = processed.replace(/`[^`\n]+`/g, (match) => {
    const index = inlineCodes.length;
    inlineCodes.push(match);
    return `__SPACE_INLINE_CODE_${index}__`;
  });

  MARKDOWN_LINK_WITH_SPACE_REGEX.lastIndex = 0;
  processed = processed.replace(
    MARKDOWN_LINK_WITH_SPACE_REGEX,
    (_, prefix, destination) => {
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(destination)) {
        return `${prefix}(${destination})`;
      }

      const titleMatch = destination.match(LINK_TITLE_REGEX);
      if (titleMatch) {
        const [, path, quote, title] = titleMatch;
        return `${prefix}(${path.replace(/ /g, '%20')} ${quote}${title}${quote})`;
      }

      return `${prefix}(${destination.replace(/ /g, '%20')})`;
    },
  );

  processed = processed.replace(/__SPACE_INLINE_CODE_(\d+)__/g, (_, index) => {
    return inlineCodes[parseInt(index, 10)];
  });

  processed = processed.replace(/__SPACE_CODE_BLOCK_(\d+)__/g, (_, index) => {
    return codeBlocks[parseInt(index, 10)];
  });

  return processed;
};

export const stripYamlFrontmatter = (content: string): string => {
  if (!content.startsWith('---')) return content;

  const match = content.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
  if (!match) {
    const endIndex = content.indexOf('\n---', 3);
    if (endIndex === -1) return content;
    return content.slice(endIndex + 4).trimStart();
  }

  return content.slice(match[0].length);
};

export const extractYamlFrontmatterFields = (
  content: string,
): Record<string, string | string[] | number | boolean> | null => {
  if (!content.startsWith('---')) return null;

  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yamlBlock = match[1];
  const fields: Record<string, string | string[] | number | boolean> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of yamlBlock.split('\n')) {
    const listItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (listItemMatch && currentKey && currentList) {
      currentList.push(listItemMatch[1].replace(/^["']|["']$/g, '').trim());
      continue;
    }

    if (currentKey && currentList) {
      fields[currentKey] = currentList;
      currentKey = null;
      currentList = null;
    }

    const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const rawValue = kvMatch[2].trim();

    if (!rawValue) {
      currentKey = key;
      currentList = [];
      continue;
    }

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const items = rawValue
        .slice(1, -1)
        .split(',')
        .map((item) => item.replace(/^["'\s]+|["'\s]+$/g, '').trim())
        .filter(Boolean);
      fields[key] = items;
      continue;
    }

    if (rawValue === 'true') {
      fields[key] = true;
      continue;
    }
    if (rawValue === 'false') {
      fields[key] = false;
      continue;
    }

    if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
      fields[key] = Number(rawValue);
      continue;
    }

    fields[key] = rawValue.replace(/^["']|["']$/g, '');
  }

  if (currentKey && currentList) {
    fields[currentKey] = currentList;
  }

  return Object.keys(fields).length > 0 ? fields : null;
};
