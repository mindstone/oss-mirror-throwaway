/**
 * WorkspaceFileSystem — boundary interface for workspace-scoped filesystem access.
 *
 * Implementations MUST reject absolute-path injection and traversal segments.
 * Symlink containment is controlled per surface by `allowOutOfRootSymlinks`
 * on the guarded path helpers. Desktop trusts in-root symlinks; cloud and
 * other authenticated multi-tenant surfaces must keep strict containment.
 */

export const WORKSPACE_NOT_CONFIGURED_MESSAGE = 'Core directory not configured';
export const WORKSPACE_PATH_TRAVERSAL_MESSAGE = 'Path traversal not allowed';
export const WORKSPACE_FILE_TOO_LARGE_MESSAGE = 'Workspace file exceeds maximum readable size';

export class WorkspaceFileTooLargeError extends Error {
  public readonly code = 'WORKSPACE_FILE_TOO_LARGE';
  public readonly filePath: string;
  public readonly sizeBytes: number;
  public readonly maxBytes: number;

  constructor(filePath: string, sizeBytes: number, maxBytes: number) {
    super(
      `${WORKSPACE_FILE_TOO_LARGE_MESSAGE} (${sizeBytes} bytes > ${maxBytes} bytes)`,
    );
    this.name = 'WorkspaceFileTooLargeError';
    this.filePath = filePath;
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
  }
}

export interface WorkspaceDirectoryEntry {
  name: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface WorkspacePathStat {
  isDirectory: boolean;
  mtimeMs: number;
  sizeBytes?: number;
}

export interface WorkspaceFileSystem {
  listDirectory(workspaceRoot: string, targetPath: string): Promise<WorkspaceDirectoryEntry[]>;
  realPath(workspaceRoot: string, targetPath: string): Promise<string>;
  stat(workspaceRoot: string, targetPath: string): Promise<WorkspacePathStat>;
  readFile(workspaceRoot: string, targetPath: string): Promise<string>;
  writeFile(workspaceRoot: string, targetPath: string, content: string | Uint8Array): Promise<void>;
  /** Append-mode write for log/diary style files where rewrites are unsafe. */
  appendFile?(workspaceRoot: string, targetPath: string, content: string | Uint8Array): Promise<void>;
  /** Atomic same-workspace rename. Required by stores that use temp-file write + rename semantics. */
  renameFile?(workspaceRoot: string, sourcePath: string, targetPath: string): Promise<void>;
  deleteFile(workspaceRoot: string, targetPath: string): Promise<void>;
  exists(workspaceRoot: string, targetPath: string): Promise<boolean>;
}

export type WorkspaceFileSystemFactory = () => WorkspaceFileSystem;

let _factory: WorkspaceFileSystemFactory | undefined;
let _instance: WorkspaceFileSystem | undefined;

export function setWorkspaceFileSystemFactory(factory: WorkspaceFileSystemFactory): void {
  _factory = factory;
  _instance = undefined;
}

export function getWorkspaceFileSystem(): WorkspaceFileSystem {
  if (_instance) return _instance;
  if (!_factory) {
    throw new Error(
      'WorkspaceFileSystem not initialized. Call setWorkspaceFileSystemFactory() before workspace file access.',
    );
  }
  _instance = _factory();
  return _instance;
}
