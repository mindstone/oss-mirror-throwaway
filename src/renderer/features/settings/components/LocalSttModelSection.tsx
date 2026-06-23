/**
 * Local STT Model Download Section
 *
 * Displays model status and provides download/remove functionality
 * for the local Parakeet V3 speech-to-text model.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@renderer/components/ui';
import { Download, Trash2, Check, Loader2, AlertCircle, FolderOpen } from 'lucide-react';
import type { LocalSttModelStatus } from '@shared/ipc/channels/localStt';

interface DownloadProgress {
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  status: 'downloading' | 'extracting' | 'complete' | 'error' | 'cancelled';
  error?: string;
}

interface LocalSttModelSectionProps {
  /** 'default' = full card (settings), 'compact' = small card, 'badge' = status-only (no wrapper) */
  variant?: 'default' | 'compact' | 'badge';
  title?: string;
  subtitle?: string;
  /** Model to manage (defaults to parakeet-v3 for backward compatibility) */
  modelId?: string;
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export const LocalSttModelSection = ({
  variant = 'default',
  title: customTitle,
  subtitle: customSubtitle,
  modelId,
}: LocalSttModelSectionProps) => {
  const [modelStatus, setModelStatus] = useState<LocalSttModelStatus | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const isCompact = variant === 'compact';
  const isBadge = variant === 'badge';

  // Build the optional request args for IPC calls
  const ipcArgs = modelId ? { modelId } : undefined;

  // Fetch initial model status
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const status = await window.localSttApi.modelStatus(ipcArgs);
        setModelStatus(status);
        // If a download is already in progress (e.g., early background download),
        // seed downloadProgress so the UI shows the correct state immediately
        if (status.downloading) {
          setDownloadProgress({
            progress: status.downloadProgress ?? 0,
            downloadedBytes: 0,
            totalBytes: 0,
            status: 'downloading',
          });
        }
      } catch (err) {
        console.error('Failed to fetch model status:', err);
        setModelStatus({ installed: false, downloading: false, error: 'Failed to check model status' });
      } finally {
        setIsLoading(false);
      }
    };
    fetchStatus();
  }, [modelId]); // eslint-disable-line react-hooks/exhaustive-deps -- intentional: omitting ipcArgs because it is recreated from modelId and would refetch every render

  // Listen for download progress updates (filter by modelId)
  useEffect(() => {
    const cleanup = window.api?.onLocalSttModelProgress?.((progress: DownloadProgress & { modelId?: string }) => {
      // Filter progress events: only handle events for our model
      // If modelId is not set on the event (legacy), assume parakeet-v3
      const eventModelId = progress.modelId ?? 'parakeet-v3';
      const ourModelId = modelId ?? 'parakeet-v3';
      if (eventModelId !== ourModelId) return;

      setDownloadProgress(progress);

      if (progress.status === 'complete') {
        // Refresh status after download completes
        window.localSttApi.modelStatus(ipcArgs).then(setModelStatus);
        setDownloadProgress(null);
      } else if (progress.status === 'error' || progress.status === 'cancelled') {
        // Clear progress on error/cancel
        setTimeout(() => setDownloadProgress(null), 3000);
      }
    });

    return cleanup;
  }, [modelId]); // eslint-disable-line react-hooks/exhaustive-deps -- intentional: omitting ipcArgs because the progress subscription should change only when modelId changes

  const handleDownload = useCallback(async () => {
    try {
      const result = await window.localSttApi.modelDownload(ipcArgs);
      if (!result.started && result.error) {
        setDownloadProgress({
          progress: 0,
          downloadedBytes: 0,
          totalBytes: 0,
          status: 'error',
          error: result.error,
        });
      }
    } catch (err: unknown) {
      setDownloadProgress({
        progress: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        status: 'error',
        error: err instanceof Error ? err.message : 'Download failed',
      });
    }
  }, [modelId]); // eslint-disable-line react-hooks/exhaustive-deps -- intentional: omitting ipcArgs because the download request args are derived from modelId

  const handleCancelDownload = useCallback(async () => {
    try {
      await window.localSttApi.modelCancelDownload(ipcArgs);
    } catch (err) {
      console.error('Failed to cancel download:', err);
    }
  }, [modelId]); // eslint-disable-line react-hooks/exhaustive-deps -- intentional: omitting ipcArgs because the cancel request args are derived from modelId

  const handleRemove = useCallback(async () => {
    try {
      const result = await window.localSttApi.modelRemove(ipcArgs);
      if (result.success) {
        setModelStatus({ installed: false, downloading: false });
      } else {
        console.error('Failed to remove model:', result.error);
      }
    } catch (err) {
      console.error('Failed to remove model:', err);
    }
    setShowRemoveConfirm(false);
  }, [modelId]); // eslint-disable-line react-hooks/exhaustive-deps -- intentional: omitting ipcArgs because the remove request args are derived from modelId

  const handleRevealInFinder = useCallback(() => {
    if (modelStatus?.path) {
      window.api.revealPath(modelStatus.path);
    }
  }, [modelStatus?.path]);

  const isMoonshine = modelId === 'moonshine-base';
  const defaultSize = isMoonshine ? '260 MB' : '461 MB';
  const modelSizeLabel = modelStatus?.sizeBytes ? formatBytes(modelStatus.sizeBytes) : defaultSize;
  const modelDisplayName = isMoonshine ? 'Moonshine Base' : 'Parakeet V3';

  const compactLabel = customTitle ?? 'Voice-to-text';
  const compactDesc = customSubtitle ?? 'Runs on your device. Audio stays private.';

  const compactCardStyle = {
    padding: '12px 14px',
    backgroundColor: 'var(--color-bg-secondary)',
    borderRadius: '10px',
    border: '1px solid rgba(148, 163, 184, 0.22)',
  };

  const compactTitleStyle = {
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--color-foreground)',
  };

  const compactSubtitleStyle = {
    margin: '2px 0 0',
    fontSize: '12px',
    color: 'var(--color-text-secondary)',
    lineHeight: 1.45,
  };

  const compactMetaStyle = {
    margin: '6px 0 0',
    fontSize: '11px',
    color: 'var(--color-text-tertiary)',
    lineHeight: 1.4,
  };

  const compactSecondaryActionsStyle = {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap' as const,
    marginTop: '4px',
  };

  const renderCompactInstalled = () => (
    <div style={{ ...compactCardStyle, border: '1px solid rgba(34, 197, 94, 0.45)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <div style={compactTitleStyle}>{compactLabel}</div>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 8px',
            borderRadius: '999px',
            background: 'rgba(34, 197, 94, 0.12)',
            color: 'var(--color-success)',
            fontSize: '11px',
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          <Check size={12} />
          Installed
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', marginTop: '2px' }}>
        <p style={{ ...compactSubtitleStyle, margin: 0, flex: '1 1 auto' }}>
          {compactDesc}
        </p>
        {showRemoveConfirm ? (
          <div style={compactSecondaryActionsStyle}>
            <Button variant="ghost" size="xs" onClick={() => setShowRemoveConfirm(false)}>
              Cancel
            </Button>
            <Button variant="ghost" size="xs" onClick={handleRemove} style={{ color: 'var(--color-error)' }}>
              Delete
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setShowRemoveConfirm(true)}
            aria-label="Delete local transcription model"
            title="Delete local transcription model"
            style={{ marginTop: '-6px', marginRight: '-6px' }}
          >
            <Trash2 size={14} />
          </Button>
        )}
      </div>
    </div>
  );

  const renderCompactDownloading = (progress: DownloadProgress) => {
    const isError = progress.status === 'error';
    const isCancelled = progress.status === 'cancelled';
    const isExtracting = progress.status === 'extracting';

    return (
      <div style={{ ...compactCardStyle, border: isError ? '1px solid var(--color-error)' : compactCardStyle.border }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <div style={compactTitleStyle}>{compactLabel}</div>
          {isError || isCancelled ? (
            <Button size="xs" onClick={handleDownload}>
              Try again
            </Button>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              <span style={{ fontSize: '11px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                {isExtracting ? 'Extracting' : `${progress.progress}%`}
              </span>
              <Button variant="ghost" size="xs" onClick={handleCancelDownload}>
                Cancel
              </Button>
            </div>
          )}
        </div>
        <p style={compactSubtitleStyle}>{compactDesc}</p>
        {isError ? (
          <p style={{ ...compactMetaStyle, color: 'var(--color-error)' }}>
            {progress.error ?? 'Download failed'}
          </p>
        ) : isCancelled ? (
          <p style={compactMetaStyle}>Download cancelled.</p>
        ) : (
          <p style={compactMetaStyle}>
            {isExtracting
              ? 'Preparing the model for use.'
              : `${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)} downloaded`}
          </p>
        )}
      </div>
    );
  };

  const renderCompactNotInstalled = () => (
    <div style={compactCardStyle}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '20px',
        }}
      >
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div style={compactTitleStyle}>{compactLabel}</div>
          <p style={{ ...compactSubtitleStyle, margin: 0, marginTop: '2px' }}>
            {compactDesc}
          </p>
        </div>
        <Button
          size="xs"
          onClick={handleDownload}
          style={{ gap: '10px', flexShrink: 0 }}
        >
          <Download size={13} style={{ flexShrink: 0 }} />
          <span>Download</span>
          <span style={{ fontSize: '10px', fontWeight: 500, opacity: 0.88 }}>{modelSizeLabel}</span>
        </Button>
      </div>
      {modelStatus?.error && <p style={{ ...compactMetaStyle, color: 'var(--color-error)' }}>{modelStatus.error}</p>}
    </div>
  );

  if (isLoading) {
    if (isBadge) {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--color-muted-foreground)' }}>
          <Loader2 size={13} className="animate-spin" />
          Checking…
        </span>
      );
    }
    if (isCompact) {
      return (
        <div style={compactCardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-text-secondary)' }}>
            <Loader2 size={14} className="animate-spin" />
            <span style={{ fontSize: '12px' }}>Checking local transcription...</span>
          </div>
        </div>
      );
    }

    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px', color: 'var(--color-text-tertiary)' }}>
        <Loader2 size={16} className="animate-spin" />
        <span style={{ fontSize: '13px' }}>Checking model status...</span>
      </div>
    );
  }

  // Download in progress
  if (downloadProgress && downloadProgress.status !== 'complete') {
    const isError = downloadProgress.status === 'error';
    const isCancelled = downloadProgress.status === 'cancelled';

    if (isBadge) {
      if (isError || isCancelled) {
        return (
          <Button size="xs" onClick={handleDownload}>Try again</Button>
        );
      }
      const isExtracting = downloadProgress.status === 'extracting';
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--color-muted-foreground)' }}>
          <Loader2 size={13} className="animate-spin" />
          {isExtracting ? 'Setting up…' : `${downloadProgress.progress}%`}
        </span>
      );
    }

    if (isCompact) {
      return renderCompactDownloading(downloadProgress);
    }

    return (
      <div style={{
        padding: '16px',
        backgroundColor: 'var(--color-bg-secondary)',
        borderRadius: '8px',
        border: isError ? '1px solid var(--color-error)' : '1px solid var(--color-border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isError || isCancelled ? (
              <AlertCircle size={16} style={{ color: 'var(--color-error)' }} />
            ) : (
              <Loader2 size={16} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
            )}
            <span style={{ fontSize: '13px', fontWeight: 500 }}>
              {isError ? 'Download failed' : isCancelled ? 'Download cancelled' : 
                downloadProgress.status === 'extracting' ? 'Extracting...' : 'Downloading model...'}
            </span>
          </div>
          {!isError && !isCancelled && (
            <Button variant="ghost" size="sm" onClick={handleCancelDownload}>
              Cancel
            </Button>
          )}
        </div>

        {isError && downloadProgress.error && (
          <p style={{ fontSize: '12px', color: 'var(--color-error)', marginBottom: '12px' }}>
            {downloadProgress.error}
          </p>
        )}

        {!isError && !isCancelled && (
          <>
            <div style={{
              width: '100%',
              height: '6px',
              backgroundColor: 'var(--color-bg-tertiary)',
              borderRadius: '3px',
              overflow: 'hidden',
            }}>
              <div style={{
                width: `${downloadProgress.progress}%`,
                height: '100%',
                backgroundColor: 'var(--color-primary)',
                transition: 'width 0.3s ease',
              }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', fontSize: '12px', color: 'var(--color-text-tertiary)' }}>
              <span>{downloadProgress.progress}%</span>
              <span>{formatBytes(downloadProgress.downloadedBytes)} / {formatBytes(downloadProgress.totalBytes)}</span>
            </div>
          </>
        )}

        {(isError || isCancelled) && (
          <Button size="sm" onClick={handleDownload} style={{ marginTop: '8px' }}>
            Try Again
          </Button>
        )}
      </div>
    );
  }

  // Model installed
  if (modelStatus?.installed) {
    if (isBadge) {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', fontWeight: 500, color: 'var(--color-success)' }}>
          <Check size={13} />
          Ready
        </span>
      );
    }
    if (isCompact) {
      return renderCompactInstalled();
    }

    return (
      <div style={{
        padding: '16px',
        backgroundColor: 'var(--color-bg-secondary)',
        borderRadius: '8px',
        border: '1px solid var(--color-success)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <Check size={16} style={{ color: 'var(--color-success)' }} />
          <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--color-success)' }}>
            Model installed
          </span>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '12px' }}>
          Local transcription is ready. Your voice never leaves your computer.
        </p>

        {modelStatus.sizeBytes && (
          <p style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginBottom: '4px' }}>
            Size: {formatBytes(modelStatus.sizeBytes)}
          </p>
        )}

        {modelStatus.path && (
          <p style={{ 
            fontSize: '11px', 
            color: 'var(--color-text-tertiary)', 
            marginBottom: '12px',
            wordBreak: 'break-all',
            fontFamily: 'monospace'
          }}>
            {modelStatus.path}
          </p>
        )}

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {modelStatus.path && (
            <Button variant="ghost" size="sm" onClick={handleRevealInFinder}>
              <FolderOpen size={14} style={{ marginRight: '4px' }} />
              Show in Finder
            </Button>
          )}

          {showRemoveConfirm ? (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>Remove model?</span>
              <Button variant="ghost" size="sm" onClick={() => setShowRemoveConfirm(false)}>
                Cancel
              </Button>
              <Button variant="ghost" size="sm" onClick={handleRemove} style={{ color: 'var(--color-error)' }}>
                Remove
              </Button>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setShowRemoveConfirm(true)}>
              <Trash2 size={14} style={{ marginRight: '4px' }} />
              Remove Model
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Model not installed
  if (isBadge) {
    return (
      <Button size="xs" onClick={handleDownload} style={{ gap: '8px' }}>
        <Download size={13} style={{ flexShrink: 0 }} />
        <span>Download</span>
        <span style={{ fontSize: '10px', fontWeight: 500, opacity: 0.88 }}>{modelSizeLabel}</span>
      </Button>
    );
  }
  if (isCompact) {
    return renderCompactNotInstalled();
  }

  return (
    <div style={{
      padding: '16px',
      backgroundColor: 'var(--color-bg-secondary)',
      borderRadius: '8px',
      border: '1px solid var(--color-border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <Download size={16} style={{ color: 'var(--color-text-secondary)' }} />
        <span style={{ fontSize: '13px', fontWeight: 500 }}>
          Model not installed
        </span>
      </div>

      <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '12px' }}>
        Download the {modelDisplayName} model (~{defaultSize}) to enable local transcription.
        This is a one-time download.
      </p>

      {modelStatus?.error && (
        <p style={{ fontSize: '12px', color: 'var(--color-error)', marginBottom: '12px' }}>
          {modelStatus.error}
        </p>
      )}

      <Button size="xs" onClick={handleDownload} style={{ gap: '10px' }}>
        <Download size={13} style={{ flexShrink: 0 }} />
        <span>Download</span>
        <span style={{ fontSize: '10px', fontWeight: 500, opacity: 0.88 }}>{modelSizeLabel}</span>
      </Button>
    </div>
  );
};
