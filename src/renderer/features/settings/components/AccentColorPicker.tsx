import { ACCENT_PALETTE, type AccentColorId } from '@renderer/utils/accentPalette';
import styles from './AccentColorPicker.module.css';

const ACCENT_IDS = Object.keys(ACCENT_PALETTE) as AccentColorId[];

type AccentColorPickerProps = {
  value: AccentColorId | undefined;
  onChange: (color: AccentColorId) => void;
};

export const AccentColorPicker = ({ value, onChange }: AccentColorPickerProps) => {
  const selected = value ?? 'purple';

  return (
    <div className={styles.swatchRow} role="radiogroup" aria-label="Accent color">
      {ACCENT_IDS.map((id) => {
        const entry = ACCENT_PALETTE[id];
        const isSelected = id === selected;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={entry.label}
            title={entry.label}
            className={`${styles.swatch} ${isSelected ? styles.swatchSelected : ''}`}
            style={{ backgroundColor: entry.swatch }}
            onClick={() => onChange(id)}
          />
        );
      })}
    </div>
  );
};
