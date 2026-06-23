/**
 * Shared decode helpers for safeStorage-backed token stores.
 *
 * All four token storage modules (authTokenStorage, providerTokenStorage,
 * openRouterTokenStorage, flyTokenStorage) write the same payload shape:
 * either an Electron safeStorage encrypted Buffer (when keychain is
 * available at write time) or a plain UTF-8 Buffer (Linux without
 * Secret Service / E2E test mode), serialized as base64.
 *
 * The on-disk format carries no metadata indicating which kind of bytes
 * are stored. When `safeStorage.isEncryptionAvailable()` flips between
 * the write session and a later read session (locked vault, post-resume
 * race, FileVault transition, app-identity drift), a naive plain decode
 * of encrypted bytes produces a U+FFFD-poisoned string that
 * deterministically fails undici's `Authorization: Bearer ${token}`
 * ByteString conversion.
 *
 * The helpers below detect Electron's `v10`/`v11` encryption header on
 * the raw buffer and route accordingly:
 * - decrypt-first when keychain is available;
 * - return null without deleting when the bytes are encrypted but the
 *   keychain is currently unreachable, so the next call recovers
 *   transparently as soon as the keychain returns;
 * - clear + null only on genuine ciphertext corruption (decrypt throws
 *   AND the bytes carry the encryption header);
 * - validator-gated plain decode for legitimate plain-stored tokens
 *   (Linux without Secret Service, E2E test mode).
 *
 * Sentry signals are deduped per token kind by a module-level latch
 * that auto-clears on successful decrypt — one event per degraded
 * period, future regressions still fire.
 *
 * See:
 *   docs-private/investigations/260506_safestorage_token_corruption_ufffd.md
 *   docs-private/postmortems/260402_fly_provider_token_corruption_fallback_postmortem.md
 *   docs-private/postmortems/260401_license_tier_downgrade_safestorage_postmortem.md
 *   src/core/services/codexTokenStorage.ts (precedent v10/v11 guard)
 */

import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'safe-storage-decode' });

export function hasSafeStorageHeader(buf: Buffer): boolean {
  if (buf.length < 3) return false;
  // Byte-level comparison rather than `buf.subarray(0, 3).toString('ascii')`,
  // because `Buffer.toString('ascii')` masks high bits (`byte & 0x7F`) and
  // would treat e.g. 0xF6/0xB1/0xB0 as 'v10'. Real Electron ciphertext only
  // ever uses raw ASCII v10/v11 header bytes, so the mask was harmless in
  // practice — but byte comparison is the unambiguous contract.
  return (
    buf[0] === 0x76 /* v */ &&
    buf[1] === 0x31 /* 1 */ &&
    (buf[2] === 0x30 /* 0 */ || buf[2] === 0x31 /* 1 */)
  );
}

const degradedLatch = new Map<string, true>();

export function captureDegradedOnce(kind: string): void {
  if (degradedLatch.has(kind)) return;
  degradedLatch.set(kind, true);
  log.warn(
    { tokenKind: kind },
    'safeStorage encrypted token detected on plain-read path — keychain unavailable; returning null pending recovery',
  );
  try {
    getErrorReporter().captureMessage('safestorage_unavailable_at_read', {
      level: 'warning',
      tags: { tokenKind: kind },
    });
  } catch (err) {
    log.warn({ err, tokenKind: kind }, 'errorReporter.captureMessage threw while recording degraded latch');
  }
}

export function clearDegradedLatch(kind: string): void {
  degradedLatch.delete(kind);
}

/**
 * Test-only helper for resetting the module-level dedupe latch between
 * test cases. Production code MUST NOT call this — the latch is an
 * intentional per-process invariant outside of tests.
 */
export function __resetDegradedLatchForTesting(): void {
  degradedLatch.clear();
}

/**
 * Strict ASCII printable validator (codepoints 0x20–0x7E only, no
 * control chars, no U+FFFD, non-empty). Auth/provider/fly/openrouter
 * tokens are documented to be ASCII (base64/base64url + delimiters), so
 * any byte outside this range on the plain-decode path indicates either
 * a misencoded ciphertext (the U+FFFD bug) or an unexpected upstream
 * change.
 */
export function isValidNonEmptyAscii(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code > 0x7E) return false;
  }
  return true;
}

/**
 * Stricter session-token validator: ASCII printable (per
 * {@link isValidNonEmptyAscii}) plus a length window of 16–4096 chars.
 * Better-Auth session tokens fit comfortably inside this window;
 * anything outside is almost certainly corruption or an upstream
 * format change worth surfacing as null rather than silently passing
 * through to the auth header.
 */
export function isValidTokenString(s: string): boolean {
  if (!isValidNonEmptyAscii(s)) return false;
  if (s.length < 16 || s.length > 4096) return false;
  return true;
}

export type DecodedResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'null' }
  | { kind: 'corrupt' }
  | { kind: 'unavailable_encrypted' };

export interface DecodeStringStoreOptions {
  stored: string;
  isEncryptionAvailable: () => boolean;
  decryptString: (buf: Buffer) => string;
  validate: (s: string) => boolean;
  kind: string;
}

export function decodeStringStore(opts: DecodeStringStoreOptions): DecodedResult<string> {
  // `Buffer.from(string, 'base64')` does not throw on malformed input — it
  // silently strips invalid characters. Downstream prefix-check + validator
  // failure is what catches garbage, so no defensive try/catch is needed here.
  const buffer = Buffer.from(opts.stored, 'base64');

  if (opts.isEncryptionAvailable()) {
    try {
      const decrypted = opts.decryptString(buffer);
      return { kind: 'ok', value: decrypted };
    } catch (err) {
      if (hasSafeStorageHeader(buffer)) {
        log.warn(
          { err, tokenKind: opts.kind },
          'safeStorage decrypt failed on encrypted-prefixed payload — treating as corrupt',
        );
        return { kind: 'corrupt' };
      }
      const plain = buffer.toString('utf-8');
      if (opts.validate(plain)) return { kind: 'ok', value: plain };
      log.warn(
        { tokenKind: opts.kind },
        'plain decode after decrypt-throws failed token validation — returning null without delete',
      );
      return { kind: 'null' };
    }
  }

  if (hasSafeStorageHeader(buffer)) {
    captureDegradedOnce(opts.kind);
    return { kind: 'unavailable_encrypted' };
  }

  const plain = buffer.toString('utf-8');
  if (opts.validate(plain)) return { kind: 'ok', value: plain };
  log.warn(
    { tokenKind: opts.kind },
    'plain decode failed token validation — returning null without delete',
  );
  return { kind: 'null' };
}

export default {
  clearDegradedLatch,
  decodeStringStore,
};

export interface DecodeJsonStoreOptions<T> {
  stored: string;
  isEncryptionAvailable: () => boolean;
  decryptString: (buf: Buffer) => string;
  validate: (parsed: unknown) => parsed is T;
  kind: string;
}

function tryParseAndValidate<T>(plain: string, validate: (parsed: unknown) => parsed is T): T | null {
  try {
    const parsed: unknown = JSON.parse(plain);
    if (validate(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function decodeJsonStore<T>(opts: DecodeJsonStoreOptions<T>): DecodedResult<T> {
  // See note in `decodeStringStore` about base64 not throwing.
  const buffer = Buffer.from(opts.stored, 'base64');

  if (opts.isEncryptionAvailable()) {
    try {
      const json = opts.decryptString(buffer);
      const parsed = tryParseAndValidate(json, opts.validate);
      if (parsed != null) return { kind: 'ok', value: parsed };
      log.warn(
        { tokenKind: opts.kind },
        'decrypted JSON failed shape validation — returning null without delete',
      );
      return { kind: 'null' };
    } catch (err) {
      if (hasSafeStorageHeader(buffer)) {
        log.warn(
          { err, tokenKind: opts.kind },
          'safeStorage decrypt failed on encrypted-prefixed payload — treating as corrupt',
        );
        return { kind: 'corrupt' };
      }
      const plain = buffer.toString('utf-8');
      const parsed = tryParseAndValidate(plain, opts.validate);
      if (parsed != null) return { kind: 'ok', value: parsed };
      log.warn(
        { tokenKind: opts.kind },
        'plain JSON decode after decrypt-throws failed validation — returning null without delete',
      );
      return { kind: 'null' };
    }
  }

  if (hasSafeStorageHeader(buffer)) {
    captureDegradedOnce(opts.kind);
    return { kind: 'unavailable_encrypted' };
  }

  const plain = buffer.toString('utf-8');
  const parsed = tryParseAndValidate(plain, opts.validate);
  if (parsed != null) return { kind: 'ok', value: parsed };
  log.warn(
    { tokenKind: opts.kind },
    'plain JSON decode failed validation — returning null without delete',
  );
  return { kind: 'null' };
}
