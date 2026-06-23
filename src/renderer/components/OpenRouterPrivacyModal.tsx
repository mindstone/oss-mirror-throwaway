import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@renderer/components/ui/Dialog';
import { Button } from '@renderer/components/ui';

const OPENROUTER_PRIVACY_URL = 'https://openrouter.ai/privacy';

interface OpenRouterPrivacyModalProps {
  open: boolean;
  onAccept: () => void;
  onCancel: () => void;
}

export function OpenRouterPrivacyModal({ open, onAccept, onCancel }: OpenRouterPrivacyModalProps) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect to OpenRouter</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p style={{ margin: '0 0 12px', lineHeight: 1.5 }}>
            OpenRouter routes your requests to AI providers (Anthropic, Google, OpenAI, and others).
            Your conversations pass through OpenRouter's servers to reach the selected model.
          </p>
          <p style={{ margin: '0 0 12px', lineHeight: 1.5 }}>
            OpenRouter enforces a zero data retention (ZDR) policy on supported providers, meaning
            your data is not stored for training or other purposes beyond completing the request.
          </p>
          <p style={{ margin: 0, lineHeight: 1.5 }}>
            By connecting, you agree to OpenRouter's{' '}
            <a
              href={OPENROUTER_PRIVACY_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: 'underline' }}
            >
              privacy policy
            </a>.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="default" onClick={onAccept}>
            Accept &amp; Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
