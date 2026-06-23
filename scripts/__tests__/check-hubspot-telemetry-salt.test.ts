import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HUBSPOT_ENV_ASSEMBLY_FILES,
  checkHubSpotTelemetrySalt,
} from '../check-hubspot-telemetry-salt';
import { STEPS } from '../run-validate-fast';

const REPO_ROOT = process.cwd();
const MANAGER_PATH = 'src/main/services/bundledMcpManager.ts';

const tempRoots: string[] = [];

function makeTempSourceCopy(): string {
  const root = mkdtempSync(join(tmpdir(), 'hubspot-telemetry-salt-guard-'));
  tempRoots.push(root);

  for (const relPath of HUBSPOT_ENV_ASSEMBLY_FILES) {
    const dest = join(root, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(REPO_ROOT, relPath), dest);
  }

  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('check-hubspot-telemetry-salt', () => {
  it('passes for the real HubSpot host-env assembly sites', () => {
    const result = checkHubSpotTelemetrySalt(REPO_ROOT);

    expect(result.errors).toEqual([]);
    expect(result.sourceLabelAssignments).toHaveLength(3);
    expect(result.saltAssignments).toHaveLength(3);
  });

  it('fails when a HubSpot env assembly drops its telemetry salt assignment', () => {
    const root = makeTempSourceCopy();
    const managerPath = join(root, MANAGER_PATH);
    const source = readFileSync(managerPath, 'utf8');
    const mutated = source.replace(
      /\n\s+env\.HUBSPOT_TELEMETRY_SALT = await getTelemetrySaltHex\(\);\n/,
      '\n',
    );

    expect(mutated, 'fixture mutation must remove one real salt assignment').not.toEqual(source);
    writeFileSync(managerPath, mutated, 'utf8');

    const result = checkHubSpotTelemetrySalt(root);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/Expected exactly 3 HUBSPOT_TELEMETRY_SALT/);
    expect(result.errors.join('\n')).toMatch(/buildPayloadFromCatalog rebel-oss HubSpot env block/);
  });

  it('is wired into validate:fast', () => {
    expect(STEPS.some((step) => step.name === 'check-hubspot-telemetry-salt')).toBe(true);
  });
});
