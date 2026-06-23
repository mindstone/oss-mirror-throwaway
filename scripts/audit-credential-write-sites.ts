#!/usr/bin/env npx tsx
import fs from 'node:fs';
import path from 'node:path';

export type AuditTarget = {
  relativePath: string;
  minAtomicCalls: number;
  minDirModeCalls: number;
};

export const AUDIT_TARGETS: AuditTarget[] = [
  {
    relativePath: 'src/main/services/hubspotAuthService.ts',
    minAtomicCalls: 2,
    minDirModeCalls: 2,
  },
  {
    relativePath: 'src/main/services/slackAuthService.ts',
    minAtomicCalls: 4,
    minDirModeCalls: 2,
  },
];

type ForbiddenWritePattern = {
  label: string;
  pattern: RegExp;
};

const FORBIDDEN_WRITE_PATTERNS: ForbiddenWritePattern[] = [
  { label: 'writeFileSync', pattern: /\b(?:fs\.)?writeFileSync\s*\(/g },
  { label: 'fs.promises.writeFile', pattern: /\bfs\.promises\.writeFile\s*\(/g },
  { label: 'writeFile', pattern: /\b(?:fs\.(?!promises\.)writeFile|(?<!\.)writeFile)\s*\(/g },
  { label: 'outputFileSync', pattern: /\b(?:[A-Za-z_$][\w$]*\.)?outputFileSync\s*\(/g },
];

const repoRoot = path.resolve(__dirname, '..');

function countMatches(content: string, pattern: RegExp): number {
  return (content.match(pattern) ?? []).length;
}

export function detectForbiddenCredentialWrites(
  content: string,
): Array<{ label: string; count: number }> {
  return FORBIDDEN_WRITE_PATTERNS
    .map(({ label, pattern }) => ({ label, count: countMatches(content, pattern) }))
    .filter(({ count }) => count > 0);
}

export function auditTargetContent(content: string): {
  hasHelperImport: boolean;
  atomicCalls: number;
  dirModeCalls: number;
  forbiddenWrites: Array<{ label: string; count: number }>;
} {
  return {
    hasHelperImport: content.includes("from '@core/utils/atomicCredentialWrite'"),
    atomicCalls: countMatches(content, /\batomicCredentialWrite\s*\(/g),
    dirModeCalls: countMatches(content, /\bmkdir\s*\([\s\S]*?\{[\s\S]*?mode:\s*0o700[\s\S]*?\}\s*\)/g),
    forbiddenWrites: detectForbiddenCredentialWrites(content),
  };
}

function main(): void {
  let failed = false;

  for (const target of AUDIT_TARGETS) {
    let targetFailed = false;
    const absolutePath = path.join(repoRoot, target.relativePath);
    const content = fs.readFileSync(absolutePath, 'utf8');

    const { hasHelperImport, atomicCalls, dirModeCalls, forbiddenWrites } = auditTargetContent(content);
    const totalForbiddenWriteCalls = forbiddenWrites.reduce((total, entry) => total + entry.count, 0);

    if (!hasHelperImport) {
      console.error(`❌ ${target.relativePath}: missing atomicCredentialWrite import`);
      targetFailed = true;
      failed = true;
    }
    if (atomicCalls < target.minAtomicCalls) {
      console.error(
        `❌ ${target.relativePath}: expected at least ${target.minAtomicCalls} atomicCredentialWrite calls, found ${atomicCalls}`,
      );
      targetFailed = true;
      failed = true;
    }
    if (totalForbiddenWriteCalls > 0) {
      const variantSummary = forbiddenWrites
        .map(({ label, count }) => `${label}=${count}`)
        .join(', ');
      console.error(
        `❌ ${target.relativePath}: found ${totalForbiddenWriteCalls} forbidden credential write call(s) (${variantSummary})`,
      );
      targetFailed = true;
      failed = true;
    }
    if (dirModeCalls < target.minDirModeCalls) {
      console.error(
        `❌ ${target.relativePath}: expected at least ${target.minDirModeCalls} mkdir(..., { mode: 0o700 }) call(s), found ${dirModeCalls}`,
      );
      targetFailed = true;
      failed = true;
    }

    if (!targetFailed) {
      console.log(
        `✅ ${target.relativePath}: atomic=${atomicCalls}, mkdir(mode:0o700)=${dirModeCalls}, forbiddenWrites=${totalForbiddenWriteCalls}`,
      );
    } else {
      console.log(
        `ℹ️ ${target.relativePath}: atomic=${atomicCalls}, mkdir(mode:0o700)=${dirModeCalls}, forbiddenWrites=${totalForbiddenWriteCalls}`,
      );
    }
  }

  if (failed) {
    process.exit(1);
  }

  console.log('✅ Credential write audit passed.');
}

if (!process.env.VITEST) {
  main();
}
