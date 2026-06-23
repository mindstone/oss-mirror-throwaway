import { useState, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  Button,
  Select,
  Input,
} from '@renderer/components/ui';

export type ExpiryOption = '7d' | '24h' | '30d' | 'never';

const EXPIRY_LABELS: Record<ExpiryOption, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  never: 'No expiry',
};

const DESCRIPTION: Record<'conversation' | 'file', string> = {
  conversation: 'Anyone with the link can read this conversation.',
  file: 'Anyone with the link can access this file. Moving or renaming the file will break the link.',
};

export interface ShareDialogResult {
  sessionId?: string;
  filePath?: string;
  expiresIn: ExpiryOption;
  password?: string;
}

interface ShareConversationDialogProps {
  /** Sharing mode — determines dialog copy and which identifier is passed to onShare. Defaults to 'conversation'. */
  mode?: 'conversation' | 'file';
  /** Session ID — required when mode is 'conversation'. */
  sessionId?: string;
  /** Workspace-relative file path — required when mode is 'file'. */
  filePath?: string;
  onShare: (opts: ShareDialogResult) => void;
  onCancel: () => void;
}

export function ShareConversationDialog({ mode = 'conversation', sessionId, filePath, onShare, onCancel }: ShareConversationDialogProps) {
  const [expiresIn, setExpiresIn] = useState<ExpiryOption>('7d');
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');

  const handleShare = useCallback(() => {
    const pw = usePassword && password.length > 0 ? password : undefined;
    if (mode === 'file') {
      onShare({ filePath, expiresIn, password: pw });
    } else {
      onShare({ sessionId, expiresIn, password: pw });
    }
  }, [mode, sessionId, filePath, expiresIn, usePassword, password, onShare]);

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent size="sm">
        <DialogHeader icon="🔗">
          <DialogTitle>Share publicly</DialogTitle>
          <DialogDescription>
            {DESCRIPTION[mode]}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label>
              <span style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 500 }}>Link expires after</span>
              <Select value={expiresIn} onChange={(e) => setExpiresIn(e.target.value as ExpiryOption)}>
                {(Object.entries(EXPIRY_LABELS) as [ExpiryOption, string][]).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </Select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={usePassword}
                onChange={(e) => setUsePassword(e.target.checked)}
              />
              Require a password
            </label>
            {usePassword && (
              <Input
                type="password"
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                maxLength={128}
                autoFocus
              />
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button
            variant="default"
            onClick={handleShare}
            disabled={usePassword && password.length === 0}
          >
            Share &amp; copy link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
