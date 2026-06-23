import { useEffect, useMemo, useState } from 'react';
import { Button } from '@renderer/components/ui';
import { acceleratorFromEvent, formatAcceleratorDisplay } from '@renderer/utils/acceleratorUtils';

type ShortcutRecorderProps = {
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
};

export const ShortcutRecorder = ({ value, onChange, placeholder = 'Ctrl+Alt+Space' }: ShortcutRecorderProps) => {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(false);
        setError(null);
        return;
      }

      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) {
        setError('Use a modifier (⌘, Ctrl, Alt, or Shift) plus a key.');
        return;
      }

      setRecording(false);
      setError(null);
      onChange(accelerator);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [recording, onChange]);

  const displayValue = useMemo(() => {
    const formatted = formatAcceleratorDisplay(value);
    if (formatted) {
      return formatted;
    }
    if (value === null) {
      return 'Disabled';
    }
    return formatAcceleratorDisplay(placeholder) || placeholder;
  }, [placeholder, value]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap'
        }}
      >
        <div
          style={{
            minWidth: '160px',
            padding: '8px 12px',
            border: '1px solid #cbd5f5',
            borderRadius: '8px',
            background: recording ? '#eef2ff' : '#f8fafc',
            fontWeight: 600,
            fontSize: '13px',
            color: recording ? '#1d4ed8' : '#0f172a'
          }}
        >
          {recording ? 'Press your shortcut…' : displayValue}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <Button
            variant="ghost"
            onClick={() => {
              setRecording((current) => !current);
              setError(null);
            }}
          >
            {recording ? 'Cancel' : 'Record new shortcut'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setRecording(false);
              setError(null);
              onChange(null);
            }}
            disabled={value === null}
            style={{ opacity: value === null ? 0.6 : 1 }}
          >
            Clear
          </Button>
        </div>
      </div>
      {error ? (
        <p style={{ fontSize: '12px', color: '#b91c1c' }}>{error}</p>
      ) : (
        <p style={{ fontSize: '12px', color: '#6b7280' }}>
          Avoid Spotlight (⌘ Space) and Input Source shortcuts. Update macOS shortcuts via System Settings → Keyboard →
          Keyboard Shortcuts if a combination is unavailable.
        </p>
      )}
    </div>
  );
};
