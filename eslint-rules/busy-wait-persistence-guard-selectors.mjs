// Single source of truth for the same-process busy-wait guard
// `no-restricted-syntax` selectors (PM 260618_quit_save_sync_lock_contention_dropped_final_save,
// rec 2 / implement_now).
//
// A synchronous lock acquire busy-waits the single event loop (sleepSync -> Atomics.wait).
// Against a SAME-PID async holder whose release() is a microtask queued on that now-frozen
// loop, the sync acquire can never succeed -> LockAcquireTimeout -> the final quit/unload
// save is DROPPED. The fix (b7501fbcd) made the persistence consumer first DRAIN same-process
// holders (the deferral branch) before ever reaching acquire*Sync. These selectors keep that
// class dead by construction: a NEW acquire*Sync / Atomics.wait / sleepSync site in the
// persistence consumer layer must either drain in-process holders first or carry an explicit
// eslint-disable with rationale. The canonical lock primitive (sessionFileLock.ts) is the
// sanctioned home of the busy-wait and is intentionally OUT of scope (cf. readLines.ts).
//
// Consumed by:
//   - eslint.config.mjs
//       → spread into the `no-restricted-syntax` rule for
//         src/core/services/lockedSessionPersistence.ts (the production wiring).
//   - eslint-rules/__tests__/busy-wait-persistence-guard.test.js
//       → verdict tests lint synthetic snippets with a minimal NON-type-aware
//         flat config (no `parserOptions.project`, so no TS program is built),
//         and a separate wiring/scoping assertion checks the production config
//         still applies these selectors to the persistence consumer (and only it).
//
// Why a single source of truth: the test must lint the exact selectors the
// production config applies, otherwise a "passing" test can drift from what
// ESLint really enforces. Keeping the literals here (not copied into the test)
// means removing/altering a selector breaks the test by construction.
//
// Why this shape: the prior test booted the FULL production `eslint.config.mjs`
// through `ESLint.lintText()` against a `src/core/**` filePath, which made a cold
// lint build the full type-aware TS program — that intermittently returned ZERO
// messages under parallel CI load (eslint@10 / esquery on CI Node), reding the
// desktop unit-test shard. These selectors are pure AST (no type information), so
// a non-type-aware lint catches the same sites — same remedy as
// eslint-rules/routing-state-writer-selectors.mjs.
//
// Why plain `.mjs` (with a co-located `.d.mts`): eslint.config.mjs is loaded by
// the `eslint` binary as plain Node ESM (no TS loader), so it cannot import a
// `.ts` at config-load time.

export const busyWaitPersistenceGuardSelectors = [
  {
    selector: "CallExpression[callee.object.name='Atomics'][callee.property.name='wait']",
    message:
      'No new Atomics.wait busy-wait in same-process persistence code — it freezes the one event ' +
      'loop, so a same-pid async lock holder can never release and the final save is dropped ' +
      '(PM 260618_quit_save_sync_lock_contention). Drain in-process holders first (the deferral ' +
      'branch in lockedSessionPersistence), or override at a genuinely cross-process-only site: ' +
      '// eslint-disable-next-line no-restricted-syntax -- sync-busy-wait-justified: <reason>.',
  },
  {
    selector: "CallExpression[callee.name='sleepSync'], CallExpression[callee.property.name='sleepSync']",
    message:
      'No new sleepSync busy-wait in same-process persistence code (PM 260618_quit_save_sync_lock_contention) ' +
      '— it blocks the event loop a same-pid lock holder needs to release. Override only with rationale: ' +
      '// eslint-disable-next-line no-restricted-syntax -- sync-busy-wait-justified: <reason>.',
  },
  {
    selector: "CallExpression[callee.name=/^acquire.*Sync$/], CallExpression[callee.property.name=/^acquire.*Sync$/]",
    message:
      'No new synchronous lock acquire (acquire*Sync) in same-process persistence code unless it FIRST drains ' +
      'same-process holders (PM 260618_quit_save_sync_lock_contention): the sync acquire busy-waits the loop, a ' +
      'same-pid async holder can never release, and the final save is dropped. Route through the deferral branch ' +
      'in lockedSessionPersistence, or override with rationale: ' +
      '// eslint-disable-next-line no-restricted-syntax -- sync-acquire-after-holder-check-justified: <reason>.',
  },
];
