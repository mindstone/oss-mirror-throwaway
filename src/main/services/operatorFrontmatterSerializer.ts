import { Document, parseDocument, isCollection, isMap, isSeq } from 'yaml';

const FRONTMATTER_DELIMITER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u;

export interface ParsedOperatorMarkdown {
  document: Document.Parsed;
  body: string;
}

export interface MutateFrontmatterApi {
  set(key: string, value: unknown): void;
  delete(key: string): void;
  has(key: string): boolean;
  get<T = unknown>(key: string): T | undefined;
}

/**
 * Splits OPERATOR.md into a YAML Document (preserving formatting/comments
 * where the `yaml` library can) and a body string. If the file has no
 * frontmatter delimiters, returns an empty document and the full content as
 * the body.
 */
export function parseOperatorMarkdown(content: string): ParsedOperatorMarkdown {
  const match = FRONTMATTER_DELIMITER_RE.exec(content);
  if (!match) {
    return { document: parseDocument(''), body: content };
  }
  const document = parseDocument(match[1] ?? '', { keepSourceTokens: true });
  const body = match[2] ?? '';
  return { document, body };
}

function applyMutationToDocument(document: Document.Parsed, mutate: (api: MutateFrontmatterApi) => void): void {
  if (!isCollection(document.contents) || !isMap(document.contents)) {
    document.contents = document.createNode({}) as unknown as typeof document.contents;
  }
  const api: MutateFrontmatterApi = {
    set(key: string, value: unknown): void {
      if (Array.isArray(value)) {
        const existingNode = document.get(key, true);
        const wasFlow = isSeq(existingNode) && existingNode.flow === true;
        const newSeq = document.createNode(value) as ReturnType<Document.Parsed['createNode']>;
        if (isSeq(newSeq) && wasFlow) {
          newSeq.flow = true;
        }
        document.set(key, newSeq);
        return;
      }
      document.set(key, value);
    },
    delete(key: string): void {
      document.delete(key);
    },
    has(key: string): boolean {
      return document.has(key);
    },
    get<T = unknown>(key: string): T | undefined {
      return document.get(key) as T | undefined;
    },
  };
  mutate(api);
}

/**
 * Serializes the document + body back to OPERATOR.md text, preserving as
 * much of the original YAML structure (comments, block-vs-flow style,
 * field order, scalar quoting) as the `yaml` library can.
 */
export function serializeOperatorMarkdown(parsed: ParsedOperatorMarkdown): string {
  const yamlText = parsed.document.toString({ lineWidth: 0 }).replace(/\n+$/u, '\n');
  const trimmedYaml = yamlText.endsWith('\n') ? yamlText : `${yamlText}\n`;
  const normalizedBody = parsed.body.replace(/^\r?\n/u, '');
  if (normalizedBody.length === 0) {
    return `---\n${trimmedYaml}---\n`;
  }
  return `---\n${trimmedYaml}---\n${normalizedBody}`;
}

/**
 * Parse, mutate and serialize an OPERATOR.md document in one round-trip.
 * Frontmatter formatting (block-style arrays, comments, field order, scalar
 * quoting) is preserved by relying on the `yaml` library's Document API.
 */
export function mutateOperatorMarkdown(
  content: string,
  mutate: (api: MutateFrontmatterApi) => void,
): string {
  const parsed = parseOperatorMarkdown(content);
  applyMutationToDocument(parsed.document, mutate);
  return serializeOperatorMarkdown(parsed);
}

/**
 * Read attributes from the parsed OPERATOR.md frontmatter as a plain
 * JS object. Useful for service code that needs to inspect existing values
 * without taking a dependency on the `yaml` Document API.
 */
export function readOperatorAttributes(content: string): Record<string, unknown> {
  const parsed = parseOperatorMarkdown(content);
  const attributes = parsed.document.toJS({ maxAliasCount: -1 }) as Record<string, unknown> | null;
  return attributes && typeof attributes === 'object' ? attributes : {};
}
