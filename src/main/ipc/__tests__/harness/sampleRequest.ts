/**
 * Stage-4 (DEMOTED): bounded Zod fixture sampler — a *fixture source* for the
 * harness driver, NOT the request-side guarantee.
 *
 * ## Role under shape C+
 * The request-side contract guarantee lives at the **Stage-2 seam decorator**
 * (`registerContractHandler.ts`), which `request.parse`-es the live input at the
 * registration chokepoint. This sampler's only job is to produce **a** smallest
 * value that PASSES `schema.parse`, so the Stage-5 driver has a contract-valid
 * payload to drive each channel through the real preload → transport → seam path
 * (`sampleRequest`), and a contract-valid response fixture to stub channels that
 * are NOT on the `EXECUTE_SAFE` allowlist (parse-only mode, `sampleResponse`).
 *
 * ## Design constraints (measured against the real channel population — testability F2)
 * A *naive* min-valid sampler (`string→''`, `number→0`, `array→[]`, `union→first
 * option`) fails `schema.parse` on the real corpus: `.min(` ×126, `.int(` ×49,
 * `.positive(` ×14, string formats (`.email`/`.uuid`/`.url`/`.regex`), cross-field
 * `.refine`, `z.lazy` recursion (`JsonValueSchema`), and `discriminatedUnion` /
 * `transform` (which report as `union` / `pipe`). This sampler therefore:
 *   - reads numeric `.min/.max/.int/.positive/.multipleOf` checks and emits a
 *     satisfying number;
 *   - reads string `.min/.max/.length` and known formats and emits a satisfying
 *     string (`'[external-email]'` for email, a nil-UUID for uuid, …);
 *   - for `union`/`discriminatedUnion` **tries options until one parses** (does
 *     NOT blindly take the first);
 *   - samples the **input** of a `pipe`/`transform` (Zod 4 `def.in` ≈ `z.input`),
 *     never the post-transform output;
 *   - depth-caps `z.lazy` recursion (e.g. `JsonValueSchema`) so it terminates;
 *   - unwraps `optional`/`nullable`/`default`/`catch`/`nullish`;
 *   - includes object **required keys only** (skips keys that accept `undefined`).
 *
 * ## Self-validation — never silently wrong
 * Every produced sample is run back through `schema.parse` inside the generator.
 * On failure it throws a named {@link SampleValidationError} (loud) — it never
 * catch-and-skips. A schema the sampler cannot construct a value for throws a
 * named {@link UnsampleableSchemaError}. Channels that hit either are routed to
 * the curated `requestOverrides` / `UNSAMPLEABLE` map — never silently skipped.
 *
 * No external sampler dependency: pure Zod-4 introspection via `schema._zod.def`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Named errors — loud failure modes (never catch-and-skip)
// ---------------------------------------------------------------------------

/** Thrown when the sampler cannot construct a value for a schema node (unknown/unsupported type, lazy depth exhausted with no base case, no union option parses). */
export class UnsampleableSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsampleableSchemaError';
  }
}

/** Thrown when a produced sample fails the schema's own `.parse` (the self-validation backstop). */
export class SampleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SampleValidationError';
  }
}

// ---------------------------------------------------------------------------
// Zod-4 introspection helpers
// ---------------------------------------------------------------------------

/** Minimal structural view of a Zod 4 schema's internal def. */
interface ZodDef {
  type: string;
  // shared / per-type fields, read defensively
  checks?: Array<{ _zod?: { def?: Record<string, unknown> } }>;
  innerType?: AnyZod;
  element?: AnyZod;
  items?: AnyZod[];
  rest?: AnyZod | null;
  keyType?: AnyZod;
  valueType?: AnyZod;
  options?: AnyZod[];
  shape?: Record<string, AnyZod>;
  values?: unknown[];
  entries?: Record<string, unknown>;
  getter?: () => AnyZod;
  in?: AnyZod;
  format?: string;
  defaultValue?: unknown;
  [k: string]: unknown;
}

type AnyZod = z.ZodTypeAny & { _zod?: { def?: ZodDef } };

function getDef(schema: AnyZod): ZodDef | undefined {
  return schema?._zod?.def;
}

/** Each `check`'s payload lives at `check._zod.def`. */
function checkDefs(def: ZodDef): Array<Record<string, unknown>> {
  return (def.checks ?? [])
    .map((c) => c._zod?.def)
    .filter((d): d is Record<string, unknown> => Boolean(d));
}

const MAX_LAZY_DEPTH = 4;

// ---------------------------------------------------------------------------
// Per-type samplers
// ---------------------------------------------------------------------------

function sampleString(def: ZodDef): string {
  // Top-level string format (z.email()/z.uuid()/z.url()/z.iso.datetime() …)
  const known = knownFormatSample(def.format);
  if (known !== undefined) {
    return known;
  }

  let minLen = 0;
  let maxLen = Infinity;
  let exactLen: number | undefined;
  let prefix = '';
  let suffix = '';
  let formatSample: string | undefined;
  let regexSrc: { source: string } | undefined;

  for (const c of checkDefs(def)) {
    const check = c.check as string | undefined;
    if (check === 'min_length') minLen = Math.max(minLen, c.minimum as number);
    else if (check === 'max_length') maxLen = Math.min(maxLen, c.maximum as number);
    else if (check === 'length_equals') exactLen = c.length as number;
    else if (check === 'string_format') {
      const fmt = c.format as string | undefined;
      if (fmt === 'starts_with') prefix = (c.prefix as string) ?? '';
      else if (fmt === 'ends_with') suffix = (c.suffix as string) ?? '';
      else if (fmt === 'regex') regexSrc = c.pattern as { source: string } | undefined;
      else {
        const ks = knownFormatSample(fmt);
        if (ks !== undefined) formatSample = ks;
      }
    }
  }

  if (formatSample !== undefined) return formatSample;
  if (regexSrc !== undefined) {
    const fromRe = sampleFromRegex(regexSrc.source);
    if (fromRe !== undefined) return fromRe;
    throw new UnsampleableSchemaError(`string with un-sampleable regex /${regexSrc.source}/`);
  }

  // Build prefix+filler+suffix satisfying length bounds.
  if (exactLen !== undefined) {
    const fill = Math.max(0, exactLen - prefix.length - suffix.length);
    return (prefix + 'a'.repeat(fill) + suffix).slice(0, exactLen);
  }
  const baseLen = prefix.length + suffix.length;
  const need = Math.max(minLen, baseLen);
  const fill = Math.max(0, need - baseLen);
  const out = prefix + 'a'.repeat(fill) + suffix;
  if (out.length > maxLen) {
    throw new UnsampleableSchemaError(`string length bounds unsatisfiable (min ${minLen} > max ${maxLen})`);
  }
  return out;
}

/** Known string-format samples that satisfy Zod's format validators. */
function knownFormatSample(format: string | undefined): string | undefined {
  switch (format) {
    case 'email':
      return '[external-email]';
    case 'uuid':
    case 'guid':
      return '00000000-0000-4000-8000-000000000000';
    case 'url':
      return 'https://example.com';
    case 'cuid':
      return 'cjld2cjxh0000qzrmn831i7rn';
    case 'cuid2':
      return 'tz4a98xxat96iws9zmbrgj3a';
    case 'ulid':
      return '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    case 'nanoid':
      return 'V1StGXR8_Z5jdHi6B-myT';
    case 'datetime':
      return '1970-01-01T00:00:00Z';
    case 'date':
      return '1970-01-01';
    case 'time':
      return '00:00:00';
    case 'duration':
      return 'P1D';
    case 'ipv4':
      return '127.0.0.1';
    case 'ipv6':
      return '::1';
    case 'emoji':
      return '\u{1F600}';
    case 'base64':
      return 'YQ==';
    case 'e164':
      return '+15555555555';
    default:
      return undefined;
  }
}

/**
 * Best-effort anchored-regex sampler for the simple slug/identifier patterns
 * that appear in the channel corpus (e.g. `^[a-z0-9][a-z0-9-]*$`,
 * `^(?:__)?[a-z0-9-]+$`, `^[a-z]{3}$`). It walks the pattern's top-level tokens,
 * emitting the minimal contribution of each, then **verifies** the result
 * against the live regex (so an over-simplistic walk can never produce a
 * non-matching string — it returns undefined → caller routes to an override).
 */
function sampleFromRegex(source: string): string | undefined {
  let body = source;
  if (body.startsWith('^')) body = body.slice(1);
  if (body.endsWith('$')) body = body.slice(0, -1);

  const built = buildFromRegexBody(body);
  if (built === undefined) return undefined;
  // Verify against the real regex (anchored).
  const re = new RegExp(`^(?:${body})$`);
  return re.test(built) ? built : undefined;
}

/**
 * Walk top-level regex tokens, emitting each token's minimal match. Supports:
 * literals, char-classes `[...]` with optional `{n}`/`{n,m}`/`*`/`+`/`?`
 * quantifiers, and non-capturing optional groups `(?:...)?` (contributes
 * nothing). Returns undefined on anything it doesn't recognise (alternation,
 * backrefs, lookahead, capturing groups, …).
 */
function buildFromRegexBody(body: string): string | undefined {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '[') {
      const close = body.indexOf(']', i + 1);
      if (close === -1) return undefined;
      const cls = body.slice(i + 1, close);
      i = close + 1;
      const { min } = readQuantifier(body, i);
      i += quantifierLength(body, i);
      const sample = pickClassChar(cls);
      if (sample === undefined) return undefined;
      out += sample.repeat(min);
    } else if (ch === '(') {
      // Only support `(?:...)?` optional non-capturing groups → contribute nothing.
      if (body.slice(i, i + 3) !== '(?:') return undefined;
      const close = matchParen(body, i);
      if (close === -1) return undefined;
      const after = body[close + 1];
      if (after !== '?' && after !== '*') return undefined; // only optional groups
      i = close + 2;
    } else if ('\\^$.*+?{}|'.includes(ch)) {
      // A bare metacharacter we don't model → bail.
      if (ch === '\\') {
        // escaped literal
        const lit = body[i + 1];
        if (lit === undefined) return undefined;
        out += lit;
        i += 2;
        continue;
      }
      return undefined;
    } else {
      // plain literal, honour a following quantifier's minimum
      i += 1;
      const { min } = readQuantifier(body, i);
      const qlen = quantifierLength(body, i);
      i += qlen;
      out += ch.repeat(min);
    }
  }
  return out;
}

/** Minimal count for a quantifier starting at `i` (`*`→0, `+`→1, `?`→0, `{n}`→n, `{n,m}`→n, none→1). */
function readQuantifier(body: string, i: number): { min: number } {
  const ch = body[i];
  if (ch === '*' || ch === '?') return { min: 0 };
  if (ch === '+') return { min: 1 };
  if (ch === '{') {
    const close = body.indexOf('}', i);
    if (close !== -1) {
      const n = parseInt(body.slice(i + 1, close), 10);
      if (!Number.isNaN(n)) return { min: n };
    }
  }
  return { min: 1 };
}

function quantifierLength(body: string, i: number): number {
  const ch = body[i];
  if (ch === '*' || ch === '+' || ch === '?') return 1;
  if (ch === '{') {
    const close = body.indexOf('}', i);
    return close === -1 ? 0 : close - i + 1;
  }
  return 0;
}

function matchParen(body: string, open: number): number {
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function pickClassChar(cls: string): string | undefined {
  if (cls.startsWith('^')) return undefined; // negated class: don't guess
  // Leading range like a-z / A-Z / 0-9 → its low bound.
  const range = cls.match(/^([a-zA-Z0-9])-([a-zA-Z0-9])/);
  if (range) return range[1];
  // Otherwise first literal char that isn't a range marker.
  const first = cls[0];
  return first === '-' ? undefined : first;
}

function sampleNumber(def: ZodDef): number {
  let min = -Infinity;
  let max = Infinity;
  let isInt = false;
  let multipleOf: number | undefined;

  for (const c of checkDefs(def)) {
    const check = c.check as string | undefined;
    if (check === 'greater_than') {
      const v = c.value as number;
      min = Math.max(min, c.inclusive ? v : v + (isInt ? 1 : 1e-6));
      if (!c.inclusive) {
        // exclusive lower bound — record the raw value too for int bump below
        min = Math.max(min, c.inclusive ? v : nextAbove(v));
      }
    } else if (check === 'less_than') {
      const v = c.value as number;
      max = Math.min(max, c.inclusive ? v : v - (isInt ? 1 : 1e-6));
    } else if (check === 'number_format' && (c.format === 'safeint' || c.format === 'int32' || c.format === 'uint32')) {
      isInt = true;
    } else if (check === 'multiple_of') {
      multipleOf = c.value as number;
    }
  }

  let candidate = 0;
  if (min > candidate) candidate = min;
  if (candidate > max) candidate = max;

  if (isInt) {
    candidate = Math.ceil(candidate);
    if (candidate > max) candidate = Math.floor(max);
  }
  if (multipleOf !== undefined && multipleOf !== 0) {
    const up = Math.ceil(candidate / multipleOf) * multipleOf;
    candidate = up <= max ? up : Math.floor(candidate / multipleOf) * multipleOf;
  }
  if (candidate < min || candidate > max) {
    throw new UnsampleableSchemaError(`number bounds unsatisfiable (min ${min}, max ${max}, int=${isInt})`);
  }
  return candidate;
}

function nextAbove(v: number): number {
  return v + 1e-6;
}

function sampleArray(_schema: AnyZod, def: ZodDef, depth: number): unknown[] {
  let minItems = 0;
  for (const c of checkDefs(def)) {
    if (c.check === 'min_length') minItems = Math.max(minItems, c.minimum as number);
  }
  if (minItems === 0) return [];
  const element = def.element as AnyZod;
  const out: unknown[] = [];
  for (let i = 0; i < minItems; i++) {
    out.push(sampleNode(element, depth + 1));
  }
  return out;
}

function sampleObject(def: ZodDef, depth: number): Record<string, unknown> {
  const shape = def.shape ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(shape)) {
    // Skip keys that accept `undefined` (optional / default / catch / nullish):
    // required-keys-only is the smallest passing object.
    if (acceptsUndefined(child)) continue;
    out[key] = sampleNode(child, depth + 1);
  }
  return out;
}

function acceptsUndefined(schema: AnyZod): boolean {
  return schema.safeParse(undefined).success;
}

/**
 * Smallest record is `{}` for a string-keyed record. But Zod 4 treats a record
 * with an **enum/literal key type as EXHAUSTIVE** — every key must be present
 * (e.g. `usage:get-cost-waterfall`'s `z.record(OutcomeEnum, BucketSchema)`), so
 * `{}` would fail. Detect that and materialise every key.
 */
function sampleRecord(def: ZodDef, depth: number): Record<string, unknown> {
  const keyType = def.keyType as AnyZod | undefined;
  const valueType = def.valueType as AnyZod | undefined;
  const keyDef = keyType ? getDef(keyType) : undefined;

  let keys: string[] | undefined;
  if (keyDef?.type === 'enum') {
    keys = Object.values(keyDef.entries ?? {}).map(String);
  } else if (keyDef?.type === 'literal') {
    keys = (keyDef.values ?? []).map(String);
  }

  if (keys && keys.length > 0 && valueType) {
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = sampleNode(valueType, depth + 1);
    return out;
  }
  // Open-keyed (string) record → smallest is empty.
  return {};
}

function sampleUnion(def: ZodDef, depth: number): unknown {
  const options = (def.options ?? []) as AnyZod[];
  let lastErr: unknown;
  // Try options until one yields a self-validating sample (don't blindly take first).
  for (const opt of options) {
    try {
      const candidate = sampleNode(opt, depth + 1);
      if (opt.safeParse(candidate).success) {
        return candidate;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw new UnsampleableSchemaError(
    `no union option produced a parseable sample (${options.length} options)${lastErr ? `; last error: ${String(lastErr)}` : ''}`,
  );
}

// ---------------------------------------------------------------------------
// Core recursive node sampler
// ---------------------------------------------------------------------------

function sampleNode(schema: AnyZod, depth: number): unknown {
  const def = getDef(schema);
  if (!def) {
    throw new UnsampleableSchemaError('schema has no Zod-4 def (not a Zod schema?)');
  }

  switch (def.type) {
    case 'string':
      return sampleString(def);
    case 'number':
      return sampleNumber(def);
    case 'boolean':
      return false;
    case 'bigint':
      return 0n;
    case 'date':
      return new Date(0);
    case 'nan':
      return NaN;
    case 'symbol':
      throw new UnsampleableSchemaError('symbol is not structured-cloneable / not a valid IPC payload');
    case 'undefined':
    case 'void':
      return undefined;
    case 'null':
      return null;
    case 'any':
    case 'unknown':
      return {};
    case 'literal': {
      const values = def.values ?? [];
      if (values.length === 0) throw new UnsampleableSchemaError('literal with no values');
      return values[0];
    }
    case 'enum': {
      const entries = Object.values(def.entries ?? {});
      if (entries.length === 0) throw new UnsampleableSchemaError('enum with no entries');
      return entries[0];
    }
    case 'object':
      return sampleObject(def, depth);
    case 'array':
      return sampleArray(schema, def, depth);
    case 'tuple': {
      const items = (def.items ?? []) as AnyZod[];
      return items.map((it) => sampleNode(it, depth + 1));
    }
    case 'record':
      return sampleRecord(def, depth);
    case 'map':
      return new Map();
    case 'set':
      return new Set();
    case 'union':
      // Covers both plain union and discriminatedUnion (both report 'union').
      return sampleUnion(def, depth);
    case 'optional':
    case 'nullable':
    case 'default':
    case 'catch':
    case 'nonoptional':
    case 'readonly': {
      const inner = def.innerType as AnyZod | undefined;
      if (!inner) {
        // optional/nullable with no inner → undefined/null is the smallest value.
        return def.type === 'nullable' ? null : undefined;
      }
      // For optional/nullable, the smallest passing value is undefined/null,
      // but inside an object we already skip these keys; when sampled directly
      // (e.g. top-level request schema), sample the inner type so the value is
      // meaningful rather than `undefined`.
      return sampleNode(inner, depth);
    }
    case 'pipe': {
      // transform / pipe / coerce: sample the INPUT side (def.in ≈ z.input),
      // never the post-transform output.
      const input = def.in as AnyZod | undefined;
      if (!input) throw new UnsampleableSchemaError('pipe/transform with no input schema');
      return sampleNode(input, depth);
    }
    case 'lazy': {
      if (depth >= MAX_LAZY_DEPTH) {
        // Depth-cap: try to find a non-recursive base case among the resolved
        // schema's options; else the cheapest terminal (a primitive).
        const resolved = def.getter?.();
        if (resolved) return sampleLazyBaseCase(resolved, depth);
        throw new UnsampleableSchemaError('lazy schema exceeded depth cap with no resolvable getter');
      }
      const resolved = def.getter?.();
      if (!resolved) throw new UnsampleableSchemaError('lazy schema has no getter');
      return sampleNode(resolved as AnyZod, depth + 1);
    }
    default:
      throw new UnsampleableSchemaError(`unsupported Zod type '${def.type}'`);
  }
}

/**
 * At the lazy depth cap, prefer a non-recursive terminal. For a union (the
 * `JsonValueSchema` shape: `union([primitive, array(self), record(self)])`),
 * pick the first option that samples WITHOUT further recursion.
 */
function sampleLazyBaseCase(schema: AnyZod, depth: number): unknown {
  const def = getDef(schema);
  if (def?.type === 'union') {
    const options = (def.options ?? []) as AnyZod[];
    for (const opt of options) {
      const od = getDef(opt);
      // Skip array/record/lazy options that would recurse back into self.
      if (od && (od.type === 'array' || od.type === 'record' || od.type === 'lazy')) continue;
      try {
        return sampleNode(opt, depth + 1);
      } catch {
        /* try next */
      }
    }
  }
  // Fallback terminal: a JSON-safe primitive.
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce the smallest value that PASSES `schema.parse`, self-validating the
 * result. Throws {@link UnsampleableSchemaError} if no value can be constructed,
 * or {@link SampleValidationError} if the constructed value fails `.parse`
 * (the loud backstop — never catch-and-skip).
 */
export function sampleSchema(schema: z.ZodTypeAny): unknown {
  const sample = sampleNode(schema as AnyZod, 0);
  const result = schema.safeParse(sample);
  if (!result.success) {
    throw new SampleValidationError(
      `produced sample failed schema.parse: ${safeStringify(sample)} — ${result.error.message}`,
    );
  }
  // Return the constructed INPUT sample, NOT `result.data`: for a transform/pipe
  // schema `result.data` is the post-transform OUTPUT, but the harness needs a
  // value the seam's `request.parse`/`response.parse` will accept — i.e. a valid
  // INPUT. `result.success` already proves the input parses.
  return sample;
}

/** JSON.stringify that tolerates bigint / ArrayBuffer / circular without throwing. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Sample a channel's REQUEST schema (a contract-valid input for the harness
 * driver). Self-validated via `request.parse`.
 */
export function sampleRequest(schema: z.ZodTypeAny): unknown {
  return sampleSchema(schema);
}

/**
 * Sample a channel's RESPONSE schema (a contract-valid response fixture used by
 * the Stage-5 driver to stub channels that are NOT on the `EXECUTE_SAFE`
 * allowlist, in parse-only mode). Same bounded-sampler machinery; self-validated
 * via `response.parse`.
 */
export function sampleResponse(schema: z.ZodTypeAny): unknown {
  return sampleSchema(schema);
}
