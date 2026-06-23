/**
 * Read-only diagnostic logging for the Anthropic auth path.
 *
 * Activated by setting `process.env.REBEL_DIAG_ANTHROPIC_AUTH=1` in the eval
 * worker process (forwarded by `evals/knowledge-work-setup.ts` when the
 * `--diag-anthropic` CLI flag is used). When inactive, callers that opt in
 * via `diagLog()` are no-ops, so production and normal-eval code paths are
 * not affected.
 *
 * NEVER log full keys. All credential output is masked via `fingerprint()`:
 * first 8 + last 4 + length. Tokens shorter than 12 chars are masked as
 * `****<length>` to avoid accidental leakage of test-key-like strings.
 *
 * Why a flag and not log levels: the production logger has structured-log
 * routing that may end up in user-visible session logs. This diag path
 * writes to stderr only, with a `[diag-anthropic-auth]` prefix that's easy
 * to grep for and never accidentally hits a customer log.
 *
 * Lifetime: this file is intended to be removable once the Stage 2 fix lands
 * (or repurposed as a permanent observability scoped logger if it proves
 * useful long-term). Tracked in `docs/plans/260430_eval_harness_recovery_*`.
 */

const ENABLED_ENV_VAR = 'REBEL_DIAG_ANTHROPIC_AUTH';

export function diagAnthropicAuthEnabled(): boolean {
  const v = process.env[ENABLED_ENV_VAR];
  return v === '1' || v === 'true';
}

export function fingerprint(value: string | null | undefined): string {
  if (value == null || value === '') return '<null/empty>';
  if (value.length < 12) return `****<${value.length}chars>`;
  return `${value.slice(0, 8)}...${value.slice(-4)}<${value.length}chars>`;
}

export interface DiagSite {
  /** Short tag identifying the call site (e.g. 'clientFactory:174', 'btsRoutePlan'). */
  site: string;
}

export function diagLog(site: DiagSite, fields: Record<string, unknown>): void {
  if (!diagAnthropicAuthEnabled()) return;
  // Single-line stderr write so output stays grep-able even when interleaved
  // with the normal eval progress chatter.
  const safe = JSON.stringify({ site: site.site, ...fields }, (_k, v) =>
    typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}...<${v.length}>` : v,
  );
  process.stderr.write(`[diag-anthropic-auth] ${safe}\n`);
}
