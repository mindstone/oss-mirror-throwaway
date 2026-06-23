import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildActiveActivityViewModel,
  type CompletedStep,
  type MissionContext,
  type SubAgentItem,
  type TaskProgressItem,
} from '@rebel/cloud-client';
import { MobileActivitySurface } from './activity/MobileActivitySurface';

const STALL_THRESHOLD_MS = 60_000;
const TICK_INTERVAL_MS = 10_000;

type Props = {
  headline: string;
  completedSteps: CompletedStep[];
  missionContext?: MissionContext | null;
  taskProgress?: TaskProgressItem[];
  subAgentItems?: SubAgentItem[];
  hasMissionSet?: boolean;
  touchedTaskIds?: string[];
};

export const AgentActivityBubble = memo(function AgentActivityBubble({
  headline,
  completedSteps,
  missionContext,
  taskProgress,
  subAgentItems,
  hasMissionSet,
  touchedTaskIds,
}: Props) {
  const turnStartRef = useRef(Date.now());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    turnStartRef.current = Date.now();
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const elapsedMs = Math.max(0, now - turnStartRef.current);
  const isStalled = elapsedMs >= STALL_THRESHOLD_MS;

  const viewModel = useMemo(
    () => buildActiveActivityViewModel({
      headline,
      completedSteps,
      missionContext,
      taskProgress,
      subAgentItems,
      hasMissionSet,
      touchedTaskIds,
      elapsedMs,
      isStalled,
      isError: false,
    }),
    [
      headline,
      completedSteps,
      missionContext,
      taskProgress,
      subAgentItems,
      hasMissionSet,
      touchedTaskIds,
      elapsedMs,
      isStalled,
    ],
  );

  return (
    <MobileActivitySurface
      mode="active"
      viewModel={viewModel}
      initialExpanded
      testID="agent-activity-bubble"
    />
  );
});
