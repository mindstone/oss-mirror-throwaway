import { describe, it, expect } from 'vitest';
import {
  checkHookMarkerDetection,
  checkWorkflowMarkerDetection,
} from '../check-commit-marker-detection';

describe('checkHookMarkerDetection', () => {
  const goodHook = [
    'current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)',
    'commit_subject=$(git log -1 --pretty=%s 2>/dev/null || true)',
    'case "$commit_subject" in *"[deploy-beta]"*) is_beta=1 ;; esac',
    'case "$commit_subject" in *"[skip-tests]"*) skip_tests=1 ;; esac',
  ].join('\n');

  it('passes when markers are matched against a %s (subject) variable', () => {
    const r = checkHookMarkerDetection(goodHook);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('FAILS the footgun: marker variable assigned from %B (full body)', () => {
    const bad = [
      'commit_msg=$(git log -1 --pretty=%B 2>/dev/null || true)',
      'case "$commit_msg" in *"[deploy-beta]"*) is_beta=1 ;; esac',
      'case "$commit_msg" in *"[skip-tests]"*) skip_tests=1 ;; esac',
    ].join('\n');
    const r = checkHookMarkerDetection(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/%B/);
    expect(r.errors.join('\n')).toMatch(/subject only/i);
  });

  it('accepts the --format synonym and a quoted format', () => {
    const ok = [
      "commit_subject=$(git log -1 --format='%s' 2>/dev/null || true)",
      'case "$commit_subject" in *"[deploy-beta]"*) is_beta=1 ;; esac',
      'case "$commit_subject" in *"[skip-tests]"*) skip_tests=1 ;; esac',
    ].join('\n');
    expect(checkHookMarkerDetection(ok).ok).toBe(true);
  });

  it('fails when a marker variable has no git log assignment to confirm subject-only', () => {
    const bad = [
      'commit_subject="$SOME_OTHER_SOURCE"',
      'case "$commit_subject" in *"[deploy-beta]"*) is_beta=1 ;; esac',
    ].join('\n');
    const r = checkHookMarkerDetection(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/no .*git log.*assignment/i);
  });

  it('fails when no marker case statement exists at all', () => {
    const r = checkHookMarkerDetection('echo "no markers here"');
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/no .*marker detection found/i);
  });

  it('ignores marker tokens that appear only in comments', () => {
    const commented = [
      '# This hook checks for [deploy-beta] and [skip-tests] markers.',
      'commit_subject=$(git log -1 --pretty=%s 2>/dev/null || true)',
      'case "$commit_subject" in *"[deploy-beta]"*) is_beta=1 ;; esac',
      'case "$commit_subject" in *"[skip-tests]"*) skip_tests=1 ;; esac',
    ].join('\n');
    expect(checkHookMarkerDetection(commented).ok).toBe(true);
  });
});

describe('checkWorkflowMarkerDetection', () => {
  it('passes when jq extracts the subject (split) before grep', () => {
    const good =
      `          FOUND=$(jq -r '.commits[]? | (.message // "" | split("\\n")[0])' "$GITHUB_EVENT_PATH" | grep -ciF '[deploy-beta]' || true)`;
    const r = checkWorkflowMarkerDetection(good);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('FAILS the footgun: jq greps the full .commits[].message (no split)', () => {
    const bad =
      `          FOUND=$(jq -r '.commits[].message' "$GITHUB_EVENT_PATH" | grep -ciF '[deploy-beta]' || true)`;
    const r = checkWorkflowMarkerDetection(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/full commit message/i);
  });

  it('fails when no jq-over-commits → grep [deploy-beta] detection line is present', () => {
    const r = checkWorkflowMarkerDetection('echo "no detection here"');
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/no .*detection line/i);
  });

  it('ignores a commented-out footgun line', () => {
    const commented = [
      `          # old: FOUND=$(jq -r '.commits[].message' "$P" | grep -ciF '[deploy-beta]')`,
      `          FOUND=$(jq -r '.commits[]? | (.message // "" | split("\\n")[0])' "$P" | grep -ciF '[deploy-beta]' || true)`,
    ].join('\n');
    expect(checkWorkflowMarkerDetection(commented).ok).toBe(true);
  });
});
