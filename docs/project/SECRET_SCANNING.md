---
description: "Secret scanning via TruffleHog — what it does, how to install, how to bypass, and how to handle false positives."
last_updated: "2026-06-22"
---

### Introduction

Rebel uses **[TruffleHog](https://github.com/trufflesecurity/trufflehog)** to detect leaked credentials before they reach the remote. TruffleHog scans every commit (locally via pre-commit hook) and every push to `dev`/`main` plus all PRs (CI), and only flags secrets that successfully authenticate against their provider — so false positives from AI-generated example/placeholder keys are essentially eliminated.

This replaces the Factory CLI's Droid Shield for this repo. You can disable Droid Shield in Factory settings if you wish.


### See also

- [SETUP_DEVELOPMENT_ENVIRONMENT.md](SETUP_DEVELOPMENT_ENVIRONMENT.md) — dev environment setup, including TruffleHog install
- [`.husky/pre-commit`](../../.husky/pre-commit) — the local hook
- [`.github/workflows/secret-scan.yml`](../../.github/workflows/secret-scan.yml) — the CI gate
- [TruffleHog upstream docs](https://github.com/trufflesecurity/trufflehog)
- [TruffleHog detector list](https://github.com/trufflesecurity/trufflehog#regular-expressions-and-credential-detection) — 800+ credential types


### Principles, key decisions

- **Verification, not regex.** TruffleHog runs in `--results=verified` mode: it attempts a real authentication call to the provider for every candidate it finds. If the credential doesn't authenticate, it's not flagged. This is the entire reason we picked it over regex-only scanners like Droid Shield or Gitleaks — AI assistants routinely emit plausible-looking placeholder keys, and regex tools flag all of them.
- **Defense in depth.** Pre-commit catches secrets before they enter git; CI catches anything that bypassed the hook (`--no-verify`, hookless clones, AI agents committing via raw git).
- **Hard-fail if missing.** The pre-commit hook refuses to run if TruffleHog isn't installed. Secret scanning is not optional. (We considered a soft warning but rejected it — silent skips are exactly how secrets leak in the first place.)
- **Block on day one.** Verified findings block the commit immediately. Because verification means the credential actually works, every finding is a live exposure that should not reach the remote.
- **Honest bypass path.** `SKIP_TRUFFLEHOG=1` skips the local scan for genuine emergencies. CI still runs and will catch any bypassed commits before they reach beta/production.
- **AGPL is fine for this use.** TruffleHog is AGPL-3.0, but we use it only as a dev tool — never bundled into the shipped Electron app or invoked at runtime. Tool-only use does not create a distribution obligation.


### Known gaps / defense-in-depth

TruffleHog runs in `--results=verified` mode, so a bare-base64 shared HMAC secret with no provider prefix and no verifiable auth endpoint is not detectable by it. The meeting-bot backend auth key class is now covered by a context-anchored forbidden pattern in [`mirror/oss-forbidden-patterns.ts`](../../mirror/oss-forbidden-patterns.ts) (`hardcoded meeting-bot auth key`), which makes `check:oss-surface` fail if that shape is reintroduced. See the [meeting-bot secret-leak plan](../plans/260622_fix-meeting-bot-secret-leak/PLAN.md).


### Install

#### macOS (recommended)

```bash
brew install trufflehog
```

The dev setup script (`scripts/setup-dev-mac.sh`) installs TruffleHog automatically in step 6.

#### Linux

```bash
curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh \
  | sh -s -- -b /usr/local/bin
```

#### Windows

Two options:

```powershell
# Option 1: scoop
scoop install trufflehog

# Option 2: download the latest release binary from
# https://github.com/trufflesecurity/trufflehog/releases
# and place trufflehog.exe somewhere on your PATH.
```


### How it runs

#### Pre-commit (local)

The hook is wired in [`.husky/pre-commit`](../../.husky/pre-commit). It runs:

```bash
git diff --cached --name-only --diff-filter=ACM \
  | xargs trufflehog filesystem --results=verified --fail --no-update
```

- **`git diff --cached --name-only --diff-filter=ACM`** — list of Added/Copied/Modified files in the staged commit. Deletions are skipped (nothing to scan).
- **`trufflehog filesystem`** — scans the specified files in the working tree. We use this rather than `trufflehog git --since-commit HEAD` because `--since-commit HEAD` only scans committed history; staged-but-uncommitted content is invisible to it. Pre-commit needs to scan the staged state.
- **`--results=verified`** — only flag credentials that authenticate against their provider. The whole point.
- **`--fail`** — exit 1 on findings, blocking the commit.
- **`--no-update`** — don't phone home for self-update during a commit.

Typical scan time: <100ms on a small staged diff; <2s on larger commits.

If TruffleHog is not installed, the hook fails with install instructions. Secret scanning is not optional.

**Caveat:** the filesystem scan covers the *whole* of each modified file, not just the staged diff hunks. If a file you're modifying already contains a leaked-and-still-live secret (one that bypassed an earlier check), the hook will flag it on your next commit to that file. That's intentional defense-in-depth — but if you hit it, the secret should be rotated and removed regardless of whether *you* added it.

#### CI

[`.github/workflows/secret-scan.yml`](../../.github/workflows/secret-scan.yml) runs the official TruffleHog action on every push to `dev`/`main` and every pull request. It scans the commit range introduced by the push or PR with the same `--results=verified --fail` flags.

CI failure blocks the workflow. It does not block merge automatically — that's controlled by branch protection rules on the GitHub side.


#### Public Mirror Allowlist Governance

The OSS mirror has a separate repo-side governance file: [`.trufflehog-public-allowlist.yaml`](../../.trufflehog-public-allowlist.yaml). It documents strings that are considered public-safe for the mirror, such as role inboxes at corporate domains, well-known public test-key prefixes, and IETF/RFC documentation fixtures.

This YAML is **not** a TruffleHog config and must not be passed to TruffleHog via `--config`. The mirror TruffleHog step runs verified-mode scanning directly; if native path exclusions are ever required, use a separate `.trufflehog-exclude-paths.txt` file with newline-delimited paths for TruffleHog's `--exclude-paths`.

The governance file is validated by [`scripts/check-trufflehog-public-allowlist.ts`](../../scripts/check-trufflehog-public-allowlist.ts), wired into `validate:fast` as `validate:trufflehog-public-allowlist`. The validator is deny-by-default: every entry must declare `kind: corporate-inbox`, `kind: public-test-key`, or `kind: public-fixture`, and each kind has stricter rules so employee inboxes, internal Slack/Linear URLs, Slack-shaped tokens, production token patterns, and arbitrary domains fail closed.


### Bypass

For genuine emergencies only:

```bash
SKIP_TRUFFLEHOG=1 git commit -m "..."
```

This skips the local pre-commit scan. **CI will still run** and catch the commit if it contains a verified secret. Treat the bypass as a temporary measure — never as a way around real findings.

If you find yourself reaching for the bypass regularly, something is wrong:

- A real secret keeps appearing in your changes (rotate and remove)
- TruffleHog is genuinely flagging a false positive (see below — this should be very rare in verified mode)
- The hook is misconfigured (file an issue)


### Handling findings

When TruffleHog blocks a commit, it prints the detector type, raw value, file, and line number. The credential is **verified live** — treat it as an active exposure:

1. **Revoke the credential at the provider.** Rotate it. Do not edit the file and re-commit hoping the secret won't matter — git history retains everything until rewritten.
2. **Remove the credential from your working tree.** Replace with `process.env.X` or equivalent, or move to a secret manager.
3. **Commit the fix.** The hook will pass once the live credential is gone from your staged diff.
4. **If the credential was already committed in a prior commit** (CI catches this when pre-commit doesn't): rotate the key, then decide whether to clean git history. See "Cleaning git history" below.


### False positives

In verified mode, false positives are rare by construction — a credential has to actually authenticate to be flagged. If you believe TruffleHog has made a genuine error:

1. **Confirm it's a false positive.** Run TruffleHog manually on the file with `--results=verified` and inspect the detector type. If the credential genuinely doesn't work (e.g., it's a test fixture pointing at a mock), file an upstream issue at [trufflesecurity/trufflehog](https://github.com/trufflesecurity/trufflehog/issues).
2. **Short-term workaround:** use `SKIP_TRUFFLEHOG=1` for that single commit and document why.
3. **Long-term:** TruffleHog supports detector exclusions, but we have not yet needed an allowlist. If recurring FPs emerge, propose an allowlist mechanism via PR.


### Cleaning git history

If a verified secret was committed previously and lives in git history (not just HEAD), the secret is recoverable via `git log -p` until history is rewritten. Two approaches:

| Approach | Effort | Notes |
|---|---|---|
| **Rotate only** | Low | Key is dead in history but still visible. Acceptable for low-value credentials. |
| **`git filter-repo` rewrite** | High | Removes the secret from history. Requires force-push to `dev`/`main`, coordinated re-clone for every dev/agent, and rebasing all open branches. |

For this repo's multi-agent workflow, **rotation alone is usually the right call** unless the exposed credential is high-value (production database, payment processor, etc.). History rewriting on a busy repo causes more disruption than it removes.


### Architecture

```
Layer 1 — Local pre-commit (.husky/pre-commit)
   ├─ Materialize staged blobs to a temp dir (scans index, not worktree)
   ├─ trufflehog filesystem <tmpdir> --results=verified --fail
   ├─ Fast (~1-2s on typical staged diffs)
   ├─ Hard-fail if trufflehog not on PATH
   └─ Bypass: SKIP_TRUFFLEHOG=1

Layer 2 — CI standalone (.github/workflows/secret-scan.yml)
   ├─ Trigger: push to dev/main + all PRs
   ├─ Pinned action: trufflesecurity/trufflehog@v3.95.2
   ├─ Runs in parallel with other workflows
   └─ Catches: --no-verify, hookless clones, raw-git AI agents

Layer 3 — Deploy gate (.github/workflows/release.yml → secret-scan job)
   ├─ Calls the same secret-scan workflow via workflow_call
   ├─ Runs in parallel with verify-submodules + setup (fast, ~1 min)
   ├─ validate-and-test needs: it, so ALL platform builds are gated
   └─ Fail-fast: a verified secret aborts before ~30 min of Mac/Linux/Windows builds
```

#### Scan range determination

The reusable workflow computes the scan range explicitly so it works
correctly across event types:

| Triggering event | Range scanned |
|---|---|
| `push` (normal commit) | `event.before .. event.after` (just the new commits) |
| `push` (first push to branch, `before=0000...`) | `HEAD~1 .. HEAD` |
| `pull_request` | auto-detected from `base.sha .. head.sha` |
| `workflow_dispatch` (release.yml via beta-deploy-trigger) | `HEAD~1 .. HEAD` |

Without explicit ranges, the action falls back to scanning **all** history,
which would re-flag any historical findings on every deploy — and would
have made Greg's pre-existing ElevenLabs leak block beta deploys forever.


### Operational notes

#### Direct-to-dev push timing

Most pushes in this repo go straight to `dev` without a PR. CI is therefore an **after-the-fact alert**, not a gate — by the time the workflow runs, the commit is already on the remote. Don't rely on CI to prevent leaks; rely on the pre-commit hook. CI exists to catch commits that bypassed the hook (`--no-verify`, hookless clones, raw-git AI agents) so you find out within a minute or two of pushing and can rotate immediately.

If you want CI to actually block, configure GitHub branch protection on `dev` to require this workflow to pass before push, or enable GitHub's native push protection. Neither is configured by default in this repo.

#### Network partition

TruffleHog's verification step makes outbound HTTPS calls to provider APIs (ElevenLabs, AWS, Anthropic, etc.). On a disconnected dev machine or behind a corporate proxy that blocks those endpoints:

- Candidate secrets that can't be verified are classified as `unknown` and **do not** trigger `--fail` in our `--results=verified` configuration.
- This means a leaked credential could slip past the local hook if verification can't complete.
- CI (on GitHub-hosted runners) has reliable network and will catch the leak shortly after push.

If you commit on a flaky network and you want stronger local guarantees, change the local hook to `--results=verified,unknown` (will introduce some false positives — every unknown counts as a finding).

#### Windows bypass syntax

Setting `SKIP_TRUFFLEHOG=1` differs by shell:

```bash
# bash / zsh / Git Bash / WSL
SKIP_TRUFFLEHOG=1 git commit -m "..."
```

```powershell
# PowerShell
$env:SKIP_TRUFFLEHOG=1; git commit -m "..."
# Or for one-off use:
cmd /c "set SKIP_TRUFFLEHOG=1 && git commit -m ..."
```


### Why we picked TruffleHog (alternatives considered)

| Tool | Stars | License | Detection | False positives | Verdict |
|---|---|---|---|---|---|
| **TruffleHog** | ~24.5k | AGPL-3.0 | Regex + live API verification (800+ types) | Very low | **Chosen** |
| Gitleaks | ~19-24k | MIT | Regex only | Medium-high; needs allowlist | Fallback if AGPL blocked |
| detect-secrets (Yelp) | ~4k | Apache-2.0 | Entropy + plugins + baseline file | Low after baseline audit | Good for noisy legacy repos |
| GitGuardian ggshield | ~1.7k | MIT client / commercial backend | ML + verification + AI-output hook | Very low | Worth adding as Layer 3 if budget allows |
| Droid Shield (Factory CLI) | n/a | Proprietary | Regex patterns | High in AI-first repos | What we're replacing |

The verification primitive is the differentiator. In AI-first codebases like ours, AI assistants emit a high volume of plausible-but-fake keys in fixtures, tests, and example docs. Regex-only tools flag all of them; TruffleHog quietly skips them because they don't authenticate.
