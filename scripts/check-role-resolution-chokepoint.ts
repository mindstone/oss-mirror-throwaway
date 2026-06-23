#!/usr/bin/env npx tsx
/**
 * CI guard: the migrated role-display surfaces must keep global working/thinking
 * role resolution behind the canonical resolver path.
 *
 * Why: F5 drift came from re-deriving global role models from raw role fields
 * (`workingProfileId` / `thinkingProfileId` -> `profiles.find(...).model`, plus
 * "thinking inherits working") instead of `resolveAllRoleAssignments` / resolved
 * values. A repo-wide ESLint rule was dropped after Stage 3 because it was too noisy.
 * This mirrors the sibling guards: file-scoped, raw-text, low-FP chokepoint checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.cwd();

export type RoleResolutionChokepointViolation = { readonly relativePath: string; readonly message: string };

const TARGET_FILES = [
  {
    relativePath: path.join('src', 'renderer', 'features', 'agent-session', 'components', 'ConversationModelSelector.tsx'),
    required: [
      {
        re: /\bresolveAllRoleAssignments\s*\(/,
        description: 'resolveAllRoleAssignments()',
      },
    ],
  },
  {
    relativePath: path.join('src', 'shared', 'data', 'qualityTiers.ts'),
    required: [
      {
        re: /\binterface\s+QualityTierResolvedGlobalDefault\b/,
        description: 'QualityTierResolvedGlobalDefault',
      },
      {
        re: /\boverridesMatchGlobalDefault\s*\([\s\S]*?\bresolvedGlobal\s*:\s*QualityTierResolvedGlobalDefault\b/,
        description: 'overridesMatchGlobalDefault(..., resolvedGlobal: QualityTierResolvedGlobalDefault)',
      },
    ],
  },
] as const;

const BYPASS_PATTERNS = [
  {
    name: 'raw-role-profile-model-lookup',
    re: /\bprofiles\s*\.\s*find\s*\([\s\S]{0,240}\b(?:globalWorkingProfileId|globalThinkingProfileId|workingProfileId|thinkingProfileId)\b[\s\S]{0,240}\)\s*\??\.\s*model\b/,
    why: 'profile-id-to-model lookups for global role derivation must go through resolveAllRoleAssignments()',
  },
  {
    name: 'raw-global-defaults-plus-profiles-api',
    re: /\boverridesMatchGlobalDefault\s*\([\s\S]{0,360}\bglobalDefaults\b[\s\S]{0,360}\bprofiles\b/,
    why: 'overridesMatchGlobalDefault must consume QualityTierResolvedGlobalDefault values, not raw globalDefaults + profiles',
  },
] as const;

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function fail(message: string): never {
  console.error(`\n✗ check-role-resolution-chokepoint: ${message}\n`);
  process.exit(1);
}

export function checkRoleResolutionChokepoint(
  readSource: (relativePath: string) => string,
): RoleResolutionChokepointViolation[] {
  const violations: RoleResolutionChokepointViolation[] = [];

  for (const target of TARGET_FILES) {
    const source = readSource(target.relativePath);
    const displayPath = toPosix(target.relativePath);

    for (const required of target.required) {
      if (!required.re.test(source)) {
        violations.push({
          relativePath: displayPath,
          message: `${displayPath} no longer references ${required.description}; keep global role display/default matching on the canonical role resolver path.`,
        });
      }
    }

    for (const { name, re, why } of BYPASS_PATTERNS) {
      if (re.test(source)) {
        violations.push({
          relativePath: displayPath,
          message: `${displayPath} reintroduces role-resolution bypass "${name}" (/${re.source}/): ${why}.`,
        });
      }
    }
  }

  return violations;
}

export function main(): void {
  const violations = checkRoleResolutionChokepoint((relativePath) => {
    const abs = path.join(REPO_ROOT, relativePath);
    if (!fs.existsSync(abs)) {
      fail(`target file not found at ${toPosix(relativePath)} — update this guard if the migrated role-display file moved.`);
    }
    return fs.readFileSync(abs, 'utf8');
  });

  if (violations.length > 0) {
    fail(
      `${violations.length} role-resolution chokepoint violation(s):\n` +
      violations.map((violation) => `- ${violation.message}`).join('\n') +
      `\n\nGlobal working/thinking role models must be derived through resolveAllRoleAssignments()/resolveRoleAssignment, not raw role fields.`,
    );
  }

  console.log('✓ check-role-resolution-chokepoint: canonical role resolver shape present, no bypass patterns.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
