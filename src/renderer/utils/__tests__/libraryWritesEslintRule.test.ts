import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const configPath = join(repoRoot, 'eslint.config.mjs');
const directWriteRuleMessage = 'Use writeFileOrFail() from @renderer/utils/libraryWrites';

async function lintFixture(relativePath: string, source: string) {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: configPath,
  });
  const [result] = await eslint.lintText(source, {
    filePath: join(repoRoot, relativePath),
  });
  return result;
}

const directWriteFixture = `
export async function saveOutsideWrapper(payload: { path: string; content: string }) {
  return await window.libraryApi.writeFile(payload);
}
`;

describe('library write ESLint guard', () => {
  it('flags direct window.libraryApi.writeFile outside the wrapper', async () => {
    const result = await lintFixture(
      'src/renderer/utils/directWriteFixture.ts',
      directWriteFixture,
    );

    const matches = result.messages.filter(
      message =>
        message.ruleId === 'no-restricted-syntax'
        && message.message.includes(directWriteRuleMessage),
    );

    expect(result.errorCount).toBe(1);
    expect(matches).toHaveLength(1);
    expect(matches[0].message).toContain('writeFileOrFail');
  });

  it('allows direct window.libraryApi.writeFile inside the wrapper file', async () => {
    const result = await lintFixture(
      'src/renderer/utils/libraryWrites.ts',
      directWriteFixture,
    );

    const matches = result.messages.filter(
      message =>
        message.ruleId === 'no-restricted-syntax'
        && message.message.includes(directWriteRuleMessage),
    );

    expect(result.errorCount).toBe(0);
    expect(matches).toHaveLength(0);
  });
});
