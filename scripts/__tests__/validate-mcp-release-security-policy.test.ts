import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_RELEASE_MAPPINGS,
  type ConnectorReleaseMapping,
} from '../mcp-release-catalog-mapping';
import { validateMcpReleaseSecurityPolicySource } from '../validate-mcp-release-security-policy';

const SOURCE_PATH = path.join(__dirname, '..', 'mcp-release.ts');
const REAL_SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

function replaceOnce(source: string, search: string | RegExp, replacement: string): string {
  const mutated = source.replace(search, replacement);
  expect(mutated).not.toBe(source);
  return mutated;
}

function expectRelevantError(errors: string[], pattern: RegExp): void {
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.some((error) => pattern.test(error))).toBe(true);
}

describe('validateMcpReleaseSecurityPolicySource', () => {
  it('accepts the real mcp-release security policy source', () => {
    expect(validateMcpReleaseSecurityPolicySource(REAL_SOURCE)).toEqual([]);
  });

  it('rejects a source that drops the assertSecurityReviewNotSkipped guard call', () => {
    const mutated = replaceOnce(REAL_SOURCE, '  assertSecurityReviewNotSkipped();\n\n', '');
    const errors = validateMcpReleaseSecurityPolicySource(mutated);

    expectRelevantError(errors, /verifySecurityReviewGate\(\) must call assertSecurityReviewNotSkipped\(\)/);
  });

  it('rejects MCP_RELEASE_SKIP_SECURITY_REVIEW handling outside the guard', () => {
    const mutated = replaceOnce(
      REAL_SOURCE,
      '  const reviewPath = resolveSecurityReviewPath(mapping, version, reviewPathFlag);\n',
      "  if (process.env.MCP_RELEASE_SKIP_SECURITY_REVIEW === '1') return { path: '', sha256: '' };\n" +
        '  const reviewPath = resolveSecurityReviewPath(mapping, version, reviewPathFlag);\n',
    );
    const errors = validateMcpReleaseSecurityPolicySource(mutated);

    expectRelevantError(errors, /MCP_RELEASE_SKIP_SECURITY_REVIEW must only be handled inside/);
  });

  it('rejects a source that removes non-TTY push approval rejection', () => {
    const mutated = replaceOnce(
      REAL_SOURCE,
      "  if (!args.isTTY) return { kind: 'rejected-non-tty', expectedToken: expected };\n",
      '',
    );
    const errors = validateMcpReleaseSecurityPolicySource(mutated);

    expectRelevantError(errors, /evaluatePushApproval\(\) must reject non-TTY push stages without prompting/);
  });

  it('rejects a mapped connector with a malformed npmPackage', () => {
    const mappings: Record<string, ConnectorReleaseMapping> = {
      ...CONNECTOR_RELEASE_MAPPINGS,
      'retell-ai': {
        ...CONNECTOR_RELEASE_MAPPINGS['retell-ai']!,
        npmPackage: '@mindstone/retell-ai',
      },
    };
    const errors = validateMcpReleaseSecurityPolicySource(REAL_SOURCE, mappings);

    expectRelevantError(errors, /mapping "retell-ai" has invalid npmPackage "@mindstone\/retell-ai"/);
  });
});
