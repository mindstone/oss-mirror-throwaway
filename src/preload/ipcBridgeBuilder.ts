/**
 * Pure-type IPC bridge builder.
 *
 * Provides a generic factory (`makeDomainApi`) that creates typed domain API
 * objects from IPC channel definitions at runtime. TypeScript mapped types
 * derive the correct method signatures — no code generation or Zod runtime
 * introspection required.
 *
 * @see src/preload/ipcBridge.ts — instantiates domain APIs using this builder
 * @see src/shared/ipc/contracts.ts — channel definitions consumed by the builder
 */

import type { z } from 'zod';
import type { InvokeChannelDef, SyncChannelDef } from '@shared/ipc/schemas/common';
import { ipcRenderer } from 'electron';

// ---------------------------------------------------------------------------
// Type utilities
// ---------------------------------------------------------------------------

/** Union of both channel definition shapes. */
export type AnyChannelDef =
  | InvokeChannelDef<z.ZodTypeAny, z.ZodTypeAny>
  | SyncChannelDef<z.ZodTypeAny, z.ZodTypeAny>;

/** Strip the `domain:` prefix from a channel name. */
type StripPrefix<T extends string> = T extends `${string}:${infer Rest}` ? Rest : T;

/** Convert kebab-case to camelCase. */
type KebabToCamel<T extends string> =
  T extends `${infer H}-${infer R}` ? `${H}${Capitalize<KebabToCamel<R>>}` : T;

/** Derive the JS method name from a channel key. */
type MethodName<T extends string> = KebabToCamel<StripPrefix<T>>;

/**
 * Derive argument tuple from a request schema: void → [], optional → [req?], required → [req].
 * Uses z.input (not z.infer) so callers can omit fields with .default() values.
 */
type RequestArgs<TReq extends z.ZodTypeAny> =
  z.input<TReq> extends void ? [] :
  undefined extends z.input<TReq> ? [request?: z.input<TReq>] :
  [request: z.input<TReq>];

/** Full typed API surface derived from a channel-definition record. */
export type DomainApi<T extends Record<string, AnyChannelDef>> = {
  [K in keyof T & string as MethodName<K>]:
    T[K] extends SyncChannelDef<infer Req, infer Res>
      ? (...args: RequestArgs<Req>) => z.infer<Res>
      : T[K] extends InvokeChannelDef<infer Req, infer Res>
        ? (...args: RequestArgs<Req>) => Promise<z.infer<Res>>
        : never;
};

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

/**
 * Derive a camelCase method name from an IPC channel string.
 * Matches the old generator's `channelToMethodName` logic exactly.
 *
 * Examples:
 *   'settings:get-default-workspace' → 'getDefaultWorkspace'
 *   'check-for-updates'              → 'checkForUpdates'
 *   'sessions:save-sync'             → 'saveSync'
 */
export function channelToMethodName(channel: string): string {
  return channel
    .replace(/^[^:]+:/, '')
    .replace(/-([a-z])/g, (_, l: string) => l.toUpperCase());
}

/**
 * Build a typed domain API object from a record of channel definitions.
 * Each channel becomes a method that calls `ipcRenderer.invoke` (async)
 * or `ipcRenderer.sendSync` (sync).
 */
export function makeDomainApi<T extends Record<string, AnyChannelDef>>(
  channels: T,
): DomainApi<T> {
  const api: Record<string, Function> = {};
  for (const def of Object.values(channels) as AnyChannelDef[]) {
    const name = channelToMethodName(def.channel);

    if (process.env.NODE_ENV !== 'production' && name in api) {
      throw new Error(
        `Duplicate IPC method name '${name}' in domain (channel: ${def.channel})`,
      );
    }

    api[name] =
      def.type === 'sync'
        ? (request?: unknown) => ipcRenderer.sendSync(def.channel, request)
        : (request?: unknown) => ipcRenderer.invoke(def.channel, request);
  }
  return api as DomainApi<T>;
}
