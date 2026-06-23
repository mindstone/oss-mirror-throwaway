import fs from 'node:fs/promises';
import path from 'node:path';
import { safeWalkDirectory } from '@core/utils/safeWalkDirectory';

export async function listSafely(root: string): Promise<void> {
  await safeWalkDirectory(root, {
    onFile: () => undefined,
  });

  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await listSafely(path.join(root, entry.name));
    }
  }
}
