/**
 * Attach observability to an intentionally-detached promise.
 *
 * Pattern used across web-companion for fire-and-forget calls (mount
 * effects, click handlers, router navigate calls). Accepts `void` as
 * well as `Promise<unknown>` to handle RR7's `void | Promise<void>`
 * return type transparently — in declarative/BrowserRouter the call is
 * synchronous and the `.catch` is dead, but the helper stays uniform.
 *
 * Current sink: browser DevTools console via `console.error` with a
 * `[web-companion:<label>]` prefix (searchable). Web-companion has no
 * browser-side error reporter today — when one is added, migration is
 * local to this file.
 *
 * Label convention: `<Component>:<handler>[:<subaction>]` — e.g.
 * `HomeScreen:mount:fetchSessions`, `InboxScreen:handleArchive`. Keep narrow
 * so search-by-label is effective.
 *
 * Do NOT use for caller-cares-about-result cases — use `await` or
 * explicit handling there.
 *
 * Body mirrors `src/shared/utils/fireAndForget.ts` (only the log prefix
 * differs) so that the deferred hoist to `packages/shared/` is a rename,
 * not a semantic migration. See docs/plans/260423_web_companion_no_floating_promises_rollout.md
 * for design rationale (Option B adopted over inline `.catch` after
 * Opus/DA/Structural-Health review).
 */
export function fireAndForget(
  promise: void | Promise<unknown>,
  label: string,
): void {
  Promise.resolve(promise).catch((err: unknown) => {
    console.error(`[web-companion:${label}]`, err);
  });
}
