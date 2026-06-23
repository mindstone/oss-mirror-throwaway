import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  Input,
  Button,
  Label,
  Tooltip,
  Badge,
} from '@renderer/components/ui';
import { Plus, ExternalLink, Loader2, Check, Info, Bot } from 'lucide-react';
import type { McpServerConfigDetails, McpServerUpsertPayload } from '@shared/types';
import { extractServerConfig, type McpConfigFormat } from '@shared/utils/mcpConfigImport';
import { redactSensitiveString } from '@shared/utils/sentryRedaction';
import { McpAccountsExtension } from './McpAccountsExtension';
import { createUntrackedConnectionCardOps } from './useConnectionCardOps';
import { serializeServerConfig, validateServerConfig, parseConfigToPayload } from '../utils/mcpConfigUtils';
import type { SetupWithRebelParams } from './tabs/types';
import styles from './SettingsSurface.module.css';

type ServerPayload = McpServerUpsertPayload;

interface AddConnectionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpsertServer?: (payload: ServerPayload) => Promise<void>;
  onAddServer?: (payload: ServerPayload) => Promise<void>;
  onRemoveServer?: (name: string) => Promise<void>;
  onLoadServer?: (serverName: string) => Promise<McpServerConfigDetails>;
  servers?: { name: string }[];
  loading?: boolean;
  mcpMutationPending?: boolean;
  mode?: 'add' | 'configure';
  existingServer?: McpServerConfigDetails | null;
  onConfigureWithRebel?: (params: SetupWithRebelParams) => void | Promise<void>;
  /** @deprecated No longer used - modal only has Custom MCP Server form */
  initialShowCustomForm?: boolean;
}

const EXAMPLE_STDIO_CONFIG = `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-example"],
  "env": {},
  "description": "My local MCP server"
}`;

const EXAMPLE_HTTP_CONFIG = `{
  "url": "https://api.example.com/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_TOKEN"
  },
  "description": "My remote MCP server"
}`;

/** Human-readable labels for detected config formats */
const FORMAT_LABELS: Record<McpConfigFormat, string> = {
  standard: 'Standard',
  keyed: 'Keyed',
  'claude-desktop': 'Claude Desktop',
  wrapper: 'Wrapper',
  array: 'Array',
  unknown: 'Unknown',
};

export const AddConnectionModal = ({
  open,
  onOpenChange,
  onUpsertServer,
  onAddServer,
  onRemoveServer,
  loading = false,
  mode = 'add',
  existingServer = null,
  onConfigureWithRebel,
}: AddConnectionModalProps) => {
  const handleAddServer = onUpsertServer ?? onAddServer;
  const extensionOps = useMemo(() => createUntrackedConnectionCardOps(
    'add-connection configure modal has no queued-state UI',
    {
      addBundledServer: (payload) => window.settingsApi.mcpAddBundledServer(payload),
      upsertServer: async (payload) => {
        await handleAddServer?.(payload);
      },
      removeServer: async (name) => {
        await onRemoveServer?.(name);
      },
      toggleServerEnabled: (serverId) => window.settingsApi.mcpToggleServerEnabled({ serverId }),
    },
  ), [handleAddServer, onRemoveServer]);

  // Custom MCP server state
  const [serverName, setServerName] = useState('');
  const [serverJson, setServerJson] = useState(EXAMPLE_STDIO_CONFIG);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync initial values when modal opens
  useEffect(() => {
    if (open) {
      if (mode === 'configure' && existingServer) {
        setServerName(existingServer.name);
        setServerJson(serializeServerConfig(existingServer));
      } else {
        setServerName('');
        setServerJson(EXAMPLE_STDIO_CONFIG);
      }
      setError(null);
    }
  }, [open, mode, existingServer]);

  // Smart format detection and extraction using shared utility
  const extractionResult = useMemo(() => {
    if (!serverJson.trim()) {
      return null;
    }
    return extractServerConfig(serverJson);
  }, [serverJson]);

  // Real-time validation (uses extraction result + existing validation)
  const validationState = useMemo(() => {
    if (!serverJson.trim()) {
      return { isValid: false, errors: [], warnings: [] };
    }
    // If extraction found errors, use those
    if (extractionResult && extractionResult.errors.length > 0) {
      return {
        isValid: false,
        errors: extractionResult.errors,
        warnings: extractionResult.warnings,
      };
    }
    // If extraction succeeded and normalized the config, validate the normalized version
    if (extractionResult?.config) {
      const normalizedJson = JSON.stringify(extractionResult.config, null, 2);
      const validation = validateServerConfig(normalizedJson);
      return {
        ...validation,
        warnings: [...extractionResult.warnings, ...validation.warnings],
      };
    }
    // Fallback to direct validation
    return validateServerConfig(serverJson);
  }, [serverJson, extractionResult]);

  // Auto-populate name from extracted config if name field is empty
  useEffect(() => {
    if (
      extractionResult?.extractedName &&
      !serverName.trim() &&
      extractionResult.errors.length === 0
    ) {
      setServerName(extractionResult.extractedName);
    }
  }, [extractionResult, serverName]);

  // Auto-format on blur: normalize JSON and extract config if in non-standard format
  const handleBlur = useCallback(() => {
    if (!extractionResult || extractionResult.errors.length > 0) {
      return;
    }
    // If format is not standard, normalize to the extracted config
    if (extractionResult.format !== 'standard' && extractionResult.config) {
      const normalized = JSON.stringify(extractionResult.config, null, 2);
      if (normalized !== serverJson) {
        setServerJson(normalized);
      }
    } else {
      // Standard format: just pretty-print if valid
      try {
        const parsed = JSON.parse(serverJson);
        const formatted = JSON.stringify(parsed, null, 2);
        if (formatted !== serverJson) {
          setServerJson(formatted);
        }
      } catch {
        // Can't format invalid JSON
      }
    }
  }, [serverJson, extractionResult]);

  const handleSetTemplate = useCallback(
    (template: string) => {
      const isUnmodified =
        serverJson === EXAMPLE_STDIO_CONFIG ||
        serverJson === EXAMPLE_HTTP_CONFIG ||
        serverJson.trim() === '';
      if (isUnmodified || window.confirm('Replace current config with template?')) {
        setServerJson(template);
      }
    },
    [serverJson]
  );

  const handleClose = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        setServerName('');
        setServerJson(EXAMPLE_STDIO_CONFIG);
        setError(null);
      }
      onOpenChange(isOpen);
    },
    [onOpenChange]
  );

  const handleSave = useCallback(async () => {
    // Use extraction result for validation and normalization
    if (!extractionResult || extractionResult.errors.length > 0) {
      setError(extractionResult?.errors.join('\n') || 'Invalid configuration');
      return;
    }

    // Use serverName if provided, otherwise fall back to extracted name
    const name = serverName.trim() || extractionResult.extractedName;
    if (!name) {
      setError("The server needs a name.");
      return;
    }

    if (!extractionResult.config) {
      setError("Couldn't read the server config out of that.");
      return;
    }

    // Validate the normalized config
    const normalizedJson = JSON.stringify(extractionResult.config, null, 2);
    const validation = validateServerConfig(normalizedJson);
    if (!validation.isValid) {
      setError(validation.errors.join('\n'));
      return;
    }

    setError(null);
    setSaving(true);

    try {
      // Handle rename in configure mode
      const isRename = mode === 'configure' && existingServer && existingServer.name !== name;
      if (isRename && onRemoveServer) {
        await onRemoveServer(existingServer.name);
      }

      // Parse the normalized config (not the raw input)
      // In configure mode, preserve metadata from the existing server to prevent data loss
      const preserveMetadata = mode === 'configure' && existingServer
        ? { email: existingServer.email, catalogId: existingServer.catalogId, workspace: existingServer.workspace }
        : undefined;
      const payload = parseConfigToPayload(normalizedJson, preserveMetadata);
      await handleAddServer?.({
        name,
        ...payload,
      });

      onOpenChange(false);
      
      // Launch conversation with Rebel to verify setup (only for new servers, not configure mode)
      if (mode !== 'configure' && onConfigureWithRebel) {
        onConfigureWithRebel({ 
          serverName: name, 
          isNewConnection: true, 
          setupResult: { success: true } 
        });
      }
    } catch (err) {
      const message = err instanceof Error ? redactSensitiveString(err.message) : 'Failed to save server';
      setError(message);
    } finally {
      setSaving(false);
    }
  }, [serverName, extractionResult, handleAddServer, onRemoveServer, onOpenChange, onConfigureWithRebel, mode, existingServer]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent size="lg" className={styles.addConnectionModal}>
        <DialogHeader onClose={() => handleClose(false)}>
          <DialogTitle>
            {mode === 'configure' ? 'Configure MCP Server' : 'Add Custom MCP Server'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'configure'
              ? 'Update server settings'
              : 'Add a custom MCP server using JSON configuration'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className={styles.addConnectionBody}>
          <div className={styles.customServerFormStandalone}>
            {error && <div className={styles.customServerError}>{error}</div>}

            {/* Name field */}
            <div className={styles.customServerField}>
              <Label htmlFor="custom-server-name">Server Name</Label>
              <Input
                id="custom-server-name"
                placeholder="my-mcp-server"
                value={serverName}
                onChange={(e) => setServerName(e.target.value)}
                disabled={saving}
                autoFocus
              />
            </div>

            {/* JSON Config */}
            <div className={styles.customServerField}>
              <div className={styles.configHeader}>
                <Label htmlFor="custom-server-config">Configuration</Label>
                <div className={styles.configActions}>
                  {/* Format badge - shows detected format when not standard */}
                  {extractionResult && extractionResult.format !== 'standard' && extractionResult.format !== 'unknown' && (
                    <Badge variant="secondary" className={styles.formatBadge}>
                      {FORMAT_LABELS[extractionResult.format]}
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleSetTemplate(EXAMPLE_STDIO_CONFIG)}
                    disabled={saving}
                    className={styles.configTemplateBtn}
                  >
                    Local
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleSetTemplate(EXAMPLE_HTTP_CONFIG)}
                    disabled={saving}
                    className={styles.configTemplateBtn}
                  >
                    Remote
                  </Button>
                  <Tooltip
                    content={
                      <div className={styles.configTooltip}>
                        <strong>Paste any MCP config format</strong>
                        <br />
                        <br />
                        <strong>Supported formats:</strong>
                        <br />
                        • Standard: {'{'} "command": "npx", ... {'}'}
                        <br />
                        • Keyed: {'{'} "name": {'{'} "command": ... {'}'} {'}'}
                        <br />
                        • Claude Desktop: {'{'} "mcpServers": ... {'}'}
                        <br />
                        <br />
                        <strong>Local (stdio):</strong>
                        <br />
                        • command: "npx", "node", etc.
                        <br />
                        • args: ["arg1", "arg2"]
                        <br />
                        • env: {'{'} KEY: "value" {'}'}
                        <br />
                        <br />
                        <strong>Remote (http/sse):</strong>
                        <br />
                        • url: server endpoint
                        <br />
                        • headers: {'{'} "Auth": "Bearer ..." {'}'}
                      </div>
                    }
                    placement="left"
                    delayShow={200}
                  >
                    <Info size={14} className={styles.infoIcon} />
                  </Tooltip>
                </div>
              </div>
              <div className={styles.jsonEditorWrapper}>
                <textarea
                  id="custom-server-config"
                  className={styles.jsonConfigEditor}
                  value={serverJson}
                  onChange={(e) => setServerJson(e.target.value)}
                  onBlur={handleBlur}
                  disabled={saving}
                  spellCheck={false}
                  rows={10}
                  placeholder="Paste any MCP config format - it will be auto-detected and normalized"
                />
                <span
                  className={`${styles.validationIndicator} ${validationState.isValid ? styles.validationValid : styles.validationInvalid}`}
                  title={validationState.isValid ? 'Valid config' : validationState.errors.join('\n')}
                />
              </div>
              {/* Warnings display */}
              {validationState.warnings.length > 0 && (
                <div className={styles.configWarnings}>
                  {validationState.warnings.map((warning, i) => (
                    <span key={i} className={styles.configWarning}>{warning}</span>
                  ))}
                </div>
              )}
            </div>

            {/* Extension for special MCPs (Google, HubSpot).
                NOTE (Stage-5 refinement, GPT-F2): this configure-only branch is
                currently UNREACHABLE — the modal's sole mount
                (UnifiedConnectionsPanel) uses the default 'add' mode, and no
                configure-mode consumer exists repo-wide. It deliberately omits
                tracked ops object that ExpandedConnectionCard plumbs into
                McpAccountsExtension: the
                modal has no UnifiedConnection id to key the panel's
                single-slot tracker with, and no card surface to render the
                queued state on. If this branch is ever revived as a supported
                account-management surface, plumb the tracker (and a queued-state
                affordance) or accept a documented queued-UX gap. */}
            {mode === 'configure' && serverName && (
              <McpAccountsExtension serverName={serverName} ops={extensionOps} />
            )}

            {/* Actions */}
            <div className={styles.customServerActions}>
              {mode === 'configure' && onConfigureWithRebel && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onConfigureWithRebel({ serverName });
                    onOpenChange(false);
                  }}
                  disabled={saving || loading || !serverName.trim()}
                >
                  Configure with Rebel
                </Button>
              )}
              <Button size="sm" onClick={handleSave} disabled={saving || loading}>
                {saving ? (
                  <>
                    <Loader2 size={14} className={styles.spinnerIcon} />
                    {mode === 'configure' ? 'Saving...' : 'Setting up...'}
                  </>
                ) : mode === 'configure' ? (
                  <>
                    <Check size={14} />
                    Save Changes
                  </>
                ) : onConfigureWithRebel ? (
                  <>
                    <Bot size={14} />
                    Set up with Rebel
                  </>
                ) : (
                  <>
                    <Plus size={14} />
                    Add Server
                  </>
                )}
              </Button>
            </div>

            <div className={styles.catalogFooter}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => window.appApi.openUrl('https://github.com/modelcontextprotocol/servers')}
              >
                <ExternalLink size={12} />
                Browse MCP Registry
              </Button>
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
