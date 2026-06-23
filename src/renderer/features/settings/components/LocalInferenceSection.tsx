/**
 * Local Inference Section — Settings UI for bundled Ollama.
 *
 * Three states:
 *   1. Not installed  → activation CTA with hardware info
 *   2. Downloading     → progress bar with cancel
 *   3. Installed       → model catalog with download/remove per model
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@renderer/components/ui';
import {
  Download,
  Trash2,
  Cpu,
  HardDrive,
  Check,
  X,
  Loader2,
  AlertTriangle,
  Cloud,
  Info,
} from 'lucide-react';
import type { AppSettings, ModelProfile } from '@shared/types';
import { LOCAL_MODEL_CATALOG } from '@core/services/localInference/modelCatalog';
import type { LocalModelCatalogEntry, LocalInferenceStatus } from '@core/services/localInference/ollamaTypes';
import styles from './LocalInferenceSection.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DownloadProgress {
  type: 'runtime' | 'model';
  progress: number;
  status: string;
  error?: string;
}

interface LocalInferenceSectionProps {
  draftSettings?: AppSettings;
  onSettingsChange?: (updates: Partial<AppSettings>) => void;
  profiles?: ModelProfile[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const formatGB = (gb: number): string => (gb < 1 ? `${Math.round(gb * 1024)} MB` : `${gb.toFixed(1)} GB`);

const formatContext = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
  return `${(tokens / 1_000).toFixed(0)}K`;
};

/** Approximate RAM estimate for display purposes (TurboQuant default, ~5× compression). */
const estimateRAM = (entry: LocalModelCatalogEntry): number => {
  const kvCacheBase = entry.downloadSizeGB * 0.2 * (entry.contextWindowDefault / 32_000);
  return entry.downloadSizeGB + (kvCacheBase / 5) + 4; // model + KV cache + OS headroom
};

const badgeClass = (badge?: string): string => {
  switch (badge) {
    case 'recommended': return styles.badgeRecommended;
    case 'lightweight': return styles.badgeLightweight;
    case 'reasoning': return styles.badgeReasoning;
    default: return styles.badge;
  }
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const LocalInferenceSection = ({
  draftSettings,
  onSettingsChange,
  profiles,
}: LocalInferenceSectionProps = {}) => {
  const [status, setStatus] = useState<LocalInferenceStatus | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false);
  const [deleteConfirmTag, setDeleteConfirmTag] = useState<string | null>(null);
  const [pullingTag, setPullingTag] = useState<string | null>(null);
  const isMounted = useRef(true);

  // Fetch initial status
  useEffect(() => {
    isMounted.current = true;
    const fetchStatus = async () => {
      try {
        const result = await window.localInferenceApi.getStatus();
        if (isMounted.current) setStatus(result as LocalInferenceStatus);
      } catch (err) {
        if (isMounted.current) setError("Couldn't read the local model's status — try again.");
        console.error('local-inference:get-status failed', err);
      } finally {
        if (isMounted.current) setIsLoading(false);
      }
    };
    void fetchStatus();
    return () => { isMounted.current = false; };
  }, []);

  // Listen for progress broadcasts
  useEffect(() => {
    const cleanup = window.api?.onLocalInferenceProgress?.((data: DownloadProgress) => {
      if (!isMounted.current) return;
      setProgress(data);
      if (data.error) setError(data.error);

      // When download completes, refresh status
      if (data.status === 'complete' || data.status === 'ready') {
        setProgress(null);
        setPullingTag(null);
        void window.localInferenceApi.getStatus()
          .then((r: Record<string, unknown>) => { if (isMounted.current) setStatus(r as unknown as LocalInferenceStatus); })
          .catch(() => {});
      }
      if (data.status === 'error' || data.status === 'cancelled') {
        setPullingTag(null);
      }
    });
    return cleanup;
  }, []);

  // Listen for status-changed broadcasts
  useEffect(() => {
    const cleanup = window.api?.onLocalInferenceStatusChanged?.(() => {
      void window.localInferenceApi.getStatus()
        .then((r: Record<string, unknown>) => { if (isMounted.current) setStatus(r as unknown as LocalInferenceStatus); })
        .catch(() => {});
    });
    return cleanup;
  }, []);

  // --- Handlers ---

  const handleActivate = useCallback(async () => {
    setError(null);
    try {
      const result = await window.localInferenceApi.activate();
      if (result.alreadyInstalled) {
        // Runtime already on disk -- refresh status to show model catalog
        const updated = await window.localInferenceApi.getStatus();
        if (isMounted.current) setStatus(updated as LocalInferenceStatus);
        return;
      }
      if (!result.started && result.error) {
        setError(result.error);
      }
    } catch {
      setError("The download didn't start. Try again.");
    }
  }, []);

  const handleCancelDownload = useCallback(async () => {
    try {
      await window.localInferenceApi.cancelPull();
      setProgress(null);
    } catch {
      // ignore cancel errors
    }
  }, []);

  const handlePullModel = useCallback(async (ollamaTag: string) => {
    setError(null);
    setPullingTag(ollamaTag);
    try {
      const result = await window.localInferenceApi.pullModel({ ollamaTag });
      if (!result.started && result.error) {
        setError(result.error);
        setPullingTag(null);
      }
    } catch {
      setError("Couldn't start the model download. Try again.");
      setPullingTag(null);
    }
  }, []);

  const handleDeleteModel = useCallback(async (modelName: string) => {
    setDeleteConfirmTag(null);
    setError(null);
    try {
      const result = await window.localInferenceApi.deleteModel({ modelName });
      if (!result.success && result.error) {
        setError(result.error);
      } else {
        const updated = await window.localInferenceApi.getStatus();
        if (isMounted.current) setStatus(updated as LocalInferenceStatus);
      }
    } catch {
      setError("Couldn't remove the model. Try again.");
    }
  }, []);

  const handleDeactivate = useCallback(async () => {
    setShowDeactivateConfirm(false);
    setError(null);
    try {
      const result = await window.localInferenceApi.deactivate();
      if (!result.success && result.error) {
        setError(result.error);
      } else {
        const updated = await window.localInferenceApi.getStatus();
        if (isMounted.current) setStatus(updated as LocalInferenceStatus);
      }
    } catch {
      setError("Couldn't remove the local engine. Try again.");
    }
  }, []);

  // --- Loading state ---
  if (isLoading) {
    return (
      <div className={styles.sectionWrapper}>
        <div className={styles.container}>
          <Loader2 size={16} className={styles.spinner} />
        </div>
      </div>
    );
  }

  const runtimeStatus = status?.runtimeStatus ?? 'not_installed';
  const systemRAMGB = status?.systemRAMGB ?? 0;
  const arch = status?.arch ?? '';
  const isDownloading = runtimeStatus === 'downloading' || (progress?.type === 'runtime' && progress.status !== 'complete');
  const installedModelNames = new Set((status?.installedModels ?? []).map(m => m.name));
  const runtimeReady = runtimeStatus === 'installed' || runtimeStatus === 'running';
  const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
  const modelSettings = draftSettings?.models;
  const workingProfile = modelSettings?.workingProfileId
    ? profileById.get(modelSettings.workingProfileId)
    : undefined;
  const thinkingProfile = modelSettings?.thinkingProfileId
    ? profileById.get(modelSettings.thinkingProfileId)
    : undefined;
  const workingUsesLocalProfile = workingProfile?.providerType === 'local';
  const thinkingUsesLocalProfile = thinkingProfile?.providerType === 'local';
  const fallbackContextName = (() => {
    if (workingUsesLocalProfile && thinkingUsesLocalProfile) {
      if (workingProfile?.id && workingProfile.id === thinkingProfile?.id) {
        return workingProfile.name;
      }
      return [workingProfile?.name, thinkingProfile?.name].filter(Boolean).join(' / ') || 'local models';
    }
    if (workingUsesLocalProfile) {
      return workingProfile?.name ?? 'local model';
    }
    if (thinkingUsesLocalProfile) {
      return thinkingProfile?.name ?? 'local model';
    }
    return null;
  })();
  const fallbackRole = workingUsesLocalProfile && thinkingUsesLocalProfile
    ? 'Working & Thinking'
    : workingUsesLocalProfile
      ? 'Working'
      : thinkingUsesLocalProfile
        ? 'Thinking'
        : null;
  const fallbackOptions = (profiles ?? [])
    .filter((profile) => profile.providerType !== 'local')
    .map((profile) => ({
      value: `profile:${profile.id}`,
      label: profile.name,
    }));
  const currentFallbackValue = draftSettings?.localInferenceCloudFallback;
  const selectedFallbackValue =
    currentFallbackValue && fallbackOptions.some((option) => option.value === currentFallbackValue)
      ? currentFallbackValue
      : '';
  const showCloudFallbackPicker = Boolean(
    draftSettings
      && runtimeReady
      && installedModelNames.size > 0
      && (workingUsesLocalProfile || thinkingUsesLocalProfile)
      && fallbackContextName
      && fallbackRole
  );

  // --- State 1: Not installed ---
  if (runtimeStatus === 'not_installed' && !isDownloading) {
    return (
      <div className={styles.sectionWrapper}>
        <div className={styles.container}>
          <h3 className={styles.heading}>Run models on your machine</h3>
          <p className={styles.subtext}>
            Your conversations stay on your device. Nothing leaves this machine.
          </p>

          {systemRAMGB > 0 && (
            <div className={styles.hardwareInfo}>
              <span className={styles.hardwareItem}>
                <Cpu size={12} />
                {arch === 'arm64' ? 'Apple Silicon' : arch || 'Unknown'}
              </span>
              <span className={styles.hardwareItem}>
                <HardDrive size={12} />
                {Math.round(systemRAMGB)} GB RAM
              </span>
            </div>
          )}

          {systemRAMGB > 0 && systemRAMGB < 16 && (
            <div className={styles.ramWarning}>
              <AlertTriangle size={14} className={styles.ramWarningIcon} />
              <span>
                Your machine has {Math.round(systemRAMGB)} GB RAM. Local models really want at
                least 16 GB to stretch out.
              </span>
            </div>
          )}

          <Button onClick={handleActivate}>
            Set up local models
          </Button>

          {error && (
            <p className={styles.errorMessage}>
              <X size={12} />
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }

  // --- State 2: Downloading runtime ---
  if (isDownloading) {
    const pct = progress?.progress ?? 0;
    return (
      <div className={styles.sectionWrapper}>
        <div className={styles.container}>
          <h3 className={styles.heading}>Setting up your local brain…</h3>
          <div className={styles.progressContainer}>
            <div className={styles.progressBar}>
              <div className={styles.progressFill} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            <p className={styles.progressStatus}>
              {progress?.status ?? 'Downloading…'}{pct > 0 ? ` (${Math.round(pct)}%)` : ''}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleCancelDownload}>
            Cancel
          </Button>
          {error && (
            <p className={styles.errorMessage}>
              <X size={12} />
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }

  // --- State 3: Runtime installed → Model catalog ---
  return (
    <div className={styles.sectionWrapper}>
      <div className={styles.container}>
        {/* Status badge */}
        <div className={styles.statusBadge}>
          <Check size={12} />
          Local engine ready{status?.runtimeVersion ? ` · v${status.runtimeVersion}` : ''}
        </div>

        {/* Model catalog */}
        <p className={styles.catalogHeader}>Models</p>

        {LOCAL_MODEL_CATALOG.map((entry) => (
          <ModelCard
            key={entry.id}
            entry={entry}
            systemRAMGB={systemRAMGB}
            isInstalled={installedModelNames.has(entry.ollamaTag)}
            isPulling={pullingTag === entry.ollamaTag}
            pullProgress={pullingTag === entry.ollamaTag && progress?.type === 'model' ? progress : null}
            deleteConfirmTag={deleteConfirmTag}
            onPull={handlePullModel}
            onDelete={handleDeleteModel}
            onDeleteConfirm={setDeleteConfirmTag}
          />
        ))}

        {showCloudFallbackPicker && (
          <div className={styles.fallbackSection}>
            <label className={styles.fallbackHeader} htmlFor="local-inference-cloud-fallback">
              <Cloud size={12} />
              Cloud fallback
            </label>
            <p className={styles.fallbackSubtext}>
              When you&apos;re on mobile or web, Rebel uses this model instead of your local one.
            </p>
            <select
              id="local-inference-cloud-fallback"
              className={styles.fallbackSelect}
              value={selectedFallbackValue}
              data-testid="local-inference-cloud-fallback"
              aria-label="Cloud fallback"
              disabled={!onSettingsChange}
              onChange={(event) => {
                onSettingsChange?.({
                  localInferenceCloudFallback: event.target.value || undefined,
                });
              }}
            >
              <option value="">None — Rebel uses Claude</option>
              {fallbackOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className={styles.fallbackContext}>
              <Info size={12} />
              <span>
                Using {fallbackContextName} as {fallbackRole}
              </span>
            </div>
          </div>
        )}

        {/* Deactivation */}
        <div className={styles.deactivateRow}>
          {showDeactivateConfirm ? (
            <div className={styles.actionBar}>
              <span style={{ fontSize: '11px', color: 'var(--color-destructive)' }}>
                Remove local engine and all downloaded models?
              </span>
              <Button variant="ghost" size="sm" onClick={handleDeactivate}>
                Yes, remove
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowDeactivateConfirm(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <button
              className={styles.deactivateLink}
              onClick={() => setShowDeactivateConfirm(true)}
            >
              Remove local engine
            </button>
          )}
        </div>

        {error && (
          <p className={styles.errorMessage}>
            <X size={12} />
            {error}
          </p>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Model Card sub-component
// ---------------------------------------------------------------------------

interface ModelCardProps {
  entry: LocalModelCatalogEntry;
  systemRAMGB: number;
  isInstalled: boolean;
  isPulling: boolean;
  pullProgress: DownloadProgress | null;
  deleteConfirmTag: string | null;
  onPull: (ollamaTag: string) => void;
  onDelete: (modelName: string) => void;
  onDeleteConfirm: (tag: string | null) => void;
}

function ModelCard({
  entry,
  systemRAMGB,
  isInstalled,
  isPulling,
  pullProgress,
  deleteConfirmTag,
  onPull,
  onDelete,
  onDeleteConfirm,
}: ModelCardProps) {
  const suitable = systemRAMGB >= entry.minRAMGB;
  const ramEstimate = estimateRAM(entry);
  const cardClass = suitable ? styles.modelCard : styles.modelCardDisabled;

  return (
    <div className={cardClass}>
      <div className={styles.modelCardTop}>
        <div className={styles.modelCardInfo}>
          <div className={styles.modelName}>
            {entry.displayName}
            {entry.badge && (
              <span className={badgeClass(entry.badge)}>
                {entry.badge}
              </span>
            )}
          </div>
          <div className={styles.modelDescription}>{entry.description}</div>
          <div className={styles.modelMeta}>
            <span className={styles.modelMetaItem}>
              <Download size={10} />
              {formatGB(entry.downloadSizeGB)}
            </span>
            <span className={styles.modelMetaItem}>
              <HardDrive size={10} />
              ~{formatGB(ramEstimate)} RAM
            </span>
            {entry.toolCallingScore != null && (
              <span className={styles.modelMetaItem}>
                Tool calling: {entry.toolCallingScore}%
              </span>
            )}
            <span className={styles.modelMetaItem}>
              Up to {formatContext(entry.contextWindowMax)} context
            </span>
          </div>
        </div>

        <div className={styles.modelCardAction}>
          {!suitable ? (
            <span className={styles.badgeNeedsRam}>Needs more RAM</span>
          ) : isInstalled ? (
            <InstalledActions
              entry={entry}
              deleteConfirmTag={deleteConfirmTag}
              onDelete={onDelete}
              onDeleteConfirm={onDeleteConfirm}
            />
          ) : isPulling ? (
            <PullProgress progress={pullProgress} />
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onPull(entry.ollamaTag)}
              style={{ gap: '4px' }}
            >
              <Download size={12} />
              Download
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Installed model actions
// ---------------------------------------------------------------------------

function InstalledActions({
  entry,
  deleteConfirmTag,
  onDelete,
  onDeleteConfirm,
}: {
  entry: LocalModelCatalogEntry;
  deleteConfirmTag: string | null;
  onDelete: (modelName: string) => void;
  onDeleteConfirm: (tag: string | null) => void;
}) {
  if (deleteConfirmTag === entry.ollamaTag) {
    return (
      <div className={styles.actionBar}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(entry.ollamaTag)}
          style={{ color: 'var(--color-destructive)', fontSize: '11px' }}
        >
          Remove?
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDeleteConfirm(null)}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.actionBar}>
      <span className={styles.badgeReady}>
        <Check size={10} />
        Ready
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onDeleteConfirm(entry.ollamaTag)}
        style={{ padding: '4px' }}
      >
        <Trash2 size={12} />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pull progress indicator
// ---------------------------------------------------------------------------

function PullProgress({ progress }: { progress: DownloadProgress | null }) {
  const pct = progress?.progress ?? 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: '100px' }}>
      <div className={styles.progressBar} style={{ flex: 1, height: '4px' }}>
        <div className={styles.progressFill} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span style={{ fontSize: '10px', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
        {Math.round(pct)}%
      </span>
    </div>
  );
}
