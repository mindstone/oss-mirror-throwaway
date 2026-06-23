import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkPackagedSuperMcpBundle } from '../check-packaged-super-mcp-bundle';

function withTempPackage(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-super-mcp-package-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createResourcesDir(baseDir: string): string {
  const resourcesDir = path.join(baseDir, 'Mindstone Rebel.app', 'Contents', 'Resources');
  fs.mkdirSync(resourcesDir, { recursive: true });
  return resourcesDir;
}

describe('checkPackagedSuperMcpBundle', () => {
  it('passes when packaged Resources contains super-mcp/dist/cli.js and node_modules', () => {
    withTempPackage((dir) => {
      const resourcesDir = createResourcesDir(dir);
      fs.mkdirSync(path.join(resourcesDir, 'super-mcp', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(resourcesDir, 'super-mcp', 'dist', 'cli.js'), 'console.log("ok");\n');
      fs.mkdirSync(path.join(resourcesDir, 'super-mcp', 'node_modules'), { recursive: true });

      const result = checkPackagedSuperMcpBundle(dir);

      expect(result.ok).toBe(true);
      expect(result.checkedResourcesDirs).toEqual([resourcesDir]);
      expect(result.missing).toEqual([]);
    });
  });

  it('fails when the bundled Super-MCP CLI is missing', () => {
    withTempPackage((dir) => {
      const resourcesDir = createResourcesDir(dir);
      fs.mkdirSync(path.join(resourcesDir, 'super-mcp', 'node_modules'), { recursive: true });

      const result = checkPackagedSuperMcpBundle(dir);

      expect(result.ok).toBe(false);
      expect(result.missing).toContain(path.join(resourcesDir, 'super-mcp', 'dist', 'cli.js'));
    });
  });

  it('fails when bundled Super-MCP node_modules is missing', () => {
    withTempPackage((dir) => {
      const resourcesDir = createResourcesDir(dir);
      fs.mkdirSync(path.join(resourcesDir, 'super-mcp', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(resourcesDir, 'super-mcp', 'dist', 'cli.js'), 'console.log("ok");\n');

      const result = checkPackagedSuperMcpBundle(dir);

      expect(result.ok).toBe(false);
      expect(result.missing).toContain(path.join(resourcesDir, 'super-mcp', 'node_modules'));
    });
  });
});
