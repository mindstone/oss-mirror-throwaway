// bounded-walker-exempt: bounded by depth=3
import fs from 'node:fs/promises';
import path from 'node:path';

export async function walk(dir: string, depth = 0): Promise<void> {
  if (depth >= 3) return;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }
}
