import React from 'react';
import { render } from '@testing-library/react-native';
import { FloatingOrbs } from '../FloatingOrbs';

const mockCancelAnimation = jest.fn();
let mockReducedMotion = false;

jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};

  return {
    ...Reanimated,
    cancelAnimation: (...args: unknown[]) => mockCancelAnimation(...args),
    useReducedMotion: () => mockReducedMotion,
  };
});

describe('FloatingOrbs', () => {
  beforeEach(() => {
    mockReducedMotion = false;
    mockCancelAnimation.mockClear();
  });

  it('renders the default orb count', () => {
    const { toJSON } = render(<FloatingOrbs />);
    const tree = toJSON();
    const node = Array.isArray(tree) ? tree[0] : tree;

    expect(node).not.toBeNull();
    expect(node?.children ?? []).toHaveLength(2);
  });

  it('respects reduced motion and still renders static orbs', () => {
    mockReducedMotion = true;

    const { toJSON, unmount } = render(<FloatingOrbs />);
    const tree = toJSON();
    const node = Array.isArray(tree) ? tree[0] : tree;

    expect(node).not.toBeNull();
    expect(node?.children ?? []).toHaveLength(2);
    expect(() => unmount()).not.toThrow();
  });

  it('renders with a custom orb count', () => {
    const { toJSON } = render(<FloatingOrbs count={4} />);
    const tree = toJSON();
    const node = Array.isArray(tree) ? tree[0] : tree;

    expect(node?.children ?? []).toHaveLength(4);
  });
});
