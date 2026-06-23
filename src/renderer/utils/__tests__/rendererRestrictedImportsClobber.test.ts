import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression net for the 260623 ESLint flat-config renderer-ban clobber:
// flat config REPLACES (does not merge) an array-valued rule when multiple
// matching blocks set it for the same file, so a later renderer-broad block
// silently killed earlier import bans. This test pins that react-markdown,
// authService, getEnabledProviders, and searchFiles all FIRE on an ordinary
// renderer file, and that a legitimate pure-@core import stays CLEAN (we did
// NOT re-introduce the stale @core ban — that concern moved to
// scripts/check-renderer-core-rn-safety.ts). See
// docs/plans/260623_render-drop-followups/PLAN.md.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const configPath = join(repoRoot, 'eslint.config.mjs');

// An ordinary renderer path: in NONE of the ban `ignores`/override file lists,
// so it should receive the full union of renderer import bans.
const ordinaryFixturePath = 'src/renderer/__fixtures__/rendererRestrictedImportsFixture.tsx';

async function lintFixture(source: string, relativePath = ordinaryFixturePath) {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: configPath,
  });
  const [result] = await eslint.lintText(source, {
    filePath: join(repoRoot, relativePath),
  });
  return result;
}

function restrictedImportMessages(result: Awaited<ReturnType<typeof lintFixture>>) {
  return result.messages.filter(
    message =>
      message.ruleId === '@typescript-eslint/no-restricted-imports'
      || message.ruleId === 'no-restricted-imports',
  );
}

describe('renderer restricted-import clobber guard', () => {
  it('fires on a direct react-markdown import (I10 pipeline ban survives)', async () => {
    const result = await lintFixture(`import ReactMarkdown from 'react-markdown';\nexport const x = ReactMarkdown;\n`);
    const matches = restrictedImportMessages(result);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some(m => m.message.includes('I10 shared pipeline'))).toBe(true);
  });

  it('fires on a direct @main/services/authService import (authService ban survives)', async () => {
    const result = await lintFixture(`import { something } from '@main/services/authService';\nexport const x = something;\n`);
    const matches = restrictedImportMessages(result);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some(m => m.message.includes('authService'))).toBe(true);
  });

  it('fires on a getEnabledProviders import from @shared/utils/settingsUtils', async () => {
    const result = await lintFixture(`import { getEnabledProviders } from '@shared/utils/settingsUtils';\nexport const x = getEnabledProviders;\n`);
    const matches = restrictedImportMessages(result);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some(m => m.message.includes('getDisplayProviderChain'))).toBe(true);
  });

  it('fires on a searchFiles import from @renderer/utils/librarySearch', async () => {
    const result = await lintFixture(`import { searchFiles } from '@renderer/utils/librarySearch';\nexport const x = searchFiles;\n`);
    const matches = restrictedImportMessages(result);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some(m => m.message.includes('searchLibrary'))).toBe(true);
  });

  it('does NOT fire on a legitimate pure-@core runtime import (stale @core ban stays dropped)', async () => {
    const result = await lintFixture(`import { isContentMonotonic } from '@core/services/sessionIngestGuard';\nexport const x = isContentMonotonic;\n`);
    const matches = restrictedImportMessages(result);
    expect(matches).toHaveLength(0);
  });

  // Per-file carveouts (S1): the two narrow overrides RE-SPREAD the rest of the
  // renderer union so the carved-out files keep every ban except the one they
  // legitimately need. Pin both directions so a future flat-config edit can't
  // silently re-clobber a carveout (the bug class this whole file guards).
  describe('per-file carveouts re-apply the remaining bans', () => {
    const ENGINE = 'src/renderer/features/library/search/engine.ts';
    const MESSAGE_MARKDOWN = 'src/renderer/components/MessageMarkdown.tsx';

    it('engine.ts: react-markdown still FIRES (markdown ban kept) but searchFiles is CLEAN (engine is the owner)', async () => {
      const reactMarkdown = await lintFixture(
        `import ReactMarkdown from 'react-markdown';\nexport const x = ReactMarkdown;\n`,
        ENGINE,
      );
      const reactMatches = restrictedImportMessages(reactMarkdown);
      expect(reactMatches.length).toBeGreaterThanOrEqual(1);
      expect(reactMatches.some(m => m.message.includes('I10 shared pipeline'))).toBe(true);

      const searchFiles = await lintFixture(
        `import { searchFiles } from '@renderer/utils/librarySearch';\nexport const x = searchFiles;\n`,
        ENGINE,
      );
      expect(restrictedImportMessages(searchFiles)).toHaveLength(0);
    });

    it('MessageMarkdown.tsx: searchFiles still FIRES (ban kept) but react-markdown is CLEAN (wrapper is the owner)', async () => {
      const searchFiles = await lintFixture(
        `import { searchFiles } from '@renderer/utils/librarySearch';\nexport const x = searchFiles;\n`,
        MESSAGE_MARKDOWN,
      );
      const searchMatches = restrictedImportMessages(searchFiles);
      expect(searchMatches.length).toBeGreaterThanOrEqual(1);
      expect(searchMatches.some(m => m.message.includes('searchLibrary'))).toBe(true);

      const reactMarkdown = await lintFixture(
        `import ReactMarkdown from 'react-markdown';\nexport const x = ReactMarkdown;\n`,
        MESSAGE_MARKDOWN,
      );
      expect(restrictedImportMessages(reactMarkdown)).toHaveLength(0);
    });
  });
});
