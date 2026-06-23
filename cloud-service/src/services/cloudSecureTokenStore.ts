import * as errorReporterNamespace from '@core/errorReporter';
import * as loggerNamespace from '@core/logger';
import type {
  SecureTokenDeleteOptions,
  SecureTokenHasOptions,
  SecureTokenReadOptions,
  SecureTokenStore,
  SecureTokenWriteOptions,
} from '@core/secureTokenStore';
import * as secureTokenStoreNamespace from '@core/secureTokenStore';
import safeStorageDecode from '@core/services/safeStorageDecode';
import * as intentionalSwallowNamespace from '@shared/utils/intentionalSwallow';

const errorReporterModule = 'getErrorReporter' in errorReporterNamespace
  ? errorReporterNamespace
  : (errorReporterNamespace as unknown as { default: typeof errorReporterNamespace }).default;
const loggerModule = 'createScopedLogger' in loggerNamespace
  ? loggerNamespace
  : (loggerNamespace as unknown as { default: typeof loggerNamespace }).default;
// Same dual-interop unwrap as the imports above: this module is loaded both by
// the cloud bootstrap and by eval harnesses whose loader surfaces CJS-transpiled
// modules as { default: namespace } (see evals/shared.ts initEvalPlatformConfig).
const intentionalSwallowModule = 'ignoreBestEffortCleanup' in intentionalSwallowNamespace
  ? intentionalSwallowNamespace
  : (intentionalSwallowNamespace as unknown as { default: typeof intentionalSwallowNamespace }).default;
const secureTokenStoreModule = 'assertSecureTokenLiveKey' in secureTokenStoreNamespace
  ? secureTokenStoreNamespace
  : (secureTokenStoreNamespace as unknown as { default: typeof secureTokenStoreNamespace }).default;
const { getErrorReporter } = errorReporterModule;
const { createScopedLogger } = loggerModule;
const { ignoreBestEffortCleanup } = intentionalSwallowModule;
const { assertSecureTokenLiveKey, getSecureTokenCorruptSidecarKey } = secureTokenStoreModule;
const { clearDegradedLatch, decodeStringStore } = safeStorageDecode;
const log = createScopedLogger({ service: 'secure-token-store.cloud' });

let hasEmittedPlaintextFallback = false;

function emitPlaintextFallbackOnce(namespace: string, key: string): void {
  if (hasEmittedPlaintextFallback) return;
  hasEmittedPlaintextFallback = true;

  const data = { namespace, key };
  log.warn(data, 'secure-token-store.fallback-plaintext');
  try {
    getErrorReporter().addBreadcrumb({
      category: 'secure-token-store.fallback-plaintext',
      level: 'warning',
      message: 'Cloud secure token store falling back to plaintext storage',
      data,
    });
  } catch (error) {
    log.warn({ err: error, ...data }, 'Failed to record secure-token-store plaintext fallback breadcrumb');
  }
}

function emitQuarantine(namespace: string, key: string): void {
  const data = { namespace, key };
  log.warn(data, 'secure-token-store.quarantine');
  try {
    getErrorReporter().addBreadcrumb({
      category: 'secure-token-store.quarantine',
      level: 'warning',
      message: 'Encrypted token quarantined on cloud: decryption unavailable',
      data,
    });
  } catch (error) {
    log.warn({ err: error, ...data }, 'Failed to record secure-token-store quarantine breadcrumb');
  }
}

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
      operation: 'cloudSecureTokenStore.quarantineCorruptPayload',
      reason: 'quarantine-sidecar-write-failed',
    });
    log.warn(
      { err: error, key: options.key, sidecarKey, namespace: options.namespace, tokenKind: options.kind },
      'Failed to quarantine secure token payload before delete',
    );
    return undefined;
  }
}

export class CloudSecureTokenStore implements SecureTokenStore {
  isEncryptionAvailable(): boolean {
    return false;
  }

  read(options: SecureTokenReadOptions): string | null {
    assertSecureTokenLiveKey(options.key);
    try {
      const stored = options.store.get(options.key);
      if (typeof stored !== 'string' || stored.length === 0) return null;

      const result = decodeStringStore({
        stored,
        isEncryptionAvailable: () => this.isEncryptionAvailable(),
        decryptString: () => {
          throw new Error('safeStorage unavailable on cloud surface');
        },
        validate: options.validate,
        kind: options.kind,
      });

      switch (result.kind) {
        case 'ok':
          clearDegradedLatch(options.kind);
          return result.value;
        case 'corrupt': {
          const sidecarKey = quarantineCorruptPayload(options, stored, 'corrupt');
          options.onDestructiveRead?.({
            kind: 'corrupt',
            namespace: options.namespace,
            key: options.key,
            ...(sidecarKey ? { sidecarKey } : {}),
          });
          options.store.delete(options.key);
          return null;
        }
        case 'unavailable_encrypted': {
          const sidecarKey = quarantineCorruptPayload(options, stored, 'unavailable_encrypted');
          emitQuarantine(options.namespace, options.key);
          // Cloud cannot decrypt safeStorage bytes (isEncryptionAvailable is permanently false);
          // quarantining without deleting strands the row forever and re-fires telemetry on every
          // cold-start. Delete to self-heal stranded desktop->cloud migration archives.
          options.onDestructiveRead?.({
            kind: 'unavailable_encrypted',
            namespace: options.namespace,
            key: options.key,
            ...(sidecarKey ? { sidecarKey } : {}),
          });
          options.store.delete(options.key);
          return null;
        }
        case 'null':
          return null;
      }
    } catch (error) {
      log.error(
        { err: error, key: options.key, namespace: options.namespace, tokenKind: options.kind },
        'Failed to read secure token from cloud store',
      );
      return null;
    }
  }

  write(options: SecureTokenWriteOptions): void {
    assertSecureTokenLiveKey(options.key);
    try {
      emitPlaintextFallbackOnce(options.namespace, options.key);
      options.store.set(options.key, Buffer.from(options.value).toString('base64'));
    } catch (error) {
      log.error(
        { err: error, key: options.key, namespace: options.namespace },
        'Failed to save secure token in cloud store',
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
