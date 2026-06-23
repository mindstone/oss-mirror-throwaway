/**
 * SafetyPromptEditor
 *
 * Settings component for viewing, editing, saving, reverting, and resetting
 * the user's Safety Prompt (principles document). Replaces the old tool safety
 * level radio cards and "Custom rules & trusted tools" textarea.
 *
 * Uses the generated `window.safetyPromptApi` domain API.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Button,
  Textarea,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  Spinner,
} from '@renderer/components/ui';
import {
  RotateCcw,
  Save,
  Edit2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { DEFAULT_SAFETY_PROMPT } from '@shared/safetyPromptDefaults';
import styles from './SettingsSurface.module.css';

/** Shape returned by safetyPromptApi.get() / update() / revert() */
interface SafetyPromptResponse {
  prompt: string;
  version: number;
  lastUpdatedAt: number;
  lastUpdatedBy: 'user' | 'system' | 'migration';
  history: SafetyPromptHistoryEntry[];
  migrationComplete: boolean;
}

interface SafetyPromptHistoryEntry {
  prompt: string;
  version: number;
  updatedAt: number;
  updatedBy: 'user' | 'system' | 'migration';
}

/** Format a timestamp to a human-readable relative or absolute date */
function formatTimestamp(epochMs: number): string {
  if (!epochMs) return 'Never';
  const date = new Date(epochMs);
  const now = Date.now();
  const diffMs = now - epochMs;
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Display name for the updatedBy field */
function formatUpdatedBy(updatedBy: string): string {
  switch (updatedBy) {
    case 'user': return 'You';
    case 'system': return 'System';
    case 'migration': return 'Migrated from previous settings';
    default: return updatedBy;
  }
}

export const SafetyPromptEditor: React.FC = () => {
  const [data, setData] = useState<SafetyPromptResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Fetch safety prompt data
  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const result = await window.safetyPromptApi.get();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load safety prompt');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Subscribe to cross-surface safety-prompt invalidation (F-R2-7).
  // When any surface writes the safety prompt, refetch so the editor
  // stays in sync without manual refresh.
  useEffect(() => {
    const unsub = window.safetyPromptSubscriptions.onSafetyPromptUpdated(() => {
      fetchData();
    });
    return unsub;
  }, [fetchData]);

  // Poll for migration completion when migration is in progress
  useEffect(() => {
    if (!data || data.migrationComplete) return;
    const interval = setInterval(fetchData, 2_000);
    return () => clearInterval(interval);
  }, [data, fetchData]);

  // Enter edit mode
  const handleEdit = useCallback(() => {
    if (data) {
      setDraft(data.prompt);
      setEditing(true);
    }
  }, [data]);

  // Cancel editing
  const handleCancel = useCallback(() => {
    setEditing(false);
    setDraft('');
  }, []);

  // Save changes
  const handleSave = useCallback(async () => {
    if (!draft.trim()) return;
    setSaving(true);
    try {
      const result = await window.safetyPromptApi.update({ prompt: draft, updatedBy: 'user' });
      setData(result);
      setEditing(false);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save safety prompt');
    } finally {
      setSaving(false);
    }
  }, [draft]);

  // Revert to a specific version
  const handleRevert = useCallback(async (targetVersion: number) => {
    setReverting(true);
    try {
      const result = await window.safetyPromptApi.revert({ targetVersion });
      setData(result);
      setEditing(false);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revert');
    } finally {
      setReverting(false);
    }
  }, []);

  // Reset to defaults
  const handleReset = useCallback(async () => {
    setShowResetConfirm(false);
    setSaving(true);
    try {
      const result = await window.safetyPromptApi.reset();
      setData(result);
      setEditing(false);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset');
    } finally {
      setSaving(false);
    }
  }, []);

  // Loading state
  if (loading) {
    return (
      <div className={styles.advancedGroup}>
        <div className={styles.flexCenter}>
          <Spinner size="sm" />
          <span className={styles.groupDescription}>Loading safety prompt…</span>
        </div>
      </div>
    );
  }

  // Migration not complete
  if (data && !data.migrationComplete) {
    return (
      <div className={styles.advancedGroup}>
        <div className={styles.flexCenter}>
          <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
          <span className={styles.groupDescription}>
            Safety system initializing — your settings are being migrated…
          </span>
        </div>
      </div>
    );
  }

  // Error state (no data at all)
  if (error && !data) {
    return (
      <div className={styles.advancedGroup}>
        <div className={styles.flexCenter}>
          <AlertTriangle size={16} style={{ color: 'var(--color-destructive)' }} />
          <span className={styles.errorText}>{error}</span>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData}>
          Retry
        </Button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <>
      {/* Prompt Display / Editor */}
      <div className={styles.advancedGroup}>
        <div className={styles.flexBetween}>
          <label htmlFor="safety-prompt-editor">Your safety rules</label>
          {!editing && (
            <Button variant="ghost" size="sm" onClick={handleEdit}>
              <Edit2 size={14} />
              Edit
            </Button>
          )}
        </div>
        <p className={styles.groupDescription}>
          Rebel reads these before every action to decide whether to ask you first.
        </p>

        {error && (
          <div className={styles.flexCenter}>
            <AlertTriangle size={14} style={{ color: 'var(--color-destructive)' }} />
            <span className={styles.errorText}>{error}</span>
          </div>
        )}

        {!editing && data.prompt === DEFAULT_SAFETY_PROMPT && (
          <p className={styles.emptyState}>
            These are Rebel&apos;s defaults. Edit to teach Rebel your preferences, or leave as-is.
          </p>
        )}

        <Textarea
          id="safety-prompt-editor"
          value={editing ? draft : data.prompt}
          onChange={editing ? (e) => setDraft(e.target.value) : undefined}
          readOnly={!editing}
          rows={12}
          style={{
            fontFamily: editing ? 'var(--font-mono, monospace)' : 'inherit',
            fontSize: editing ? '0.85rem' : '0.9rem',
            lineHeight: '1.6',
            opacity: editing ? 1 : 0.85,
            resize: editing ? 'vertical' : 'none',
          }}
        />

        {/* Edit mode actions */}
        {editing && (
          <div className={styles.flexRow}>
            <Button
              variant="default"
              size="sm"
              onClick={handleSave}
              disabled={saving || !draft.trim()}
            >
              {saving ? <Spinner size="sm" /> : <Save size={14} />}
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        )}

        {/* Footer — metadata + actions */}
        {!editing && (
          <div className={styles.promptFooter}>
            {data.lastUpdatedAt > 0 && (
              <span className={styles.promptFooterCaption}>
                Updated {formatTimestamp(data.lastUpdatedAt)} by {formatUpdatedBy(data.lastUpdatedBy)} · v{data.version}
              </span>
            )}
            <div className={styles.promptFooterActions}>
              {data.history.length > 0 && (
                <Button
                  variant="ghost"
                  size="xxs"
                  onClick={() => setShowHistory((v) => !v)}
                  aria-expanded={showHistory}
                  aria-controls="safety-prompt-history"
                >
                  {showHistory ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  Version history ({data.history.length})
                </Button>
              )}
              <Button
                variant="ghost"
                size="xxs"
                onClick={() => setShowResetConfirm(true)}
              >
                <RotateCcw size={12} />
                Reset to defaults
              </Button>
            </div>
          </div>
        )}

        {/* Version history expansion */}
        {showHistory && data.history.length > 0 && (
          <div id="safety-prompt-history" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[...data.history].reverse().map((entry) => (
              <div
                key={entry.version}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--color-border-soft)',
                  background: 'var(--color-card, transparent)',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--color-text-primary)' }}>
                    Version {entry.version}
                  </span>
                  <span className={styles.groupDescription}>
                    {formatTimestamp(entry.updatedAt)} · {formatUpdatedBy(entry.updatedBy)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRevert(entry.version)}
                  disabled={reverting}
                >
                  {reverting ? <Spinner size="sm" /> : <RotateCcw size={14} />}
                  Revert
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Reset Confirmation Dialog */}
      <Dialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <AlertTriangle
                size={18}
                style={{ color: 'var(--color-warning, #f59e0b)', verticalAlign: 'middle', marginRight: '8px' }}
              />
              Reset Safety Rules?
            </DialogTitle>
            <DialogDescription>
              This will replace your current safety rules with the default principles.
              Your current rules will be saved in the version history, so you can revert if needed.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p style={{ fontSize: '0.85rem', color: 'var(--color-muted-foreground)' }}>
              The default rules include basic principles like confirming before sending external messages
              and never sharing credentials. Any custom rules you&apos;ve added will be removed.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowResetConfirm(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReset}>
              Reset to defaults
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
