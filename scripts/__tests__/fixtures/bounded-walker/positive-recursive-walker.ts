import fs from 'node:fs/promises';
import path from 'node:path';

export async function walk(dir: string): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await walk(path.join(dir, entry.name));
    }
  }
}
