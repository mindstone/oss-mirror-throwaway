import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Notice, Select } from '@renderer/components/ui';
import type { ThemePreference } from '@shared/types';
import type { AccentColorId } from '@renderer/utils/accentPalette';
import { tracking } from '@renderer/src/tracking';
import styles from '../SettingsSurface.module.css';
import { SettingRow } from '../SettingRow';
import { SettingSection } from '../SettingSection';
import { AccentColorPicker } from '../AccentColorPicker';
import type { SystemTabProps } from '../tabs/types';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * Self-contained toggle for community events visibility.
 * State lives in the community events store (via IPC), not AppSettings.
 */
function CommunityEventsSettingSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [toggling, setToggling] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  // Read current suppression state on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchState() {
      try {
        const data = await window.communityEventsApi.getCardData({});
        if (!cancelled) {
          setEnabled(data.type !== 'suppressed');
        }
      } catch {
        // If fetch fails, default to enabled (non-suppressed)
        if (!cancelled) setEnabled(true);
      }
    }
    void fetchState();
    return () => { cancelled = true; };
  }, []);

  const handleToggle = useCallback(async () => {
    if (toggling || enabled === null) return;
    const newEnabled = !enabled;
    setToggling(true);
    try {
      await window.communityEventsApi.suppress({ suppress: !newEnabled });
      if (mountedRef.current) {
        setEnabled(newEnabled);
        if (newEnabled) {
          tracking.spark.communityEvent.unsuppressed();
        } else {
          tracking.spark.communityEvent.suppressed();
        }
      }
    } catch {
      // Non-critical — toggle failed silently
    } finally {
      if (mountedRef.current) setToggling(false);
    }
  }, [toggling, enabled]);

  // Don't render until we know the current state
  if (enabled === null) return null;

  return (
    <SettingSection
      title="Suggestions"
      description="Control what Rebel suggests based on your location and activity."
      data-section="suggestions"
      data-testid="settings-section-suggestions"
    >
      <SettingRow
        label="Community events near you"
        description="Show upcoming Mindstone AI meetups when you're near one."
        tooltip="When enabled, Rebel checks if there's a community event within 50km and shows a card in The Spark. Uses IP geolocation — no system permissions required."
        htmlFor="community-events-toggle"
      >
        <input
          id="community-events-toggle"
          data-testid="settings-community-events-toggle"
          type="checkbox"
          checked={enabled}
          disabled={toggling}
          onChange={handleToggle}
        />
      </SettingRow>
      <CommunityVideoRecsSettingSection />
    </SettingSection>
  );
}

/**
 * Self-contained toggle for community video recommendations visibility.
 * State lives in the community video recs store (via IPC), not AppSettings.
 */
function CommunityVideoRecsSettingSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [toggling, setToggling] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  // Read current suppression state on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchState() {
      try {
        const data = await window.communityVideoRecsApi.getCardData({});
        if (!cancelled) {
          setEnabled(data.type !== 'suppressed');
        }
      } catch {
        // If fetch fails, default to enabled (non-suppressed)
        if (!cancelled) setEnabled(true);
      }
    }
    void fetchState();
    return () => { cancelled = true; };
  }, []);

  const handleToggle = useCallback(async () => {
    if (toggling || enabled === null) return;
    const newEnabled = !enabled;
    setToggling(true);
    try {
      await window.communityVideoRecsApi.suppress({ suppress: !newEnabled });
      if (mountedRef.current) {
        setEnabled(newEnabled);
        if (newEnabled) {
          tracking.spark.communityVideoRecs.unsuppressed();
        } else {
          tracking.spark.communityVideoRecs.suppressed();
        }
      }
    } catch {
      // Non-critical — toggle failed silently
    } finally {
      if (mountedRef.current) setToggling(false);
    }
  }, [toggling, enabled]);

  // Don't render until we know the current state
  if (enabled === null) return null;

  return (
    <SettingRow
      label="Community video picks"
      description="Show personalized video recommendations from community meetups in The Spark."
      htmlFor="community-video-recs-toggle"
    >
      <input
        id="community-video-recs-toggle"
        data-testid="settings-community-video-recs-toggle"
        type="checkbox"
        checked={enabled}
        disabled={toggling}
        onChange={handleToggle}
      />
    </SettingRow>
  );
}

/**
 * Appearance + notification blocks from System settings for Account & Preferences composition.
 */
export const SystemAccountPreferencesSections = ({
  draftSettings,
  updateDraft,
}: Pick<SystemTabProps, 'draftSettings' | 'updateDraft'>) => (
  <>
    <SettingSection title="Appearance" description="Customize the look and feel of the app." data-section="appearance">
      <SettingRow label="Theme" tooltip="Choose whether Rebel follows your system appearance or always uses light or dark mode." htmlFor="theme-select">
        <Select
          id="theme-select"
          data-testid="settings-theme-select"
          value={draftSettings.theme ?? 'system'}
          onChange={(e) => updateDraft('theme', e.target.value as ThemePreference)}
        >
          {THEME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </SettingRow>

      <SettingRow label="Accent color" htmlFor="accent-color">
        <AccentColorPicker value={draftSettings.accentColor as AccentColorId | undefined} onChange={(color) => updateDraft('accentColor', color)} />
      </SettingRow>

      <SettingRow label="Font size" tooltip="Adjust text size across the app for readability." htmlFor="font-scale-select">
        <Select
          id="font-scale-select"
          data-testid="settings-font-scale-select"
          value={draftSettings.fontScale ?? 'default'}
          onChange={(e) => updateDraft('fontScale', e.target.value as 'small' | 'default' | 'large')}
        >
          <option value="small">Small</option>
          <option value="default">Default</option>
          <option value="large">Large</option>
        </Select>
      </SettingRow>

      <SettingRow label="UI density" description="More content or more breathing room." htmlFor="ui-density-select">
        <Select
          id="ui-density-select"
          data-testid="settings-ui-density-select"
          value={draftSettings.uiDensity ?? 'comfortable'}
          onChange={(e) => updateDraft('uiDensity', e.target.value as 'compact' | 'comfortable' | 'spacious')}
        >
          <option value="compact">Compact</option>
          <option value="comfortable">Comfortable</option>
          <option value="spacious">Spacious</option>
        </Select>
      </SettingRow>

      <SettingRow
        label="Conversation width"
        tooltip="Controls how wide conversation content appears in the main workspace."
        htmlFor="conversation-width-select"
      >
        <Select
          id="conversation-width-select"
          data-testid="settings-conversation-width-select"
          value={draftSettings.conversationWidth ?? 'medium'}
          onChange={(e) => updateDraft('conversationWidth', e.target.value as 'narrow' | 'medium' | 'wide')}
        >
          <option value="narrow">Narrow</option>
          <option value="medium">Medium</option>
          <option value="wide">Wide</option>
        </Select>
      </SettingRow>

      {(draftSettings.accentColor || draftSettings.fontScale || draftSettings.uiDensity || draftSettings.conversationWidth) && (
        <SettingRow label="" htmlFor="reset-appearance">
          <Button
            id="reset-appearance"
            variant="ghost"
            data-testid="settings-reset-appearance"
            onClick={() => {
              updateDraft('accentColor', undefined);
              updateDraft('fontScale', undefined);
              updateDraft('uiDensity', undefined);
              updateDraft('conversationWidth', undefined);
            }}
          >
            Back to defaults
          </Button>
        </SettingRow>
      )}

      <SettingRow
        label="Estimate time saved after conversations"
        description={
          draftSettings.efficiencyMode === 'on'
            ? 'Managed by Efficiency Mode'
            : undefined
        }
        tooltip="After each conversation, Rebel estimates how long the task would have taken manually. Weekly totals appear in the header."
        htmlFor="time-saved"
      >
        <input
          id="time-saved"
          data-testid="settings-time-saved-toggle"
          type="checkbox"
          checked={draftSettings.timeSavedEstimation?.enabled !== false}
          disabled={draftSettings.efficiencyMode === 'on'}
          onChange={(event) => updateDraft('timeSavedEstimation', { enabled: event.target.checked })}
        />
      </SettingRow>

      <SettingRow
        label="Stream responses as they generate"
        tooltip="Show text progressively as Rebel thinks, rather than waiting for complete responses. Disable if you experience performance issues."
        htmlFor="streaming"
      >
        <input
          id="streaming"
          data-testid="settings-streaming-toggle"
          type="checkbox"
          checked={draftSettings.streaming?.enabled !== false}
          onChange={(event) => updateDraft('streaming', { enabled: event.target.checked })}
        />
      </SettingRow>
    </SettingSection>

    <SettingSection
      title="Desktop Notifications"
      description="Rebel can send native system notifications when work finishes in the background — so you don't have to keep checking."
      data-section="notifications"
    >
      <SettingRow
        label="Enable desktop notifications"
        tooltip="Master switch for all Rebel desktop notifications. When off, Rebel will only show a badge on the dock/taskbar icon."
        htmlFor="notification-enabled"
      >
        <label className={styles.toggle}>
          <input
            id="notification-enabled"
            data-testid="settings-notification-enabled-toggle"
            type="checkbox"
            checked={draftSettings.notifications?.enabled === true}
            onChange={(event) => updateDraft('notifications', { ...draftSettings.notifications, enabled: event.target.checked })}
          />
          <span className={styles.toggleSlider} />
        </label>
      </SettingRow>

      {draftSettings.notifications?.enabled === true && (
        <>
          <SettingRow
            label="Automations"
            tooltip="Get notified when a scheduled or triggered automation finishes running."
            htmlFor="notification-automation"
          >
            <label className={styles.toggle}>
              <input
                id="notification-automation"
                data-testid="settings-notification-automation-toggle"
                type="checkbox"
                checked={draftSettings.notifications?.automationComplete !== false}
                onChange={(event) =>
                  updateDraft('notifications', { ...draftSettings.notifications, automationComplete: event.target.checked })
                }
              />
              <span className={styles.toggleSlider} />
            </label>
          </SettingRow>

          <SettingRow
            label="Conversations"
            tooltip="Get notified when a conversation finishes while you're in another app or viewing a different screen."
            htmlFor="notification-conversation"
          >
            <label className={styles.toggle}>
              <input
                id="notification-conversation"
                data-testid="settings-notification-conversation-toggle"
                type="checkbox"
                checked={draftSettings.notifications?.conversationComplete !== false}
                onChange={(event) =>
                  updateDraft('notifications', { ...draftSettings.notifications, conversationComplete: event.target.checked })
                }
              />
              <span className={styles.toggleSlider} />
            </label>
          </SettingRow>

          <SettingRow
            label="Role check-in complete"
            tooltip="Get notified when a Role finishes a scheduled check-in with substantive work to review."
            htmlFor="notification-role"
          >
            <label className={styles.toggle}>
              <input
                id="notification-role"
                data-testid="settings-notification-role-toggle"
                type="checkbox"
                checked={draftSettings.notifications?.roleComplete !== false}
                onChange={(event) =>
                  updateDraft('notifications', { ...draftSettings.notifications, roleComplete: event.target.checked })
                }
              />
              <span className={styles.toggleSlider} />
            </label>
          </SettingRow>

          <Notice
            tone="info"
            placement="inline"
            actions={[
              {
                label: 'Open settings',
                onClick: () => {
                  void window.permissionsApi.openSystemPreferences('notifications');
                },
              },
            ]}
          >
            Notifications also need to be allowed in your system settings.
          </Notice>
        </>
      )}
    </SettingSection>

    <CommunityEventsSettingSection />
  </>
);
