---
description: "Persisted-data migration patterns for Mindstone Rebel — versioned store migrations, one-time startup migrations, and ordering rules"
last_updated: "2026-06-18"
---

# Migrations

This document describes the two migration patterns used in Mindstone Rebel for evolving persisted data structures.

## See also

- [ELECTRON_STORAGE_REFERENCE.md](./ELECTRON_STORAGE_REFERENCE.md) - Comprehensive reference for all files in userData
- [ARCHITECTURE_DATA_STRUCTURES.md](./ARCHITECTURE_DATA_STRUCTURES.md) - Overview of persisted data structures
- [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md) - Where migrations fit in the startup sequence
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md](./SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) - AppSettings schema and storage

---

## Overview

The app uses two distinct migration patterns depending on the complexity and nature of the data being migrated:

| Pattern | Use case | Location | Features |
|---------|----------|----------|----------|
| **Versioned store migration** | Complex stores with evolving schemas | `src/core/utils/storeMigration.ts` | Version numbers, backups, future-version protection |
| **One-time startup migration** | Simple field renames/transformations | Called from `src/main/index.ts` | Idempotent, no version tracking |

---

## Pattern 1: Versioned Store Migration

**Location:** `src/core/utils/storeMigration.ts`

**Used by:**
- Inbox store (`src/main/services/inboxStore.ts`)
- Automation scheduler (`src/main/services/automationScheduler.ts`)
- Session history (`src/main/index.ts`)

### When to use

Use versioned store migration when:
- The store has complex nested data structures
- You need to track migration versions explicitly
- You want automatic backups before destructive changes
- The store may be modified by newer app versions (future-version protection)

### How it works

1. Each store includes a `version` number in its persisted data
2. Migrations are registered as functions that transform from version N to N+1
3. On startup, `migrateStore()` compares stored version to current version
4. If stored < current: creates backup, runs migrations sequentially
5. If stored > current: refuses to modify (future-version protection)

### Non-destructive invariant

Migrations must **never wipe real on-disk fields** when version read fails, a future-version store is detected, or a registered migration throws. The shared contract in `src/core/utils/storeMigration.ts`:

- **`shouldPersist`** — callers write migrated data back only when `true`. On `future_version`, migration throw, or non-empty version-less/corrupted data, `shouldPersist` is `false` and the raw file (plus any pre-migration backup) stays intact.
- **`shouldEnterReadOnlyMode()`** — trips read-only for `future_version` and for `corrupted` results where `shouldPersist === false`, blocking later writes that would clobber preserved data with empty defaults.

This invariant is enforced across all **12 production `migrateStore` call sites** (desktop + cloud): inbox, automation scheduler, tool/skill/time-saved/achievements/contribution stores, and the other versioned stores listed under Pattern 1. See `src/core/services/__tests__/storeMigrationCorruptedNonDestructive.test.ts` for caller parity tests.

### Example

```typescript
import { migrateStore, StoreMigrationConfig } from '../utils/storeMigration';

interface MyStoreData extends VersionedData {
  version: number;
  items: Array<{ id: string; name: string }>;
}

const config: StoreMigrationConfig<MyStoreData> = {
  storeName: 'my-store',
  currentVersion: 2,
  migrations: {
    // Migration from v1 to v2: add 'name' field to items
    1: (data) => ({
      ...data,
      version: 2,
      items: data.items.map(item => ({
        ...item,
        name: (item as any).title ?? 'Untitled'
      }))
    })
  },
  createDefault: () => ({ version: 2, items: [] })
};

const result = migrateStore(existingData, config);
if (result.shouldPersist) {
  store.store = result.data;
}
```

---

## Pattern 2: One-Time Startup Migration

**Example:** `migrateLegacyWrapperSettingsIfNeeded()` in `src/main/services/bundledMcpManager.ts`

**Used by:**
- AppSettings field renames and simple transformations
- MCP config migrations

### When to use

Use one-time startup migration when:
- You're doing a simple field rename or value transformation
- The migration is idempotent (safe to run multiple times)
- No version tracking is needed
- You want to actually remove the old field from disk

### How it works

1. Migration function checks if old field exists
2. If present: transforms data, removes old field via destructuring
3. Returns transformed settings (or unchanged if nothing to do)
4. Caller writes result back to store

### Key principle: Migrate before normalize

**Critical ordering:** One-time migrations must run **before** `ensureNormalizedSettings()`. Otherwise:
- Normalization with new schema sets new field to default (e.g., `null`)
- Migration sees new field exists and skips
- Old field value is lost!

```typescript
// In src/main/index.ts - CORRECT ORDER
settingsStore.store = migrateOnboardingTimestampIfNeeded(settingsStore.store);
ensureNormalizedSettings();
settingsStore.store = await migrateLegacyWrapperSettingsIfNeeded(settingsStore.store);
```

### Example

```typescript
export const migrateOnboardingTimestampIfNeeded = (settings: AppSettings): AppSettings => {
  const oldValue = (settings as any).onboardingCompletedAt;
  const newValue = (settings as any).onboardingFirstCompletedAt;

  // If old field doesn't exist, nothing to do
  if (oldValue === undefined) {
    return settings;
  }

  // Always drop the old field from the returned object
  const { onboardingCompletedAt: _dropped, ...rest } = settings as any;

  // If new field already exists, keep it; just return without old field
  if (newValue !== undefined) {
    return rest as AppSettings;
  }

  // Migrate: copy old value to new field (with type guard)
  return {
    ...rest,
    onboardingFirstCompletedAt: typeof oldValue === 'number' ? oldValue : null,
  } as AppSettings;
};
```

### Testing one-time migrations

Write unit tests covering these scenarios:
1. Neither old nor new field exists → unchanged
2. Only old field exists (valid type) → migrated to new, old removed
3. Only new field exists → unchanged
4. Both fields exist → old removed, new preserved
5. Old field has invalid type → migrated as null/default

---

## Adding a new migration

### For versioned stores

1. Increment `currentVersion` in the store's migration config
2. Add a migration function for version N-1 that transforms to version N
3. Update the `createDefault()` function to return the new schema
4. Add tests for the migration function

### For settings field renames

1. Create an idempotent migration function in `src/main/settingsStore.ts`
2. Call it in `src/main/index.ts` **before** `ensureNormalizedSettings()`
3. Update type definitions, schemas, and all consumers
4. Add unit tests for the migration function
5. Run `npm run validate:ipc` if IPC schemas changed; add new domain APIs to `src/preload/ipcBridge.ts`
