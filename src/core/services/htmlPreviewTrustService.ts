/**
 * HtmlPreviewTrustService
 *
 * Per-file trust gate for the rebel-html:// document viewer. Persists which
 * absolute file paths the user has explicitly opted into "trusted mode" for,
 * keyed by sha256 of file content so that editing a trusted file invalidates
 * trust on the next load.
 *
 * Used by the rebel-html protocol handler in src/main/index.ts to pick
 * between a strict CSP (default) and a permissive CSP (trusted).
 *
 * @see docs/plans/260525_html_preview_trust_tiers.md
 */

import { createHash } from 'node:crypto';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { HTML_PREVIEW_TRUST_STORE_VERSION } from '../constants';

const log = createScopedLogger({ service: 'htmlPreviewTrust' });

const STORE_NAME = 'html-preview-trust';
const ENTRIES_KEY = 'entries';

interface HtmlPreviewTrustStoreShape extends Record<string, unknown> {
  entries: Record<string, string>;
  version: number;
}

const DEFAULTS: HtmlPreviewTrustStoreShape = {
  entries: {},
  version: HTML_PREVIEW_TRUST_STORE_VERSION,
};

let storeInstance: KeyValueStore<HtmlPreviewTrustStoreShape> | null = null;

function getStore(): KeyValueStore<HtmlPreviewTrustStoreShape> {
  if (!storeInstance) {
    storeInstance = createStore<HtmlPreviewTrustStoreShape>({
      name: STORE_NAME,
      defaults: DEFAULTS,
    });
  }
  return storeInstance;
}

function hashContent(content: Buffer | string): string {
  const hash = createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}

function readEntries(): Record<string, string> {
  try {
    return getStore().get(ENTRIES_KEY, {}) ?? {};
  } catch (err) {
    log.warn({ err }, 'Failed to read trust entries; treating as empty');
    return {};
  }
}

function writeEntries(entries: Record<string, string>): void {
  try {
    getStore().set(ENTRIES_KEY, entries);
  } catch (err) {
    log.warn({ err }, 'Failed to write trust entries');
  }
}

export interface HtmlPreviewTrustService {
  /** True iff the absolute path has been trusted AND the content hash still matches. */
  isTrustedForContent(absolutePath: string, content: Buffer | string): boolean;
  /** True iff the absolute path is trusted regardless of current content. Used by UI for state display. */
  isTrustedPath(absolutePath: string): boolean;
  /** Mark an absolute path as trusted, pinning the current content hash. */
  trust(absolutePath: string, content: Buffer | string): { hash: string };
  /** Remove trust for an absolute path. No-op if not present. */
  reset(absolutePath: string): void;
}

const service: HtmlPreviewTrustService = {
  isTrustedForContent(absolutePath, content) {
    if (!absolutePath) return false;
    const entries = readEntries();
    const stored = entries[absolutePath];
    if (!stored) return false;
    try {
      return stored === hashContent(content);
    } catch (err) {
      log.warn({ err, absolutePath }, 'Hash compute failed; treating as untrusted');
      return false;
    }
  },

  isTrustedPath(absolutePath) {
    if (!absolutePath) return false;
    const entries = readEntries();
    return Boolean(entries[absolutePath]);
  },

  trust(absolutePath, content) {
    const hash = hashContent(content);
    const entries = { ...readEntries(), [absolutePath]: hash };
    writeEntries(entries);
    log.info({ absolutePath }, 'HTML preview trusted');
    return { hash };
  },

  reset(absolutePath) {
    const entries = readEntries();
    if (!(absolutePath in entries)) return;
    const next = { ...entries };
    delete next[absolutePath];
    writeEntries(next);
    log.info({ absolutePath }, 'HTML preview trust reset');
  },
};

export function getHtmlPreviewTrustService(): HtmlPreviewTrustService {
  return service;
}
