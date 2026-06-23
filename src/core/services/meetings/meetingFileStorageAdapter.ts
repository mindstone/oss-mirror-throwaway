export interface MeetingFileStorageAdapter {
  getSessionDir(sessionId: string): string;
  getChunkPath(sessionId: string, chunkIndex: number): string;
  getMetaPath(sessionId: string): string;
  ensureSessionDir(sessionId: string): Promise<void>;
  ensureRoot(): Promise<void>;
  writeJsonAtomic(filePath: string, data: unknown): Promise<void>;
  readJson(filePath: string): Promise<unknown | null>;
  listSessionDirs(): Promise<string[]>;
  copyFile(src: string, dst: string): Promise<void>;
  writeFile(filePath: string, contents: string): Promise<void>;
  fileExists(filePath: string): Promise<boolean>;
  getRoot(): string;
}
