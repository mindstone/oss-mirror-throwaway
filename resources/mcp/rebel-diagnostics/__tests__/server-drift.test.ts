import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type DriftExports = {
  TOOL_NAMES: Record<string, string>;
  TOOL_DESCRIPTIONS: Record<string, string>;
};

const require = createRequire(import.meta.url);

describe('rebel-diagnostics MCP server drift', () => {
  it('TOOL_NAMES are equal between server.mjs and server.cjs', async () => {
    const { mjs, cjs } = await loadServerExports();

    expect(mjs.TOOL_NAMES).toEqual(cjs.TOOL_NAMES);
  });

  it('tool descriptions are equal between server.mjs and server.cjs', async () => {
    const { mjs, cjs } = await loadServerExports();

    expect(mjs.TOOL_DESCRIPTIONS).toEqual(cjs.TOOL_DESCRIPTIONS);
  });
});

async function loadServerExports(): Promise<{ mjs: DriftExports; cjs: DriftExports }> {
  const mjs = (await import(new URL('../server.mjs', import.meta.url).href)) as DriftExports;
  const cjs = require(fileURLToPath(new URL('../server.cjs', import.meta.url))) as DriftExports;
  return { mjs, cjs };
}
