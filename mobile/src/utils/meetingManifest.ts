import * as FileSystem from 'expo-file-system/legacy';
import { createLogger } from '@rebel/cloud-client';

const log = createLogger('meetingManifest');

const MANIFESTS_DIR_NAME = 'meeting-sessions';
const DEFAULT_CHUNK_EXT = 'm4a';

function getDocumentsDir(): string {
  return FileSystem.documentDirectory || '';
}

function getManifestsRootDir(): string {
  return `${getDocumentsDir()}${MANIFESTS_DIR_NAME}/`;
}

function getManifestTmpPath(localId: string): string {
  return `${getManifestsRootDir()}${localId}.json.tmp`;
}

export function getMeetingManifestPath(localId: string): string {
  return `${getManifestsRootDir()}${localId}.json`;
}

export function getMeetingChunkDirectory(localId: string): string {
  return `${getManifestsRootDir()}${localId}/`;
}

export function getMeetingChunkPath(
  localId: string,
  chunkIndex: number,
  ext: string = DEFAULT_CHUNK_EXT,
): string {
  return `${getMeetingChunkDirectory(localId)}chunk_${chunkIndex}.${ext}`;
}

export interface MeetingManifest {
  localId: string;
  cloudSessionId?: string;
  nextChunkIndex: number;
  lastAckedChunkIndex: number;
  companionSessionId?: string;
  meetingTitle?: string;
  startTime: number;
  isStopped?: boolean;
  totalChunks?: number;
  finalizedAt?: number;
}

export interface MeetingChunkQueueMetadata {
  meetingSessionId: string;
  chunkIndex: number;
  meetingTitle?: string;
  meetingStartTime: number;
  mimeType: string;
  isFinalChunk?: boolean;
  totalChunks?: number;
}

async function ensureRootDir(): Promise<void> {
  const rootDir = getManifestsRootDir();
  const info = await FileSystem.getInfoAsync(rootDir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(rootDir, { intermediates: true });
  }
}

export function generateMeetingLocalId(): string {
  return `meeting-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function writeMeetingManifest(manifest: MeetingManifest): Promise<void> {
  await ensureRootDir();
  const manifestPath = getMeetingManifestPath(manifest.localId);
  const tmpPath = getManifestTmpPath(manifest.localId);

  await FileSystem.writeAsStringAsync(tmpPath, JSON.stringify(manifest), {
    encoding: FileSystem.EncodingType.UTF8,
  });
  await FileSystem.moveAsync({ from: tmpPath, to: manifestPath });
}

export async function readMeetingManifest(localId: string): Promise<MeetingManifest | null> {
  const manifestPath = getMeetingManifestPath(localId);
  const info = await FileSystem.getInfoAsync(manifestPath);
  if (!info.exists) return null;

  try {
    const raw = await FileSystem.readAsStringAsync(manifestPath, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const parsed = JSON.parse(raw) as MeetingManifest;
    if (!parsed || parsed.localId !== localId) return null;
    return parsed;
  } catch (err) {
    log.warn('Failed to parse meeting manifest', {
      localId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function createMeetingManifest(
  localId: string,
  meetingTitle: string | undefined,
  startTime: number,
): Promise<MeetingManifest> {
  const manifest: MeetingManifest = {
    localId,
    nextChunkIndex: 0,
    lastAckedChunkIndex: -1,
    meetingTitle,
    startTime,
    isStopped: false,
  };
  await writeMeetingManifest(manifest);
  return manifest;
}

export async function updateMeetingManifest(
  localId: string,
  updater: (current: MeetingManifest) => MeetingManifest,
): Promise<MeetingManifest | null> {
  const current = await readMeetingManifest(localId);
  if (!current) return null;
  const next = updater(current);
  await writeMeetingManifest(next);
  return next;
}

export async function saveMeetingChunkToDisk(
  localId: string,
  chunkIndex: number,
  sourceUri: string,
  ext: string = DEFAULT_CHUNK_EXT,
): Promise<string> {
  await ensureRootDir();
  const sessionDir = getMeetingChunkDirectory(localId);
  const sessionDirInfo = await FileSystem.getInfoAsync(sessionDir);
  if (!sessionDirInfo.exists) {
    await FileSystem.makeDirectoryAsync(sessionDir, { intermediates: true });
  }

  const targetUri = getMeetingChunkPath(localId, chunkIndex, ext);
  await FileSystem.deleteAsync(targetUri, { idempotent: true }).catch(() => {});
  await FileSystem.copyAsync({ from: sourceUri, to: targetUri });
  return targetUri;
}

export async function listMeetingManifests(): Promise<MeetingManifest[]> {
  await ensureRootDir();
  const rootDir = getManifestsRootDir();
  const files = await FileSystem.readDirectoryAsync(rootDir).catch(() => []);
  const manifestFiles = files.filter((name) => name.endsWith('.json'));

  const manifests: MeetingManifest[] = [];
  for (const fileName of manifestFiles) {
    const localId = fileName.replace(/\.json$/, '');
    const manifest = await readMeetingManifest(localId);
    if (manifest) {
      manifests.push(manifest);
    }
  }

  return manifests.sort((a, b) => a.startTime - b.startTime);
}

export async function listMeetingChunkIndices(localId: string): Promise<number[]> {
  const sessionDir = getMeetingChunkDirectory(localId);
  const info = await FileSystem.getInfoAsync(sessionDir);
  if (!info.exists) return [];

  const files = await FileSystem.readDirectoryAsync(sessionDir).catch(() => []);
  const indices = files
    .map((fileName) => {
      const match = /^chunk_(\d+)\./.exec(fileName);
      return match ? parseInt(match[1], 10) : null;
    })
    .filter((value): value is number => value !== null && Number.isInteger(value))
    .sort((a, b) => a - b);

  return indices;
}

export async function deleteMeetingChunkFromDisk(
  localId: string,
  chunkIndex: number,
  ext: string = DEFAULT_CHUNK_EXT,
): Promise<void> {
  const chunkUri = getMeetingChunkPath(localId, chunkIndex, ext);
  await FileSystem.deleteAsync(chunkUri, { idempotent: true }).catch(() => {});
}

export async function deleteMeetingSession(localId: string): Promise<void> {
  const manifestPath = getMeetingManifestPath(localId);
  const chunkDir = getMeetingChunkDirectory(localId);
  const tmpPath = getManifestTmpPath(localId);
  await FileSystem.deleteAsync(chunkDir, { idempotent: true }).catch(() => {});
  await FileSystem.deleteAsync(manifestPath, { idempotent: true }).catch(() => {});
  await FileSystem.deleteAsync(tmpPath, { idempotent: true }).catch(() => {});
  log.info('Deleted meeting session manifest and chunks', { localId });
}
