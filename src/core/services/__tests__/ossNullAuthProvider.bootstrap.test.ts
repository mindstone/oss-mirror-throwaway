import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OSS null auth provider bootstrap isolation', () => {
  // Phase 6 S1 (Behavioral-Safety): accidental cloud registration of OSS_NULL_AUTH_PROVIDER
  // would hard-set licenseTier='teams' and override REBEL_LICENSE_TIER env intent. Stage 3 is
  // the right time to add this guard since the whole stage exists to prevent accidental wiring.
  // Cloud bootstrap must continue to register the inert NULL_REBEL_AUTH_PROVIDER sentinel
  // (per Decision Log Q1) until B3 lands a real cloud auth impl.
  it('keeps cloud bootstrap wired directly to the inert sentinel until cloud auth lands', () => {
    const cloudBootstrapPath = path.resolve(__dirname, '../../../../cloud-service/src/bootstrap.ts');
    const source = fs.readFileSync(cloudBootstrapPath, 'utf8');

    expect(source).toMatch(/import\s+\{\s*NULL_REBEL_AUTH_PROVIDER,\s*setRebelAuthProvider\s*\}\s+from\s+['"]@core\/rebelAuth['"]/);
    expect(source).toMatch(/setRebelAuthProvider\(NULL_REBEL_AUTH_PROVIDER\)/);
    expect(source).not.toContain('@private/mindstone/bootstrap');
    expect(source).not.toContain('OSS_NULL_AUTH_PROVIDER');
    expect(source).not.toMatch(/setRebelAuthProvider\(OSS_NULL_AUTH_PROVIDER\)/);
  });
});
