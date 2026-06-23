import { Notice } from '@renderer/components/ui';

export interface MultiRebelWorkspaceNoticeProps {
  peerInstanceCount?: number | null;
}

export function MultiRebelWorkspaceNotice({
  peerInstanceCount,
}: MultiRebelWorkspaceNoticeProps) {
  if (!peerInstanceCount || peerInstanceCount <= 1) {
    return null;
  }

  return (
    <Notice
      tone="info"
      placement="inline"
      data-testid="multi-rebel-workspace-notice"
    >
      More than one Rebel is connected to this Slack workspace. They don&apos;t coordinate territory yet, so each Rebel handles incoming messages independently.
    </Notice>
  );
}
