import { useCallback, useEffect, useMemo, useRef, useState, type FC, type MouseEvent as ReactMouseEvent } from 'react';
import { Badge, Button, Card, MaturityBadge, Notice, Tooltip } from '@renderer/components/ui';
import { CodeXml, DatabaseBackup, ExternalLink, MoreHorizontal, RotateCcw, Trash2, Upload } from 'lucide-react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import { PluginActionsMenu, type PluginAction } from '../../../plugins/components/PluginActionsMenu';
import menuStyles from '../../../plugins/components/PluginActionsMenu.module.css';
import type { PluginConflict } from '@shared/ipc/schemas/plugins';
import type { AppSettings } from '@shared/types';
import { formatNavigationUrl } from '@shared/navigation/urlParser';
import { useAppContext } from '@renderer/contexts/AppContext';
import { useNavigationSafe } from '@renderer/contexts/NavigationContext';
import { fetchSpaces, getSpacesSnapshotFor } from '@renderer/hooks/useSpacesData';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { useSettingsSafe } from '../../SettingsProvider';
import { resolveModelSettings } from '@shared/utils/settingsUtils';
import { useRegisteredPlugins } from '../../../plugins/hooks/useRegisteredPlugins';
import { useSharedSpacePlugins } from '../../../plugins/hooks/spacePluginsStartup';
import { registerPlugin, unregisterPlugin, getPluginSource, getRegisteredPlugin } from '../../../plugins/manifest/pluginRegistry';
import type { CatalogPlugin } from '../../../plugins/manifest/pluginRegistry';
import type { PluginManifest } from '../../../plugins/manifest/pluginManifest';
import { formatSpaceSourceLabel } from '../../../plugins/utils/formatSpaceSourceLabel';
import {
  archivePlugin,
  deleteArchivedPlugin,
  loadArchivedPlugins,
  restoreArchivedPlugin,
  type ArchivedPlugin,
} from '../../../plugins/manifest/pluginArchiveStore';
import { PluginSecurityDialog } from '../../../plugins/security/PluginSecurityDialog';
import { reviewPluginSecurity, type PluginSecurityReport } from '../../../plugins/security/pluginSecurityReview';
import { SettingSection } from '../SettingSection';
import { PluginSourceViewer } from './PluginSourceViewer';
import styles from '../SettingsSurface.module.css';

function hasRendererAuth(settings: AppSettings): boolean {
  const resolvedModelSettings = resolveModelSettings(settings);
  return Boolean(resolvedModelSettings?.apiKey?.trim()) || Boolean(resolvedModelSettings?.oauthToken?.trim());
}

interface MergeProposal {
  conflictKey: string;
  conflict: PluginConflict;
  mergedManifest: Record<string, unknown>;
  mergedSource: string;
}

const renderMaturityBadge = (manifest: PluginManifest) => {
  if (manifest.maturity === 'stable') {
    return <Badge variant="secondary" size="sm">Stable</Badge>;
  }

  return <MaturityBadge level="labs" featureName={manifest.name} />;
};

// formatSpaceSourceLabel moved to ../../../plugins/utils/formatSpaceSourceLabel.

/** Format byte count as human-readable string (KB or MB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface PluginUsageInfo {
  usedBytes: number;
  quotaBytes: number;
  percentUsed: number;
}

/**
 * Tracks which plugins have a data backup available (keyed by pluginId).
 * Re-checks whenever the plugin list changes.
 */
function usePluginDataBackups(pluginIds: string[]): Set<string> {
  const [backupSet, setBackupSet] = useState<Set<string>>(new Set());
  const idsKey = pluginIds.join(',');
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    if (!window.pluginsApi?.hasDataBackup || pluginIds.length === 0) return;

    const fetchAll = async () => {
      const ids: string[] = [];
      for (const pluginId of pluginIds) {
        try {
          const result = await window.pluginsApi.hasDataBackup({ pluginId });
          if (result.hasBackup) {
            ids.push(pluginId);
          }
        } catch {
          // Skip on failure
        }
      }
      if (isMounted.current) {
        setBackupSet(new Set(ids));
      }
    };

    fireAndForget(fetchAll(), 'fetchPluginDataBackups');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting pluginIds array because idsKey is the stable recheck trigger
  }, [idsKey]);

  return backupSet;
}

/**
 * Fetches storage usage for all given plugin IDs. Returns a map of pluginId → usage.
 * Only includes plugins with > 0 bytes used.
 */
function usePluginStorageUsage(pluginIds: string[]): Map<string, PluginUsageInfo> {
  const [usageMap, setUsageMap] = useState<Map<string, PluginUsageInfo>>(new Map());
  const idsKey = pluginIds.join(',');
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    if (!window.pluginsApi?.storageUsage || pluginIds.length === 0) return;

    const fetchAll = async () => {
      const entries: [string, PluginUsageInfo][] = [];
      for (const pluginId of pluginIds) {
        try {
          const result = await window.pluginsApi.storageUsage({ pluginId });
          if (result.usedBytes > 0) {
            entries.push([pluginId, result]);
          }
        } catch {
          // Skip plugins where usage fetch fails
        }
      }
      if (isMounted.current) {
        setUsageMap(new Map(entries));
      }
    };

    fireAndForget(fetchAll(), 'fetchPluginStorageUsage');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting pluginIds array because idsKey is the stable usage-refresh trigger
  }, [idsKey]);

  return usageMap;
}

// ── Disabled/Archived Plugin Context Menu ──────────────────────────────

type DisabledPluginAction = 'restore' | 'viewSource' | 'exportData' | 'delete';

interface DisabledPluginActionDef {
  id: DisabledPluginAction;
  label: string;
  icon: FC<{ size?: number; strokeWidth?: number; className?: string }>;
  dividerBefore?: boolean;
  isDanger?: boolean;
}

const DISABLED_PLUGIN_ACTIONS: DisabledPluginActionDef[] = [
  { id: 'restore', label: 'Re-enable', icon: RotateCcw },
  { id: 'viewSource', label: 'View Source', icon: CodeXml },
  { id: 'exportData', label: 'Export Data', icon: DatabaseBackup, dividerBefore: true },
  { id: 'delete', label: 'Delete', icon: Trash2, dividerBefore: true, isDanger: true },
];

interface DisabledPluginActionsMenuProps {
  pluginName: string;
  onAction: (action: DisabledPluginAction) => void;
}

const DisabledPluginActionsMenu: FC<DisabledPluginActionsMenuProps> = ({ pluginName, onAction }) => {
  const [isOpen, setIsOpen] = useState(false);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-end',
    strategy: 'fixed',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context, { ancestorScroll: true });
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  const handleAction = useCallback(
    (actionId: DisabledPluginAction, event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onAction(actionId);
      setIsOpen(false);
    },
    [onAction],
  );

  return (
    <>
      <Tooltip content="More actions" disabled={isOpen}>
        <button
          ref={refs.setReference}
          type="button"
          className={`${menuStyles.menuTrigger} ${isOpen ? menuStyles.menuTriggerOpen : ''}`.trim()}
          aria-label={`More actions for ${pluginName}`}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          {...getReferenceProps({ onClick: (e) => e.stopPropagation() })}
        >
          <MoreHorizontal size={16} strokeWidth={2} />
        </button>
      </Tooltip>
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={menuStyles.menu}
            role="menu"
            data-positioned={isPositioned}
            onClick={(e) => e.stopPropagation()}
            {...getFloatingProps()}
          >
            {DISABLED_PLUGIN_ACTIONS.map((action, index) => (
              <div key={action.id}>
                {action.dividerBefore && index > 0 && <div className={menuStyles.menuDivider} />}
                <button
                  type="button"
                  className={`${menuStyles.menuItem} ${action.isDanger ? menuStyles.menuItemDanger : ''}`.trim()}
                  role="menuitem"
                  onClick={(e) => handleAction(action.id, e)}
                >
                  <action.icon size={14} strokeWidth={2} className={menuStyles.menuItemIcon} />
                  <span>{action.label}</span>
                </button>
              </div>
            ))}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

export const PluginsTab = () => {
  const registeredPlugins = useRegisteredPlugins();
  const {
    spacePlugins,
    conflicts,
    isLoading: isSpacePluginsLoading,
    error: spacePluginsError,
    refresh: refreshSpacePlugins,
  } = useSharedSpacePlugins();
  const { showToast } = useAppContext();
  const settingsContext = useSettingsSafe();
  const navigation = useNavigationSafe();
  const [viewingSource, setViewingSource] = useState<{ name: string; source: string } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [resolvingConflictKey, setResolvingConflictKey] = useState<string | null>(null);
  const [requestingMergeKey, setRequestingMergeKey] = useState<string | null>(null);
  const [acceptingMergeKey, setAcceptingMergeKey] = useState<string | null>(null);
  const [mergeProposal, setMergeProposal] = useState<MergeProposal | null>(null);
  const [isMergeAuthAvailable, setIsMergeAuthAvailable] = useState(false);
  const [isCheckingMergeAuth, setIsCheckingMergeAuth] = useState(true);
  const [expandedDocsPluginIds, setExpandedDocsPluginIds] = useState<Set<string>>(new Set());
  const [securityReviewPlugin, setSecurityReviewPlugin] = useState<CatalogPlugin | null>(null);
  const [securityReport, setSecurityReport] = useState<PluginSecurityReport | null>(null);
  const [securityScanError, setSecurityScanError] = useState<string | null>(null);
  const [isEnablingSpacePlugin, setIsEnablingSpacePlugin] = useState(false);
  const [securityReviewReadOnly, setSecurityReviewReadOnly] = useState(false);

  // Tracks what action to perform when the user confirms the security review dialog.
  // All enable paths (Space, restore-archived, imported plugin) go through security review first.
  const [pendingEnableAction, setPendingEnableAction] = useState<
    | { type: 'space'; entry: CatalogPlugin }
    | { type: 'restore'; pluginId: string; manifest: PluginManifest; source: string }
    | { type: 'import'; manifest: PluginManifest; source: string }
    | null
  >(null);
  const [archivedPlugins, setArchivedPlugins] = useState<ArchivedPlugin[]>(() => loadArchivedPlugins());
  const refreshArchived = useCallback(() => setArchivedPlugins(loadArchivedPlugins()), []);

  useEffect(() => {
    let cancelled = false;

    const refreshMergeAuth = async () => {
      setIsCheckingMergeAuth(true);
      try {
        const settings = await window.settingsApi.get();
        if (!cancelled) {
          setIsMergeAuthAvailable(hasRendererAuth(settings));
        }
      } catch {
        if (!cancelled) {
          setIsMergeAuthAvailable(false);
        }
      } finally {
        if (!cancelled) {
          setIsCheckingMergeAuth(false);
        }
      }
    };

    fireAndForget(refreshMergeAuth(), 'refreshPluginMergeAuth');
    return () => {
      cancelled = true;
    };
  }, []);

  const activePlugins = useMemo(
    () =>
      registeredPlugins
        .filter((plugin) => !plugin.manifest.id.startsWith('__'))
        .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)),
    [registeredPlugins],
  );

  const enabledPluginIds = useMemo(
    () => new Set(activePlugins.map((plugin) => plugin.manifest.id)),
    [activePlugins],
  );

  const activePluginIds = useMemo(
    () => activePlugins.map((plugin) => plugin.manifest.id),
    [activePlugins],
  );
  const storageUsageMap = usePluginStorageUsage(activePluginIds);
  const dataBackupSet = usePluginDataBackups(activePluginIds);

  const spacePluginsById = useMemo(
    () => new Map(spacePlugins.map((plugin) => [plugin.manifest.id, plugin])),
    [spacePlugins],
  );

  const availableSpacePlugins = useMemo(
    () => spacePlugins
      .filter((plugin) => !enabledPluginIds.has(plugin.manifest.id))
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)),
    [enabledPluginIds, spacePlugins],
  );

  const pluginDisplayNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const plugin of spacePlugins) {
      map.set(plugin.manifest.id, plugin.manifest.name);
    }
    for (const plugin of activePlugins) {
      map.set(plugin.manifest.id, plugin.manifest.name);
    }
    return map;
  }, [activePlugins, spacePlugins]);

  const handleDisablePlugin = useCallback((pluginId: string) => {
    unregisterPlugin(pluginId);
  }, []);

  const handleDisableSpacePlugin = useCallback(async (pluginId: string, spacePath?: string) => {
    setImportError(null);

    if (spacePath && window.pluginsApi.deindexReadme) {
      try {
        const response = await window.pluginsApi.deindexReadme({ pluginId, spacePath });
        if (!response.success) {
          console.warn(`[PluginsTab] Failed to de-index README for Space plugin "${pluginId}".`);
        }
      } catch (err) {
        console.warn(`[PluginsTab] Failed to de-index README for Space plugin "${pluginId}":`, err);
      }
    }

    unregisterPlugin(pluginId);

    try {
      await window.pluginsApi.removeActivated({ pluginId });
    } catch (err) {
      console.warn(`[PluginsTab] Failed to remove activated Space plugin "${pluginId}":`, err);
      setImportError('Plugin disabled for this session, but the activation record could not be removed. It may re-activate on next launch.');
    }

    try {
      await window.pluginsApi.addDeactivated?.({ pluginId });
    } catch (err) {
      console.warn(`[PluginsTab] Failed to mark Space plugin "${pluginId}" as deactivated:`, err);
    }

    refreshSpacePlugins();
  }, [refreshSpacePlugins]);

  const handleViewSource = useCallback((pluginId: string, pluginName: string) => {
    const source = getPluginSource(pluginId);
    if (source) {
      setViewingSource({ name: pluginName, source });
      return;
    }
    const archived = archivedPlugins.find((a) => a.manifest.id === pluginId);
    if (archived) {
      setViewingSource({ name: pluginName, source: archived.source });
    }
  }, [archivedPlugins]);

  const handleToggleDocumentation = useCallback((pluginId: string) => {
    setExpandedDocsPluginIds((previous) => {
      const next = new Set(previous);
      if (next.has(pluginId)) {
        next.delete(pluginId);
      } else {
        next.add(pluginId);
      }
      return next;
    });
  }, []);

  const handleOpenPlugin = useCallback((pluginId: string) => {
    fireAndForget(navigation?.navigate(formatNavigationUrl({ type: 'plugin', pluginId })), 'openPluginTab');
  }, [navigation]);

  const handleRescanPlugin = useCallback((pluginId: string, pluginName: string) => {
    const plugin = getRegisteredPlugin(pluginId);
    const source = plugin?.source ?? getPluginSource(pluginId);
    if (!source) return;
    const manifest = plugin?.manifest ?? { id: pluginId, name: pluginName, version: '0.1.0', entryPoint: 'inline' };
    const permissions = plugin?.manifest.permissions ?? [];
    try {
      const report = reviewPluginSecurity(source, { permissions });
      setSecurityReport(report);
      setSecurityScanError(null);
    } catch (err) {
      setSecurityReport(null);
      setSecurityScanError(err instanceof Error ? err.message : 'Security review failed.');
    }
    setSecurityReviewReadOnly(true);
    setSecurityReviewPlugin({ manifest, source } as CatalogPlugin);
  }, []);

  const handleOpenPluginFolder = useCallback(async (pluginId: string, spacePath: string) => {
    try {
      const pluginDir = `${spacePath}/plugins/${pluginId}`;
      await window.appApi.revealPath(pluginDir);
    } catch {
      showToast({ title: 'Failed to open folder' });
    }
  }, [showToast]);

  const handleCopyPluginPath = useCallback(async (pluginId: string, spacePath?: string) => {
    const text = spacePath ?? pluginId;
    try {
      await navigator.clipboard.writeText(text);
      showToast({ title: spacePath ? 'Path copied to clipboard' : 'Plugin ID copied to clipboard' });
    } catch {
      showToast({ title: 'Failed to copy to clipboard' });
    }
  }, [showToast]);

  const handleOpenInConversation = useCallback((pluginId: string, pluginName: string) => {
    const source = getPluginSource(pluginId);
    window.dispatchEvent(new CustomEvent('rebel:start-plugin-conversation', {
      detail: { pluginId, pluginName, source: source ?? '' },
    }));
  }, []);

  const handleDuplicatePlugin = useCallback((pluginId: string) => {
    const plugin = getRegisteredPlugin(pluginId);
    if (!plugin) return;

    const archivedIds = new Set(archivedPlugins.map((a) => a.manifest.id));
    let copyId = `${pluginId}-copy`;
    let copyName = `${plugin.manifest.name} (Copy)`;
    let counter = 2;
    while (getRegisteredPlugin(copyId) || archivedIds.has(copyId)) {
      copyId = `${pluginId}-copy-${counter}`;
      copyName = `${plugin.manifest.name} (Copy ${counter})`;
      counter++;
    }

    const manifest: PluginManifest = {
      ...plugin.manifest,
      id: copyId,
      name: copyName,
      forkedFrom: undefined,
    };
    const source = getPluginSource(pluginId);
    if (source) {
      registerPlugin(manifest, source);
      showToast({ title: `Duplicated as "${copyName}"` });
    }
  }, [archivedPlugins, showToast]);

  const handleArchivePlugin = useCallback((pluginId: string, pluginName: string) => {
    const source = getPluginSource(pluginId);
    const plugin = getRegisteredPlugin(pluginId);
    if (!plugin || !source) return;

    const confirmed = window.confirm(
      `Archive "${pluginName}"? It will be removed from the sidebar but you can restore it later.`,
    );
    if (!confirmed) return;

    archivePlugin(plugin.manifest, source);
    unregisterPlugin(pluginId);
    refreshArchived();
  }, [refreshArchived]);

  const handleDeletePlugin = useCallback(async (pluginId: string, pluginName: string, spacePath?: string) => {
    const confirmed = window.confirm(
      `Permanently delete "${pluginName}"? This cannot be undone.`,
    );
    if (!confirmed) return;

    // Clear plugin storage BEFORE unregistering — isKnownPlugin() rejects unknown plugins
    try {
      await window.pluginsApi.storageClear({ pluginId });
    } catch {
      // Best-effort storage cleanup
    }

    unregisterPlugin(pluginId);

    if (spacePath) {
      try {
        await window.pluginsApi.removeActivated({ pluginId });
      } catch {
        // Best-effort cleanup
      }
      try {
        await window.pluginsApi.deleteFromSpace({ pluginId, spacePath });
      } catch {
        showToast({ title: 'Plugin removed but failed to delete files from Space' });
      }
      refreshSpacePlugins();
    }

    showToast({ title: `Deleted "${pluginName}"` });
  }, [showToast, refreshSpacePlugins]);

  const handleRestoreArchived = useCallback((pluginId: string) => {
    // Find the archived plugin data without removing it yet — removal
    // happens on confirm so the user can cancel the security review safely.
    const archived = archivedPlugins.find((a) => a.manifest.id === pluginId);
    if (!archived) return;

    // Route through security review dialog before restoring
    setSecurityReviewPlugin({ manifest: archived.manifest, source: archived.source, isActive: false });
    setPendingEnableAction({ type: 'restore', pluginId, manifest: archived.manifest, source: archived.source });
    setSecurityReviewReadOnly(false);
    try {
      setSecurityReport(reviewPluginSecurity(archived.source, { permissions: archived.manifest.permissions }));
      setSecurityScanError(null);
    } catch (err) {
      setSecurityReport(null);
      setSecurityScanError(err instanceof Error ? err.message : 'Security review failed.');
    }
  }, [archivedPlugins]);

  const handleDeleteArchived = useCallback(async (pluginId: string, pluginName: string) => {
    const confirmed = window.confirm(
      `Permanently delete "${pluginName}"? This cannot be undone.`,
    );
    if (!confirmed) return;

    // Best-effort storage cleanup — archived plugins may not be recognized by
    // isKnownPlugin(), but we still attempt to clear any orphaned storage data
    try {
      await window.pluginsApi.storageClear({ pluginId });
    } catch {
      // Best-effort: archived plugin may no longer be "known"
    }

    deleteArchivedPlugin(pluginId);
    refreshArchived();
  }, [refreshArchived]);

  const handleExportData = useCallback(async (pluginId: string) => {
    try {
      const result = await window.pluginsApi.exportData({ pluginId });
      if (!result.ok && result.error && result.error !== 'Export cancelled.') {
        showToast({ title: result.error });
      }
    } catch (err) {
      console.warn(`[PluginsTab] Failed to export data for plugin "${pluginId}":`, err);
      showToast({ title: 'An unexpected error occurred during data export.' });
    }
  }, [showToast]);

  const handleImportData = useCallback(async (pluginId: string) => {
    try {
      const result = await window.pluginsApi.importData({ pluginId });
      if (result.ok) {
        showToast({ title: 'Plugin data imported successfully.' });
      } else if (result.error && result.error !== 'Import cancelled.' && result.error !== 'Import cancelled by user.') {
        showToast({ title: result.error });
      }
    } catch (err) {
      console.warn(`[PluginsTab] Failed to import data for plugin "${pluginId}":`, err);
      showToast({ title: 'An unexpected error occurred during data import.' });
    }
  }, [showToast]);

  const handleRestoreData = useCallback(async (pluginId: string) => {
    try {
      const result = await window.pluginsApi.restoreDataBackup({ pluginId });
      if (result.ok) {
        showToast({ title: 'Plugin data restored from backup.' });
      } else if (result.error) {
        showToast({ title: result.error });
      }
    } catch (err) {
      console.warn(`[PluginsTab] Failed to restore data for plugin "${pluginId}":`, err);
      showToast({ title: 'An unexpected error occurred during data restore.' });
    }
  }, [showToast]);

  const handleExportPlugin = useCallback(async (pluginId: string) => {
    try {
      const result = await window.pluginsApi.exportPlugin({ pluginId });
      if (!result.ok && result.error && result.error !== 'Export cancelled.') {
        setImportError(result.error);
      }
    } catch (err) {
      console.warn(`[PluginsTab] Failed to export plugin "${pluginId}":`, err);
      setImportError('An unexpected error occurred during export.');
    }
  }, []);

  const handleExportPluginToSpace = useCallback(async (pluginId: string, pluginName: string) => {
    setImportError(null);

    try {
      const coreDirectory = settingsContext?.settings?.coreDirectory;
      if (!coreDirectory) {
        setImportError('No writable Spaces found to export this plugin.');
        return;
      }

      await fetchSpaces(coreDirectory, { force: true });
      const scanResult = getSpacesSnapshotFor(coreDirectory);
      if (scanResult.error) {
        setImportError(scanResult.errorMessage ?? 'Failed to scan Spaces.');
        return;
      }
      const writableSpaces = scanResult.spaces;

      if (writableSpaces.length === 0) {
        setImportError('No writable Spaces found to export this plugin.');
        return;
      }

      let targetSpace = writableSpaces[0];
      if (writableSpaces.length > 1) {
        const options = writableSpaces
          .map((space, index) => `${index + 1}. ${space.name}`)
          .join('\n');
        const selected = window.prompt(
          `Choose a Space for "${pluginName}":\n${options}\n\nEnter a number:`,
          '1',
        );
        if (!selected) {
          return;
        }

        const selectedIndex = Number.parseInt(selected, 10) - 1;
        if (
          Number.isNaN(selectedIndex)
          || selectedIndex < 0
          || selectedIndex >= writableSpaces.length
        ) {
          setImportError('Invalid Space selection.');
          return;
        }

        targetSpace = writableSpaces[selectedIndex];
      }

      const markAsHero = window.confirm(
        `Mark "${pluginName}" as the Hero plugin for "${targetSpace.name}"?\n\n`
        + 'Hero plugins are sorted first in the Library Plugins lens with a Hero badge. '
        + 'Choose this only when the plugin is the marquee/featured plugin for that Space. '
        + '\n\nClick OK for Hero, Cancel for Utility (default).',
      );

      const exportResult = await window.pluginsApi.exportToSpace({
        pluginId,
        spacePath: targetSpace.absolutePath,
        role: markAsHero ? 'hero' : 'utility',
      });

      if (!exportResult.ok) {
        setImportError(exportResult.error ?? `Failed to export "${pluginName}" to Space.`);
        return;
      }

      refreshSpacePlugins();
    } catch (err) {
      console.warn(`[PluginsTab] Failed to export plugin "${pluginId}" to Space:`, err);
      setImportError('An unexpected error occurred while exporting to Space.');
    }
  }, [refreshSpacePlugins, settingsContext?.settings?.coreDirectory]);

  const enableSpacePlugin = useCallback(async (entry: CatalogPlugin) => {
    setImportError(null);

    try {
      const { compilePluginSource } = await import('../../../plugins/compiler/pluginCompiler');
      const compiled = compilePluginSource(entry.source);
      if (!compiled.ok) {
        setImportError(
          `Plugin "${entry.manifest.name}" has compile errors: ${compiled.errors.map((error) => error.message).join(', ')}`,
        );
        return;
      }

      await window.pluginsApi.addActivated({ pluginId: entry.manifest.id });
      await window.pluginsApi.removeDeactivated?.({ pluginId: entry.manifest.id });

      const result = registerPlugin(entry.manifest, entry.source);
      if (!result.ok) {
        await window.pluginsApi.removeActivated({ pluginId: entry.manifest.id });
        setImportError(`Failed to enable "${entry.manifest.name}": ${result.error}`);
        return;
      }

      if (entry.spacePath && window.pluginsApi.indexReadme) {
        const indexResponse = await window.pluginsApi.indexReadme({
          pluginId: entry.manifest.id,
          spacePath: entry.spacePath,
        });
        if (!indexResponse.success) {
          setImportError(`"${entry.manifest.name}" was enabled, but its README could not be indexed.`);
        }
      }

      refreshSpacePlugins();
    } catch (err) {
      console.warn(`[PluginsTab] Failed to enable Space plugin "${entry.manifest.id}":`, err);
      setImportError('An unexpected error occurred while enabling a Space plugin.');
    }
  }, [refreshSpacePlugins]);

  const handleEnableSpacePlugin = useCallback((entry: CatalogPlugin) => {
    setImportError(null);
    setSecurityReviewPlugin(entry);
    setPendingEnableAction({ type: 'space', entry });
    setSecurityReviewReadOnly(false);
    try {
      setSecurityReport(reviewPluginSecurity(entry.source, { permissions: entry.manifest.permissions }));
      setSecurityScanError(null);
    } catch (err) {
      setSecurityReport(null);
      setSecurityScanError(err instanceof Error ? err.message : 'Security review failed.');
    }
  }, []);

  const handleCancelSecurityReview = useCallback(() => {
    setSecurityReviewPlugin(null);
    setSecurityReport(null);
    setSecurityScanError(null);
    setSecurityReviewReadOnly(false);
    setPendingEnableAction(null);
  }, []);

  const handleConfirmSecurityReview = useCallback(async () => {
    if (!pendingEnableAction) {
      return;
    }

    const action = pendingEnableAction;
    handleCancelSecurityReview();

    switch (action.type) {
      case 'space': {
        setIsEnablingSpacePlugin(true);
        try {
          await enableSpacePlugin(action.entry);
        } finally {
          setIsEnablingSpacePlugin(false);
        }
        break;
      }
      case 'restore': {
        const restored = restoreArchivedPlugin(action.pluginId);
        if (!restored) {
          setImportError(`Failed to restore plugin "${action.manifest.name}": archive entry not found.`);
          break;
        }
        const result = registerPlugin(restored.manifest, restored.source);
        if (!result.ok) {
          setImportError(`Failed to restore "${restored.manifest.name}": ${result.error}`);
        }
        refreshArchived();
        break;
      }
      case 'import': {
        const result = registerPlugin(action.manifest, action.source);
        if (!result.ok) {
          setImportError(`Failed to register imported plugin: ${result.error}`);
        }
        break;
      }
    }
  }, [enableSpacePlugin, handleCancelSecurityReview, pendingEnableAction, refreshArchived]);

  const handleResolvePluginConflict = useCallback(
    async (conflict: PluginConflict, resolution: 'keep-mine' | 'keep-theirs') => {
      setImportError(null);
      const conflictKey = `${conflict.spacePath}:${conflict.pluginId}`;
      setResolvingConflictKey(conflictKey);
      setMergeProposal((current) => (current?.conflictKey === conflictKey ? null : current));

      try {
        const result = await window.pluginsApi.resolveConflict({
          pluginId: conflict.pluginId,
          spacePath: conflict.spacePath,
          resolution,
        });

        if (!result.success) {
          setImportError(result.error ?? `Failed to resolve sync conflict for "${conflict.pluginId}".`);
          return;
        }

        refreshSpacePlugins();
      } catch (err) {
        console.warn(`[PluginsTab] Failed to resolve sync conflict for "${conflict.pluginId}":`, err);
        setImportError('An unexpected error occurred while resolving a plugin sync conflict.');
      } finally {
        setResolvingConflictKey((current) => (current === conflictKey ? null : current));
      }
    },
    [refreshSpacePlugins],
  );

  const handleProposeRebelMerge = useCallback(
    async (conflict: PluginConflict) => {
      setImportError(null);
      const conflictKey = `${conflict.spacePath}:${conflict.pluginId}`;
      setRequestingMergeKey(conflictKey);
      setMergeProposal(null);

      try {
        if (!isMergeAuthAvailable) {
          setImportError('Add an API key or OAuth token in Settings before asking Rebel to merge.');
          return;
        }

        const result = await window.pluginsApi.rebelMerge({
          pluginId: conflict.pluginId,
          spacePath: conflict.spacePath,
        });

        if (!result.success || !result.mergedManifest || !result.mergedSource) {
          setImportError(result.error ?? `Failed to propose a merge for "${conflict.pluginId}".`);
          return;
        }

        const { compilePluginSource } = await import('../../../plugins/compiler/pluginCompiler');
        const compileResult = compilePluginSource(result.mergedSource);
        if (!compileResult.ok) {
          setImportError(
            `Rebel proposed a merge, but it has compile errors: ${compileResult.errors.map((error) => error.message).join(', ')}`,
          );
          return;
        }

        setMergeProposal({
          conflictKey,
          conflict,
          mergedManifest: result.mergedManifest,
          mergedSource: result.mergedSource,
        });
      } catch (err) {
        console.warn(`[PluginsTab] Failed to ask Rebel to merge "${conflict.pluginId}":`, err);
        setImportError('An unexpected error occurred while asking Rebel to merge this plugin.');
      } finally {
        setRequestingMergeKey((current) => (current === conflictKey ? null : current));
      }
    },
    [isMergeAuthAvailable],
  );

  const handleCancelMergeProposal = useCallback(() => {
    setMergeProposal(null);
  }, []);

  const handleAcceptMergeProposal = useCallback(
    async (proposal: MergeProposal) => {
      setImportError(null);
      setAcceptingMergeKey(proposal.conflictKey);

      try {
        const result = await window.pluginsApi.acceptMerge({
          pluginId: proposal.conflict.pluginId,
          spacePath: proposal.conflict.spacePath,
          mergedManifest: proposal.mergedManifest,
          mergedSource: proposal.mergedSource,
        });

        if (!result.success) {
          setImportError(result.error ?? `Failed to accept merged version for "${proposal.conflict.pluginId}".`);
          return;
        }

        setMergeProposal(null);
        refreshSpacePlugins();
      } catch (err) {
        console.warn(`[PluginsTab] Failed to accept merged plugin "${proposal.conflict.pluginId}":`, err);
        setImportError('An unexpected error occurred while accepting the merged plugin.');
      } finally {
        setAcceptingMergeKey((current) => (current === proposal.conflictKey ? null : current));
      }
    },
    [refreshSpacePlugins],
  );

  const handleImportPlugin = useCallback(async () => {
    setImportError(null);

    try {
      const result = await window.pluginsApi.importPlugin();
      if (!result.ok) {
        if (result.error && result.error !== 'Import cancelled.') {
          setImportError(result.error);
        }
        return;
      }

      if (!result.manifest || !result.source) {
        setImportError('Invalid plugin file: missing manifest or source.');
        return;
      }

      const { manifest: importedManifest, source } = result;

      // Check for existing plugin with same ID
      const existing = getRegisteredPlugin(importedManifest.id);
      if (existing) {
        const confirmed = window.confirm(
          `A plugin with ID "${importedManifest.id}" ("${existing.manifest.name}") is already active. Replace it with the imported version?`,
        );
        if (!confirmed) return;

        unregisterPlugin(importedManifest.id);
      }

      // Compile-validate before registering to catch errors at import time
      try {
        const { compilePluginSource } = await import('../../../plugins/compiler/pluginCompiler');
        const compiled = compilePluginSource(source);
        if (!compiled.ok) {
          setImportError(`Imported plugin has compile errors: ${compiled.errors.map((e: { message: string }) => e.message).join(', ')}`);
          return;
        }
      } catch {
        // Compiler unavailable — fall through to register (will fail at render time)
      }

      const pluginManifest: PluginManifest = {
        id: importedManifest.id,
        name: importedManifest.name,
        description: importedManifest.description,
        version: importedManifest.version ?? '0.1.0',
        entryPoint: 'inline',
        maturity: 'labs',
        role: 'utility',
        permissions: [],
        externalDomains: [],
        surfaces: { sidebar: { enabled: true }, homepageWidget: { enabled: false, defaultSize: 'medium' } },
        ...(importedManifest.forkedFrom ? { forkedFrom: importedManifest.forkedFrom } : {}),
        ...(importedManifest.documentation ? { documentation: importedManifest.documentation } : {}),
      };

      // Route through security review dialog before enabling imported plugin
      setSecurityReviewPlugin({ manifest: pluginManifest, source, isActive: false });
      setPendingEnableAction({ type: 'import', manifest: pluginManifest, source });
      setSecurityReviewReadOnly(false);
      try {
        setSecurityReport(reviewPluginSecurity(source, { permissions: pluginManifest.permissions }));
        setSecurityScanError(null);
      } catch (err) {
        setSecurityReport(null);
        setSecurityScanError(err instanceof Error ? err.message : 'Security review failed.');
      }
    } catch (err) {
      console.warn('[PluginsTab] Failed to import plugin:', err);
      setImportError('An unexpected error occurred during import.');
    }
  }, []);

  return (
    <>
      <div
        style={{ marginBottom: '1rem' }}
        data-testid="settings-plugins-library-banner"
      >
        <Notice
          tone="info"
          density="compact"
          placement="inline"
          actions={[
            {
              label: 'Open Library',
              variant: 'primary',
              onClick: () => {
                fireAndForget(
                  Promise.resolve(navigation?.navigate?.(formatNavigationUrl({ type: 'library', filter: 'plugins' }))),
                  'navigateToLibraryPlugins',
                );
              },
            },
          ]}
        >
          Plugins now live in the Library — switch to the Plugins lens to browse, enable,
          or disable any plugin. This page is for authoring and admin maintenance.
        </Notice>
      </div>

      {importError && (
        <div
          style={{
            marginTop: '0.5rem',
            padding: '0.5rem 0.75rem',
            fontSize: '0.8125rem',
            color: 'var(--color-text-error, #dc2626)',
            backgroundColor: 'var(--color-bg-error, rgba(220, 38, 38, 0.08))',
            borderRadius: '0.375rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.5rem',
          }}
        >
          <span>{importError}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setImportError(null)}
            style={{ padding: '0.125rem 0.375rem', fontSize: '0.75rem' }}
          >
            Dismiss
          </Button>
        </div>
      )}

      {conflicts.length > 0 && (
        <Card
          variant="outlined"
          style={{
            marginBottom: '1rem',
            padding: '0.875rem 1rem',
            borderColor: 'var(--color-border-warning, #f59e0b)',
            backgroundColor: 'var(--color-bg-warning, rgba(245, 158, 11, 0.08))',
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: '0.875rem',
              fontWeight: 600,
              color: 'var(--color-text-warning, #92400e)',
            }}
          >
            {`${conflicts.length} plugin(s) have sync conflicts.`}
          </p>
          <div className={styles.flexColLarge} style={{ marginTop: '0.75rem' }}>
            {conflicts.map((conflict) => {
              const conflictKey = `${conflict.spacePath}:${conflict.pluginId}`;
              const pluginName = spacePluginsById.get(conflict.pluginId)?.manifest.name ?? conflict.pluginId;
              const isResolving = resolvingConflictKey === conflictKey;
              const isRequestingMerge = requestingMergeKey === conflictKey;
              const isAcceptingMerge = acceptingMergeKey === conflictKey;
              const proposedMerge = mergeProposal?.conflictKey === conflictKey ? mergeProposal : null;
              const isMergeDisabled = isResolving || isRequestingMerge || isAcceptingMerge || isCheckingMergeAuth || !isMergeAuthAvailable;
              const mergeButtonTitle = isCheckingMergeAuth
                ? 'Checking authentication availability for Rebel merge…'
                : !isMergeAuthAvailable
                  ? 'Add an API key or OAuth token in Settings to use Rebel merge.'
                  : 'Ask Rebel to propose a merged plugin for review.';

              return (
                <div
                  key={conflictKey}
                  style={{
                    padding: '0.625rem 0.75rem',
                    borderRadius: '0.5rem',
                    backgroundColor: 'var(--color-surface, rgba(255, 255, 255, 0.65))',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: '0.75rem',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <p
                        style={{
                          margin: 0,
                          fontSize: '0.8125rem',
                          fontWeight: 600,
                          color: 'var(--color-text-primary)',
                        }}
                      >
                        {pluginName}
                      </p>
                      <p
                        style={{
                          margin: '0.25rem 0 0',
                          fontSize: '0.75rem',
                          color: 'var(--color-text-secondary)',
                          wordBreak: 'break-word',
                        }}
                      >
                        Conflict files: {conflict.conflictFiles.join(', ')}
                      </p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isResolving || isRequestingMerge || isAcceptingMerge}
                        onClick={() => void handleResolvePluginConflict(conflict, 'keep-mine')}
                      >
                        Keep mine
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isResolving || isRequestingMerge || isAcceptingMerge}
                        onClick={() => void handleResolvePluginConflict(conflict, 'keep-theirs')}
                      >
                        Keep theirs
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isMergeDisabled}
                        title={mergeButtonTitle}
                        onClick={() => void handleProposeRebelMerge(conflict)}
                      >
                        {isRequestingMerge ? 'Asking Rebel…' : 'Ask Rebel to merge'}
                      </Button>
                    </div>
                  </div>

                  {proposedMerge && (
                    <div style={{ marginTop: '0.75rem' }}>
                      <p
                        style={{
                          margin: 0,
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          color: 'var(--color-text-primary)',
                        }}
                      >
                        Proposed merged manifest
                      </p>
                      <pre
                        style={{
                          margin: '0.375rem 0 0',
                          maxHeight: '10rem',
                          overflow: 'auto',
                          fontSize: '0.72rem',
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                          backgroundColor: 'var(--color-bg-secondary, #f5f5f5)',
                          padding: '0.625rem',
                          borderRadius: '0.5rem',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        <code>{JSON.stringify(proposedMerge.mergedManifest, null, 2)}</code>
                      </pre>

                      <p
                        style={{
                          margin: '0.625rem 0 0',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          color: 'var(--color-text-primary)',
                        }}
                      >
                        Proposed merged source
                      </p>
                      <pre
                        style={{
                          margin: '0.375rem 0 0',
                          maxHeight: '12rem',
                          overflow: 'auto',
                          fontSize: '0.72rem',
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                          backgroundColor: 'var(--color-bg-secondary, #f5f5f5)',
                          padding: '0.625rem',
                          borderRadius: '0.5rem',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        <code>{proposedMerge.mergedSource}</code>
                      </pre>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.625rem' }}>
                        <Button
                          variant="default"
                          size="sm"
                          disabled={isAcceptingMerge}
                          onClick={() => void handleAcceptMergeProposal(proposedMerge)}
                        >
                          {isAcceptingMerge ? 'Accepting…' : 'Accept merge'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isAcceptingMerge}
                          onClick={handleCancelMergeProposal}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <div
        data-section="labsPlugins"
        data-focus-target-section="pluginsActive"
        data-testid="settings-section-labs-plugins"
      >
        <SettingSection
          title="Active Plugins"
          description="Plugins currently active in your workspace."
          badge={(
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleImportPlugin()}
              >
                <Upload size={14} style={{ marginRight: '0.25rem' }} />
                Import Plugin
              </Button>
              <Badge variant="secondary">{activePlugins.length}</Badge>
            </>
          )}
          data-section="pluginsActive"
        >
          <div className={styles.flexColLarge}>
          {activePlugins.length === 0 ? (
            <p
              style={{
                margin: 0,
                fontSize: '0.875rem',
                color: 'var(--color-text-secondary)',
              }}
            >
              No plugins active. Enable one from Library → Plugins.
            </p>
          ) : (
            activePlugins.map((plugin) => {
              const documentation = plugin.manifest.documentation;
              const hasDocumentation = Boolean(documentation?.trim());
              const isDocumentationOpen = hasDocumentation && expandedDocsPluginIds.has(plugin.manifest.id);
              const spacePlugin = spacePluginsById.get(plugin.manifest.id);
              const isSpacePlugin = Boolean(spacePlugin);

              const metaParts: string[] = [plugin.manifest.id];
              if (plugin.manifest.forkedFrom) {
                metaParts.push(`Forked from ${pluginDisplayNameById.get(plugin.manifest.forkedFrom) ?? plugin.manifest.forkedFrom}`);
              }
              if (isSpacePlugin) {
                metaParts.push(`From: ${formatSpaceSourceLabel(spacePlugin?.spacePath)}`);
              }
              const manifestWithScope = plugin.manifest as typeof plugin.manifest & { storageScope?: string };
              if (manifestWithScope.storageScope === 'shared') {
                metaParts.push('Data shared with Space');
              }

              const handlePluginAction = (action: PluginAction) => {
                switch (action) {
                  case 'askRebel': handleOpenInConversation(plugin.manifest.id, plugin.manifest.name); break;
                  case 'duplicate': handleDuplicatePlugin(plugin.manifest.id); break;
                  case 'viewSource': handleViewSource(plugin.manifest.id, plugin.manifest.name); break;
                  case 'scan': handleRescanPlugin(plugin.manifest.id, plugin.manifest.name); break;
                  case 'docs': handleToggleDocumentation(plugin.manifest.id); break;
                  case 'exportData': fireAndForget(handleExportData(plugin.manifest.id), 'exportPluginData'); break;
                  case 'importData': fireAndForget(handleImportData(plugin.manifest.id), 'importPluginData'); break;
                  case 'restoreData': fireAndForget(handleRestoreData(plugin.manifest.id), 'restorePluginData'); break;
                  case 'export': fireAndForget(handleExportPlugin(plugin.manifest.id), 'exportPlugin'); break;
                  case 'exportToSpace': fireAndForget(handleExportPluginToSpace(plugin.manifest.id, plugin.manifest.name), 'exportPluginToSpace'); break;
                  case 'openFolder': if (spacePlugin?.spacePath) fireAndForget(handleOpenPluginFolder(plugin.manifest.id, spacePlugin.spacePath), 'openPluginFolder'); break;
                  case 'copyId': fireAndForget(handleCopyPluginPath(plugin.manifest.id, spacePlugin?.spacePath), 'copyPluginPath'); break;
                  case 'archive': handleArchivePlugin(plugin.manifest.id, plugin.manifest.name); break;
                  case 'delete': fireAndForget(handleDeletePlugin(plugin.manifest.id, plugin.manifest.name, spacePlugin?.spacePath), 'deletePlugin'); break;
                  case 'disable':
                    if (isSpacePlugin) { fireAndForget(handleDisableSpacePlugin(plugin.manifest.id, spacePlugin?.spacePath), 'disableSpacePlugin'); }
                    else { handleDisablePlugin(plugin.manifest.id); }
                    break;
                }
              };

              const registeredDate = new Date(plugin.registeredAt).toLocaleDateString(undefined, {
                month: 'short', day: 'numeric', year: 'numeric',
              });
              const storageUsage = storageUsageMap.get(plugin.manifest.id);

              return (
                <Card
                  key={plugin.manifest.id}
                  variant="outlined"
                  style={{ padding: '0.875rem 1rem' }}
                >
                  {/* Header: name + badges + Open + context menu */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '0.75rem',
                      marginBottom: '0.375rem',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', minWidth: 0 }}>
                      <span style={{ fontSize: '0.9375rem', fontWeight: 600 }}>
                        {plugin.manifest.name}
                      </span>
                      {renderMaturityBadge(plugin.manifest)}
                      <Badge variant="outline" size="sm">v{plugin.manifest.version ?? '0.1.0'}</Badge>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexShrink: 0 }}>
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => handleOpenPlugin(plugin.manifest.id)}
                        title={`Open "${plugin.manifest.name}" tab`}
                      >
                        <ExternalLink size={14} style={{ marginRight: '0.25rem' }} />
                        Open
                      </Button>
                      <PluginActionsMenu
                        pluginName={plugin.manifest.name}
                        hasDocumentation={hasDocumentation}
                        isDocsOpen={isDocumentationOpen}
                        isSpacePlugin={isSpacePlugin}
                        spacePath={spacePlugin?.spacePath}
                        hasDataBackup={dataBackupSet.has(plugin.manifest.id)}
                        onAction={handlePluginAction}
                      />
                    </div>
                  </div>

                  {/* Description */}
                  <p style={{ margin: '0 0 0.375rem', fontSize: '0.8125rem', color: 'var(--color-text-secondary)', lineHeight: 1.45 }}>
                    {plugin.manifest.description || 'No description provided.'}
                  </p>

                  {/* Metadata line */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.375rem',
                      fontSize: '0.6875rem',
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-block',
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        backgroundColor: 'var(--color-text-success, #22c55e)',
                        flexShrink: 0,
                      }}
                      title="Compiled and active"
                    />
                    <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}>
                      {metaParts.join(' \u00B7 ')}
                    </span>
                    <span style={{ opacity: 0.5 }}>&middot;</span>
                    <span>{registeredDate}</span>
                    {storageUsage && (
                      <>
                        <span style={{ opacity: 0.5 }}>&middot;</span>
                        <span title={`${storageUsage.percentUsed}% of storage quota used`}>
                          {formatBytes(storageUsage.usedBytes)} / {formatBytes(storageUsage.quotaBytes)}
                        </span>
                      </>
                    )}
                  </div>

                  {/* Expanded documentation */}
                  {isDocumentationOpen && (
                    <pre
                      style={{
                        marginTop: '0.625rem',
                        maxHeight: '14rem',
                        overflow: 'auto',
                        fontSize: '0.75rem',
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        backgroundColor: 'var(--color-bg-secondary, #f5f5f5)',
                        padding: '0.75rem',
                        borderRadius: '0.5rem',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      <code>{documentation}</code>
                    </pre>
                  )}
                </Card>
              );
            })
          )}
          </div>
        </SettingSection>
      </div>

      {archivedPlugins.length > 0 && (
        <SettingSection
          title="Archived"
          description="Previously active plugins you can restore or permanently delete."
          badge={<Badge variant="outline">{archivedPlugins.length}</Badge>}
          data-section="pluginsArchived"
        >
          <div className={styles.flexColLarge}>
            {archivedPlugins.map((archived) => (
              <Card key={archived.manifest.id} variant="outlined" style={{ padding: '0.75rem 1rem', opacity: 0.85 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.25rem' }}>
                      <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>{archived.manifest.name}</span>
                      <Badge variant="outline" size="sm">v{archived.manifest.version ?? '0.1.0'}</Badge>
                    </div>
                    <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                      {archived.manifest.id} &middot; Archived {new Date(archived.archivedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', flexShrink: 0 }}>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => handleRestoreArchived(archived.manifest.id)}
                    >
                      <RotateCcw size={13} style={{ marginRight: '0.25rem' }} />
                      Restore
                    </Button>
                    <DisabledPluginActionsMenu
                      pluginName={archived.manifest.name}
                      onAction={(action) => {
                        switch (action) {
                          case 'restore': handleRestoreArchived(archived.manifest.id); break;
                          case 'viewSource': handleViewSource(archived.manifest.id, archived.manifest.name); break;
                          case 'exportData': fireAndForget(handleExportData(archived.manifest.id), 'exportArchivedPluginData'); break;
                          case 'delete': fireAndForget(handleDeleteArchived(archived.manifest.id, archived.manifest.name), 'deleteArchivedPlugin'); break;
                        }
                      }}
                    />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </SettingSection>
      )}

      <SettingSection
        title="Available from Spaces"
        description="Shared plugins discovered in your Spaces that aren't active yet."
        badge={<Badge variant="outline">{availableSpacePlugins.length}</Badge>}
        data-section="pluginsAvailableFromSpaces"
      >
        <div className={styles.flexColLarge}>
          {isSpacePluginsLoading ? (
            <p
              style={{
                margin: 0,
                fontSize: '0.875rem',
                color: 'var(--color-text-secondary)',
              }}
            >
              Scanning Spaces for plugins…
            </p>
          ) : spacePluginsError ? (
            <Card variant="outlined" style={{ padding: '0.875rem 1rem' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                }}
              >
                <p
                  style={{
                    margin: 0,
                    fontSize: '0.8125rem',
                    color: 'var(--color-text-error, #dc2626)',
                  }}
                >
                  Failed to scan Space plugins: {spacePluginsError}
                </p>
                <Button variant="outline" size="sm" onClick={refreshSpacePlugins}>
                  Retry
                </Button>
              </div>
            </Card>
          ) : availableSpacePlugins.length === 0 ? (
            <p
              style={{
                margin: 0,
                fontSize: '0.875rem',
                color: 'var(--color-text-secondary)',
              }}
            >
              No additional Space plugins available right now.
            </p>
          ) : (
            availableSpacePlugins.map((plugin) => (
              <Card key={plugin.manifest.id} variant="outlined" style={{ padding: '0.875rem 1rem' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        flexWrap: 'wrap',
                        marginBottom: '0.375rem',
                      }}
                    >
                      <span style={{ fontSize: '0.9375rem', fontWeight: 600 }}>
                        {plugin.manifest.name}
                      </span>
                      {renderMaturityBadge(plugin.manifest)}
                      <Badge variant="outline" size="sm">
                        v{plugin.manifest.version ?? '0.1.0'}
                      </Badge>
                      {plugin.isPendingReview && (
                        <Badge variant="warning" size="sm">
                          Needs review
                        </Badge>
                      )}
                    </div>
                    <p
                      style={{
                        margin: 0,
                        fontSize: '0.8125rem',
                        color: 'var(--color-text-secondary)',
                      }}
                    >
                      {plugin.manifest.description || 'No description provided.'}
                    </p>
                    {plugin.isPendingReview && (
                      <p
                        style={{
                          margin: '0.25rem 0 0',
                          fontSize: '0.75rem',
                          color: 'var(--color-text-secondary)',
                        }}
                      >
                        Created by Rebel. Review the elevated permissions it requested before this plugin can run.
                      </p>
                    )}
                    <p
                      style={{
                        margin: '0.25rem 0 0',
                        fontSize: '0.75rem',
                        color: 'var(--color-text-tertiary)',
                      }}
                    >
                      From: {formatSpaceSourceLabel(plugin.spacePath)}
                    </p>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Button
                      variant="default"
                      size="sm"
                      disabled={isEnablingSpacePlugin}
                      onClick={() => handleEnableSpacePlugin(plugin)}
                    >
                      {plugin.isPendingReview ? 'Review & enable' : 'Enable'}
                    </Button>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      </SettingSection>

      <PluginSourceViewer
        pluginName={viewingSource?.name ?? ''}
        source={viewingSource?.source ?? ''}
        open={viewingSource !== null}
        onClose={() => setViewingSource(null)}
      />
      <PluginSecurityDialog
        open={Boolean(securityReviewPlugin && (securityReport || securityScanError))}
        pluginName={securityReviewPlugin?.manifest.name ?? ''}
        sourceSpaceLabel={formatSpaceSourceLabel(securityReviewPlugin?.spacePath)}
        report={securityReport}
        permissions={securityReviewPlugin?.manifest.permissions}
        externalDomains={securityReviewPlugin?.manifest.externalDomains}
        pendingReview={securityReviewPlugin?.isPendingReview}
        isEnabling={isEnablingSpacePlugin}
        readOnly={securityReviewReadOnly}
        scanError={securityScanError}
        onCancel={handleCancelSecurityReview}
        onConfirm={() => {
          fireAndForget(handleConfirmSecurityReview(), 'confirmSecurityReview');
        }}
      />
    </>
  );
};
