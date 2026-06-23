import React from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';

// Capture the props handed to RNGH's Swipeable so the test can render its
// panels and invoke onSwipeableOpen with a known direction. This pins the
// label<->action contract (B4 regression guard): in RNGH 2.28 the LEFT panel
// (leftLabel) opens with direction='left' and the RIGHT panel (rightLabel)
// with direction='right' (verified against the dependency source).
let capturedProps: Record<string, unknown> | null = null;
jest.mock('react-native-gesture-handler', () => {
  const ReactLocal = require('react');
  return {
    Swipeable: ReactLocal.forwardRef((props: Record<string, unknown>, _ref: unknown) => {
      capturedProps = props;
      const renderLeft = props.renderLeftActions as undefined | (() => React.ReactNode);
      const renderRight = props.renderRightActions as undefined | (() => React.ReactNode);
      return ReactLocal.createElement(
        ReactLocal.Fragment,
        null,
        renderLeft ? renderLeft() : null,
        renderRight ? renderRight() : null,
        props.children,
      );
    }),
  };
});

jest.mock('../../utils/haptics', () => ({ hapticMedium: jest.fn() }));

import { SwipeableRow } from '../SwipeableRow';

function open(direction: 'left' | 'right') {
  const onSwipeableOpen = capturedProps?.onSwipeableOpen as (d: 'left' | 'right') => void;
  onSwipeableOpen(direction);
}

describe('SwipeableRow direction -> handler contract', () => {
  beforeEach(() => {
    capturedProps = null;
  });

  it("fires onSwipeLeft for the LEFT panel (direction='left')", () => {
    const onSwipeLeft = jest.fn();
    const onSwipeRight = jest.fn();
    render(
      <SwipeableRow
        onSwipeLeft={onSwipeLeft}
        onSwipeRight={onSwipeRight}
        leftLabel="Star"
        rightLabel="Done"
      >
        <Text>row</Text>
      </SwipeableRow>,
    );

    open('left');
    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it("fires onSwipeRight for the RIGHT panel (direction='right')", () => {
    const onSwipeLeft = jest.fn();
    const onSwipeRight = jest.fn();
    render(
      <SwipeableRow
        onSwipeLeft={onSwipeLeft}
        onSwipeRight={onSwipeRight}
        leftLabel="Star"
        rightLabel="Done"
      >
        <Text>row</Text>
      </SwipeableRow>,
    );

    open('right');
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  it('renders each panel only when its handler is provided', () => {
    const { queryByText, rerender } = render(
      <SwipeableRow
        onSwipeLeft={jest.fn()}
        onSwipeRight={jest.fn()}
        leftLabel="Snooze"
        rightLabel="Done"
      >
        <Text>row</Text>
      </SwipeableRow>,
    );
    expect(queryByText('Snooze')).toBeTruthy();
    expect(queryByText('Done')).toBeTruthy();

    // Without onSwipeLeft (e.g. inbox when snooze is unavailable) the left
    // panel must not render, but the right panel still does.
    rerender(
      <SwipeableRow onSwipeRight={jest.fn()} leftLabel="Snooze" rightLabel="Done">
        <Text>row</Text>
      </SwipeableRow>,
    );
    expect(queryByText('Snooze')).toBeNull();
    expect(queryByText('Done')).toBeTruthy();

    // Without onSwipeRight (e.g. background sessions with no Done affordance)
    // the right panel must not render, but the left panel still does.
    rerender(
      <SwipeableRow onSwipeLeft={jest.fn()} leftLabel="Star">
        <Text>row</Text>
      </SwipeableRow>,
    );
    expect(queryByText('Star')).toBeTruthy();
    expect(queryByText('Done')).toBeNull();
  });

  it('does not fire onSwipeLeft when it is omitted', () => {
    const onSwipeRight = jest.fn();
    render(
      <SwipeableRow onSwipeRight={onSwipeRight} leftLabel="Snooze" rightLabel="Done">
        <Text>row</Text>
      </SwipeableRow>,
    );

    open('left');
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('does not fire onSwipeRight when it is omitted', () => {
    const onSwipeLeft = jest.fn();
    render(
      <SwipeableRow onSwipeLeft={onSwipeLeft} leftLabel="Snooze">
        <Text>row</Text>
      </SwipeableRow>,
    );

    open('right');
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });
});
