/**
 * Stage 3.B (260426) — shared path-token extractor.
 *
 * Single source of truth for "where is the connector path?" lookups across
 * the contribution observation pipeline. Consolidates the previously
 * duplicated scans of `args.args` / `args.command` / `args.cwd` /
 * `file_path` / `path` / `filePath` so every consumer (Stage 3 hook,
 * bridge, sweep, evals) sees the same candidates in the same order.
 *
 * Closes failure-matrix #6/#7/#8 (detection blind-spots) by giving every
 * detection site a single, well-tested entrypoint.
 *
 * Design constraints (per plan § 3.B):
 *   - Pure function: no side effects.
 *   - No `node:fs`, no `node:path`, no `electron` import — usable from
 *     main, renderer, evals, cloud, mobile.
 *   - NEVER throws; bad input returns `[]`.
 *   - Does NOT canonicalise paths (caller's responsibility).
 *   - Does NOT classify (caller's responsibility).
 *   - Does NOT touch platform config.
 *
 * @see docs/plans/260426_foolproof_contribution_flow_stage3.md § 3.B
 */

/**
 * Absolute-path-shape predicate — accepts POSIX (`/...`), home-relative
 * (`~/...` or `~\...`), and Windows drive-letter (`C:\...` or `C:/...`)
 * tokens. Mirrors `ABSOLUTE_PATH_TOKEN_REGEX` from the legacy
 * `mcpBuildAutoDetectHook` helpers so the new shared helper picks up the
 * same candidate set.
 */
const ABSOLUTE_PATH_TOKEN_REGEX = /^(?:\/|~[\\/]|[A-Za-z]:[\\/])/u;

/**
 * Quote-aware command tokeniser — matches the `splitCommandTokens` shape
 * used by `mcpBuildAutoDetectHook.ts`. Preserves quoted substrings (so a
 * spaced path like `"/Users/alex/My MCP/index.js"` arrives as one token).
 */
function splitCommandTokens(command: string): string[] {
  return command.match(/"[^"]+"|'[^']+'|`[^`]+`|\S+/gu) ?? [];
}

function stripWrappingQuotes(raw: string): string {
  return raw.trim().replace(/^['"`]+|['"`]+$/gu, '');
}

/**
 * Normalises a raw command-line token into its path-shaped value.
 * Strips wrapping quotes and unwraps `--flag=value` forms when the RHS
 * looks like an absolute path.
 *
 * Returns the normalised string (which may not itself be a path — callers
 * must still apply `looksLikeAbsolutePath` to filter).
 */
function normalizePathToken(rawToken: string): string {
  const stripped = stripWrappingQuotes(rawToken);
  const equalsIndex = stripped.indexOf('=');
  if (equalsIndex > 0) {
    const rhs = stripWrappingQuotes(stripped.slice(equalsIndex + 1));
    if (ABSOLUTE_PATH_TOKEN_REGEX.test(rhs)) return rhs;
  }
  return stripped;
}

function looksLikeAbsolutePath(value: string): boolean {
  return ABSOLUTE_PATH_TOKEN_REGEX.test(value);
}

/**
 * Append a candidate path token to the accumulator after normalising and
 * shape-checking it. Skips empty / non-path-like tokens.
 *
 * Caller is responsible for ordering — the helper preserves first-seen
 * order via a single `seen` set shared across the entire scan.
 */
function pushIfPathLike(
  accumulator: string[],
  seen: Set<string>,
  raw: string | null | undefined,
): void {
  if (typeof raw !== 'string') return;
  const trimmed = raw.trim();
  if (!trimmed) return;
  const normalized = normalizePathToken(trimmed);
  if (!normalized) return;
  if (!looksLikeAbsolutePath(normalized)) return;
  if (seen.has(normalized)) return;
  seen.add(normalized);
  accumulator.push(normalized);
}

/**
 * Pure scanner: given a tool-call input record, return a deduped, ordered
 * array of path-like candidate strings. Scan order (preserves caller
 * priority — first-match callers should treat `[0]` as "most likely"):
 *   1. `toolInput.args` (when an array — every string entry is a candidate)
 *   2. `toolInput.command` (when a string — quote-aware tokenisation)
 *   3. `toolInput.cwd` (when a string)
 *   4. `toolInput.file_path` / `toolInput.path` / `toolInput.filePath`
 *      (Write/Create/Edit field-name aliases)
 *
 * Returns `[]` for `null` / `undefined` / non-object input, or when no
 * path-shaped tokens are present.
 */
export function extractCandidatePathsFromToolCall(
  toolInput: Record<string, unknown> | null | undefined,
): string[] {
  if (!toolInput || typeof toolInput !== 'object') return [];

  const candidates: string[] = [];
  const seen = new Set<string>();

  // 1. args.args — array of command-argument strings.
  const argsList = (toolInput as { args?: unknown }).args;
  if (Array.isArray(argsList)) {
    for (const arg of argsList) {
      if (typeof arg === 'string') {
        pushIfPathLike(candidates, seen, arg);
      }
    }
  }

  // 2. args.command — full command string; tokenise and scan each piece.
  const command = (toolInput as { command?: unknown }).command;
  if (typeof command === 'string' && command.length > 0) {
    for (const token of splitCommandTokens(command)) {
      pushIfPathLike(candidates, seen, token);
    }
  }

  // 3. args.cwd — single working-directory string.
  const cwd = (toolInput as { cwd?: unknown }).cwd;
  if (typeof cwd === 'string') {
    pushIfPathLike(candidates, seen, cwd);
  }

  // 4. file_path / path / filePath — Write/Create/Edit aliases.
  const filePath = (toolInput as { file_path?: unknown }).file_path;
  if (typeof filePath === 'string') {
    pushIfPathLike(candidates, seen, filePath);
  }
  const pathField = (toolInput as { path?: unknown }).path;
  if (typeof pathField === 'string') {
    pushIfPathLike(candidates, seen, pathField);
  }
  const filePathCamel = (toolInput as { filePath?: unknown }).filePath;
  if (typeof filePathCamel === 'string') {
    pushIfPathLike(candidates, seen, filePathCamel);
  }

  return candidates;
}
