import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
  ToastProvider,
  Tooltip,
  useToast,
} from '@renderer/components/ui';

const meta = {
  title: 'Design System/Mixed/Dialogs & Feedback',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'Shared feedback and overlay families. This page should help review what these components are for, where they are used, and where they should not be forced as substitutes for more specific patterns.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function DialogDemo() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button onClick={() => setOpen(true)}>Open dialog</Button>
        <Tooltip content="Keep tooltips short and specific.">
          <Button variant="ghost">Hover for tooltip</Button>
        </Tooltip>
        <Spinner label="Working" />
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md">
          <DialogHeader icon={<CheckCircle2 size={20} />} onClose={() => setOpen(false)}>
            <DialogTitle>Ready to publish?</DialogTitle>
            <DialogDescription>
              Preview modal spacing, hierarchy, and button emphasis without needing the full app flow.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
              This kind of isolated preview is useful for checking trust-sensitive confirmation states.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setOpen(false)}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ToastReviewHarness() {
  const { showToast, dismissToast } = useToast();
  const toastIdsRef = React.useRef<string[]>([]);

  const clearReviewToasts = React.useCallback(() => {
    toastIdsRef.current.forEach((id) => dismissToast(id));
    toastIdsRef.current = [];
  }, [dismissToast]);

  const showReviewToast = React.useCallback(
    (...args: Parameters<typeof showToast>[]) => {
      clearReviewToasts();
      toastIdsRef.current = args.map((toast) => showToast({ duration: 0, ...toast }));
    },
    [clearReviewToasts, showToast],
  );

  React.useEffect(() => clearReviewToasts, [clearReviewToasts]);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <p style={{ margin: 0, color: 'var(--color-text-secondary)', maxWidth: 720 }}>
        These buttons call the real app toast API: `ToastProvider` plus `useToast().showToast()`. The
        rendered cards appear in the top-right viewport because that is how Toast behaves in the app.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            showReviewToast(
              {
                title: 'Conversation archived',
                description: 'You can find it again from Library.',
                variant: 'default',
              },
              {
                title: 'Settings saved',
                description: 'Your meeting preferences are up to date.',
                variant: 'success',
              },
              {
                title: 'Sync started',
                description: "We'll let you know when it's done.",
                variant: 'info',
              },
            )
          }
        >
          Show neutral / success / info
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            showReviewToast(
              {
                title: 'Heads up',
                description: 'Voice responses may take longer on slower connections.',
                variant: 'warning',
              },
              {
                title: "Couldn't reconnect",
                description: 'Check the account connection and try again.',
                variant: 'error',
              },
            )
          }
        >
          Show warning / error
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            showReviewToast(
              {
                title: 'Transcript exported',
                description: 'The file is ready.',
                variant: 'success',
                action: { label: 'View', onClick: () => {} },
              },
              {
                title: 'Upload failed',
                description: 'The connection dropped before the file finished uploading.',
                variant: 'error',
                action: { label: 'Retry', onClick: () => {} },
                cancel: { label: 'Cancel', onClick: () => {} },
              },
            )
          }
        >
          Show actions
        </Button>
        <Button size="sm" variant="ghost" onClick={clearReviewToasts}>
          Clear review toasts
        </Button>
      </div>
    </div>
  );
}

export const OverlayAndStatus: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24, padding: 24 }}>
      <section style={{ display: 'grid', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Dialogs & Feedback</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Shared components. Dialogs, tooltips, and loading indicators used across trust-sensitive
          flows.
        </p>
      </section>
      <section
        style={{
          display: 'grid',
          gap: 8,
          padding: 16,
          borderRadius: 16,
          border: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(255,255,255,0.03)',
          lineHeight: 1.55,
        }}
      >
        <div><strong>How this should be used</strong> - dialogs for explicit confirmation or forms, tooltips for compact clarification, and spinners for transient in-progress feedback.</div>
        <div><strong>Where it is used now</strong> - trust-sensitive confirmations, settings dialogs, inbox details, and other interruption/recovery moments.</div>
        <div><strong>Not for</strong> - replacing page structure, empty states, or larger contextual progress/education patterns.</div>
      </section>
      <DialogDemo />
    </div>
  ),
};

export const Toast: Story = {
  render: () => (
    <ToastProvider>
      <div style={{ display: 'grid', gap: 24, padding: 24, maxWidth: 980 }}>
        <section style={{ display: 'grid', gap: 8 }}>
          <h1 style={{ margin: 0, fontSize: 28 }}>Toast</h1>
          <p style={{ margin: 0, color: 'var(--color-text-secondary)', maxWidth: 720 }}>
            Transient floating feedback for action results and short-lived system events. This story
            uses the same `ToastProvider` and `showToast()` path as the app, so it previews the real
            toast rather than a static reconstruction.
          </p>
        </section>
        <ToastReviewHarness />
      </div>
    </ToastProvider>
  ),
};
