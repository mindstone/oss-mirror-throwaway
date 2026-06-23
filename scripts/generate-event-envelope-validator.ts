#!/usr/bin/env npx tsx
/**
 * Stage 0.B: auto-generate cloud-client/src/utils/eventEnvelopeValidator.generated.ts
 * from src/shared/ipc/schemas/agent.ts.
 *
 * The hand-maintained KNOWN_AGENT_EVENT_TYPES list was the single biggest silent-
 * drift class identified in docs/plans/260516_cross_surface_centralization.md:
 * new event variants would land in the Zod schema but fail to register here,
 * causing mobile / web clients to drop them as `unknown-type`. This generator
 * extracts the discriminator literals straight from the Zod schema's source so
 * the generated file is always in sync.
 *
 * Approach: source-text scan (not runtime import) because the Zod schema
 * imports cross-package path aliases (@rebel/shared, etc.) that tsx does not
 * resolve when this script is invoked outside the build context. A simple
 * `type: z.literal('...')` regex against the AgentEventSchema block is
 * deterministic, robust against Zod-internal API changes, and avoids the
 * path-resolution complexity of a runtime import.
 *
 * Run modes:
 *   tsx scripts/generate-event-envelope-validator.ts          # write or update
 *   tsx scripts/generate-event-envelope-validator.ts --check  # CI: fail if stale
 *
 * Wired into validate:fast as `validate:event-envelope-codegen`.
 *
 * @see docs/plans/260516_cross_surface_centralization.md (Stage 0.B)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'src/shared/ipc/schemas/agent.ts');
const GENERATED_PATH = path.join(
  REPO_ROOT,
  'cloud-client/src/utils/eventEnvelopeValidator.generated.ts',
);

const SCHEMA_NAME = 'AgentEventSchema';
/**
 * The discriminator-level `type: z.literal(...)` lives at paren-depth 2 relative
 * to the outer `z.discriminatedUnion(` (1 for the union, +1 for each `z.object(`).
 * Anything deeper is a nested literal (e.g. `imageContent: z.array(z.object({ type: z.literal('image') }))`)
 * and must NOT be treated as a discriminator value.
 */
const DISCRIMINATOR_PAREN_DEPTH = 2;
const TYPE_LITERAL_PATTERN = /\btype:\s*z\.literal\(\s*['"]([^'"]+)['"]\s*\)/g;

interface GenerateOptions {
  readonly checkOnly: boolean;
}

function parseArgs(argv: readonly string[]): GenerateOptions {
  return { checkOnly: argv.includes('--check') };
}

/**
 * Extract the source-text span containing `export const AgentEventSchema = z.discriminatedUnion(...)`.
 * Tracks paren/bracket depth so we capture the whole expression, including any `.and(...)`
 * intersection tail (which is irrelevant for our discriminator scan but helps make
 * the span boundaries unambiguous).
 */
function extractSchemaSourceSpan(source: string): string {
  const declarationMarker = `export const ${SCHEMA_NAME}`;
  const declarationIndex = source.indexOf(declarationMarker);
  if (declarationIndex < 0) {
    throw new Error(
      `Could not find \`${declarationMarker}\` in ${path.relative(REPO_ROOT, SCHEMA_PATH)}. ` +
        'The codegen depends on this declaration; update generate-event-envelope-validator.ts when it moves.',
    );
  }

  const unionMarkerOffset = source.indexOf('z.discriminatedUnion', declarationIndex);
  if (unionMarkerOffset < 0) {
    throw new Error(
      `Could not find \`z.discriminatedUnion\` after \`${SCHEMA_NAME}\`. The codegen assumes ` +
        'AgentEventSchema is built from a discriminated union and must be updated if that changes.',
    );
  }

  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  let scanIndex = source.indexOf('(', unionMarkerOffset);
  if (scanIndex < 0) {
    throw new Error('Malformed discriminatedUnion(...) — no opening paren found.');
  }
  const start = scanIndex;

  for (; scanIndex < source.length; scanIndex += 1) {
    const ch = source[scanIndex];
    const next = source[scanIndex + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        scanIndex += 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      scanIndex += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      scanIndex += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, scanIndex + 1);
      }
    }
  }

  throw new Error('Unbalanced parens in AgentEventSchema source; cannot extract discriminator span.');
}

interface AnalyzedSpan {
  /**
   * Original span text with COMMENT contents replaced by spaces (offsets
   * preserved). String contents are kept intact so the discriminator regex
   * can capture `z.literal('value')` arguments — we instead protect against
   * literal-looking strings via the `isCodePosition` array.
   */
  readonly cleanedText: string;
  /** Paren depth at each character position, comment/string-aware. */
  readonly depth: Int32Array;
  /** True iff the position is real code (not inside a comment OR string). */
  readonly isCodePosition: Uint8Array;
  /**
   * Number of distinct, non-empty entries in the discriminated-union top-level
   * `[...]` array. Counted by walking the array at bracket-depth 1 and
   * paren-depth 1, splitting on commas, and filtering out empty entries
   * (trailing commas). Any entry that is NOT an inline `z.object(...)` (e.g.
   * a named schema reference like `StatusEventSchema`, an `.extend()` chain,
   * or an imported variant) makes this counter diverge from the discriminator
   * literal count — at which point we fail closed because the source-scan
   * generator cannot statically introspect what the named schema resolves to.
   */
  readonly arrayEntryCount: number;
}

function analyzeSpan(span: string): AnalyzedSpan {
  const depth = new Int32Array(span.length);
  const bracketDepth = new Int32Array(span.length);
  const isCodePosition = new Uint8Array(span.length);
  const cleanedChars: string[] = new Array(span.length);
  let currentParen = 0;
  let currentBracket = 0;
  let inString: '"' | "'" | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < span.length; i += 1) {
    const ch = span[i];
    const next = span[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        cleanedChars[i] = '\n';
      } else {
        cleanedChars[i] = ' ';
      }
      depth[i] = currentParen;
      bracketDepth[i] = currentBracket;
      continue;
    }
    if (inBlockComment) {
      cleanedChars[i] = ch === '\n' ? '\n' : ' ';
      depth[i] = currentParen;
      bracketDepth[i] = currentBracket;
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
        cleanedChars[i] = ' ';
        depth[i] = currentParen;
        bracketDepth[i] = currentBracket;
      }
      continue;
    }
    if (inString) {
      cleanedChars[i] = ch;
      depth[i] = currentParen;
      bracketDepth[i] = currentBracket;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      cleanedChars[i] = ' ';
      depth[i] = currentParen;
      bracketDepth[i] = currentBracket;
      i += 1;
      cleanedChars[i] = ' ';
      depth[i] = currentParen;
      bracketDepth[i] = currentBracket;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      cleanedChars[i] = ' ';
      depth[i] = currentParen;
      bracketDepth[i] = currentBracket;
      i += 1;
      cleanedChars[i] = ' ';
      depth[i] = currentParen;
      bracketDepth[i] = currentBracket;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      cleanedChars[i] = ch;
      depth[i] = currentParen;
      bracketDepth[i] = currentBracket;
      isCodePosition[i] = 1;
      continue;
    }
    if (ch === '(') {
      currentParen += 1;
    } else if (ch === ')') {
      currentParen -= 1;
    } else if (ch === '[') {
      currentBracket += 1;
    } else if (ch === ']') {
      currentBracket -= 1;
    }
    cleanedChars[i] = ch;
    depth[i] = currentParen;
    bracketDepth[i] = currentBracket;
    isCodePosition[i] = 1;
  }

  const arrayEntryCount = countTopLevelArrayEntries({
    cleanedText: cleanedChars.join(''),
    depth,
    bracketDepth,
    isCodePosition,
  });

  return {
    cleanedText: cleanedChars.join(''),
    depth,
    isCodePosition,
    arrayEntryCount,
  };
}

/**
 * Walk the cleaned span at paren-depth 1 and bracket-depth 1 (i.e. inside the
 * discriminated-union outermost array) and split on commas to count entries.
 * Empty entries (trailing commas, whitespace-only) are filtered out so the
 * caller can compare directly against the discriminator literal count.
 */
function countTopLevelArrayEntries(args: {
  readonly cleanedText: string;
  readonly depth: Int32Array;
  readonly bracketDepth: Int32Array;
  readonly isCodePosition: Uint8Array;
}): number {
  const { cleanedText, depth, bracketDepth, isCodePosition } = args;
  const segments: string[] = [];
  let buffer = '';

  for (let i = 0; i < cleanedText.length; i += 1) {
    const ch = cleanedText[i];
    const inDiscriminatorArray = depth[i] === 1 && bracketDepth[i] === 1 && isCodePosition[i] === 1;
    if (!inDiscriminatorArray) continue;
    if (ch === ',') {
      segments.push(buffer);
      buffer = '';
      continue;
    }
    if (ch === '[' || ch === ']') continue;
    buffer += ch;
  }
  if (buffer.length > 0) segments.push(buffer);

  return segments.filter(segment => segment.trim().length > 0).length;
}

function extractTypeLiterals(span: string): readonly string[] {
  const collected = new Set<string>();
  const analyzed = analyzeSpan(span);
  let skippedNested = 0;
  let skippedInNonCode = 0;

  for (const match of analyzed.cleanedText.matchAll(TYPE_LITERAL_PATTERN)) {
    const matchIndex = match.index ?? -1;
    if (matchIndex < 0) continue;
    const value = match[1];
    if (value.length === 0) {
      throw new Error('Found empty `type: z.literal("")` — unexpected in AgentEventSchema.');
    }
    if (!analyzed.isCodePosition[matchIndex]) {
      skippedInNonCode += 1;
      continue;
    }
    if (analyzed.depth[matchIndex] !== DISCRIMINATOR_PAREN_DEPTH) {
      skippedNested += 1;
      continue;
    }
    collected.add(value);
  }

  if (collected.size === 0) {
    throw new Error(
      `No \`type: z.literal(...)\` matches at depth ${DISCRIMINATOR_PAREN_DEPTH} inside AgentEventSchema span ` +
        `(skipped ${skippedNested} nested + ${skippedInNonCode} non-code match(es)); schema structure may have changed.`,
    );
  }

  if (analyzed.arrayEntryCount !== collected.size) {
    throw new Error(
      `Top-level union-member count (${analyzed.arrayEntryCount} array entries) does not match discriminator ` +
        `literal count (${collected.size}). This usually means a union member was refactored into a named schema, ` +
        '.extend() chain, or imported variant — patterns the source-scan generator cannot statically introspect. ' +
        'Either inline the variant into AgentEventSchema or upgrade the generator to runtime-import the Zod schema.',
    );
  }

  return [...collected].sort((a, b) => a.localeCompare(b));
}

function renderGeneratedFile(types: readonly string[]): string {
  const lines: string[] = [
    '/* eslint-disable -- generated file; do not hand-edit. Run `npx tsx scripts/generate-event-envelope-validator.ts` to refresh. */',
    '/**',
    ' * AUTO-GENERATED — Stage 0.B (cross-surface centralization).',
    ' *',
    ' * Source: src/shared/ipc/schemas/agent.ts (`AgentEventSchema` discriminator literals).',
    ' * Generator: scripts/generate-event-envelope-validator.ts',
    ' *',
    ' * Adding new event types: add the variant to AgentEventSchema and rerun the',
    ' * generator (or let validate:fast catch the drift). DO NOT edit this file',
    ' * directly — your edits will be overwritten.',
    ' */',
    '',
    'export const GENERATED_KNOWN_AGENT_EVENT_TYPES: ReadonlySet<string> = new Set([',
    ...types.map(value => `  ${JSON.stringify(value)},`),
    ']);',
    '',
  ];
  return lines.join('\n');
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const source = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const span = extractSchemaSourceSpan(source);
  const types = extractTypeLiterals(span);
  const nextContent = renderGeneratedFile(types);

  if (options.checkOnly) {
    let existing = '';
    try {
      existing = fs.readFileSync(GENERATED_PATH, 'utf8');
    } catch {
      process.stderr.write(
        `[generate-event-envelope-validator] FAIL: generated file missing at ${path.relative(REPO_ROOT, GENERATED_PATH)}\n`,
      );
      return 1;
    }
    if (existing !== nextContent) {
      process.stderr.write(
        '[generate-event-envelope-validator] FAIL: generated file is stale. ' +
          'Run `npx tsx scripts/generate-event-envelope-validator.ts` to refresh.\n',
      );
      return 1;
    }
    process.stdout.write(
      `[generate-event-envelope-validator] OK: ${types.length} event type(s) in sync.\n`,
    );
    return 0;
  }

  fs.writeFileSync(GENERATED_PATH, nextContent, 'utf8');
  process.stdout.write(
    `[generate-event-envelope-validator] wrote ${types.length} event type(s) to ` +
      `${path.relative(REPO_ROOT, GENERATED_PATH)}\n`,
  );
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  process.stderr.write(
    `[generate-event-envelope-validator] ERROR: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
