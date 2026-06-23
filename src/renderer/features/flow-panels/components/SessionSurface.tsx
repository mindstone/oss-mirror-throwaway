import type { ReactNode } from 'react';
import { CompactionOverlay, type CompactionPhase } from '@renderer/features/agent-session/components/CompactionOverlay';
import type { ExhaustedReason } from '@renderer/features/agent-session/store/sessionStore';

type SessionSurfaceProps = {
  errorBanner?: ReactNode;
  content: ReactNode;
  footer: ReactNode;
  compaction?: {
    phase: CompactionPhase;
    statusMessage: string;
    depth: number;
    onDismiss: () => void;
    reason?: ExhaustedReason | null;
  };
};

export const SessionSurface = ({ errorBanner, content, footer, compaction }: SessionSurfaceProps) => (
  <>
    {errorBanner}
    <div className="flow-stage">
      {content}
      {footer}
      {compaction && (
        <CompactionOverlay
          isOpen={compaction.phase !== 'idle'}
          phase={compaction.phase}
          statusMessage={compaction.statusMessage}
          depth={compaction.depth}
          onDismiss={compaction.onDismiss}
          reason={compaction.reason}
        />
      )}
    </div>
  </>
);
