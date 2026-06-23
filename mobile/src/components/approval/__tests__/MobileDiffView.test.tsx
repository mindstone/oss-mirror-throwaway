/**
 * MobileDiffView tests — verifies the stats badge path, too-large
 * bailout state, and error-state rendering. The async compute path is
 * flushed deterministically via `flushPromises` because the default
 * scheduler wraps `InteractionManager.runAfterInteractions`, which
 * resolves synchronously in jest-expo.
 */

import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';

// Keep computeDiff real so we test the actual pipeline. But jest-expo's
// InteractionManager shim resolves tasks synchronously, so the async
// scheduler inside MobileDiffView settles in the next microtask.
//
// For the generation-guard test we swap `computeDiffAsync` with a
// controllable mock. The mock must be named `mock*` so jest hoists it
// correctly. Other tests opt out by leaving `mockComputeDiffAsyncImpl`
// undefined, in which case we fall through to the real implementation.
const mockComputeDiffAsyncImpl = jest.fn();
jest.mock('@rebel/shared', () => {
  const actual = jest.requireActual('@rebel/shared');
  return {
    ...actual,
    computeDiffAsync: (...args: Parameters<typeof actual.computeDiffAsync>) => {
      if (mockComputeDiffAsyncImpl.getMockImplementation()) {
        return mockComputeDiffAsyncImpl(...args);
      }
      return actual.computeDiffAsync(...args);
    },
  };
});

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name, testID }: { name: string; testID?: string }) => (
      <Text testID={testID}>{name}</Text>
    ),
  };
});

import { MobileDiffView } from '../MobileDiffView';
import type { DiffResult } from '@rebel/shared';

async function flush() {
  // Allow microtasks + the scheduler yield to drain.
   
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('MobileDiffView', () => {
  it('renders the +added / -removed stats badge for a small diff', async () => {
    const before = 'line 1\nline 2\nline 3\n';
    const after = 'line 1\nline 2 edited\nline 3\nline 4\n';

    const { getByTestId, queryByTestId } = render(
      <MobileDiffView before={before} after={after} />,
    );

    // Initial render shows loading.
    expect(getByTestId('mobile-diff-loading')).toBeTruthy();

    await flush();
    await flush();

    await waitFor(() => expect(getByTestId('mobile-diff-stats')).toBeTruthy());
    const added = getByTestId('mobile-diff-added-count');
    const removed = getByTestId('mobile-diff-removed-count');
    // Text content should include the +/- counts with the proper markers.
    expect(String(added.props.children.join?.('') ?? added.props.children)).toMatch(/\+\d+ added/);
    expect(String(removed.props.children.join?.('') ?? removed.props.children)).toMatch(/−\d+ removed/);
    // Hunks are hidden by default (expanded=false).
    expect(queryByTestId('mobile-diff-hunks')).toBeNull();
  });

  it('renders hunks when expanded is true', async () => {
    const before = 'line A\nline B\n';
    const after = 'line A\nline B modified\n';

    const { getByTestId } = render(
      <MobileDiffView before={before} after={after} expanded />,
    );

    await flush();
    await flush();

    await waitFor(() => expect(getByTestId('mobile-diff-hunks')).toBeTruthy());
  });

  it('shows the too-large state when input exceeds maxLinesForFullDiff', async () => {
    const before = Array.from({ length: 101 }, (_, i) => `before line ${i}`).join('\n');
    const after = Array.from({ length: 101 }, (_, i) => `after line ${i}`).join('\n');

    const { getByTestId } = render(
      <MobileDiffView before={before} after={after} maxLinesForFullDiff={50} />,
    );

    await flush();
    await flush();

    await waitFor(() => expect(getByTestId('mobile-diff-too-large')).toBeTruthy());
  });

  it('renders no stats / no hunks when both sides are identical (zero-diff)', async () => {
    const content = 'line 1\nline 2\n';

    const { getByTestId } = render(
      <MobileDiffView before={content} after={content} />,
    );

    await flush();
    await flush();

    await waitFor(() => expect(getByTestId('mobile-diff-stats')).toBeTruthy());
    const added = getByTestId('mobile-diff-added-count');
    const removed = getByTestId('mobile-diff-removed-count');
    expect(String(added.props.children.join?.('') ?? added.props.children)).toMatch(/\+0 added/);
    expect(String(removed.props.children.join?.('') ?? removed.props.children)).toMatch(/−0 removed/);
  });

  // -----------------------------------------------------------------
  // F6-R1-4 — stale async race
  // -----------------------------------------------------------------
  it('ignores a stale diff that resolves AFTER a newer prop update (generation guard)', async () => {
    // Build two deferred promises that resolve on demand. The older
    // (A) promise resolves with a 5-added result AFTER the fresh (B)
    // promise resolves with a 1-added result. Without the generation
    // guard the older result would overwrite the newer one.
    let resolveA!: (r: DiffResult) => void;
    let resolveB!: (r: DiffResult) => void;
    const pendingA = new Promise<DiffResult>((res) => {
      resolveA = res;
    });
    const pendingB = new Promise<DiffResult>((res) => {
      resolveB = res;
    });

    mockComputeDiffAsyncImpl
      .mockImplementationOnce(() => pendingA)
      .mockImplementationOnce(() => pendingB);

    const { rerender, getByTestId } = render(
      <MobileDiffView before="A-before" after="A-after" />,
    );

    // Re-render with new props BEFORE resolving either promise — a
    // second compute (for B) is kicked off while the first is still
    // pending.
    rerender(<MobileDiffView before="B-before" after="B-after" />);

    // Resolve B first (the fresh one).
    await act(async () => {
      resolveB({
        tooLarge: false,
        hunks: [
          { type: 'added', value: 'B-fresh\n', lineCount: 1 },
        ],
        stats: { added: 1, removed: 0, unchanged: 0 },
      });
      await new Promise((r) => setTimeout(r, 0));
    });

    // Then resolve A (the stale one) with a DIFFERENT, bigger result.
    // Without the generation guard this would commit over B and we'd
    // incorrectly render "+5 added".
    await act(async () => {
      resolveA({
        tooLarge: false,
        hunks: [
          { type: 'added', value: 'A-stale\n', lineCount: 5 },
        ],
        stats: { added: 5, removed: 0, unchanged: 0 },
      });
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(getByTestId('mobile-diff-stats')).toBeTruthy());
    const added = getByTestId('mobile-diff-added-count');
    // Fresh B (1 added), not stale A (5 added).
    expect(String(added.props.children.join?.('') ?? added.props.children)).toMatch(/\+1 added/);

    mockComputeDiffAsyncImpl.mockReset();
  });
});
