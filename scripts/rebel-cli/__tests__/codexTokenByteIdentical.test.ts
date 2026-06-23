import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..', '..');
const rebelDist = path.join(projectRoot, 'scripts', 'rebel-cli', 'dist', 'rebel.js');
const tempDirs: string[] = [];

describe('standalone CLI Codex token byte preservation', () => {
  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('leaves the desktop Codex store bytes identical after smoke-test', () => {
    execFileSync('node', ['scripts/rebel-cli/build.mjs'], { cwd: projectRoot, stdio: 'pipe' });
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-cli-codex-bytes-'));
    tempDirs.push(userData);
    const storePath = path.join(userData, 'codex-oauth-tokens.json');
    const encryptedTokens = Buffer.concat([
      Buffer.from('v10'),
      Buffer.from(JSON.stringify({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60_000,
      })),
    ]).toString('base64');

    fs.writeFileSync(storePath, `${JSON.stringify({ encryptedTokens }, null, 2)}\n`, 'utf8');
    const before = fs.readFileSync(storePath);

    const result = execFileSync('node', [rebelDist, 'smoke-test'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        REBEL_USER_DATA: userData,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const after = fs.readFileSync(storePath);
    expect(result).toContain('OK');
    expect(after.equals(before)).toBe(true);
  });
});
