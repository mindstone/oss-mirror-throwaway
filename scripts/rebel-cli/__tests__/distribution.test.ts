import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..', '..');

describe('standalone CLI distribution controls', () => {
  it('runs the POSIX PATH setup script in dry-run mode without writing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-cli-path-home-'));
    const sourceCli = path.join(home, 'rebel.js');
    fs.writeFileSync(sourceCli, '#!/usr/bin/env node\n', 'utf8');

    const output = execFileSync('sh', ['scripts/setup-cli-path.sh'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: home,
        REBEL_CLI_SOURCE: sourceCli,
        SETUP_CLI_DRY_RUN: '1',
      },
      encoding: 'utf8',
    });

    expect(output).toContain('DRY RUN');
    expect(fs.existsSync(path.join(home, '.local', 'bin', 'rebel'))).toBe(false);
  });

  it('keeps standalone Super-MCP fallback pinned instead of using @latest', () => {
    const mainSource = fs.readFileSync(path.join(projectRoot, 'scripts', 'rebel-cli', 'main.ts'), 'utf8');
    const buildSource = fs.readFileSync(path.join(projectRoot, 'scripts', 'rebel-cli', 'build.mjs'), 'utf8');

    expect(mainSource).not.toContain('@latest');
    expect(buildSource).toContain('REBEL_SUPER_MCP_PINNED_VERSION');
  });
});
