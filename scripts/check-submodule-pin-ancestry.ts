#!/usr/bin/env npx tsx
/**
 * validate:fast gate for the "submodule pin orphan" regression class: fails when a
 * submodule's recorded pin has diverged from (or is merely ahead of, i.e. not yet
 * landed on) its `.gitmodules` tracked branch. See
 * docs/postmortems/260603_supermcp_bulk_export_submodule_pin_orphan_postmortem.md
 * and the "Submodule Pin Policy" in docs/project/PROJECT_OVERRIDES2.md.
 *
 * This is the OFFLINE surface: it does NOT fetch, so it SKIPs (with a loud warning)
 * when a submodule clone or its `origin/<branch>` ref isn't present in this
 * environment, rather than false-failing. The ONLINE, hard, by-construction check
 * lives in scripts/git-safe-sync.ts (fetches the tracked branch, then refuses to
 * push an off-branch pin). Both share scripts/lib/submodulePinAncestry.ts so the
 * two surfaces cannot drift apart.
 */
import { checkSubmodulePins, makeRunGit } from './lib/submodulePinAncestry';

function main(): void {
  const runGit = makeRunGit(process.cwd());
  const outcomes = checkSubmodulePins(runGit, { fetch: false });

  if (outcomes.length === 0) {
    console.error('[check-submodule-pin-ancestry] ERROR: no submodules found in .gitmodules');
    process.exit(1);
  }

  for (const o of outcomes) {
    if (o.status === 'ok') {
      console.log(`[check-submodule-pin-ancestry] OK ${o.path} ${(o.sha ?? '').slice(0, 10)} is on origin/${o.branch}`);
    } else if (o.status === 'skip') {
      console.warn(`[check-submodule-pin-ancestry] SKIP ${o.path}: ${o.reason}`);
    } else {
      console.error(`[check-submodule-pin-ancestry] FAIL ${o.path}: ${o.reason}`);
    }
  }

  const failures = outcomes.filter((o) => o.status === 'fail');
  const skips = outcomes.filter((o) => o.status === 'skip');
  const verified = outcomes.filter((o) => o.status === 'ok');

  if (failures.length > 0) {
    console.error(
      `[check-submodule-pin-ancestry] ${failures.length} submodule pin(s) not on their tracked branch ` +
      `(see FAIL above). Full enforcement runs at pre-push / git-safe-sync where all submodules are present.`,
    );
    process.exit(1);
  }
  console.log(
    `[check-submodule-pin-ancestry] OK — ${verified.length} verified on tracked branch` +
    (skips.length > 0 ? `, ${skips.length} skipped (unverifiable here — see SKIP above)` : '') + '.',
  );
}

main();
