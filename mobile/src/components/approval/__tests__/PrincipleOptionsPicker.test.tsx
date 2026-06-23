/**
 * PrincipleOptionsPicker tests — covers all 5 `usePrincipleOptions`
 * generation states plus the apply lifecycle:
 *   idle (not rendered yet)
 *   loading → skeleton
 *   loaded → list + custom row
 *   loaded + zero options → "no suggestions" fallback
 *   error → error banner + retry + custom fallback
 *   applying → spinner on confirm
 *   apply-error → error banner + retry-apply
 *
 * The picker is a pure presentational component — it renders whatever
 * hook-slice props are passed. That lets us test each state deterministic-
 * ally without mocking the network.
 */

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    Feather: ({ name, testID }: { name: string; testID?: string }) =>
      ReactLocal.createElement(
        RNLocal.Text,
        { testID: testID ?? `feather-${name}` },
        name,
      ),
  };
});

import {
  PrincipleOptionsPicker,
  type PrincipleOptionsPickerProps,
} from '../PrincipleOptionsPicker';

function defaultProps(
  overrides: Partial<PrincipleOptionsPickerProps> = {},
): PrincipleOptionsPickerProps {
  return {
    generationState: 'loaded',
    options: [{ label: 'Always allow safe web fetches', scope: 'broad' }],
    generationError: null,
    selectedOption: null,
    otherText: '',
    applyState: 'idle',
    applyError: null,
    selectOption: jest.fn(),
    setOtherText: jest.fn(),
    confirmSelection: jest.fn(),
    confirmTrustedTool: jest.fn(),
    cancelTrustedTool: jest.fn(),
    retryGeneration: jest.fn(),
    retryApply: jest.fn(),
    direction: 'allow',
    testIDPrefix: 'test-picker',
    ...overrides,
  };
}

describe('PrincipleOptionsPicker', () => {
  it('renders loading skeleton in loading state', () => {
    const { getByTestId, queryByTestId } = render(
      <PrincipleOptionsPicker {...defaultProps({ generationState: 'loading' })} />,
    );
    expect(getByTestId('test-picker-loading')).toBeTruthy();
    expect(queryByTestId('test-picker-option-0')).toBeNull();
  });

  it('renders option rows + custom input row in loaded state', () => {
    const { getByTestId } = render(
      <PrincipleOptionsPicker
        {...defaultProps({
          generationState: 'loaded',
          options: [
            { label: 'Option A', scope: 'broad' },
            { label: 'Option B', scope: 'broad' },
          ],
        })}
      />,
    );
    expect(getByTestId('test-picker-option-0')).toBeTruthy();
    expect(getByTestId('test-picker-option-1')).toBeTruthy();
    expect(getByTestId('test-picker-other-row')).toBeTruthy();
    expect(getByTestId('test-picker-confirm')).toBeTruthy();
  });

  it('fires selectOption with the tapped index', () => {
    const selectOption = jest.fn();
    const { getByTestId } = render(
      <PrincipleOptionsPicker
        {...defaultProps({
          generationState: 'loaded',
          options: [
            { label: 'Option A', scope: 'broad' },
            { label: 'Option B', scope: 'broad' },
          ],
          selectOption,
        })}
      />,
    );
    fireEvent.press(getByTestId('test-picker-option-1'));
    expect(selectOption).toHaveBeenCalledWith(1);
  });

  it('renders zero-options fallback when loaded but options are empty', () => {
    const { getByTestId } = render(
      <PrincipleOptionsPicker
        {...defaultProps({ generationState: 'loaded', options: [] })}
      />,
    );
    expect(getByTestId('test-picker-zero-options')).toBeTruthy();
    // Free-text fallback still shown so users can type their own.
    expect(getByTestId('test-picker-other-row')).toBeTruthy();
  });

  it('renders error banner + retry in error state', () => {
    const retryGeneration = jest.fn();
    const { getByTestId } = render(
      <PrincipleOptionsPicker
        {...defaultProps({
          generationState: 'error',
          generationError: 'Network failed',
          retryGeneration,
        })}
      />,
    );
    expect(getByTestId('test-picker-error')).toBeTruthy();
    fireEvent.press(getByTestId('test-picker-retry-generation'));
    expect(retryGeneration).toHaveBeenCalledTimes(1);
  });

  it('shows apply-error banner + retry-apply when applyState=error', () => {
    const retryApply = jest.fn();
    const { getByTestId } = render(
      <PrincipleOptionsPicker
        {...defaultProps({
          applyState: 'error',
          applyError: 'Permission denied',
          retryApply,
        })}
      />,
    );
    expect(getByTestId('test-picker-apply-error')).toBeTruthy();
    fireEvent.press(getByTestId('test-picker-retry-apply'));
    expect(retryApply).toHaveBeenCalledTimes(1);
  });

  it('shows applying spinner when applyState=applying', () => {
    const { getByTestId } = render(
      <PrincipleOptionsPicker {...defaultProps({ applyState: 'applying' })} />,
    );
    expect(getByTestId('test-picker-applying')).toBeTruthy();
  });

  it('confirm button is disabled when nothing is selected', () => {
    const { getByTestId } = render(
      <PrincipleOptionsPicker {...defaultProps({ selectedOption: null })} />,
    );
    const confirm = getByTestId('test-picker-confirm');
    expect(confirm.props.accessibilityState?.disabled).toBe(true);
  });

  it('confirm button is enabled when an option is selected', () => {
    const { getByTestId } = render(
      <PrincipleOptionsPicker {...defaultProps({ selectedOption: 0 })} />,
    );
    const confirm = getByTestId('test-picker-confirm');
    expect(confirm.props.accessibilityState?.disabled).toBe(false);
  });

  it('confirm button is disabled when "other" is selected but text is empty', () => {
    const { getByTestId } = render(
      <PrincipleOptionsPicker
        {...defaultProps({ selectedOption: 'other', otherText: '' })}
      />,
    );
    const confirm = getByTestId('test-picker-confirm');
    expect(confirm.props.accessibilityState?.disabled).toBe(true);
  });

  it('confirm button is enabled when "other" is selected with text', () => {
    const { getByTestId } = render(
      <PrincipleOptionsPicker
        {...defaultProps({ selectedOption: 'other', otherText: 'Because' })}
      />,
    );
    const confirm = getByTestId('test-picker-confirm');
    expect(confirm.props.accessibilityState?.disabled).toBe(false);
  });

  it('uses "Block" label for deny direction', () => {
    const { getByTestId } = render(
      <PrincipleOptionsPicker
        {...defaultProps({ direction: 'deny', selectedOption: 0 })}
      />,
    );
    const confirm = getByTestId('test-picker-confirm');
    expect(confirm.props.accessibilityLabel).toBe('Confirm principle — Block');
  });

  it('uses "Allow" label for allow direction (default)', () => {
    const { getByTestId } = render(
      <PrincipleOptionsPicker {...defaultProps({ selectedOption: 0 })} />,
    );
    const confirm = getByTestId('test-picker-confirm');
    expect(confirm.props.accessibilityLabel).toBe('Confirm principle — Allow');
  });

  it('fires confirmSelection when the confirm button is pressed', () => {
    const confirmSelection = jest.fn();
    const { getByTestId } = render(
      <PrincipleOptionsPicker
        {...defaultProps({ selectedOption: 0, confirmSelection })}
      />,
    );
    fireEvent.press(getByTestId('test-picker-confirm'));
    expect(confirmSelection).toHaveBeenCalledTimes(1);
  });

  // F-D-R2-2 — confirming_trust branch
  describe('confirming_trust branch', () => {
    it('renders the trust-confirmation block with allow copy when applyState=confirming_trust (allow direction)', () => {
      const { getByTestId, getByText } = render(
        <PrincipleOptionsPicker
          {...defaultProps({
            applyState: 'confirming_trust',
            selectedOption: 0,
          })}
        />,
      );
      expect(getByTestId('test-picker-confirming-trust')).toBeTruthy();
      expect(
        getByText(
          'This tool will always be allowed without safety checks. Are you sure?',
        ),
      ).toBeTruthy();
      expect(getByTestId('test-picker-confirming-trust-confirm')).toBeTruthy();
      expect(getByTestId('test-picker-confirming-trust-cancel')).toBeTruthy();
    });

    it('renders the trust-confirmation block with block copy when direction=deny', () => {
      const { getByText } = render(
        <PrincipleOptionsPicker
          {...defaultProps({
            applyState: 'confirming_trust',
            selectedOption: 0,
            direction: 'deny',
          })}
        />,
      );
      expect(
        getByText('This will always be blocked by your safety rules. Are you sure?'),
      ).toBeTruthy();
    });

    it('fires confirmTrustedTool when the primary button is pressed', () => {
      const confirmTrustedTool = jest.fn();
      const { getByTestId } = render(
        <PrincipleOptionsPicker
          {...defaultProps({
            applyState: 'confirming_trust',
            selectedOption: 0,
            confirmTrustedTool,
          })}
        />,
      );
      fireEvent.press(getByTestId('test-picker-confirming-trust-confirm'));
      expect(confirmTrustedTool).toHaveBeenCalledTimes(1);
    });

    it('fires cancelTrustedTool when the cancel button is pressed', () => {
      const cancelTrustedTool = jest.fn();
      const { getByTestId } = render(
        <PrincipleOptionsPicker
          {...defaultProps({
            applyState: 'confirming_trust',
            selectedOption: 0,
            cancelTrustedTool,
          })}
        />,
      );
      fireEvent.press(getByTestId('test-picker-confirming-trust-cancel'));
      expect(cancelTrustedTool).toHaveBeenCalledTimes(1);
    });

    it('hides the regular confirm button while confirming_trust is active', () => {
      const { queryByTestId } = render(
        <PrincipleOptionsPicker
          {...defaultProps({
            applyState: 'confirming_trust',
            selectedOption: 0,
          })}
        />,
      );
      expect(queryByTestId('test-picker-confirm')).toBeNull();
    });
  });
});
