/**
 * ApprovalSheetHost tests — validates the selectedId-only pattern:
 *  (a) `openApproval(kind, id)` sets the right sheet visible
 *  (b) when the store drops the selected id (cross-surface resolve), the
 *      host clears its own state ("cross-surface close")
 *  (c) `closeApproval()` clears state without touching the stores
 *
 * The three individual sheets are mocked to render a sentinel Text so
 * we don't have to mount `@gorhom/bottom-sheet` in the test environment.
 * That lets us assert on presence + `visible` prop without stubbing
 * reanimated/gesture-handler.
 */

import React, { createRef } from 'react';
import { act, render } from '@testing-library/react-native';

// Mock the three sheets to render a simple sentinel per kind. jest.mock
// factories must stay self-contained — all RN + React imports happen
// inside the factory so they survive the hoisted `require` reordering.
jest.mock('../StagedFileApprovalSheet', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    StagedFileApprovalSheet: ({
      file,
      visible,
    }: {
      file: { id?: string } | null;
      visible: boolean;
    }) =>
      ReactLocal.createElement(
        RNLocal.Text,
        { testID: 'sentinel-staged-file' },
        `${visible ? 'open' : 'closed'}:${file?.id ?? 'null'}`,
      ),
  };
});
jest.mock('../MemoryApprovalSheet', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    MemoryApprovalSheet: ({
      approval,
      visible,
    }: {
      approval: { toolUseId?: string } | null;
      visible: boolean;
    }) =>
      ReactLocal.createElement(
        RNLocal.Text,
        { testID: 'sentinel-memory' },
        `${visible ? 'open' : 'closed'}:${approval?.toolUseId ?? 'null'}`,
      ),
  };
});
// F-D-R2-7 — host renders TWO ToolApprovalSheet instances: one bound to
// `tool` approvals and one to `staged-call` approvals. Each instance
// grabs a stable ordinal on first render via a global counter +
// a useRef sentinel; instance 0 → `sentinel-tool`, instance 1 →
// `sentinel-staged-call`. The counter is reset in `beforeEach` via
// `globalThis.__toolSheetOrdinalCounter = 0`.
declare global {
   
  var __toolSheetOrdinalCounter: number;
}
globalThis.__toolSheetOrdinalCounter = 0;
jest.mock('../ToolApprovalSheet', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    ToolApprovalSheet: ({
      approval,
      visible,
    }: {
      approval: { toolUseID?: string } | null;
      visible: boolean;
    }) => {
      const ordinalRef = ReactLocal.useRef(-1);
      if (ordinalRef.current === -1) {
        ordinalRef.current = globalThis.__toolSheetOrdinalCounter++;
      }
      const testID =
        ordinalRef.current === 0 ? 'sentinel-tool' : 'sentinel-staged-call';
      return ReactLocal.createElement(
        RNLocal.Text,
        { testID },
        `${visible ? 'open' : 'closed'}:${approval?.toolUseID ?? 'null'}`,
      );
    },
  };
});

import {
  ApprovalSheetHost,
  type ApprovalSheetHandle,
} from '../ApprovalSheetHost';
import {
  useApprovalStore,
  useStagedFilesStore,
  type StagedFile,
} from '@rebel/cloud-client';

function makeStagedFile(id: string): StagedFile {
  return {
    id,
    realPath: `Project/${id}.md`,
    spaceName: 'Project',
    spacePath: 'Project',
    sessionId: 'session-1',
    baseHash: 'hash',
    summary: 'staged',
    stagedAt: Date.now(),
    sensitivity: 'high',
    hasConflict: false,
  };
}

function makeToolApproval(id: string) {
  return {
    toolUseID: id,
    turnId: 't1',
    sessionId: 's1',
    toolName: 'bash',
    input: { command: 'ls' },
    timestamp: Date.now(),
    reason: 'Safety check',
  };
}

function makeMemoryApproval(id: string) {
  return {
    toolUseId: id,
    originalTurnId: 't1',
    originalSessionId: 's1',
    spaceName: 'Project',
    spacePath: 'Project',
    filePath: 'Project/notes.md',
    summary: 'update',
    contentPreview: 'content',
    timestamp: Date.now(),
    isNewFile: false,
    blockedBy: 'unknown',
    staged: false,
  };
}

const noop = () => {};

function renderHost(
  ref: React.RefObject<ApprovalSheetHandle | null>,
  overrides?: Partial<{
    onExecuteStagedCall: (call: unknown) => void;
    onRejectStagedCall: (call: unknown) => void;
  }>,
) {
  return render(
    <ApprovalSheetHost
      ref={ref}
      onPublishStagedFile={noop}
      onDiscardStagedFile={noop}
      onKeepPrivateStagedFile={noop}
      onResolveWithRebel={noop}
      onKeepMine={noop}
      onKeepTheirs={noop}
      onApproveMemoryWrite={noop}
      onSkipMemoryWrite={noop}
      onApproveTool={noop}
      onDenyTool={noop}
      onExecuteStagedCall={overrides?.onExecuteStagedCall ?? noop}
      onRejectStagedCall={overrides?.onRejectStagedCall ?? noop}
      isOnline
    />,
  );
}

function makeStagedCall(id: string) {
  return {
    id,
    sessionId: 's1',
    turnId: 't1',
    timestamp: Date.now(),
    status: 'pending',
    displayName: 'run_bash',
    toolCategory: 'execute',
    riskLevel: 'medium',
    reason: 'Review',
    mcpPayload: { args: { command: 'ls' } } as { args: Record<string, unknown> },
  };
}

// Helpers that accept a partial store slice and cast through `unknown` so the
// generated TypeScript state types don't complicate the mock setup.
function setStagedFilesState(patch: Record<string, unknown>) {
  useStagedFilesStore.setState(
    patch as unknown as ReturnType<typeof useStagedFilesStore.getState>,
  );
}
function setApprovalState(patch: Record<string, unknown>) {
  useApprovalStore.setState(
    patch as unknown as ReturnType<typeof useApprovalStore.getState>,
  );
}

beforeEach(() => {
  setStagedFilesState({ files: [], isLoading: false, error: null });
  setApprovalState({
    toolApprovals: [],
    stagedCalls: [],
    memoryApprovals: [],
    isLoading: false,
    error: null,
  });
  globalThis.__toolSheetOrdinalCounter = 0;
});

describe('ApprovalSheetHost', () => {
  it('renders all sheets closed by default', () => {
    const ref = createRef<ApprovalSheetHandle>();
    const { getByTestId } = renderHost(ref);
    expect(getByTestId('sentinel-staged-file').props.children).toBe('closed:null');
    expect(getByTestId('sentinel-memory').props.children).toBe('closed:null');
    expect(getByTestId('sentinel-tool').props.children).toBe('closed:null');
    expect(getByTestId('sentinel-staged-call').props.children).toBe('closed:null');
  });

  it('opens the staged-file sheet with the right item via openApproval', () => {
    const ref = createRef<ApprovalSheetHandle>();
    const file = makeStagedFile('stg_1');
    setStagedFilesState({ files: [file] });
    const { getByTestId } = renderHost(ref);

    act(() => {
      ref.current?.openApproval('staged-file', 'stg_1');
    });

    expect(getByTestId('sentinel-staged-file').props.children).toBe(
      'open:stg_1',
    );
  });

  it('opens the memory sheet with the right approval', () => {
    const ref = createRef<ApprovalSheetHandle>();
    const approval = makeMemoryApproval('mem_1');
    setApprovalState({ memoryApprovals: [approval] });
    const { getByTestId } = renderHost(ref);

    act(() => {
      ref.current?.openApproval('memory', 'mem_1');
    });

    expect(getByTestId('sentinel-memory').props.children).toBe('open:mem_1');
  });

  it('opens the tool sheet with the right approval', () => {
    const ref = createRef<ApprovalSheetHandle>();
    const approval = makeToolApproval('tool_1');
    setApprovalState({ toolApprovals: [approval] });
    const { getByTestId } = renderHost(ref);

    act(() => {
      ref.current?.openApproval('tool', 'tool_1');
    });

    expect(getByTestId('sentinel-tool').props.children).toBe('open:tool_1');
  });

  it('auto-closes when the selected staged file disappears from the store (cross-surface close)', () => {
    const ref = createRef<ApprovalSheetHandle>();
    const file = makeStagedFile('stg_1');
    setStagedFilesState({ files: [file] });
    const { getByTestId } = renderHost(ref);

    act(() => {
      ref.current?.openApproval('staged-file', 'stg_1');
    });
    expect(getByTestId('sentinel-staged-file').props.children).toBe(
      'open:stg_1',
    );

    // Another surface resolved the file — store drops it.
    act(() => {
      setStagedFilesState({ files: [] });
    });

    // Host should clear selectedId and flip sheet to closed.
    expect(getByTestId('sentinel-staged-file').props.children).toBe(
      'closed:null',
    );
  });

  it('auto-closes when the selected memory approval disappears from the store', () => {
    const ref = createRef<ApprovalSheetHandle>();
    const approval = makeMemoryApproval('mem_1');
    setApprovalState({ memoryApprovals: [approval] });
    const { getByTestId } = renderHost(ref);

    act(() => {
      ref.current?.openApproval('memory', 'mem_1');
    });
    expect(getByTestId('sentinel-memory').props.children).toBe('open:mem_1');

    act(() => {
      setApprovalState({ memoryApprovals: [] });
    });

    expect(getByTestId('sentinel-memory').props.children).toBe('closed:null');
  });

  it('closeApproval() clears state without mutating the stores', () => {
    const ref = createRef<ApprovalSheetHandle>();
    const approval = makeToolApproval('tool_1');
    setApprovalState({ toolApprovals: [approval] });
    const { getByTestId } = renderHost(ref);

    act(() => {
      ref.current?.openApproval('tool', 'tool_1');
    });
    expect(getByTestId('sentinel-tool').props.children).toBe('open:tool_1');

    act(() => {
      ref.current?.closeApproval();
    });
    // Tool approval still in store, sheet closed.
    expect(useApprovalStore.getState().toolApprovals).toHaveLength(1);
    expect(getByTestId('sentinel-tool').props.children).toBe('closed:null');
  });

  it('switches sheets when openApproval is called with a different kind', () => {
    const ref = createRef<ApprovalSheetHandle>();
    setStagedFilesState({ files: [makeStagedFile('stg_1')] });
    setApprovalState({ toolApprovals: [makeToolApproval('tool_1')] });
    const { getByTestId } = renderHost(ref);

    act(() => {
      ref.current?.openApproval('staged-file', 'stg_1');
    });
    expect(getByTestId('sentinel-staged-file').props.children).toBe(
      'open:stg_1',
    );
    expect(getByTestId('sentinel-tool').props.children).toBe('closed:null');

    act(() => {
      ref.current?.openApproval('tool', 'tool_1');
    });
    expect(getByTestId('sentinel-staged-file').props.children).toBe(
      'closed:null',
    );
    expect(getByTestId('sentinel-tool').props.children).toBe('open:tool_1');
  });

  // F-D-R2-7 — staged-call kind routes through the second ToolApprovalSheet
  // instance via `stagedCallToToolApproval` adapter.
  it('opens the staged-call sheet when openApproval("staged-call", id) is called', () => {
    const ref = createRef<ApprovalSheetHandle>();
    const call = makeStagedCall('stgc_1');
    setApprovalState({ stagedCalls: [call] });
    const { getByTestId } = renderHost(ref);

    act(() => {
      ref.current?.openApproval('staged-call', 'stgc_1');
    });

    // The staged-call sheet should show the adapted approval id.
    expect(getByTestId('sentinel-staged-call').props.children).toBe(
      'open:stgc_1',
    );
    // The regular tool sheet stays closed.
    expect(getByTestId('sentinel-tool').props.children).toBe('closed:null');
  });

  it('auto-closes when the selected staged call disappears from the store', () => {
    const ref = createRef<ApprovalSheetHandle>();
    const call = makeStagedCall('stgc_1');
    setApprovalState({ stagedCalls: [call] });
    const { getByTestId } = renderHost(ref);

    act(() => {
      ref.current?.openApproval('staged-call', 'stgc_1');
    });
    expect(getByTestId('sentinel-staged-call').props.children).toBe(
      'open:stgc_1',
    );

    act(() => {
      setApprovalState({ stagedCalls: [] });
    });

    expect(getByTestId('sentinel-staged-call').props.children).toBe(
      'closed:null',
    );
  });

  it('keeps sheet closed when openApproval is called for an id not in the store (defensive)', () => {
    const ref = createRef<ApprovalSheetHandle>();
    const { getByTestId } = renderHost(ref);

    act(() => {
      ref.current?.openApproval('staged-file', 'stg_missing');
    });

    // Selected set, but store lookup returns null → sheet stays closed via
    // cross-surface-close effect.
    expect(getByTestId('sentinel-staged-file').props.children).toBe(
      'closed:null',
    );
  });
});
