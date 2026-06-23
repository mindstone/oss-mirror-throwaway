/**
 * usePluginStorageWithVersion — convenience wrapper around usePluginStorage
 * that adds schema versioning and data migration support.
 *
 * Stores data in a version envelope: `{ _v: number, d: T }`.
 * On load, if the stored version is older than the current schemaVersion,
 * the migrate callback is invoked to upgrade the data. The upgraded data
 * is written back with the current version.
 *
 * Plugins that don't need versioning can continue using usePluginStorage
 * directly — this is a convenience hook, not a requirement.
 *
 * @see docs/plans/260408_plugin_data_storage_robustness.md (Stage 5)
 * @see rebel-system/skills/system/build-custom-plugin/references/MIGRATIONS.md
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePluginStorage } from './usePluginStorage';

/** Internal envelope format stored via usePluginStorage. */
interface VersionEnvelope<T> {
  _v: number;
  d: T;
}

function isVersionEnvelope(value: unknown): value is VersionEnvelope<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_v' in value &&
    'd' in value &&
    typeof (value as VersionEnvelope<unknown>)._v === 'number'
  );
}

export function usePluginStorageWithVersion<T>(
  key: string,
  defaultValue: T,
  options: {
    schemaVersion: number;
    migrate: (oldVersion: number, oldData: unknown) => T;
  },
): [T, (value: T) => void] {
  const { schemaVersion, migrate } = options;

  // Use a sentinel default so we can detect "no stored data" vs "stored data"
  const envelopeDefault: VersionEnvelope<T> = { _v: schemaVersion, d: defaultValue };
  const [rawValue, setRawValue] = usePluginStorage<VersionEnvelope<T> | unknown>(key, envelopeDefault);

  const [value, setValueState] = useState<T>(defaultValue);
  const hasMigratedRef = useRef(false);
  const latestSchemaVersion = useRef(schemaVersion);
  latestSchemaVersion.current = schemaVersion;

  // Handle migration on load / when rawValue changes
  useEffect(() => {
    if (rawValue === undefined || rawValue === null) {
      // No stored data — use default
      setValueState(defaultValue);
      hasMigratedRef.current = false;
      return;
    }

    if (isVersionEnvelope(rawValue)) {
      const envelope = rawValue as VersionEnvelope<unknown>;
      if (envelope._v >= latestSchemaVersion.current) {
        // Current or newer version — use data as-is
        setValueState(envelope.d as T);
        hasMigratedRef.current = true;
        return;
      }

      // Older version — migrate
      try {
        const migrated = migrate(envelope._v, envelope.d);
        const newEnvelope: VersionEnvelope<T> = { _v: latestSchemaVersion.current, d: migrated };
        setRawValue(newEnvelope);
        setValueState(migrated);
        hasMigratedRef.current = true;
      } catch (err) {
        // Migration failed — keep old data, don't write back
        console.warn(
          `[usePluginStorageWithVersion] Migration failed for key "${key}" from version ${envelope._v} to ${latestSchemaVersion.current}:`,
          err,
        );
        setValueState(envelope.d as T);
        hasMigratedRef.current = true;
      }
    } else {
      // Unversioned data (no envelope) — treat as version 0
      try {
        const migrated = migrate(0, rawValue);
        const newEnvelope: VersionEnvelope<T> = { _v: latestSchemaVersion.current, d: migrated };
        setRawValue(newEnvelope);
        setValueState(migrated);
        hasMigratedRef.current = true;
      } catch (err) {
        // Migration failed — keep raw data as best-effort
        console.warn(
          `[usePluginStorageWithVersion] Migration from unversioned data failed for key "${key}":`,
          err,
        );
        setValueState(rawValue as T);
        hasMigratedRef.current = true;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- migrate is a callback from options, schemaVersion from options
  }, [rawValue, key]);

  const setValue = useCallback(
    (newValue: T) => {
      const envelope: VersionEnvelope<T> = { _v: latestSchemaVersion.current, d: newValue };
      setRawValue(envelope);
      setValueState(newValue);
    },
    [setRawValue],
  );

  return [value, setValue];
}
