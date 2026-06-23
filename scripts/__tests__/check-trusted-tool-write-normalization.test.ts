import { describe, it, expect } from 'vitest';
import {
  scanSourceForTrustedWrites,
  findUnnormalizedTrustedWrites,
} from '../check-trusted-tool-write-normalization';

describe('scanSourceForTrustedWrites — fires on un-normalized writes (non-vacuous)', () => {
  it('flags a raw-string toolId write (the 260330 compound-id shape)', () => {
    const src = `
      store.set({
        trustedTools: [
          ...existing,
          { toolId: \`\${packageId}/\${toolId}\`, displayName: d, addedAt: Date.now() },
        ],
      });
    `;
    const v = scanSourceForTrustedWrites(src, 'src/renderer/App.tsx');
    expect(v).toHaveLength(1);
  });

  it('flags a bare identifier toolId not derived from bareToolId()', () => {
    const src = `
      const next = { trustedTools: [{ toolId: rawId, displayName: 'x' }] };
    `;
    const v = scanSourceForTrustedWrites(src, 'src/main/x.ts');
    expect(v).toHaveLength(1);
  });
});

describe('scanSourceForTrustedWrites — clears normalized writes (no FP)', () => {
  it('accepts a direct bareToolId(...) toolId', () => {
    const src = `
      const next = { trustedTools: [...prev, { toolId: bareToolId(toolId), displayName: d }] };
    `;
    expect(scanSourceForTrustedWrites(src, 'src/renderer/App.tsx')).toEqual([]);
  });

  it('accepts a toolId const that was assigned from bareToolId(...)', () => {
    const src = `
      function add(toolId) {
        const canonical = bareToolId(toolId);
        return { trustedTools: [...existing, { toolId: canonical, displayName: 'x', addedAt: 1 }] };
      }
    `;
    expect(scanSourceForTrustedWrites(src, 'src/main/ipc/settingsHandlers.ts')).toEqual([]);
  });

  it('accepts a normalizeTrustedTools(...) wrapped array wholesale', () => {
    const src = `
      const next = { trustedTools: normalizeTrustedTools(incoming) };
    `;
    expect(scanSourceForTrustedWrites(src, 'src/shared/utils/settingsUtils.ts')).toEqual([]);
  });

  it('ignores a pure spread (carried-forward entries are already canonical)', () => {
    const src = `
      const next = { trustedTools: [...existing] };
    `;
    expect(scanSourceForTrustedWrites(src, 'src/main/x.ts')).toEqual([]);
  });

  it('ignores object literals in trustedTools array that have no toolId (not a write entry)', () => {
    const src = `
      const filter = { trustedTools: [{ displayName: 'x' }] };
    `;
    expect(scanSourceForTrustedWrites(src, 'src/main/x.ts')).toEqual([]);
  });

  it('respects a TRUSTED_TOOL_WRITE_OK marker', () => {
    const src = `
      const next = {
        trustedTools: [
          // TRUSTED_TOOL_WRITE_OK: migration entry already canonical upstream
          { toolId: legacyAlreadyBare, displayName: 'x' },
        ],
      };
    `;
    expect(scanSourceForTrustedWrites(src, 'src/main/x.ts')).toEqual([]);
  });
});

describe('live tree', () => {
  it('every production trustedTools write is normalized (zero violations)', () => {
    const v = findUnnormalizedTrustedWrites();
    expect(
      v,
      `un-normalized trustedTools writes: ${v.map((x) => `${x.relativePath}:${x.line}`).join(', ')}`,
    ).toEqual([]);
  });
});
