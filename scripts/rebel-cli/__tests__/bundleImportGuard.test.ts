import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..', '..');

describe('standalone CLI bundle import guard', () => {
  it('does not bundle desktop token-storage modules', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-cli-metafile-'));
    const metafilePath = path.join(tempDir, 'stage8.json');
    execFileSync('node', ['scripts/rebel-cli/build.mjs', '--metafile', metafilePath], {
      cwd: projectRoot,
      stdio: 'pipe',
    });

    const metafile = JSON.parse(fs.readFileSync(metafilePath, 'utf8')) as { inputs: Record<string, unknown> };
    const inputs = Object.keys(metafile.inputs).map((input) => input.replaceAll('\\', '/'));
    const banned = [
      'src/core/services/codexTokenStorage.ts',
      'src/main/services/authTokenStorage.ts',
      'src/main/services/providerTokenStorage.ts',
      'src/main/services/flyTokenStorage.ts',
      'src/core/services/openRouterTokenStorage.ts',
      'src/main/services/openRouterTokenStorage.ts',
    ];

    for (const bannedPath of banned) {
      expect(inputs.some((input) => input.endsWith(bannedPath)), bannedPath).toBe(false);
    }
  });
});
