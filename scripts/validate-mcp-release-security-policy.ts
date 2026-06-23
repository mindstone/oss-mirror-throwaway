#!/usr/bin/env npx tsx
/**
 * CI Validation: MCP Release Security Policy
 *
 * Static fail-closed backstop for scripts/mcp-release.ts. Unit tests cover the
 * pure decisions; this validate:fast gate catches a refactor that removes or
 * bypasses the release-security guardrails without touching those tests.
 *
 * Run: npx tsx scripts/validate-mcp-release-security-policy.ts
 * Wired into: npm run validate:fast (scripts/run-validate-fast.ts)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONNECTOR_RELEASE_MAPPINGS,
  type ConnectorReleaseMapping,
} from './mcp-release-catalog-mapping';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_RELEASE_PATH = path.join(ROOT, 'scripts', 'mcp-release.ts');
const MCP_RELEASE_FILE = 'scripts/mcp-release.ts';
const MAPPING_FILE = 'scripts/mcp-release-catalog-mapping.ts';

const CONNECTOR_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const NPM_PACKAGE_RE = /^@mindstone\/mcp-server-[a-z0-9-]+$/;

export function checkMappedConnectorSecurityReviewPolicy(
  mappings: Readonly<Record<string, ConnectorReleaseMapping>>,
): string[] {
  const errors: string[] = [];
  for (const [key, mapping] of Object.entries(mappings)) {
    if (mapping.name !== key) {
      errors.push(
        `${MAPPING_FILE}: mapping key "${key}" must match mapping.name "${mapping.name}" ` +
          'so the default security review path suffix is unambiguous.',
      );
    }
    if (!CONNECTOR_NAME_RE.test(mapping.name)) {
      errors.push(
        `${MAPPING_FILE}: mapping "${key}" has invalid name "${mapping.name}". ` +
          'Security reviews resolve as <yyMMdd>_<name>_<version>.md, so names must be lowercase slug ids.',
      );
    }
    if (!NPM_PACKAGE_RE.test(mapping.npmPackage)) {
      errors.push(
        `${MAPPING_FILE}: mapping "${key}" has invalid npmPackage "${mapping.npmPackage}". ` +
          'The security gate validates Package against this exact value.',
      );
    }
  }
  return errors;
}

export function validateMcpReleaseSecurityPolicySource(
  source: string,
  mappings: Readonly<Record<string, ConnectorReleaseMapping>> = CONNECTOR_RELEASE_MAPPINGS,
): string[] {
  const errors: string[] = [];

  if (!source.includes('MCP_RELEASE_SKIP_SECURITY_REVIEW is no longer supported')) {
    errors.push(
      `${MCP_RELEASE_FILE}: missing the MCP_RELEASE_SKIP_SECURITY_REVIEW rejection message. ` +
        'Update this policy gate if the security-review contract changed; otherwise restore the fail-closed throw.',
    );
  }
  if (!source.includes('Every agent-driven connector release requires a security review artifact')) {
    errors.push(
      `${MCP_RELEASE_FILE}: missing the mandatory security-review artifact message. ` +
        'The release path must fail closed instead of honoring MCP_RELEASE_SKIP_SECURITY_REVIEW.',
    );
  }

  const skipGuardRegion = extractFunctionRegion(source, 'assertSecurityReviewNotSkipped');
  if (!skipGuardRegion) {
    errors.push(`${MCP_RELEASE_FILE}: missing assertSecurityReviewNotSkipped().`);
  } else {
    const skipGuardStart = source.indexOf(skipGuardRegion);
    const skipGuardEnd = skipGuardStart + skipGuardRegion.length;
    const skipEnvMentions = [...source.matchAll(/MCP_RELEASE_SKIP_SECURITY_REVIEW/g)]
      .map((match) => match.index)
      .filter((index): index is number => index !== undefined);
    const outsideSkipGuard = skipEnvMentions.filter((index) => index < skipGuardStart || index >= skipGuardEnd);
    if (outsideSkipGuard.length > 0) {
      errors.push(
        `${MCP_RELEASE_FILE}: MCP_RELEASE_SKIP_SECURITY_REVIEW must only be handled inside ` +
          'assertSecurityReviewNotSkipped(); remove any bypass path or update this policy gate intentionally.',
      );
    }
    if (!/MCP_RELEASE_SKIP_SECURITY_REVIEW\s*===\s*['"]1['"]/.test(skipGuardRegion)) {
      errors.push(`${MCP_RELEASE_FILE}: assertSecurityReviewNotSkipped() no longer checks MCP_RELEASE_SKIP_SECURITY_REVIEW === '1'.`);
    }
    if (!/throw\s+new\s+Error\s*\(/.test(skipGuardRegion)) {
      errors.push(`${MCP_RELEASE_FILE}: assertSecurityReviewNotSkipped() must throw on MCP_RELEASE_SKIP_SECURITY_REVIEW=1.`);
    }
  }

  const verifyRegion = extractFunctionRegion(source, 'verifySecurityReviewGate');
  if (!verifyRegion) {
    errors.push(`${MCP_RELEASE_FILE}: missing verifySecurityReviewGate().`);
  } else {
    const guardIndex = verifyRegion.indexOf('assertSecurityReviewNotSkipped(');
    const resolveIndex = verifyRegion.indexOf('resolveSecurityReviewPath(');
    if (guardIndex === -1) {
      errors.push(`${MCP_RELEASE_FILE}: verifySecurityReviewGate() must call assertSecurityReviewNotSkipped().`);
    } else if (resolveIndex !== -1 && guardIndex > resolveIndex) {
      errors.push(
        `${MCP_RELEASE_FILE}: verifySecurityReviewGate() must reject MCP_RELEASE_SKIP_SECURITY_REVIEW ` +
          'before resolving or reading a review artifact.',
      );
    }
  }

  const approvalRegion = extractFunctionRegion(source, 'evaluatePushApproval');
  if (!approvalRegion) {
    errors.push(`${MCP_RELEASE_FILE}: missing evaluatePushApproval().`);
  } else {
    if (!/pushApprovalEnv\s*===\s*expected/.test(approvalRegion)) {
      errors.push(`${MCP_RELEASE_FILE}: evaluatePushApproval() must approve only the exact MCP_RELEASE_PUSH_APPROVAL token.`);
    }
    if (!/!args\.isTTY/.test(approvalRegion) || !approvalRegion.includes('rejected-non-tty')) {
      errors.push(`${MCP_RELEASE_FILE}: evaluatePushApproval() must reject non-TTY push stages without prompting.`);
    }
    if (approvalRegion.includes('MCP_RELEASE_AUTO_APPROVE')) {
      errors.push(`${MCP_RELEASE_FILE}: evaluatePushApproval() must not allow MCP_RELEASE_AUTO_APPROVE to approve push stages.`);
    }
  }

  const confirmRegion = extractFunctionRegion(source, 'confirmPush');
  if (!confirmRegion) {
    errors.push(`${MCP_RELEASE_FILE}: missing confirmPush().`);
  } else {
    if (!confirmRegion.includes('MCP_RELEASE_AUTO_APPROVE=1) does not approve push stages')) {
      errors.push(`${MCP_RELEASE_FILE}: confirmPush() must keep the AUTO_APPROVE-does-not-push warning.`);
    }
    if (!confirmRegion.includes('evaluatePushApproval({')) {
      errors.push(`${MCP_RELEASE_FILE}: confirmPush() must delegate the push decision to evaluatePushApproval().`);
    }
    if (!confirmRegion.includes("case 'rejected-non-tty'") || !confirmRegion.includes('Cannot prompt for ${stage}: stdin is not a TTY')) {
      errors.push(`${MCP_RELEASE_FILE}: confirmPush() must throw on rejected-non-tty push decisions.`);
    }
  }

  errors.push(...checkMappedConnectorSecurityReviewPolicy(mappings));
  return errors;
}

function extractFunctionRegion(source: string, functionName: string): string | null {
  const match = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\s*\\(`).exec(source);
  if (!match) return null;
  const rest = source.slice(match.index + 1);
  const next = /\n(?:export\s+)?(?:async\s+)?function\s+[A-Za-z0-9_]+\s*\(/.exec(rest);
  const end = next ? match.index + 1 + next.index : source.length;
  return source.slice(match.index, end);
}

function main(): number {
  let source: string;
  try {
    source = fs.readFileSync(MCP_RELEASE_PATH, 'utf8');
  } catch (err) {
    process.stderr.write(
      `validate-mcp-release-security-policy: FAIL - could not read ${MCP_RELEASE_FILE}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const errors = validateMcpReleaseSecurityPolicySource(source);
  if (errors.length === 0) {
    process.stdout.write(
      `validate-mcp-release-security-policy: OK - ${Object.keys(CONNECTOR_RELEASE_MAPPINGS).length} ` +
        'mapped connector release(s) keep fail-closed security-review and push-approval policy markers.\n',
    );
    return 0;
  }

  process.stderr.write(
    `validate-mcp-release-security-policy: FAIL - ${errors.length} release-security policy problem(s):\n\n`,
  );
  for (const error of errors) {
    process.stderr.write(`  - ${error}\n`);
  }
  process.stderr.write(
    '\nIf scripts/mcp-release.ts changed intentionally, update this policy gate and the matching unit tests in the same change.\n',
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
