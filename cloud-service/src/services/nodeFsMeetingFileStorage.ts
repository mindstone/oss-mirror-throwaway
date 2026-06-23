import fs from 'node:fs/promises';
import path from 'node:path';
import type { MeetingFileStorageAdapter } from '@core/services/meetings/meetingFileStorageAdapter';
import { META_FILENAME } from '@core/services/meetings/meetingUploadSessionService';

export const DEFAULT_MEETING_SESSIONS_ROOT = '/data/meeting-sessions';

export class NodeFsMeetingFileStorage implements MeetingFileStorageAdapter {
  public constructor(private readonly rootDir: string = DEFAULT_MEETING_SESSIONS_ROOT) {}

  public getSessionDir(sessionId: string): string {
    return path.join(this.rootDir, sessionId);
  }

  public getChunkPath(sessionId: string, chunkIndex: number): string {
    return path.join(this.getSessionDir(sessionId), `chunk_${chunkIndex}.m4a`);
  }

  public getMetaPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), META_FILENAME);
  }

  public async ensureSessionDir(sessionId: string): Promise<void> {
    await fs.mkdir(this.getSessionDir(sessionId), { recursive: true });
  }

  public async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  public async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  public async readJson(filePath: string): Promise<unknown | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as unknown;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  public async listSessionDirs(): Promise<string[]> {
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  public async copyFile(src: string, dst: string): Promise<void> {
    await fs.copyFile(src, dst);
  }

  public async writeFile(filePath: string, contents: string): Promise<void> {
    await fs.writeFile(filePath, contents, 'utf-8');
  }

  public async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  public getRoot(): string {
    return this.rootDir;
  }
}

export function createNodeFsMeetingFileStorage(rootDir?: string): NodeFsMeetingFileStorage {
  return new NodeFsMeetingFileStorage(rootDir);
}
