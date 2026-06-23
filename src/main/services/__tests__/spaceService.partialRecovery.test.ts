import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readSpaceFrontmatterWithError } from '../spaceService';

let scratchRoot: string | null = null;

afterEach(async () => {
  if (!scratchRoot) return;
  await fs.rm(scratchRoot, { recursive: true, force: true });
  scratchRoot = null;
});

describe('readSpaceFrontmatterWithError partial recovery', () => {
  it('preserves organisation_name when another frontmatter field fails strict validation', async () => {
    scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'space-service-partial-recovery-'));
    const spacePath = path.join(scratchRoot, 'workspace', 'work', 'Mindstone', 'General');
    await fs.mkdir(spacePath, { recursive: true });
    await fs.writeFile(
      path.join(spacePath, 'README.md'),
      [
        '---',
        'rebel_space_description: Team notes',
        'sharing: invalid-sharing-value',
        'organisation_name: Mindstone',
        '---',
        '',
        '# General',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await readSpaceFrontmatterWithError(spacePath);

    expect(result.parseError).toBeUndefined();
    expect(result.frontmatter).toMatchObject({
      rebel_space_description: 'Team notes',
      organisation_name: 'Mindstone',
    });
    expect(result.frontmatter?.sharing).toBeUndefined();
  });
});
