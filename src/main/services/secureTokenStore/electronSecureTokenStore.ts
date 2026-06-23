// CORE-MOVE-EXEMPT: Electron safeStorage is desktop-only; this adapter must stay in src/main.
import type {
  SecureTokenDeleteOptions,
  SecureTokenHasOptions,
  SecureTokenReadOptions,
  SecureTokenStore,
  SecureTokenWriteOptions,
} from '@core/secureTokenStore';
import { assertSecureTokenLiveKey, getSecureTokenCorruptSidecarKey } from '@core/secureTokenStore';
import { getElectronModule } from '@core/lazyElectron';
import { createScopedLogger } from '@core/logger';
import { clearDegradedLatch, decodeStringStore } from '@core/services/safeStorageDecode';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { isE2eTestMode } from '../../utils/testIsolation';

const log = createScopedLogger({ service: 'secure-token-store.electron' });

function quarantineCorruptPayload(options: SecureTokenReadOptions, stored: string, kind: 'corrupt' | 'unavailable_encrypted'): string | undefined {
  const sidecarKey = getSecureTokenCorruptSidecarKey(options.key);
  try {
    options.store.set(sidecarKey, {
      namespace: options.namespace,
      key: options.key,
      kind,
      archivedAt: Date.now(),
      stored,
    });
    return sidecarKey;
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'electronSecureTokenStore.quarantineCorruptPayload',
      reason: 'quarantine-sidecar-write-failed',
    });
    log.warn(
      { err: error, key: options.key, sidecarKey, namespace: options.namespace, tokenKind: options.kind },
      'Failed to quarantine corrupt secure token payload before delete',
    );
    return undefined;
  }
}

export class ElectronSecureTokenStore implements SecureTokenStore {
  isEncryptionAvailable(): boolean {
    if (isE2eTestMode()) return false;
    try {
      const safeStorage = getElectronModule()?.safeStorage;
      return safeStorage?.isEncryptionAvailable() ?? false;
    } catch (error) {
      log.warn({ err: error }, 'Failed to check safeStorage availability');
      return false;
    }
  }

  read(options: SecureTokenReadOptions): string | null {
    assertSecureTokenLiveKey(options.key);
    try {
      const stored = options.store.get(options.key);
      if (typeof stored !== 'string' || stored.length === 0) return null;

      const result = decodeStringStore({
        stored,
        isEncryptionAvailable: () => this.isEncryptionAvailable(),
        decryptString: (buf) => {
          const safeStorage = getElectronModule()?.safeStorage;
          if (!safeStorage) throw new Error('safeStorage unavailable after encryption check');
          return safeStorage.decryptString(buf);
        },
        validate: options.validate,
        kind: options.kind,
      });

      switch (result.kind) {
        case 'ok':
          clearDegradedLatch(options.kind);
          return result.value;
        case 'corrupt':
          // Keep the latest unreadable payload for local forensics, then
          // remove the live key so normal auth flows can self-heal.
          const sidecarKey = quarantineCorruptPayload(options, stored, 'corrupt');
          log.error(
            { key: options.key, sidecarKey, namespace: options.namespace, tokenKind: options.kind },
            'Token decryption failed on encrypted-prefixed payload — clearing corrupt token from store',
          );
          options.onDestructiveRead?.({
            kind: 'corrupt',
            namespace: options.namespace,
            key: options.key,
            ...(sidecarKey ? { sidecarKey } : {}),
          });
          options.store.delete(options.key);
          return null;
        case 'unavailable_encrypted':
        case 'null':
          return null;
      }
    } catch (error) {
      log.error(
        { err: error, key: options.key, namespace: options.namespace, tokenKind: options.kind },
        'Failed to read secure token',
      );
      return null;
    }
  }

  write(options: SecureTokenWriteOptions): void {
    assertSecureTokenLiveKey(options.key);
    try {
      if (this.isEncryptionAvailable()) {
        const safeStorage = getElectronModule()?.safeStorage;
        if (!safeStorage) throw new Error('safeStorage unavailable after encryption check');
        const encrypted = safeStorage.encryptString(options.value);
        options.store.set(options.key, encrypted.toString('base64'));
        log.debug({ key: options.key, namespace: options.namespace }, 'Secure token saved with encryption');
        return;
      }

      log.warn(
        { key: options.key, namespace: options.namespace },
        'safeStorage unavailable — storing token without encryption',
      );
      options.store.set(options.key, Buffer.from(options.value).toString('base64'));
    } catch (error) {
      log.error(
        { err: error, key: options.key, namespace: options.namespace },
        'Failed to save secure token',
      );
      throw new Error('Failed to save secure token');
    }
  }

  delete(options: SecureTokenDeleteOptions): void {
    assertSecureTokenLiveKey(options.key);
    options.store.delete(options.key);
  }

  has(options: SecureTokenHasOptions): boolean {
    assertSecureTokenLiveKey(options.key);
    return options.store.has(options.key);
  }
}
