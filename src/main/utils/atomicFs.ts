import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeFileAtomic(
  filePath: string,
  content: string,
  encoding: BufferEncoding = 'utf8',
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    await fs.writeFile(tmpPath, content, encoding);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }

  try {
    if (process.platform === 'win32') {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          await fs.unlink(tmpPath).catch(() => {});
          throw error;
        }
      }
    }
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}
