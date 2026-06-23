import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge, Tooltip, Button, Input } from '@renderer/components/ui';
import { Loader2, ChevronRight, ChevronDown, AlertCircle, LogIn, ToggleLeft, ToggleRight, X } from 'lucide-react';
import type { McpToolInfo } from '@shared/types';
import { ConnectorSetupDialog } from './ConnectorSetupDialog';
import { useConnectorSetupGuidance } from '../hooks/useConnectorSetupGuidance';
import styles from './SettingsSurface.module.css';

export type McpHealthStatus = 'ok' | 'error' | 'unavailable' | 'unknown' | 'checking';

/** Auth hint derived from catalog entry — drives which UI to show when health is unavailable. */
type ConnectorAuthHint = 'oauth' | 'api-key' | 'none';

interface McpToolListProps {
  /** MCP server ID (server name/instance ID) to fetch tools for */
  serverId: string;
  /** Callback when health status changes - allows parent to show reconnect UI */
  onHealthStatusChange?: (status: McpHealthStatus) => void;
  /** Auth type of the connector — determines error messaging when unavailable */
  authHint?: ConnectorAuthHint;
  /** Optional action rendered in the tools header */
  headerAction?: ReactNode;
}

type HealthStatus = McpHealthStatus;

/**
 * Extract short tool name from fully-qualified tool ID.
 * E.g., "filesystem__read_file" -> "read_file"
 */
const getShortToolName = (toolId: string): string => {
  const parts = toolId.split('__');
  return parts.length > 1 ? parts.slice(1).join('__') : toolId;
};

/**
 * McpToolList - Displays tools available from an MCP package.
 * 
 * Shows tool names, descriptions, and blocked status.
 * Supports pagination for packages with many tools (>50).
 */
export const McpToolList = ({ serverId, onHealthStatusChange, authHint = 'none', headerAction }: McpToolListProps) => {
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [healthStatus, setHealthStatus] = useState<HealthStatus>('checking');
  const [authenticating, setAuthenticating] = useState(false);
  const setupGuidanceDialog = useConnectorSetupGuidance();
  const [toolSearch, setToolSearch] = useState('');
  const [isExpanded, setIsExpanded] = useState(true);
  
  // Notify parent when health status changes
  useEffect(() => {
    onHealthStatusChange?.(healthStatus);
  }, [healthStatus, onHealthStatusChange]);

  useEffect(() => {
    setToolSearch('');
    setIsExpanded(true);
  }, [serverId]);
  
  // Track current request to prevent race conditions on serverId change
  const requestIdRef = useRef(0);

  // Check health status before fetching tools
  const checkHealth = useCallback(async (): Promise<HealthStatus> => {
    if (!serverId) return 'unknown';
    try {
      const result = await window.miscApi.mcpCheckHealth({ serverId });
      return result.health;
    } catch {
      return 'unknown';
    }
  }, [serverId]);

  // Fetch tools from the API
  const fetchTools = useCallback(async (pageToken?: string | null) => {
    // Skip if no serverId
    if (!serverId) {
      setLoading(false);
      setTools([]);
      return;
    }

    const isInitialLoad = !pageToken;
    const currentRequestId = ++requestIdRef.current;
    
    if (isInitialLoad) {
      setLoading(true);
      setError(null);
    } else {
      setLoadingMore(true);
    }
    
    try {
      const result = await window.settingsApi.mcpListTools({
        serverId,
        pageToken: pageToken ?? undefined,
      });
      
      // Ignore stale responses (another fetch started)
      if (currentRequestId !== requestIdRef.current) return;
      
      if (isInitialLoad) {
        setTools(result.tools);
      } else {
        setTools(prev => [...prev, ...result.tools]);
      }
      setNextPageToken(result.nextPageToken);
    } catch (err) {
      // Ignore errors from stale requests
      if (currentRequestId !== requestIdRef.current) return;
      
      console.error('[McpToolList] Failed to fetch tools:', err);
      
      // Extract meaningful error message (handle Error, plain objects, strings)
      let errorMessage = 'Failed to load tools';
      if (err instanceof Error) {
        // Check for common error conditions
        if (err.message.includes('ECONNREFUSED') || err.message.includes('not running')) {
          errorMessage = 'Super-MCP is not running';
        } else if (err.message.includes('not found') || err.message.includes('unknown package')) {
          errorMessage = 'Package not found';
        } else if (err.message.includes('auth') || err.message.includes('unauthorized')) {
          errorMessage = 'Authentication required';
          setHealthStatus('unavailable');
        } else if (err.message.includes('timeout')) {
          errorMessage = 'Connection timed out';
        } else {
          errorMessage = err.message;
        }
      } else if (typeof err === 'object' && err !== null && 'message' in err) {
        errorMessage = String((err as { message: unknown }).message);
      }
      setError(errorMessage);
    } finally {
      // Only update loading state if this is still the current request
      if (currentRequestId === requestIdRef.current) {
        if (isInitialLoad) {
          setLoading(false);
        } else {
          setLoadingMore(false);
        }
      }
    }
  }, [serverId]);

  // Check health first, then fetch tools if healthy
  useEffect(() => {
    let cancelled = false;
    let completed = false;
    
    // Safety timeout - if health check + tool fetch takes too long, show error
    const timeoutId = setTimeout(() => {
      if (!cancelled && !completed) {
        setLoading(false);
        setHealthStatus('unknown');
        setError('That connection timed out.');
      }
    }, 15000); // 15 second maximum wait

    const init = async () => {
      setHealthStatus('checking');
      setTools([]);
      setError(null);

      const health = await checkHealth();
      if (cancelled) return;

      setHealthStatus(health);

      // Fetch tools for 'ok' and 'error' health statuses.
      // 'error' can happen transiently (e.g., stdio health check calling listTools)
      // but the tools may still be available via direct fetch.
      // This fixes built-in connectors showing "No tools available" despite having tools.
      if (health === 'ok' || health === 'error') {
        void fetchTools().finally(() => {
          completed = true;
        });
      } else if (health === 'unavailable') {
        // Auth required - stop loading, show sign-in prompt
        setLoading(false);
        completed = true;
      } else {
        // 'unknown' - couldn't reach Super-MCP, stop loading
        setLoading(false);
        completed = true;
      }
    };

    void init();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [serverId, checkHealth, fetchTools]);

  // Handle sign-in button click
  const handleSignIn = useCallback(async () => {
    if (!serverId || authenticating) return;
    
    setAuthenticating(true);
    setError(null);
    
    try {
      // GitHub uses Rebel-side OAuth (bypasses Super-MCP's DCR which GitHub doesn't support)
      if (serverId === 'GitHub') {
        const result = await window.githubApi.startAuth();
        if (result.success) {
          // Reload token files into Super-MCP.
          const restartResult = await window.settingsApi.mcpRestartSuperMcp();
          if (!restartResult.success) {
            console.error('[McpToolList] Failed to restart Super-MCP after GitHub auth:', restartResult.error);
          }

          // Re-check health and fetch tools
          const health = await checkHealth();
          setHealthStatus(health);
          if (health !== 'unavailable') {
            void fetchTools();
          }
        } else if (!setupGuidanceDialog.handleResult(result)) {
          setError(result.error || 'Authentication failed');
        }
        return;
      }

      const result = await window.miscApi.mcpAuthenticate({ serverId, force: true });
      if (result.success) {
        // Re-check health and fetch tools
        const health = await checkHealth();
        setHealthStatus(health);
        if (health !== 'unavailable') {
          void fetchTools();
        }
      } else if (!setupGuidanceDialog.handleResult(result)) {
        setError(result.error || 'Authentication failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setAuthenticating(false);
    }
  }, [serverId, authenticating, checkHealth, fetchTools, setupGuidanceDialog]);

  // Auto-paginate: fetch remaining pages so the total count is accurate
  useEffect(() => {
    if (nextPageToken && !loading && !loadingMore) {
      void fetchTools(nextPageToken);
    }
  }, [nextPageToken, loading, loadingMore, fetchTools]);

  // Load more handler (manual fallback)
  const handleLoadMore = useCallback(() => {
    if (nextPageToken && !loadingMore) {
      void fetchTools(nextPageToken);
    }
  }, [fetchTools, nextPageToken, loadingMore]);

  // Track which tools are being toggled (for loading state)
  const [togglingTools, setTogglingTools] = useState<Set<string>>(new Set());

  // Handle tool enable/disable toggle
  const handleToggleTool = useCallback(async (tool: McpToolInfo, enabled: boolean) => {
    const shortName = getShortToolName(tool.toolId);
    const toolKey = tool.toolId;
    
    // Add to toggling set for loading state
    setTogglingTools(prev => new Set(prev).add(toolKey));
    
    // Optimistic UI update
    setTools(prevTools => prevTools.map(t => {
      if (t.toolId !== tool.toolId) return t;
      if (enabled) {
        // Re-enabling: clear userDisabled and blocked (if it was user-disabled)
        return { ...t, userDisabled: false, blocked: false, blockedReason: undefined };
      } else {
        // Disabling: set userDisabled and blocked
        return { ...t, userDisabled: true, blocked: true, blockedReason: 'Disabled by user' };
      }
    }));
    
    try {
      const result = await window.settingsApi.mcpToggleTool({
        serverId,
        toolName: shortName,
        enabled,
      });
      
      if (!result.success) {
        // Rollback on failure
        console.error('[McpToolList] Toggle failed:', result.error);
        void fetchTools(); // Refetch to restore correct state
      }
    } catch (err) {
      console.error('[McpToolList] Toggle error:', err);
      // Rollback on error by refetching
      void fetchTools();
    } finally {
      setTogglingTools(prev => {
        const next = new Set(prev);
        next.delete(toolKey);
        return next;
      });
    }
  }, [serverId, fetchTools]);

  // Calculate counts (admin-disabled tools are not enabled)
  const enabledCount = tools.filter(t => !t.blocked && !t.adminDisabled).length;
  const totalCount = tools.length;
  const normalizedToolSearch = toolSearch.trim().toLowerCase();
  const showToolSearch = totalCount > 8;
  const visibleTools = useMemo(() => {
    if (!normalizedToolSearch) {
      return tools;
    }

    return tools.filter(tool => {
      const shortName = getShortToolName(tool.toolId).toLowerCase();
      return shortName.includes(normalizedToolSearch) || tool.toolId.toLowerCase().includes(normalizedToolSearch);
    });
  }, [normalizedToolSearch, tools]);

  // Don't render section if no serverId
  if (!serverId) return null;

  return (
    <div className={styles.mcpToolList}>
      <div className={styles.mcpToolListHeader}>
        <button
          type="button"
          className={styles.mcpToolListToggle}
          onClick={() => setIsExpanded(previous => !previous)}
          aria-expanded={isExpanded}
        >
          <span className={`${styles.mcpToolListChevron} ${isExpanded ? styles.mcpToolListChevronExpanded : ''}`}>
            <ChevronRight size={14} />
          </span>
          <span className={styles.mcpToolListTitle}>Tools</span>
        </button>
        <div className={styles.mcpToolListHeaderActions}>
          {headerAction}
          {!loading && !error && totalCount > 0 && (
            <span className={styles.mcpToolListCount}>
              {enabledCount} enabled / {totalCount} total
              {nextPageToken && '+'}
            </span>
          )}
        </div>
      </div>

      {isExpanded && !loading && !error && totalCount > 0 && showToolSearch && (
        <div className={styles.mcpToolListSearch}>
          <Input
            type="search"
            inputSize="sm"
            value={toolSearch}
            onChange={(event) => setToolSearch(event.target.value)}
            placeholder="Search tools"
            aria-label="Search tools"
            className={styles.mcpToolListSearchInput}
          />
        </div>
      )}

      {!isExpanded ? null : healthStatus === 'unavailable' ? (
        authHint === 'oauth' ? (
          <div className={styles.mcpToolListAuth}>
            <p className={styles.mcpToolListAuthText}>Authentication required to access tools</p>
            <Tooltip content="Re-authenticate to refresh your connection">
              <Button
                variant="outline"
                size="sm"
                onClick={handleSignIn}
                disabled={authenticating}
              >
                {authenticating ? (
                  <>
                    <Loader2 size={12} className={styles.spinnerIcon} />
                    Authenticating...
                  </>
                ) : (
                  <>
                    <LogIn size={12} />
                    Re-authenticate
                  </>
                )}
              </Button>
            </Tooltip>
            {error && (
              <p className={styles.mcpToolListAuthError}>{error}</p>
            )}
          </div>
        ) : (
          <div className={styles.mcpToolListError}>
            <AlertCircle size={14} />
            <span>{authHint === 'api-key'
              ? 'Unable to connect. Your API key may be invalid or expired.'
              : 'Unable to connect. The service may be unavailable.'
            }</span>
          </div>
        )
      ) : loading || healthStatus === 'checking' ? (
        <div className={styles.mcpToolListLoading}>
          <Loader2 size={16} className={styles.spinnerIcon} />
          <span>Loading tools...</span>
        </div>
      ) : error ? (
        <div className={styles.mcpToolListError}>
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      ) : totalCount === 0 ? (
        authHint === 'oauth' && healthStatus === 'ok' ? (
          // OAuth connector with health ok but no tools - likely needs re-authentication
          <div className={styles.mcpToolListAuth}>
            <p className={styles.mcpToolListAuthText}>No tools available. Try re-authenticating to restore access.</p>
            <Tooltip content="Re-authenticate to refresh your connection">
              <Button
                variant="outline"
                size="sm"
                onClick={handleSignIn}
                disabled={authenticating}
              >
                {authenticating ? (
                  <>
                    <Loader2 size={12} className={styles.spinnerIcon} />
                    Authenticating...
                  </>
                ) : (
                  <>
                    <LogIn size={12} />
                    Re-authenticate
                  </>
                )}
              </Button>
            </Tooltip>
            {error && (
              <p className={styles.mcpToolListAuthError}>{error}</p>
            )}
          </div>
        ) : healthStatus === 'error' || healthStatus === 'unknown' ? (
          // Health indicates connection issue - show error instead of misleading "No tools"
          <div className={styles.mcpToolListError}>
            <AlertCircle size={14} />
            <span>Unable to load tools. Check connection status.</span>
          </div>
        ) : (
          <p className={styles.mcpToolListEmpty}>No tools available</p>
        )
      ) : visibleTools.length === 0 ? (
        <p className={styles.mcpToolListEmpty}>No matching tools</p>
      ) : (
        <>
          <div className={styles.mcpToolListItems}>
            {visibleTools.map(tool => {
              // Determine tool state (precedence: security-blocked > admin-disabled > user-disabled > enabled):
              const isAdminDisabled = tool.adminDisabled === true;
              const isSecurityBlocked = tool.blocked && !tool.userDisabled && !tool.adminDisabled;
              const isUserDisabled = tool.userDisabled === true && !tool.adminDisabled;
              const isEnabled = !tool.blocked && !tool.adminDisabled;
              const isToggling = togglingTools.has(tool.toolId);
              
              return (
                <div 
                  key={tool.toolId} 
                  className={`${styles.mcpToolItem} ${(tool.blocked || isAdminDisabled) ? styles.mcpToolItemBlocked : ''}`}
                >
                  {isAdminDisabled ? (
                    // Admin-disabled: unified tooltip across icon, name, and badge
                    <Tooltip
                      content={
                        <div>
                          <div style={{ fontWeight: 500, marginBottom: tool.summary ? 4 : 0 }}>{tool.toolId}</div>
                          {tool.summary && <div style={{ opacity: 0.85 }}>{tool.summary}</div>}
                          <div style={{ color: '#f59e0b', marginTop: 4 }}>Disabled by your organization's administrator</div>
                        </div>
                      }
                      delayShow={300}
                      maxWidth="500px"
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'inherit', flex: 1, minWidth: 0 }}>
                        <div className={styles.mcpToolItemIcon}>
                          <AlertCircle size={13} className={styles.mcpToolItemIconAdmin} />
                        </div>
                        <div className={styles.mcpToolItemContent}>
                          <div className={styles.mcpToolItemHeader}>
                            <span className={styles.mcpToolItemName}>
                              {getShortToolName(tool.toolId)}
                            </span>
                            <Badge variant="outline" size="sm" className={styles.mcpToolItemBadgeAdmin}>
                              Disabled
                            </Badge>
                          </div>
                        </div>
                      </div>
                    </Tooltip>
                  ) : (
                    // Non-admin-disabled: individual tooltips on icon and name
                    <>
                      <div className={styles.mcpToolItemIcon}>
                        {isSecurityBlocked ? (
                          <Tooltip content={tool.blockedReason || 'Blocked by security policy'}>
                            <AlertCircle size={12} className={styles.mcpToolItemIconBlocked} />
                          </Tooltip>
                        ) : isUserDisabled ? (
                          <Tooltip content="Disabled by you">
                            <X size={12} className={styles.mcpToolItemIconDisabled} />
                          </Tooltip>
                        ) : (
                          <span className={styles.mcpToolItemIconSpacer} aria-hidden />
                        )}
                      </div>
                      <div className={styles.mcpToolItemContent}>
                        <div className={styles.mcpToolItemHeader}>
                          <Tooltip 
                            content={
                              <div>
                                <div style={{ fontWeight: 500, marginBottom: tool.summary ? 4 : 0 }}>{tool.toolId}</div>
                                {tool.summary && <div style={{ opacity: 0.85 }}>{tool.summary}</div>}
                              </div>
                            } 
                            delayShow={300}
                            maxWidth="500px"
                          >
                            <span className={styles.mcpToolItemName}>
                              {getShortToolName(tool.toolId)}
                            </span>
                          </Tooltip>
                          {isSecurityBlocked && (
                            <Badge variant="outline" size="sm" className={styles.mcpToolItemBadge}>
                              Blocked
                            </Badge>
                          )}
                          {isUserDisabled && (
                            <Badge variant="outline" size="sm" className={styles.mcpToolItemBadgeDisabled}>
                              Disabled
                            </Badge>
                          )}
                          {tool.readOnlyHint === true && (
                            <Tooltip content="This tool reports it does not modify external data. Used for automatic retry after connection recovery.">
                              <Badge variant="outline" size="sm" className={styles.mcpToolItemBadgeReadOnly}>
                                Read-only
                              </Badge>
                            </Tooltip>
                          )}
                          {tool.readOnlyHint === false && tool.destructiveHint === true && (
                            <Tooltip content="This tool reports it may permanently delete or destroy data.">
                              <Badge variant="outline" size="sm" className={styles.mcpToolItemBadgeModifies}>
                                Destructive
                              </Badge>
                            </Tooltip>
                          )}
                          {tool.readOnlyHint === false && tool.destructiveHint !== true && (
                            <Tooltip content="This tool reports it may modify external data.">
                              <Badge variant="outline" size="sm" className={styles.mcpToolItemBadgeModifies}>
                                Modifies data
                              </Badge>
                            </Tooltip>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                  {/* Toggle control - only show for tools that can be toggled (not security-blocked or admin-disabled) */}
                  {!isSecurityBlocked && !isAdminDisabled && (
                    <div className={styles.mcpToolItemToggle}>
                      {isToggling ? (
                        <Loader2 size={14} className={styles.spinnerIcon} aria-label="Updating..." />
                      ) : isUserDisabled ? (
                        <Tooltip content="Enable this tool">
                          <Button
                            variant="ghost"
                            size="sm"
                            className={styles.mcpToolToggleButton}
                            onClick={() => void handleToggleTool(tool, true)}
                            aria-label={`Enable tool ${getShortToolName(tool.toolId)}`}
                            aria-pressed={false}
                          >
                            <ToggleLeft size={16} />
                          </Button>
                        </Tooltip>
                      ) : isEnabled ? (
                        <Tooltip content="Disable this tool">
                          <Button
                            variant="ghost"
                            size="sm"
                            className={styles.mcpToolToggleButton}
                            onClick={() => void handleToggleTool(tool, false)}
                            aria-label={`Disable tool ${getShortToolName(tool.toolId)}`}
                            aria-pressed={true}
                          >
                            <ToggleRight size={16} className={styles.mcpToolToggleEnabled} />
                          </Button>
                        </Tooltip>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Load more button for pagination */}
          {nextPageToken && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className={styles.mcpToolListLoadMore}
            >
              {loadingMore ? (
                <>
                  <Loader2 size={12} className={styles.spinnerIcon} />
                  Loading...
                </>
              ) : (
                <>
                  <ChevronDown size={12} />
                  Load more tools
                </>
              )}
            </Button>
          )}
        </>
      )}

      <ConnectorSetupDialog
        guidance={setupGuidanceDialog.guidance}
        open={setupGuidanceDialog.isOpen}
        onOpenChange={setupGuidanceDialog.setOpen}
      />
    </div>
  );
};
