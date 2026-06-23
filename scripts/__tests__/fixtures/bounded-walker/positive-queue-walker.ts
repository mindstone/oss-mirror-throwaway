import fs from 'node:fs';
import path from 'node:path';

export function walkWithQueue(root: string): void {
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop();
    if (!dir) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push(path.join(dir, entry.name));
      }
    }
  }
}
