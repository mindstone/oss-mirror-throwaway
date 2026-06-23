import styles from './SettingsSurface.module.css';
import type { SettingsOnPageAnchorConfig } from './settingsOnPageAnchorConfig';

type SettingsPageAnchorsProps = {
  anchors: readonly SettingsOnPageAnchorConfig[];
  activeAnchorId?: string;
  onSelectAnchor: (anchorId: string) => void;
};

export const SettingsPageAnchors = ({
  anchors,
  activeAnchorId,
  onSelectAnchor,
}: SettingsPageAnchorsProps) => {
  if (anchors.length === 0) {
    return null;
  }

  return (
    <nav className={styles.settingsAnchorStrip} data-settings-on-page-strip aria-label="On this page">
      {anchors.map((anchor) => {
        const isActive = anchor.anchorId === activeAnchorId;
        return (
          <button
            key={anchor.anchorId}
            type="button"
            onClick={() => onSelectAnchor(anchor.anchorId)}
            aria-pressed={isActive}
            className={`${styles.settingsAnchorLink} ${isActive ? styles.settingsAnchorLinkActive : ''}`}
          >
            {anchor.label}
          </button>
        );
      })}
    </nav>
  );
};
