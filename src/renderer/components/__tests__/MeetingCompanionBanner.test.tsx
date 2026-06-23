// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MeetingCompanionBanner } from '../MeetingCompanionBanner';

const useOperatorRegistryMock = vi.fn();

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@renderer/features/settings', () => ({
  useSettingsSafe: () => ({ settings: { coreDirectory: '/workspace' } }),
}));

vi.mock('@renderer/features/operators/hooks/useOperatorRegistry', () => ({
  useOperatorRegistry: (...args: unknown[]) => useOperatorRegistryMock(...args),
}));

describe('MeetingCompanionBanner', () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    useOperatorRegistryMock.mockReturnValue({
      operators: [{
        id: '/workspace/Chief-of-Staff::skeptical-engineer',
        operatorSlug: 'skeptical-engineer',
        spacePath: '/workspace/Chief-of-Staff',
        sourceSpacePath: '/workspace/Chief-of-Staff',
        category: 'space',
        name: 'Skeptical Engineer',
        description: 'Stress-tests the room.',
        consult_when: 'When the plan needs pressure.',
        kind: 'operator',
        roles: ['live_meeting'],
        operatorFileAbsolutePath: '/workspace/Chief-of-Staff/operators/skeptical-engineer/OPERATOR.md',
        groundingPath: '/workspace/Chief-of-Staff/operators/skeptical-engineer/grounding.md',
        diaryPath: '/workspace/Chief-of-Staff/operators/skeptical-engineer/diary.md',
      }],
      loading: false,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    document.body.innerHTML = '';
    container = null;
    root = null;
    vi.clearAllMocks();
  });

  it('lists Operators in the coach picker and returns the OPERATOR.md path', async () => {
    const onSelectCoach = vi.fn();
    await act(async () => {
      root?.render(
        <MeetingCompanionBanner
          meetingTitle="Weekly Review"
          meetingUrl="https://example.com"
          isRecording={true}
          selectedCoach={null}
          onSelectCoach={onSelectCoach}
          presenceMode="coach"
        />,
      );
    });
    expect(useOperatorRegistryMock).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'panel',
      roleFilter: 'live_meeting',
    }));

    const pickerButton = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('No coach')) as HTMLButtonElement | undefined;
    expect(pickerButton).toBeDefined();

    await act(async () => {
      pickerButton?.click();
    });

    const operatorButton = Array.from(document.querySelectorAll('.meeting-companion-banner__coach-item'))
      .find((element) => element.textContent?.includes('Skeptical Engineer')) as HTMLButtonElement | undefined;
    expect(operatorButton).toBeDefined();

    await act(async () => {
      operatorButton?.click();
    });

    expect(onSelectCoach).toHaveBeenCalledWith({
      skillPath: '/workspace/Chief-of-Staff/operators/skeptical-engineer/OPERATOR.md',
      skillName: 'Skeptical Engineer',
      description: 'Stress-tests the room.',
    }, undefined);
  });

  it('shows a zero-Operators row with a deep link when Join in needs an Operator', async () => {
    useOperatorRegistryMock.mockReturnValue({
      operators: [],
      loading: false,
    });
    const onOpenOperatorsPanel = vi.fn();
    await act(async () => {
      root?.render(
        <MeetingCompanionBanner
          meetingTitle="Weekly Review"
          meetingUrl="https://example.com"
          isRecording={true}
          selectedCoach={null}
          onSelectCoach={vi.fn()}
          presenceMode="silent"
          onOpenOperatorsPanel={onOpenOperatorsPanel}
        />,
      );
    });

    const joinButton = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Join in')) as HTMLButtonElement | undefined;
    expect(joinButton).toBeDefined();

    await act(async () => {
      joinButton?.click();
    });

    expect(document.body.textContent).toContain('No coaches available — install or activate a live meeting coach.');
    const deepLink = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Open Operators panel')) as HTMLButtonElement | undefined;
    expect(deepLink).toBeDefined();

    await act(async () => {
      deepLink?.click();
    });
    expect(onOpenOperatorsPanel).toHaveBeenCalledTimes(1);
  });
});
