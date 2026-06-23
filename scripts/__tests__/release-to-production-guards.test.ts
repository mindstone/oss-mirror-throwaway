import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  isCleanFastForward,
  prePushHookWillRun,
  selectStableReleaseRun,
  shouldSoftenGcsWarning,
} from "../release-to-production";

// ---------------------------------------------------------------------------
// Real git fixtures (no mocks — exercises actual git semantics, matching the
// real-HTTP-fixture style of release-to-production-verify-published.test.ts).
//
// Hermeticity is load-bearing here: this suite often runs INSIDE the git
// pre-push hook (validate:fast → vitest related), where git exports
// GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/etc. into the environment. If our temp-repo
// git commands — or prePushHookWillRun's own `git config` call — inherited those,
// they'd operate on the real repo instead of the fixture. So we scrub the
// per-invocation GIT_* vars from process.env (and pin GIT_CONFIG_GLOBAL/NOSYSTEM)
// for the whole suite, restoring afterward. Without this the suite passes
// standalone but fails under the pre-push hook.
// ---------------------------------------------------------------------------

const SCRUBBED_GIT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
];
const savedGitEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of SCRUBBED_GIT_VARS) savedGitEnv[key] = process.env[key];
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  delete process.env.GIT_INDEX_FILE;
  delete process.env.GIT_PREFIX;
  delete process.env.GIT_COMMON_DIR;
  delete process.env.GIT_CONFIG_PARAMETERS;
  // Ignore the developer's global/system config (hooksPath, gpgsign, templateDir).
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedGitEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const tmpRepos: string[] = [];

function git(repo: string, args: string): void {
  execSync(`git ${args}`, { cwd: repo, stdio: "pipe" });
}

/** Init a temp repo on branch `main` with one empty commit. */
function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rel-prod-guard-"));
  tmpRepos.push(repo);
  git(repo, "-c init.templateDir= -c init.defaultBranch=main init");
  git(repo, "config user.email test@example.com");
  git(repo, "config user.name Test");
  git(repo, "config commit.gpgsign false");
  git(repo, "commit --allow-empty -m initial");
  return repo;
}

afterEach(() => {
  while (tmpRepos.length > 0) {
    const repo = tmpRepos.pop();
    if (repo) rmSync(repo, { recursive: true, force: true });
  }
});

describe("isCleanFastForward", () => {
  it("is true when base is an ancestor of target (clean fast-forward)", () => {
    const repo = initRepo();
    // feature branches off main, then advances — main is still an ancestor.
    git(repo, "branch feature");
    git(repo, "checkout feature");
    git(repo, "commit --allow-empty -m feature-work");
    expect(isCleanFastForward("main", "feature", repo)).toBe(true);
  });

  it("is true reflexively (target == base)", () => {
    const repo = initRepo();
    expect(isCleanFastForward("main", "main", repo)).toBe(true);
  });

  it("is FALSE when base advanced independently (the TOCTOU case the guard catches)", () => {
    const repo = initRepo();
    git(repo, "branch feature");
    git(repo, "checkout feature");
    git(repo, "commit --allow-empty -m feature-work");
    // main advances with a commit NOT on feature → no longer a fast-forward.
    git(repo, "checkout main");
    git(repo, "commit --allow-empty -m hotfix-on-main");
    expect(isCleanFastForward("main", "feature", repo)).toBe(false);
  });
});

describe("prePushHookWillRun", () => {
  const origHusky = process.env.HUSKY;
  afterEach(() => {
    if (origHusky === undefined) delete process.env.HUSKY;
    else process.env.HUSKY = origHusky;
  });

  /** Wire a repo so hooks would genuinely fire: core.hooksPath + both hook files. */
  function wireHooks(repo: string): void {
    mkdirSync(join(repo, ".husky", "_"), { recursive: true });
    writeFileSync(join(repo, ".husky", "_", "pre-push"), "#!/bin/sh\n");
    writeFileSync(join(repo, ".husky", "pre-push"), "#!/bin/sh\nnpm run validate:fast\n");
    git(repo, "config core.hooksPath .husky/_");
  }

  it("is true when HUSKY!=0 + core.hooksPath routes to an existing wrapper + hook body exists", () => {
    delete process.env.HUSKY;
    const repo = initRepo();
    wireHooks(repo);
    expect(prePushHookWillRun(repo)).toBe(true);
  });

  it("is FALSE when HUSKY=0 (hooks disabled) even if everything else is wired", () => {
    const repo = initRepo();
    wireHooks(repo);
    process.env.HUSKY = "0";
    expect(prePushHookWillRun(repo)).toBe(false);
  });

  it("is FALSE when core.hooksPath is unset even though BOTH hook files exist (proves hooksPath is consulted)", () => {
    delete process.env.HUSKY;
    const repo = initRepo();
    // Wire both hook files but DO NOT set core.hooksPath. Git won't run the hook
    // because no hooksPath routes to it — so an impl that hard-coded the paths and
    // ignored core.hooksPath would wrongly return true here. Must be false.
    mkdirSync(join(repo, ".husky", "_"), { recursive: true });
    writeFileSync(join(repo, ".husky", "_", "pre-push"), "#!/bin/sh\n");
    writeFileSync(join(repo, ".husky", "pre-push"), "#!/bin/sh\n");
    expect(prePushHookWillRun(repo)).toBe(false);
  });

  it("is FALSE when core.hooksPath points elsewhere (misrouted) despite both .husky files existing", () => {
    delete process.env.HUSKY;
    const repo = initRepo();
    mkdirSync(join(repo, ".husky", "_"), { recursive: true });
    writeFileSync(join(repo, ".husky", "_", "pre-push"), "#!/bin/sh\n");
    writeFileSync(join(repo, ".husky", "pre-push"), "#!/bin/sh\n");
    mkdirSync(join(repo, "other-hooks"), { recursive: true }); // no pre-push here
    git(repo, "config core.hooksPath other-hooks");
    expect(prePushHookWillRun(repo)).toBe(false);
  });

  it("is FALSE when the wrapper hook is missing at core.hooksPath", () => {
    delete process.env.HUSKY;
    const repo = initRepo();
    mkdirSync(join(repo, ".husky"), { recursive: true });
    writeFileSync(join(repo, ".husky", "pre-push"), "#!/bin/sh\n");
    git(repo, "config core.hooksPath .husky/_"); // dir/file does not exist
    expect(prePushHookWillRun(repo)).toBe(false);
  });

  it("is FALSE when the real hook body (.husky/pre-push) is missing", () => {
    delete process.env.HUSKY;
    const repo = initRepo();
    mkdirSync(join(repo, ".husky", "_"), { recursive: true });
    writeFileSync(join(repo, ".husky", "_", "pre-push"), "#!/bin/sh\n");
    git(repo, "config core.hooksPath .husky/_"); // wrapper present, body absent
    expect(prePushHookWillRun(repo)).toBe(false);
  });
});

describe("selectStableReleaseRun", () => {
  const runs = JSON.stringify([
    { databaseId: 1, headSha: "aaa", status: "completed", conclusion: "success" },
    { databaseId: 2, headSha: "bbb", status: "in_progress", conclusion: null },
  ]);

  it("returns the run whose headSha matches", () => {
    expect(selectStableReleaseRun(runs, "bbb")?.databaseId).toBe(2);
  });

  it("returns null when no headSha matches", () => {
    expect(selectStableReleaseRun(runs, "zzz")).toBeNull();
  });

  it("returns null for a non-array JSON payload", () => {
    expect(selectStableReleaseRun('{"not":"an array"}', "aaa")).toBeNull();
  });

  it("returns null for unparseable output", () => {
    expect(selectStableReleaseRun("not json at all", "aaa")).toBeNull();
  });
});

describe("shouldSoftenGcsWarning", () => {
  const run = (status: string, conclusion: string | null = null) => ({
    databaseId: 1,
    headSha: "aaa",
    status,
    conclusion,
  });

  it("softens only while the run is still in flight", () => {
    expect(shouldSoftenGcsWarning(run("in_progress"))).toBe(true);
    expect(shouldSoftenGcsWarning(run("queued"))).toBe(true);
  });

  it("does NOT soften a completed run (incl. failed) — a real publish failure must surface", () => {
    expect(shouldSoftenGcsWarning(run("completed", "failure"))).toBe(false);
    expect(shouldSoftenGcsWarning(run("completed", "success"))).toBe(false);
  });

  it("does NOT soften when no run was found", () => {
    expect(shouldSoftenGcsWarning(null)).toBe(false);
  });
});
