/**
 * Plaud API Client
 *
 * Typed API calls for Plaud cloud API.
 */

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createScopedLogger } from '@core/logger';
import { ensureValidToken } from './plaudAuthService';
import type { PlaudFile, PlaudFileDetails } from './types';

const log = createScopedLogger({ service: 'plaud-api' });

const PLAUD_API_BASE = 'https://platform.plaud.ai/developer/api/open/third-party';

interface PlaudFilesResponse {
  type: string;
  data: PlaudFile[];
  page: number;
  page_size: number;
}

const DEFAULT_PAGE_SIZE = 20;

interface FetchPlaudFilesResult {
  files: PlaudFile[];
  page: number;
  pageSize: number;
}

/**
 * Fetch a single page of files from Plaud API.
 * @param page - Page number (1-based, default 1)
 * @returns Files from the requested page along with pagination info
 */
export async function fetchPlaudFiles(page = 1): Promise<FetchPlaudFilesResult> {
  const accessToken = await ensureValidToken();

  const url = new URL(`${PLAUD_API_BASE}/files/`);
  url.searchParams.set('page', String(page));
  url.searchParams.set('page_size', String(DEFAULT_PAGE_SIZE));

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch files: ${response.status}`);
  }

  const data: PlaudFilesResponse = await response.json();
  log.debug({ count: data.data.length, page: data.page, pageSize: data.page_size }, 'Fetched Plaud files page');

  return {
    files: data.data,
    page: data.page,
    pageSize: data.page_size,
  };
}

/**
 * Fetch all files from Plaud API with pagination.
 * Loops through pages until we get fewer files than page_size.
 * Has a safety limit of 10 pages (200 files max).
 * @returns All files combined from all pages
 */
export async function fetchAllPlaudFiles(): Promise<PlaudFile[]> {
  const allFiles: PlaudFile[] = [];
  let page = 1;
  const maxPages = 10; // Safety limit: 200 files max

  while (page <= maxPages) {
    const response = await fetchPlaudFiles(page);
    allFiles.push(...response.files);

    // If we got fewer than page_size, we've reached the end
    if (response.files.length < response.pageSize) {
      break;
    }
    page++;
  }

  log.info({ totalFiles: allFiles.length, pages: page }, 'Fetched all Plaud files');
  return allFiles;
}

/**
 * Fetch details for a specific file, including presigned URL for audio.
 */
export async function fetchPlaudFileDetails(fileId: string): Promise<PlaudFileDetails> {
  const accessToken = await ensureValidToken();

  const response = await fetch(`${PLAUD_API_BASE}/files/${fileId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch file details: ${response.status}`);
  }

  return response.json();
}

/**
 * Download audio file from presigned URL to local path.
 */
export async function downloadAudioFile(presignedUrl: string, destPath: string): Promise<void> {
  log.debug({ destPath }, 'Downloading Plaud audio');

  const response = await fetch(presignedUrl);

  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.status}`);
  }
  if (!response.body) {
    throw new Error('Plaud download response has no body');
  }

  // Ensure directory exists
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  const tempPath = `${destPath}.partial-${process.pid}-${Date.now()}`;
  try {
    const nodeReadable = Readable.fromWeb(response.body as never);
    await pipeline(nodeReadable, createWriteStream(tempPath));
    await fs.rename(tempPath, destPath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {
      // Best-effort cleanup for partial stream writes
    });
    throw err;
  }

  const { size } = await fs.stat(destPath);
  log.debug({ destPath, size }, 'Audio downloaded');
}

/**
 * Check if a file exists.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
