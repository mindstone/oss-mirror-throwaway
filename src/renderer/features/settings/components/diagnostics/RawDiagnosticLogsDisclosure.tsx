import { useCallback, useId, useState } from 'react';
import { ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { Button } from '@renderer/components/ui';

export interface RawDiagnosticLogsDisclosureProps {
  markdown: string;
}

export function RawDiagnosticLogsDisclosure({ markdown }: RawDiagnosticLogsDisclosureProps) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(markdown);
    } catch (err) {
      console.warn('Failed to copy raw diagnostic event log', { err });
    }
  }, [markdown]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
        style={{ alignSelf: 'flex-start' }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {expanded ? 'Hide raw event log' : 'Show raw event log'}
      </Button>
      {expanded ? (
        <div
          id={panelId}
          style={{
            position: 'relative',
            border: '1px solid var(--color-border-soft)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-background-subtle)',
            padding: 12,
          }}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleCopy()}
            style={{ position: 'absolute', top: 8, right: 8 }}
          >
            <Copy size={14} />
            Copy
          </Button>
          <pre
            style={{
              margin: 0,
              maxHeight: 320,
              overflow: 'auto',
              paddingRight: 78,
              fontFamily: 'var(--font-family-mono)',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
            }}
          >
            <code>{markdown}</code>
          </pre>
        </div>
      ) : null}
    </div>
  );
}
