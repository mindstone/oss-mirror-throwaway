import { useCallback, useEffect, useRef, useState } from 'react';

export type ListedPermission =
  Awaited<ReturnType<typeof window.mcpAppsApi.listPermissions>>['permissions'][number];

export interface UseConnectedAppPermissionsResult {
  permissions: ListedPermission[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  revokeConversation: (sourcePackageId: string, conversationId: string) => Promise<void>;
  revokePackage: (sourcePackageId: string) => Promise<void>;
  pendingRevokes: Set<string>;
}

export const connectedAppPermissionKey = (
  sourcePackageId: string,
  conversationId: string,
): string => `${sourcePackageId}|${conversationId}`;

const LOAD_ERROR = "Couldn't load connected app permissions.";
const REVOKE_ERROR = "Couldn't remove access. Try again.";

export function useConnectedAppPermissions(): UseConnectedAppPermissionsResult {
  const [permissions, setPermissions] = useState<ListedPermission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingRevokes, setPendingRevokes] = useState<Set<string>>(() => new Set());
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await window.mcpAppsApi.listPermissions({});
      if (!mountedRef.current) return;
      setPermissions(result.permissions);
    } catch {
      if (!mountedRef.current) return;
      setError(LOAD_ERROR);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unsubscribe = window.api.onMcpPermissionChanged?.(() => {
      void refresh();
    });
    return () => unsubscribe?.();
  }, [refresh]);

  const revokeConversation = useCallback(async (sourcePackageId: string, conversationId: string) => {
    const revokeKey = connectedAppPermissionKey(sourcePackageId, conversationId);
    setPendingRevokes((current) => new Set(current).add(revokeKey));
    setError(null);

    try {
      const result = await window.mcpAppsApi.revokePermission({
        scope: 'conversation',
        sourcePackageId,
        conversationId,
      });
      if (!result.success) {
        throw new Error('mcp:revoke-permission returned success=false');
      }
      await refresh();
    } catch (err) {
      if (mountedRef.current) {
        setError(REVOKE_ERROR);
      }
      throw err;
    } finally {
      if (mountedRef.current) {
        setPendingRevokes((current) => {
          const next = new Set(current);
          next.delete(revokeKey);
          return next;
        });
      }
    }
  }, [refresh]);

  const revokePackage = useCallback(async (sourcePackageId: string) => {
    const packageKeys = permissions
      .filter((permission) => permission.sourcePackageId === sourcePackageId)
      .map((permission) => connectedAppPermissionKey(
        permission.sourcePackageId,
        permission.conversationId,
      ));

    setPendingRevokes((current) => {
      const next = new Set(current);
      packageKeys.forEach((key) => next.add(key));
      return next;
    });
    setError(null);

    try {
      const result = await window.mcpAppsApi.revokePermission({
        scope: 'package',
        sourcePackageId,
      });
      if (!result.success) {
        throw new Error('mcp:revoke-permission returned success=false');
      }
      await refresh();
    } catch (err) {
      if (mountedRef.current) {
        setError(REVOKE_ERROR);
      }
      throw err;
    } finally {
      if (mountedRef.current) {
        setPendingRevokes((current) => {
          const next = new Set(current);
          packageKeys.forEach((key) => next.delete(key));
          return next;
        });
      }
    }
  }, [permissions, refresh]);

  return {
    permissions,
    loading,
    error,
    refresh,
    revokeConversation,
    revokePackage,
    pendingRevokes,
  };
}
