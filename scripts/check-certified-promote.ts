#!/usr/bin/env npx tsx

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface CertifiedPromoteInputs {
  isProduction: boolean;
  certifiedShaEnv: string | undefined;
  pushedOid: string | undefined;
  prevOid: string | undefined;
  isAncestor: (ancestor: string, descendant: string) => boolean;
  resolveFreshDevTip: () => string | undefined;
}

export interface CertifiedPromoteCliOptions {
  isProduction: boolean;
  pushedOid?: string;
  prevOid?: string;
  remote: string;
}

interface CertifiedPromoteCliDeps {
  env: NodeJS.ProcessEnv;
  argv: string[];
  isAncestor: (ancestor: string, descendant: string) => boolean;
  resolveFreshDevTip: (remote: string) => string | undefined;
}

interface CertifiedPromoteCliResult {
  exitCode: 0 | 1;
  reason: string;
}

const ZERO_OID_RE = /^0+$/;
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isOid(value: string): boolean {
  return OID_RE.test(value);
}

function oidCandidate(value: string | undefined): string | undefined {
  const trimmed = nonEmpty(value);
  if (!trimmed || value !== trimmed) return undefined;
  return trimmed;
}

export function isCertifiedPromote(i: CertifiedPromoteInputs): boolean {
  if (!i.isProduction) return false;

  const certifiedSha = oidCandidate(i.certifiedShaEnv);
  const pushedOid = oidCandidate(i.pushedOid);
  const prevOid = oidCandidate(i.prevOid);
  if (!certifiedSha || !pushedOid || pushedOid !== certifiedSha) return false;
  if (!prevOid || ZERO_OID_RE.test(prevOid)) return false;
  if (!isOid(certifiedSha) || !isOid(pushedOid) || !isOid(prevOid)) return false;

  try {
    if (!i.isAncestor(prevOid, pushedOid)) return false;
    const devTip = nonEmpty(i.resolveFreshDevTip());
    if (!devTip) return false;
    return i.isAncestor(pushedOid, devTip);
  } catch {
    return false;
  }
}

export function parseCertifiedPromoteArgs(argv: string[]): CertifiedPromoteCliOptions {
  const options: CertifiedPromoteCliOptions = {
    isProduction: false,
    remote: 'origin',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--is-production') {
      options.isProduction = true;
    } else if (arg === '--pushed-oid') {
      options.pushedOid = argv[index + 1];
      index += 1;
    } else if (arg === '--prev-oid') {
      options.prevOid = argv[index + 1];
      index += 1;
    } else if (arg === '--remote') {
      options.remote = argv[index + 1] ?? 'origin';
      index += 1;
    }
  }

  options.remote = nonEmpty(options.remote) ?? 'origin';
  return options;
}

export function runCertifiedPromoteCli(deps: CertifiedPromoteCliDeps): CertifiedPromoteCliResult {
  try {
    const options = parseCertifiedPromoteArgs(deps.argv);
    const certified = isCertifiedPromote({
      isProduction: options.isProduction,
      certifiedShaEnv: deps.env.REBEL_CERTIFIED_PROMOTE_SHA,
      pushedOid: options.pushedOid,
      prevOid: options.prevOid,
      isAncestor: deps.isAncestor,
      resolveFreshDevTip: () => deps.resolveFreshDevTip(options.remote),
    });

    return certified
      ? { exitCode: 0, reason: 'certified promote verified' }
      : { exitCode: 1, reason: 'not a certified promote' };
  } catch (error) {
    return {
      exitCode: 1,
      reason: `certified promote check errored (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

// Bound every git subprocess: a hung call (esp. the network `fetch`) must not block the
// pre-push hook — and therefore the release — indefinitely. On timeout execFileSync throws,
// which the catch maps to false/undefined → "not a certified promote" → the full suite runs.
const GIT_TIMEOUT_MS = 30_000;

function gitIsAncestor(ancestor: string, descendant: string): boolean {
  try {
    // git-exec-allow: relies on `merge-base --is-ancestor` exit status as a boolean; captures no output (stdio:ignore), so the maxBuffer concern this gate guards doesn't apply.
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      stdio: 'ignore',
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

function gitResolveFreshDevTip(remote: string): string | undefined {
  try {
    // git-exec-allow: quiet fetch, captures no output (stdio:ignore); any failure falls back to not-certified (full suite runs).
    execFileSync('git', ['fetch', '--quiet', remote, 'refs/heads/dev'], {
      stdio: 'ignore',
      timeout: GIT_TIMEOUT_MS,
    });
    // git-exec-allow: reads one bounded OID (FETCH_HEAD, ~40-64 bytes); failure falls back to not-certified.
    return execFileSync('git', ['rev-parse', 'FETCH_HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch {
    return undefined;
  }
}

function main(): void {
  const result = runCertifiedPromoteCli({
    env: process.env,
    argv: process.argv.slice(2),
    isAncestor: gitIsAncestor,
    resolveFreshDevTip: gitResolveFreshDevTip,
  });
  console.error(`pre-push: certified-promote check: ${result.reason}`);
  process.exit(result.exitCode);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
