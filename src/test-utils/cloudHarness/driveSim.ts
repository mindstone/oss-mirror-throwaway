import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { toPortablePath } from '@core/utils/portablePath';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

export interface DriveMount {
  name: string;
  dir: string;
  writeFile(rel: string, content: string): Promise<void>;
  snapshot(): Promise<string[]>;
}

export interface DriveSimCreateOpts {
  rootDir: string;
  provider?: 'google-drive';
}

export interface DriveSimSettleOpts {
  to?: string[];
}

export interface DriveSimConcurrentWrite {
  mount: string;
  rel: string;
  content: string;
}

class DriveMountImpl implements DriveMount {
  constructor(
    private readonly drive: DriveSim,
    public readonly name: string,
    public readonly dir: string,
  ) {}

  async writeFile(rel: string, content: string): Promise<void> {
    await this.drive.writeMountFile(this.name, rel, content);
  }

  async snapshot(): Promise<string[]> {
    return this.drive.snapshotMount(this.name);
  }
}

export class DriveSim {
  private readonly mounts = new Map<string, DriveMountImpl>();
  private readonly truth = new Map<string, string>();
  private pendingWindow: DriveSimConcurrentWrite[] | null = null;

  private constructor(private readonly rootDir: string) {}

  static async create(opts: DriveSimCreateOpts): Promise<DriveSim> {
    // `opts.provider` reserved for future non-Drive providers; only google-drive
    // conflict-copy naming is modelled today, so it does not affect behaviour yet.
    const drive = new DriveSim(path.resolve(opts.rootDir));
    await fsp.mkdir(drive.rootDir, { recursive: true });
    return drive;
  }

  async mount(name: string): Promise<DriveMount> {
    if (this.mounts.has(name)) {
      throw new Error(`DriveSim mount already exists: ${name}`);
    }

    const dir = path.join(this.rootDir, 'Google Drive', `Machine ${name}`, 'Rebel');
    const mount = new DriveMountImpl(this, name, dir);
    this.mounts.set(name, mount);
    await this.materializeMount(mount);
    return mount;
  }

  async seedFile(rel: string, content: string): Promise<void> {
    const normalized = normalizeRel(rel);
    this.truth.set(normalized, content);

    await Promise.all(
      [...this.mounts.values()].map((mount) => writeTextFile(pathForRel(mount.dir, normalized), content)),
    );
  }

  concurrent(writes: DriveSimConcurrentWrite[]): void {
    if (this.pendingWindow) {
      throw new Error('DriveSim already has an unsettled concurrent write window');
    }

    const normalized = writes.map((write) => {
      const mount = this.mounts.get(write.mount);
      if (!mount) {
        throw new Error(`DriveSim mount does not exist: ${write.mount}`);
      }

      const rel = normalizeRel(write.rel);
      writeTextFileSync(pathForRel(mount.dir, rel), write.content);
      return { ...write, rel };
    });

    this.pendingWindow = normalized;
  }

  async settle(opts: DriveSimSettleOpts = {}): Promise<void> {
    this.reconcilePendingWindow();

    const targetNames = opts.to ?? [...this.mounts.keys()];
    await Promise.all(targetNames.map((name) => this.materializeNamedMount(name)));
  }

  async mintFolderConflict(folderRel: string, fromMount: string): Promise<void> {
    const mount = this.mounts.get(fromMount);
    if (!mount) {
      throw new Error(`DriveSim mount does not exist: ${fromMount}`);
    }

    const normalizedFolder = normalizeRel(folderRel);
    const sourceRoot = pathForRel(mount.dir, normalizedFolder);
    const files = await listRelativeFiles(sourceRoot);
    if (files.length === 0) {
      throw new Error(`DriveSim folder conflict source has no files: ${normalizedFolder}`);
    }

    // Models Google Drive's folder-level conflict outcome: concurrent edits to a
    // folder can copy the whole subtree to `Folder (1)/`, which Rebel's current
    // file-extension conflict matcher does not suppress (REBEL-5QS).
    const conflictFolder = this.allocateConflictCopyPath(normalizedFolder);
    for (const childRel of files) {
      const sourcePath = pathForRel(sourceRoot, childRel);
      const content = await fsp.readFile(sourcePath, 'utf8');
      this.truth.set(`${conflictFolder}/${childRel}`, content);
    }
  }

  async tree(): Promise<Record<string, string[]>> {
    const entries = await Promise.all(
      [...this.mounts.values()].map(async (mount) => [mount.name, await mount.snapshot()] as const),
    );
    return Object.fromEntries(entries);
  }

  async writeMountFile(mountName: string, rel: string, content: string): Promise<void> {
    const mount = this.mounts.get(mountName);
    if (!mount) {
      throw new Error(`DriveSim mount does not exist: ${mountName}`);
    }
    await writeTextFile(pathForRel(mount.dir, normalizeRel(rel)), content);
  }

  async snapshotMount(mountName: string): Promise<string[]> {
    const mount = this.mounts.get(mountName);
    if (!mount) {
      throw new Error(`DriveSim mount does not exist: ${mountName}`);
    }
    return listRelativeFiles(mount.dir);
  }

  private reconcilePendingWindow(): void {
    if (!this.pendingWindow) return;

    const groups = new Map<string, DriveSimConcurrentWrite[]>();
    for (const write of this.pendingWindow) {
      const existing = groups.get(write.rel);
      if (existing) {
        existing.push(write);
      } else {
        groups.set(write.rel, [write]);
      }
    }

    for (const [rel, writes] of groups) {
      const first = writes[0];
      this.truth.set(rel, first.content);

      for (const later of writes.slice(1)) {
        if (later.content === first.content) continue;
        this.truth.set(this.allocateConflictCopyPath(rel), later.content);
      }
    }

    this.pendingWindow = null;
  }

  private async materializeNamedMount(name: string): Promise<void> {
    const mount = this.mounts.get(name);
    if (!mount) {
      throw new Error(`DriveSim mount does not exist: ${name}`);
    }
    await this.materializeMount(mount);
  }

  private async materializeMount(mount: DriveMountImpl): Promise<void> {
    await fsp.rm(mount.dir, { recursive: true, force: true });
    await fsp.mkdir(mount.dir, { recursive: true });

    await Promise.all(
      [...this.truth.entries()].map(([rel, content]) => writeTextFile(pathForRel(mount.dir, rel), content)),
    );
  }

  private allocateConflictCopyPath(rel: string): string {
    return deriveConflictCopyName(rel, (candidate) => this.pathTaken(candidate));
  }

  private pathTaken(rel: string): boolean {
    if (this.truth.has(rel)) return true;
    const prefix = `${rel}/`;
    for (const existing of this.truth.keys()) {
      if (existing.startsWith(prefix)) return true;
    }
    return false;
  }
}

function normalizeRel(rel: string): string {
  const portable = rel.replace(/\\/g, '/');
  const normalized = path.posix.normalize(portable).replace(/^\.\/+/, '');

  if (
    normalized === '.' ||
    normalized === '' ||
    path.posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`DriveSim relative path is invalid: ${rel}`);
  }

  return normalized;
}

function pathForRel(root: string, rel: string): string {
  return path.join(root, ...normalizeRel(rel).split('/'));
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
}

function writeTextFileSync(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        ignoreBestEffortCleanup(err, {
          operation: 'cloudHarness.driveSim.listRelativeFiles',
          reason: 'directory-absent-yields-empty-list',
          severity: 'debug',
          owner: 'test-utils.cloudHarness',
        });
        return;
      }
      throw err;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(absolutePath);
          return;
        }
        if (!entry.isFile()) return;
        files.push(toPortablePath(path.relative(root, absolutePath)));
      }),
    );
  }

  await walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function deriveConflictCopyName(rel: string, isTaken: (candidate: string) => boolean): string {
  const normalized = normalizeRel(rel);
  const dir = path.posix.dirname(normalized);
  const basename = path.posix.basename(normalized);
  const ext = path.posix.extname(basename);
  const stem = ext ? basename.slice(0, -ext.length) : basename;

  for (let index = 1; ; index += 1) {
    const candidateName = `${stem} (${index})${ext}`;
    const candidate = dir === '.' ? candidateName : `${dir}/${candidateName}`;
    if (!isTaken(candidate)) return candidate;
  }
}
