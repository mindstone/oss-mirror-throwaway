export interface ExtractedUrl {
  /** The full URL as found in the message */
  url: string;
  /** The domain (e.g., "docs.google.com") */
  domain: string;
  /** The full regex match string */
  fullMatch: string;
}

const RAW_URL_REGEX = /\b(?:https?:\/\/|file:\/\/\/)[^\s<>"']+/gi;
const MARKDOWN_LINK_REGEX = /\[[^\]]*]\(([^)\s]+)\)/g;
const TRAILING_CHARS_TO_TRIM = new Set(['.', ',', ':', ';', '!', '?', '"', "'", ']', '}', '>']);

const countChar = (value: string, char: string): number => {
  let count = 0;
  for (const currentChar of value) {
    if (currentChar === char) {
      count += 1;
    }
  }
  return count;
};

const trimTrailingUrlPunctuation = (value: string): string => {
  let trimmed = value.trim();

  while (trimmed.length > 0) {
    const lastChar = trimmed.at(-1);
    if (!lastChar) {
      break;
    }

    if (TRAILING_CHARS_TO_TRIM.has(lastChar)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }

    if (lastChar === ')') {
      const openParens = countChar(trimmed, '(');
      const closeParens = countChar(trimmed, ')');
      if (closeParens > openParens) {
        trimmed = trimmed.slice(0, -1);
        continue;
      }
    }

    break;
  }

  return trimmed;
};

const toExtractedUrl = (rawUrl: string, fullMatch: string): ExtractedUrl | null => {
  const candidateUrl = trimTrailingUrlPunctuation(rawUrl);
  if (!candidateUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(candidateUrl);
    const protocol = parsedUrl.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'file:') {
      return null;
    }

    const domain = protocol === 'file:' ? 'file' : parsedUrl.hostname.toLowerCase();
    if (!domain) {
      return null;
    }

    return {
      url: candidateUrl,
      domain,
      fullMatch,
    };
  } catch {
    return null;
  }
};

/** Extract URLs from a user message. Handles https://, http://, and markdown link syntax. */
export function extractUrls(message: string): ExtractedUrl[] {
  if (!message) {
    return [];
  }

  const extractedUrls: ExtractedUrl[] = [];
  const seenUrls = new Set<string>();

  for (const markdownMatch of message.matchAll(MARKDOWN_LINK_REGEX)) {
    const markdownUrl = markdownMatch[1];
    if (!markdownUrl) {
      continue;
    }
    const extractedUrl = toExtractedUrl(markdownUrl, markdownMatch[0]);
    if (!extractedUrl || seenUrls.has(extractedUrl.url)) {
      continue;
    }
    seenUrls.add(extractedUrl.url);
    extractedUrls.push(extractedUrl);
  }

  for (const urlMatch of message.matchAll(RAW_URL_REGEX)) {
    const rawUrl = urlMatch[0];
    const extractedUrl = toExtractedUrl(rawUrl, rawUrl);
    if (!extractedUrl || seenUrls.has(extractedUrl.url)) {
      continue;
    }
    seenUrls.add(extractedUrl.url);
    extractedUrls.push(extractedUrl);
  }

  return extractedUrls;
}

/** Map a domain to a human-readable service hint for tool search enrichment. */
export const getDomainSearchHint = (domain: string): string => {
  if (domain === 'docs.google.com') {
    return 'Google Docs document reader';
  }
  if (domain === 'notion.so' || domain === 'www.notion.so' || domain.endsWith('.notion.site')) {
    return 'Notion page reader';
  }
  if (domain === 'linear.app') {
    return 'Linear issue tracker';
  }
  if (domain.endsWith('.slack.com')) {
    return 'Slack message reader';
  }
  if (domain === 'github.com') {
    return 'GitHub repository';
  }
  if (domain === 'figma.com' || domain === 'www.figma.com') {
    return 'Figma design file';
  }
  if (domain.endsWith('.atlassian.net')) {
    return 'Atlassian (Jira/Confluence)';
  }
  if (domain.endsWith('.salesforce.com')) {
    return 'Salesforce record';
  }
  return domain;
};

/** Generate domain-based search hints for tool search enrichment. */
export function enrichToolSearchQuery(urls: ExtractedUrl[]): string {
  if (urls.length === 0) {
    return '';
  }

  const hints: string[] = [];
  const seenHints = new Set<string>();

  for (const url of urls) {
    const hint = getDomainSearchHint(url.domain.toLowerCase());
    if (seenHints.has(hint)) {
      continue;
    }
    seenHints.add(hint);
    hints.push(hint);
  }

  return hints.join(', ');
}

/**
 * Sanitize a text string for vector embedding by replacing raw URLs with
 * service hints. This prevents URL tokens from diluting the embedding —
 * "Notion page" is a much better embedding query for finding `notion-fetch`
 * than `https://www.notion.so/acme/Q3-Competitive-Strategy-54f0c9...`.
 *
 * Returns the original text unchanged if no URLs are found.
 */
export function sanitizeUrlsForEmbedding(text: string): string {
  const urls = extractUrls(text);
  if (urls.length === 0) return text;

  let sanitized = text;
  const hints: string[] = [];
  const seenHints = new Set<string>();

  for (const extracted of urls) {
    // Remove all occurrences of the URL (extractUrls deduplicates, so the same
    // URL might appear multiple times in text — e.g., raw + markdown reference)
    sanitized = sanitized.replaceAll(extracted.fullMatch, ' ');

    // Add a service hint (deduplicated)
    const hint = getDomainSearchHint(extracted.domain.toLowerCase());
    if (!seenHints.has(hint)) {
      seenHints.add(hint);
      hints.push(hint);
    }
  }

  // Append service hints and clean up whitespace
  const result = [sanitized, ...hints].join(' ').replace(/\s+/g, ' ').trim();
  return result || text;
}
