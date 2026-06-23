/**
 * Shared in-process guard-group runner (validate:fast guard batching —
 * docs/plans/260618_git-safe-sync-speedup, generalizing the precedent in
 * scripts/check-testing-guards.ts per docs/plans/260611_prepush-gate-speedup
 * Stage 2).
 *
 * WHY: validate:fast spawns ~120 trivial guard scripts, each paying ~0.35s of
 * `node --import tsx` (tsx/esbuild) boot. Running a themed group of guards in
 * ONE process collapses N boots into 1, recovering ~(N-1)×0.35s — with NO loss
 * of coverage: every guard still runs, fail-closed, with its own label and a
 * standalone rerun hint when it fails.
 *
 * SAFETY MODEL (this is the only safety net before code hits hot shared `dev`):
 * - **Fail-closed aggregation.** A guard that returns a non-zero code, returns
 *   `{ok:false}`, throws, or rejects ⇒ the group fails, naming the guard and
 *   printing its standalone rerun hint. A guard whose module fails to import
 *   takes down the whole group process (static import) — also fail-closed.
 * - **Batch-level isolation.** Each group is one fresh process per gate run
 *   (one STEPS entry), so a residual module-level mutation can at worst
 *   contaminate siblings in the SAME small themed group — never the other ~100
 *   guards. The batchability audit confirmed zero process.chdir / process.env
 *   mutation across all candidates, so the residual-state surface is small.
 * - **Behaviour parity via `guardFromMain`.** Batched Bucket-A guards keep their
 *   existing, import-safe `main()` (gated behind an `invokedDirectly` check, so
 *   importing the module is inert). `guardFromMain` calls that `main()` with
 *   `process.exit` intercepted FOR THE DURATION OF THAT CALL ONLY, so a guard
 *   that signals its verdict via `process.exit(1)` (the standalone-CLI idiom)
 *   yields code 1 as its in-batch verdict instead of killing the batch. The
 *   guard's scan, I/O, logging, and pass/fail decision are UNCHANGED — only the
 *   exit is captured. This is a relocation of the exit, not a re-implementation,
 *   which is what makes batched == standalone by construction.
 *   CAVEAT: a guard that schedules a DETACHED async exit (a `setTimeout` that
 *   calls process.exit after `main()` resolves) is out of the interception
 *   window — such guards must stay standalone (none in the audited batch set;
 *   anything leaving open handles is Bucket C).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Structural superset of scripts/checks/types.ts `GuardRunResult`, inlined so
 * this runner stays self-contained (no cross-file project-membership coupling).
 * A guard may return either a numeric exit code (0 = pass) or this richer shape.
 */
export interface GuardRunResultLike {
  readonly ok: boolean;
  readonly failures?: readonly string[];
  readonly summary?: string;
}

/** A guard's verdict: numeric exit code (0 = pass) or a `GuardRunResultLike`. */
export type GuardVerdict = number | GuardRunResultLike;

export interface GuardGroupMember {
  /** Stable label — MUST match the guard's original validate:fast STEPS name so
   *  the step-identity baseline (group-member identities) stays traceable. */
  readonly name: string;
  /** Standalone rerun hint printed on failure (defaults to `npm run <name>`). */
  readonly rerun?: string;
  /** Runs the guard in-process. 0 / `{ok:true}` = pass; throw/reject = fail. */
  run(): GuardVerdict | Promise<GuardVerdict>;
}

function verdictFailed(v: GuardVerdict): boolean {
  return typeof v === 'number' ? v !== 0 : !v.ok;
}

function defaultRerun(member: GuardGroupMember): string {
  return member.rerun ?? `npm run ${member.name}`;
}

/** Thrown by the intercepted `process.exit` so the exit code surfaces as a verdict. */
class GuardExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code}) intercepted`);
    this.name = 'GuardExitSignal';
  }
}

/**
 * Adapt an import-safe guard's exported `main()` into a batchable group member.
 * `mainFn` may return a numeric code, return void, or signal its verdict by
 * calling `process.exit(code)` — all three map to a verdict without aborting
 * the batch. A genuine throw (not a process.exit) propagates so the group
 * runner records it fail-closed.
 *
 * Preconditions (Bucket A): the guard module is side-effect-free at import
 * (work gated behind an `invokedDirectly` check) and exports `main`.
 */
export function guardFromMain(
  name: string,
  mainFn: () => void | number | Promise<void | number>,
  rerun?: string,
): GuardGroupMember {
  return {
    name,
    rerun,
    run: async (): Promise<number> => {
      // Capture the ORIGINAL reference (no .bind — a bound copy would both fail
      // an identity-restore check and accrete a wrapper layer per guard).
      const realExit = process.exit;
      // Snapshot + clear process.exitCode so we can detect a guard that signals
      // failure via `process.exitCode = 1; return;` (the OTHER standalone idiom):
      // standalone, Node exits non-zero at process end; in-batch that guard
      // returns void, so without this it would FALSE-GREEN. Restored in finally
      // so one guard's exit code never leaks into a sibling or the batch total.
      const prevExitCode = process.exitCode;
      process.exitCode = 0;
      let exitCode: number | null = null;
      const intercept = ((code?: number): never => {
        exitCode = code ?? 0;
        throw new GuardExitSignal(exitCode);
      }) as typeof process.exit;
      process.exit = intercept;
      try {
        const ret = await Promise.resolve(mainFn());
        if (exitCode !== null) return exitCode;
        if (typeof ret === 'number') return ret;
        // void return: honour a process.exitCode the guard set without exiting.
        const raw = process.exitCode;
        if (typeof raw === 'number') return raw;
        return raw ? 1 : 0;
      } catch (err) {
        if (err instanceof GuardExitSignal) return err.code;
        throw err; // genuine crash → fail-closed at the group level
      } finally {
        process.exit = realExit;
        process.exitCode = prevExitCode;
      }
    },
  };
}

/**
 * Runs a themed group of guards sequentially in-process, fail-closed.
 * Returns 0 iff every guard passed; 1 otherwise (after running ALL guards, so a
 * single run surfaces every failure, not just the first).
 */
export async function runGuardGroup(
  groupName: string,
  guards: readonly GuardGroupMember[],
): Promise<number> {
  const failed: GuardGroupMember[] = [];
  for (const guard of guards) {
    process.stdout.write(`── ${groupName}: ${guard.name} ──\n`);
    try {
      const verdict = await Promise.resolve(guard.run());
      if (verdictFailed(verdict)) {
        failed.push(guard);
        if (typeof verdict !== 'number') {
          if (verdict.summary) process.stdout.write(`   ${verdict.summary}\n`);
          for (const line of verdict.failures ?? []) {
            process.stderr.write(`✘ [${guard.name}] ${line}\n`);
          }
        }
      } else if (typeof verdict !== 'number' && verdict.summary) {
        process.stdout.write(`   ${verdict.summary}\n`);
      }
    } catch (error) {
      // A guard that cannot run is a failure, not a skip — fail closed.
      failed.push(guard);
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`✘ [${guard.name}] guard crashed: ${message}\n`);
    }
  }
  if (failed.length > 0) {
    process.stderr.write(
      `\n${groupName} FAILED: ${failed.length}/${guards.length} guard(s) red.\n`,
    );
    process.stderr.write('Rerun a failing guard standalone:\n');
    for (const guard of failed) {
      process.stderr.write(`  ${defaultRerun(guard)}\n`);
    }
    return 1;
  }
  process.stdout.write(`\n${groupName} passed (${guards.length} guard(s)).\n`);
  return 0;
}

/**
 * Standard CLI tail for a group module: when the module is the entry point,
 * run the group and exit with its aggregate code. Importing the module (from a
 * unit test or the step-identity baseline expansion) is side-effect-free.
 */
export function runGroupAsCli(
  moduleUrl: string,
  groupName: string,
  guards: readonly GuardGroupMember[],
): void {
  const invokedDirectly =
    process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
  if (!invokedDirectly) return;
  runGuardGroup(groupName, guards).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${groupName} orchestrator crashed: ${String(error)}\n`);
      process.exit(1);
    },
  );
}

export { GuardExitSignal };
