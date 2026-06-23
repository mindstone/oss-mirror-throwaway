/**
 * Turn Pipeline Replay — Corpus Index (R1 Stage 1B)
 *
 * Enumerates every replay-corpus row in the plan (table at lines 545–577 +
 * Round-2 rows 37–43 + Round-3 rows 44–46 + Round-4 row 47). Each entry has:
 *   - `id` / `description` — human-readable identifiers.
 *   - `stage` — the seam the row primarily exercises (S1–S5).
 *   - `fixtureFile` — the JSON fixture under this directory.
 *   - `status` — one of `'shipped' | 'stub' | 'pending'`. Stage 1B ships
 *     row 1 only; the rest are seeded with `'pending'` and filled by their
 *     owning stage (per plan: "all rows must exist as `.skip`-marked stubs
 *     in Stage 1 with their input fixtures populated").
 *
 * For Stage 1B's purposes the heavy `expected` traces are deferred — Stage
 * 1C drives the bulk of the corpus through the monolith. Stage 1B's value
 * is the harness + canonicalizer + index + row-1 proof.
 *
 * See:
 *   - `docs/plans/260427_refactor_agent_turn_executor_pipeline.md` (Stage 1
 *     section, around line 802; corpus row table around line 545; F4
 *     runtime-assembly split; F5 high-risk seams).
 *   - `docs/plans/260427_r1_stage0_working_notes.md` § A (14 terminal exits).
 */

/**
 * Seam identity for the row. Maps 1:1 with plan F5 high-risk seams.
 *
 * - `S1` — session admission / reset / checkpointing
 * - `S2` — pre-turn context assembly
 * - `S3` — MCP / system prompt / capability / hook boundary
 * - `S4` — provider route / query options / proxy / direct-client seam
 * - `S5` — query / watchdog / error-completion seam
 * - `orchestrator` — pure orchestrator-shape concerns (cross-phase races,
 *   abort-between-boundaries) that don't belong to a single seam.
 */
export type CorpusStage = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'orchestrator';

/**
 * Status of the row's fixture and test:
 *   - `'shipped'` — input fixture populated AND `expected` populated AND
 *     the test driver runs the executor + asserts the canonical trace.
 *   - `'stub'`    — input fixture populated; `expected` populated as a
 *     skeleton placeholder; test is `it.skip(...)` until the owning
 *     stage fills the trace from a recorded run.
 *   - `'pending'` — input fixture populated as a minimal seed; test is
 *     `it.skip(...)`. Used for rows that haven't been authored yet.
 */
export type CorpusRowStatus = 'shipped' | 'stub' | 'pending';

export interface CorpusRow {
  readonly id: number;
  readonly stage: CorpusStage;
  readonly description: string;
  readonly fixtureFile: string;
  readonly status: CorpusRowStatus;
  /** Optional terminal cleanup reason the row asserts. */
  readonly terminalReason?: string;
  /**
   * Marks rows added in a specific review round. Useful for tracking the
   * provenance of the row table; does not affect test behavior.
   */
  readonly addedIn?: 'round-1' | 'round-2' | 'round-3' | 'round-4';
}

/**
 * The full corpus. Order matches the plan's row table. Adding a row here
 * without a matching fixture file is a structural error — the test driver
 * uses dynamic `import(...)` to load fixtures and will fail fast with a
 * clear error message.
 *
 * Total: 47 rows. Plan target was 35–40; Round 2 expanded to 33+ minimum,
 * Round 3 added 44–46, Round 4 added 47. Ship the full enumeration so the
 * test driver doesn't need to be re-edited as rows fill in.
 */
export const CORPUS_INDEX: ReadonlyArray<CorpusRow> = [
  // -------------------------------------------------------------------------
  // S1 — admission / preflight (terminals #1–#4 + happy paths)
  // -------------------------------------------------------------------------
  {
    id: 1,
    stage: 'S1',
    description: 'new-conversation-anthropic-direct-happy',
    fixtureFile: 'row-01-admission-happy.json',
    status: 'shipped',
    terminalReason: 'completed',
    addedIn: 'round-1',
  },
  {
    id: 2,
    stage: 'S1',
    description: 'continuation-with-existing-session-anthropic-direct-happy',
    fixtureFile: 'row-02-continuation-happy.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 3,
    stage: 'S1',
    description: 'reset-conversation-renderer-explicit-true',
    fixtureFile: 'row-03-reset-explicit.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 4,
    stage: 'S1',
    description: 'active-provider-override-codex-to-openrouter',
    fixtureFile: 'row-04-active-provider-override.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 5,
    stage: 'S1',
    description: 'terminal-missing-core-directory',
    fixtureFile: 'row-05-terminal-missing-core-directory.json',
    status: 'shipped',
    terminalReason: 'missing-core-directory',
    addedIn: 'round-1',
  },
  {
    id: 6,
    stage: 'S1',
    description: 'terminal-openrouter-not-connected',
    fixtureFile: 'row-06-terminal-openrouter-not-connected.json',
    status: 'shipped',
    terminalReason: 'openrouter-not-connected',
    addedIn: 'round-1',
  },
  {
    id: 7,
    stage: 'S1',
    description: 'terminal-missing-auth',
    fixtureFile: 'row-07-terminal-missing-auth.json',
    status: 'shipped',
    terminalReason: 'missing-auth',
    addedIn: 'round-1',
  },
  {
    id: 8,
    stage: 'S1',
    description: 'terminal-pre-execution-abort',
    fixtureFile: 'row-08-terminal-pre-execution-abort.json',
    status: 'shipped',
    terminalReason: 'aborted',
    addedIn: 'round-1',
  },
  // -------------------------------------------------------------------------
  // S2 — pre-turn context assembly (worker / fallback / abort / attachments)
  // -------------------------------------------------------------------------
  {
    id: 9,
    stage: 'S2',
    description: 'preTurn-worker-happy-with-semantic-tools-conversations',
    fixtureFile: 'row-09-preTurn-worker-happy.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 10,
    stage: 'S2',
    description: 'preTurn-worker-fallback-with-main-process-tool-search',
    fixtureFile: 'row-10-preTurn-worker-fallback.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 11,
    stage: 'S2',
    description: 'preTurn-assembly-timeout-60s-continues-sans-context',
    fixtureFile: 'row-11-preTurn-timeout.json',
    status: 'pending',
    addedIn: 'round-1',
  },
  {
    id: 12,
    stage: 'S2',
    description: 'preTurn-aborted-mid-context',
    fixtureFile: 'row-12-preTurn-aborted-mid-context.json',
    status: 'shipped',
    terminalReason: 'aborted',
    addedIn: 'round-1',
  },
  {
    id: 13,
    stage: 'S2',
    description: 'text-attachment-validation-truncation',
    fixtureFile: 'row-13-text-attachment-truncation.json',
    status: 'pending',
    addedIn: 'round-1',
  },
  {
    id: 14,
    stage: 'S2',
    description: 'image-attachment-with-history-injection',
    fixtureFile: 'row-14-image-attachment-history.json',
    status: 'pending',
    addedIn: 'round-1',
  },
  // -------------------------------------------------------------------------
  // S3 — MCP / sysprompt / capability / hook boundary (TERM-6, TERM-7, TERM-8)
  // -------------------------------------------------------------------------
  {
    id: 15,
    stage: 'S3',
    description: 'mcp-resolve-graceful-super-mcp-not-running',
    fixtureFile: 'row-15-mcp-graceful-super-mcp-down.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 16,
    stage: 'S3',
    description: 'mcp-direct-mode-tool-name-aliasing',
    fixtureFile: 'row-16-mcp-direct-mode-aliasing.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 17,
    stage: 'S3',
    description: 'terminal-post-mcp-resolution-abort',
    fixtureFile: 'row-17-terminal-post-mcp-abort.json',
    status: 'shipped',
    terminalReason: 'aborted',
    addedIn: 'round-2',
  },
  {
    id: 18,
    stage: 'S3',
    description: 'terminal-invalid-core-directory-post-stat',
    fixtureFile: 'row-18-terminal-invalid-core-dir.json',
    status: 'pending',
    terminalReason: 'invalid-core-directory',
    addedIn: 'round-1',
  },
  {
    id: 19,
    stage: 'S3',
    description: 'terminal-profile-incompatible',
    fixtureFile: 'row-19-terminal-profile-incompatible.json',
    status: 'pending',
    terminalReason: 'profile-incompatible',
    addedIn: 'round-1',
  },
  // -------------------------------------------------------------------------
  // S4 — provider route / proxy / direct-client / R4 route plan (council, ad-hoc)
  // -------------------------------------------------------------------------
  {
    id: 20,
    stage: 'S4',
    description: 'council-mode-happy-anthropic-direct',
    fixtureFile: 'row-20-council-happy-anthropic-direct.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 21,
    stage: 'S4',
    description: 'terminal-council-proxy-failed',
    fixtureFile: 'row-21-terminal-council-proxy-failed.json',
    status: 'shipped',
    terminalReason: 'council-proxy-failed',
    addedIn: 'round-1',
  },
  {
    id: 22,
    stage: 'S4',
    description: 'ad-hoc-mode-with-pre-registered-and-mentions',
    fixtureFile: 'row-22-ad-hoc-pre-registered.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 23,
    stage: 'S4',
    description: 'direct-execution-client-openai-compatible',
    fixtureFile: 'row-23-direct-execution-openai.json',
    status: 'pending',
    addedIn: 'round-1',
  },
  {
    id: 24,
    stage: 'S4',
    description: 'thinking-profile-auth-failure-fallback-to-claude',
    fixtureFile: 'row-24-thinking-profile-fallback.json',
    status: 'pending',
    addedIn: 'round-1',
  },
  {
    id: 25,
    stage: 'S4',
    description: 'route-plan-codex-connected-fully-routable',
    fixtureFile: 'row-25-route-plan-codex-connected.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 26,
    stage: 'S4',
    description: 'route-plan-codex-disconnected-fail-closed',
    fixtureFile: 'row-26-route-plan-codex-disconnected.json',
    status: 'shipped',
    terminalReason: 'codex-not-connected',
    addedIn: 'round-1',
  },
  {
    id: 27,
    stage: 'S4',
    description: 'terminal-openrouter-proxy-failed',
    fixtureFile: 'row-27-terminal-openrouter-proxy-failed.json',
    status: 'shipped',
    terminalReason: 'openrouter-proxy-failed',
    addedIn: 'round-1',
  },
  {
    id: 28,
    stage: 'S4',
    description: 'terminal-post-spawn-delay-abort',
    fixtureFile: 'row-28-terminal-spawn-delay-abort.json',
    status: 'shipped',
    terminalReason: 'aborted',
    addedIn: 'round-2',
  },
  {
    id: 29,
    stage: 'S4',
    description: 'terminal-cooldown-abort-distinct-from-spawn',
    fixtureFile: 'row-29-terminal-cooldown-abort.json',
    status: 'shipped',
    terminalReason: 'aborted',
    addedIn: 'round-2',
  },
  // -------------------------------------------------------------------------
  // S5 — primary query / watchdog / error completion / recursive retry
  // -------------------------------------------------------------------------
  {
    id: 30,
    stage: 'S5',
    description: 'normal-completion-text-only-anthropic',
    fixtureFile: 'row-30-normal-completion-anthropic.json',
    status: 'shipped',
    terminalReason: 'completed',
    addedIn: 'round-1',
  },
  {
    id: 31,
    stage: 'S5',
    description: 'abort-during-iteration-user',
    fixtureFile: 'row-31-abort-during-iteration.json',
    status: 'shipped',
    terminalReason: 'aborted',
    addedIn: 'round-1',
  },
  {
    id: 32,
    stage: 'S5',
    description: 'watchdog-auto-abort-15min',
    fixtureFile: 'row-32-watchdog-auto-abort.json',
    status: 'pending',
    terminalReason: 'watchdog-aborted',
    addedIn: 'round-1',
  },
  {
    id: 33,
    stage: 'S5',
    description: 'session-recovery-fresh-retry',
    fixtureFile: 'row-33-session-recovery-fresh-retry.json',
    status: 'pending',
    addedIn: 'round-1',
  },
  {
    id: 34,
    stage: 'S5',
    description: 'rate-limit-oauth-to-apikey-fallback',
    fixtureFile: 'row-34-rate-limit-oauth-fallback.json',
    status: 'pending',
    addedIn: 'round-1',
  },
  {
    id: 35,
    stage: 'S5',
    description: 'server-error-retry-then-exhaust-depth-3',
    fixtureFile: 'row-35-server-error-retry-depth-3.json',
    status: 'pending',
    addedIn: 'round-1',
  },
  {
    id: 36,
    stage: 'S5',
    description: 'long-context-1m-to-200k-via-RouteRebuildHint-R4-I8',
    fixtureFile: 'row-36-long-context-fallback-rebuild.json',
    status: 'pending',
    addedIn: 'round-1',
  },
  // -------------------------------------------------------------------------
  // Round-2 additions: lifecycle / late-resolve / abort-boundaries / per-attempt cleanup
  // -------------------------------------------------------------------------
  {
    id: 37,
    stage: 'S2',
    description: 'late-pre-turn-worker-resolution-after-timeout',
    fixtureFile: 'row-37-late-worker-after-timeout.json',
    status: 'pending',
    addedIn: 'round-2',
  },
  {
    id: 38,
    stage: 'S1',
    description: 'empty-prompt-zero-attachments-resetConversation-true',
    fixtureFile: 'row-38-empty-prompt-reset.json',
    status: 'shipped',
    addedIn: 'round-2',
  },
  {
    id: 39,
    stage: 'S2',
    description: 'is-cloud-service-attachment-path-skip',
    fixtureFile: 'row-39-cloud-service-attachment-skip.json',
    status: 'pending',
    addedIn: 'round-2',
  },
  {
    id: 40,
    stage: 'S2',
    description: 'preTurnWorker-import-failure-cached-as-unavailable',
    fixtureFile: 'row-40-preTurnWorker-import-failure-cached.json',
    status: 'pending',
    addedIn: 'round-2',
  },
  {
    id: 41,
    stage: 'orchestrator',
    description: 'abort-exactly-between-phase-boundaries',
    fixtureFile: 'row-41-abort-between-phase-boundaries.json',
    status: 'pending',
    terminalReason: 'aborted',
    addedIn: 'round-2',
  },
  {
    id: 42,
    stage: 'orchestrator',
    description: 'abort-during-side-effect-emission-routes-cleanup',
    fixtureFile: 'row-42-abort-during-side-effect-emission.json',
    status: 'pending',
    terminalReason: 'aborted',
    addedIn: 'round-2',
  },
  {
    id: 43,
    stage: 'S5',
    description: 'post-addRoutes-failure-then-recursive-retry-no-leaked-routes',
    fixtureFile: 'row-43-post-addRoutes-failure-retry.json',
    status: 'pending',
    addedIn: 'round-2',
  },
  // -------------------------------------------------------------------------
  // Round-3 additions: pre-runtime phase throws (admission / modelMcp / routingProxy)
  // -------------------------------------------------------------------------
  {
    id: 44,
    stage: 'S1',
    description: 'admission-throws-pre-runtime-failure',
    fixtureFile: 'row-44-admission-throws-pre-runtime.json',
    status: 'shipped',
    terminalReason: 'pre-runtime-failure',
    addedIn: 'round-3',
  },
  {
    id: 45,
    stage: 'S3',
    description: 'modelMcp-throws-pre-runtime-failure',
    fixtureFile: 'row-45-modelMcp-throws-pre-runtime.json',
    status: 'shipped',
    terminalReason: 'pre-runtime-failure',
    addedIn: 'round-3',
  },
  {
    id: 46,
    stage: 'S4',
    description: 'routingProxy-throws-incomplete-routing-pre-runtime',
    fixtureFile: 'row-46-routingProxy-throws-incomplete.json',
    status: 'shipped',
    terminalReason: 'pre-runtime-failure',
    addedIn: 'round-3',
  },
  // -------------------------------------------------------------------------
  // Round-4 addition: preTurn cancel-protocol end-to-end
  // -------------------------------------------------------------------------
  {
    id: 47,
    stage: 'S2',
    description: 'preTurn-cancel-protocol-end-to-end',
    fixtureFile: 'row-47-preTurn-cancel-protocol.json',
    status: 'pending',
    addedIn: 'round-4',
  },
  // -------------------------------------------------------------------------
  // Stage 1C Phase 3 additions (rows 48–55): variant rows that expand
  // turnOptions / proxy / activation-flag coverage. Each row exercises a
  // distinct production code branch with the existing Phase 2 mock surface.
  // -------------------------------------------------------------------------
  {
    id: 48,
    stage: 'S4',
    description: 'openrouter-connected-happy-with-proxy-success',
    fixtureFile: 'row-48-openrouter-connected-happy.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 49,
    stage: 'S1',
    description: 'turnOptions-privateMode-true',
    fixtureFile: 'row-49-turnOptions-private-mode.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 50,
    stage: 'S1',
    description: 'turnOptions-modelOverride-haiku',
    fixtureFile: 'row-50-turnOptions-model-override.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 51,
    stage: 'S1',
    description: 'council-keyword-in-prompt-vs-flag',
    fixtureFile: 'row-51-council-keyword-in-prompt.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 52,
    stage: 'S1',
    description: 'unleashed-keyword-in-prompt',
    fixtureFile: 'row-52-unleashed-keyword.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 53,
    stage: 'S1',
    description: 'turnOptions-unleashedMode-flag',
    fixtureFile: 'row-53-turnOptions-unleashed-flag.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 54,
    stage: 'S1',
    description: 'turnOptions-voiceActive-true',
    fixtureFile: 'row-54-turnOptions-voice-active.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 55,
    stage: 'S1',
    description: 'turnOptions-sessionType-automation',
    fixtureFile: 'row-55-turnOptions-session-type-automation.json',
    status: 'shipped',
    addedIn: 'round-1',
  },
  {
    id: 56,
    stage: 'S4',
    description: 'terminal-route-plan-profile-missing-openrouter-credentials',
    fixtureFile: 'row-56-terminal-profile-missing-openrouter-credentials.json',
    status: 'shipped',
    addedIn: 'round-4',
  },
];

/**
 * Returns the corpus row by id. Throws if not found — corpus rows are a
 * closed enumeration; a missing id is a structural test bug, not a runtime
 * concern.
 */
export function getCorpusRow(id: number): CorpusRow {
  const row = CORPUS_INDEX.find(r => r.id === id);
  if (!row) {
    throw new Error(`getCorpusRow: id ${id} not in CORPUS_INDEX`);
  }
  return row;
}
