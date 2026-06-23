import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { resolveSpaceByName, validateSpacePath } from './spaceService';

const log = createScopedLogger({ service: 'roles:readme' });

const MAX_SPACE_README_LENGTH = 2000;
const README_FILE_NAME = 'README.md';
const LEGACY_AGENTS_FILE_NAME = 'AGENTS.md';

function truncateReadme(readme: string): string {
  if (readme.length <= MAX_SPACE_README_LENGTH) {
    return readme;
  }

  return readme.slice(0, MAX_SPACE_README_LENGTH);
}

async function readSpaceReadmeFromAbsolutePath(spaceAbsolutePath: string): Promise<string> {
  const readmePath = path.join(spaceAbsolutePath, README_FILE_NAME);

  try {
    return await fs.readFile(readmePath, 'utf-8');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
    if (code !== 'ENOENT') {
      throw err;
    }
  }

  const legacyAgentsPath = path.join(spaceAbsolutePath, LEGACY_AGENTS_FILE_NAME);
  return fs.readFile(legacyAgentsPath, 'utf-8');
}

export async function readSpaceReadme(
  spacePath: string,
  coreDirectory: string,
): Promise<string | null> {
  const trimmedSpacePath = spacePath.trim();
  const trimmedCoreDirectory = coreDirectory.trim();
  if (!trimmedSpacePath || !trimmedCoreDirectory) {
    return null;
  }

  try {
    const spaceAbsolutePath = validateSpacePath(trimmedCoreDirectory, trimmedSpacePath);
    const readme = await readSpaceReadmeFromAbsolutePath(spaceAbsolutePath);
    return truncateReadme(readme);
  } catch (err) {
    log.warn(
      { coreDirectory: trimmedCoreDirectory, err, spacePath: trimmedSpacePath },
      'Failed to read space README context by path',
    );
    return null;
  }
}

export async function readSpaceReadmesForRole(
  spaceNames: string[],
  coreDirectory: string,
): Promise<Array<{ name: string; readme: string }>> {
  if (spaceNames.length === 0 || !coreDirectory.trim()) {
    return [];
  }

  try {
    const readmes = await Promise.all(
      spaceNames.map(async (spaceName) => {
        const trimmedSpaceName = spaceName.trim();
        if (!trimmedSpaceName) {
          return null;
        }

        const space = await resolveSpaceByName(trimmedSpaceName, coreDirectory);
        if (!space) {
          log.warn(
            { coreDirectory, spaceName: trimmedSpaceName },
            'Role space could not be resolved for README context',
          );
          return null;
        }

        try {
          const readme = await readSpaceReadmeFromAbsolutePath(space.absolutePath);
          return { name: trimmedSpaceName, readme: truncateReadme(readme) };
        } catch (err) {
          log.warn(
            {
              coreDirectory,
              err,
              spaceName: trimmedSpaceName,
              spacePath: space.absolutePath,
            },
            'Failed to read role space README context',
          );
          return null;
        }
      }),
    );

    return readmes.filter((readme): readme is { name: string; readme: string } => readme !== null);
  } catch (err) {
    log.warn({ coreDirectory, err, spaceNames }, 'Failed to assemble role space README context');
    return [];
  }
}
