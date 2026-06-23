import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import type { IframeMessageMethod, PermissionScope } from '@shared/types/agent';

/**
 * Conversation-scoped MCP App permission entry.
 *
 * Fields may be added over time; writers must merge with existing entries so
 * future metadata survives older grant paths.
 */
export type PermissionEntry = {
  granted: boolean;
  grantedAt: string;
  methods: string[];
  /**
   * Explicit C3 allowlist for iframe-originated `tools/call`.
   * Missing on pre-C3 entries means "no tools allowed" until grantTool() adds one.
   */
  toolAllowlist?: string[];
  [key: string]: unknown;
};

export type McpAppTrustPermissionStore = Record<
  string,
  Record<string, PermissionEntry>
>;

export interface ListedPermission {
  sourcePackageId: string;
  conversationId: string;
  granted: boolean;
  grantedAt: string;
  methods: IframeMessageMethod[];
  toolAllowlist?: string[];
}

type StoreState = {
  'mcpAppsTrust.permissions': McpAppTrustPermissionStore;
};

const STORE_KEY = 'mcpAppsTrust.permissions';

let storeOverrideForTests: KeyValueStore<StoreState> | null = null;
let cachedStore: KeyValueStore<StoreState> | null = null;

function getStore(): KeyValueStore<StoreState> {
  if (storeOverrideForTests) {
    return storeOverrideForTests;
  }

  if (!cachedStore) {
    cachedStore = createStore<StoreState>({
      name: 'mcp-apps-trust',
      defaults: {
        [STORE_KEY]: {},
      },
    });
  }

  return cachedStore;
}

function readPermissions(): McpAppTrustPermissionStore {
  return getStore().get(STORE_KEY, {});
}

function writePermissions(permissions: McpAppTrustPermissionStore): void {
  getStore().set(STORE_KEY, permissions);
}

function normalizeMethods(methods: IframeMessageMethod[]): string[] {
  return Array.from(new Set(methods)).sort();
}

function normalizeToolAllowlist(toolNames: string[]): string[] {
  return Array.from(
    new Set(toolNames.map((toolName) => toolName.trim()).filter(Boolean)),
  ).sort();
}

export function isGranted(scope: PermissionScope, method: IframeMessageMethod): boolean {
  const entry = readPermissions()[scope.sourcePackageId]?.[scope.conversationId];
  return Boolean(entry?.granted && entry.methods.includes(method));
}

export function isToolAllowed(scope: PermissionScope, toolName: string): boolean {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName) {
    return false;
  }
  const entry = readPermissions()[scope.sourcePackageId]?.[scope.conversationId];
  return Boolean(entry?.granted && entry.toolAllowlist?.includes(normalizedToolName));
}

export function grant(scope: PermissionScope, methods: IframeMessageMethod[]): void {
  const permissions = readPermissions();
  const sourcePermissions = permissions[scope.sourcePackageId] ?? {};
  const existing = sourcePermissions[scope.conversationId];
  const nextMethods = normalizeMethods([
    ...(existing?.methods.filter((method): method is IframeMessageMethod => method.length > 0) ?? []),
    ...methods,
  ]);

  writePermissions({
    ...permissions,
    [scope.sourcePackageId]: {
      ...sourcePermissions,
      [scope.conversationId]: {
        ...existing,
        granted: true,
        grantedAt: existing?.grantedAt ?? new Date().toISOString(),
        methods: nextMethods,
      },
    },
  });
}

export function grantTool(scope: PermissionScope, toolName: string): void {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName) {
    return;
  }

  const permissions = readPermissions();
  const sourcePermissions = permissions[scope.sourcePackageId] ?? {};
  const existing = sourcePermissions[scope.conversationId];
  const nextToolAllowlist = normalizeToolAllowlist([
    ...(existing?.toolAllowlist ?? []),
    normalizedToolName,
  ]);

  writePermissions({
    ...permissions,
    [scope.sourcePackageId]: {
      ...sourcePermissions,
      [scope.conversationId]: {
        ...existing,
        granted: true,
        grantedAt: existing?.grantedAt ?? new Date().toISOString(),
        methods: existing?.methods ?? [],
        toolAllowlist: nextToolAllowlist,
      },
    },
  });
}

const V1_MCP_APP_TOOL_ALLOWLIST_BY_FAMILY: Record<string, readonly string[]> = {
  'google-workspace': ['send_workspace_email'],
};

export function isKnownV1McpAppTool(appFamily: string, toolName: string): boolean {
  const normalizedFamily = appFamily.trim();
  const normalizedToolName = toolName.trim();
  if (!normalizedFamily || !normalizedToolName) {
    return false;
  }
  return V1_MCP_APP_TOOL_ALLOWLIST_BY_FAMILY[normalizedFamily]?.includes(normalizedToolName) ?? false;
}

export function ensureKnownV1ToolGrant(scope: PermissionScope, appFamily: string, toolName: string): boolean {
  if (!isKnownV1McpAppTool(appFamily, toolName)) {
    return false;
  }
  grantTool(scope, toolName);
  return true;
}

export function listPermissions(): ListedPermission[] {
  return Object.entries(readPermissions())
    .flatMap(([sourcePackageId, conversations]) =>
      Object.entries(conversations).map(([conversationId, entry]) => ({
        sourcePackageId,
        conversationId,
        granted: entry.granted,
        grantedAt: entry.grantedAt,
        methods: [...entry.methods] as IframeMessageMethod[],
        ...(entry.toolAllowlist ? { toolAllowlist: [...entry.toolAllowlist] } : {}),
      })),
    )
    .sort((left, right) => {
      const sourceComparison = left.sourcePackageId.localeCompare(right.sourcePackageId);
      if (sourceComparison !== 0) {
        return sourceComparison;
      }
      return left.conversationId.localeCompare(right.conversationId);
    });
}

export function revoke(scope: PermissionScope, methods?: IframeMessageMethod[]): void {
  const permissions = readPermissions();
  const sourcePermissions = permissions[scope.sourcePackageId];
  const existing = sourcePermissions?.[scope.conversationId];
  if (!sourcePermissions || !existing) {
    return;
  }

  if (!methods || methods.length === 0) {
    const { [scope.conversationId]: _removed, ...remainingConversations } = sourcePermissions;
    const nextPermissions = { ...permissions };
    if (Object.keys(remainingConversations).length === 0) {
      delete nextPermissions[scope.sourcePackageId];
    } else {
      nextPermissions[scope.sourcePackageId] = remainingConversations;
    }
    writePermissions(nextPermissions);
    return;
  }

  const revoked = new Set(methods);
  const remainingMethods = existing.methods.filter((method) => !revoked.has(method as IframeMessageMethod));
  if (remainingMethods.length === 0) {
    // A3 amendment: revoking the last method must preserve entries that still
    // carry tool allowlist grants; delete only when both capability sets are empty.
    if ((existing.toolAllowlist?.length ?? 0) === 0) {
      revoke(scope);
      return;
    }

    writePermissions({
      ...permissions,
      [scope.sourcePackageId]: {
        ...sourcePermissions,
        [scope.conversationId]: {
          ...existing,
          methods: [],
        },
      },
    });
    return;
  }

  writePermissions({
    ...permissions,
    [scope.sourcePackageId]: {
      ...sourcePermissions,
      [scope.conversationId]: {
        ...existing,
        methods: remainingMethods,
      },
    },
  });
}

export function revokeTool(scope: PermissionScope, toolName: string): void {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName) {
    return;
  }

  const permissions = readPermissions();
  const sourcePermissions = permissions[scope.sourcePackageId];
  const existing = sourcePermissions?.[scope.conversationId];
  if (!sourcePermissions || !existing) {
    return;
  }

  const existingToolAllowlist = existing.toolAllowlist ?? [];
  if (!existingToolAllowlist.includes(normalizedToolName)) {
    return;
  }

  const remainingToolAllowlist = existingToolAllowlist.filter((tool) => tool !== normalizedToolName);
  if (existing.methods.length === 0 && remainingToolAllowlist.length === 0) {
    revoke(scope);
    return;
  }

  writePermissions({
    ...permissions,
    [scope.sourcePackageId]: {
      ...sourcePermissions,
      [scope.conversationId]: {
        ...existing,
        toolAllowlist: remainingToolAllowlist,
      },
    },
  });
}

export function revokePackage(sourcePackageId: string): void {
  const permissions = readPermissions();
  if (!permissions[sourcePackageId]) {
    return;
  }

  const nextPermissions = { ...permissions };
  delete nextPermissions[sourcePackageId];
  writePermissions(nextPermissions);
}

export function cleanupConversation(conversationId: string): void {
  const permissions = readPermissions();
  let changed = false;
  const nextPermissions: McpAppTrustPermissionStore = {};

  for (const [sourcePackageId, conversations] of Object.entries(permissions)) {
    const { [conversationId]: _removed, ...remainingConversations } = conversations;
    if (Object.keys(remainingConversations).length !== Object.keys(conversations).length) {
      changed = true;
    }
    if (Object.keys(remainingConversations).length > 0) {
      nextPermissions[sourcePackageId] = remainingConversations;
    }
  }

  if (changed) {
    writePermissions(nextPermissions);
  }
}

export function _setPermissionStoreForTests(store: KeyValueStore<StoreState> | null): void {
  storeOverrideForTests = store;
  cachedStore = null;
}
