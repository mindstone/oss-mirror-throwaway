import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@renderer/components/ui';

interface PluginSourceViewerProps {
  pluginName: string;
  source: string;
  open: boolean;
  onClose: () => void;
}

export const PluginSourceViewer: React.FC<PluginSourceViewerProps> = ({
  pluginName,
  source,
  open,
  onClose,
}) => {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader onClose={onClose}>
          <DialogTitle>{pluginName} — Source</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <pre
            style={{
              maxHeight: '60vh',
              overflow: 'auto',
              fontSize: '0.75rem',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              backgroundColor: 'var(--color-bg-secondary, #f5f5f5)',
              padding: '1rem',
              borderRadius: '0.5rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
            }}
          >
            <code>{source}</code>
          </pre>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
