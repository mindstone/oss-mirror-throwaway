import React from 'react';
import { render } from '@testing-library/react-native';
import { ParticleField } from '../ParticleField';

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

describe('ParticleField', () => {
  beforeEach(() => {
    mockReducedMotion = false;
    mockCancelAnimation.mockClear();
  });

  it('renders the default particle count', () => {
    const { toJSON } = render(<ParticleField />);
    const tree = toJSON();
    const node = Array.isArray(tree) ? tree[0] : tree;

    expect(node).not.toBeNull();
    expect(node?.children ?? []).toHaveLength(25);
  });

  it('respects reduced motion and renders nothing', () => {
    mockReducedMotion = true;

    const { toJSON } = render(<ParticleField />);

    expect(toJSON()).toBeNull();
  });

  it('renders with a custom particle count', () => {
    const { toJSON } = render(<ParticleField count={7} />);
    const tree = toJSON();
    const node = Array.isArray(tree) ? tree[0] : tree;

    expect(node?.children ?? []).toHaveLength(7);
  });

  it('does not crash when count is 0', () => {
    const { toJSON } = render(<ParticleField count={0} />);
    const tree = toJSON();
    const node = Array.isArray(tree) ? tree[0] : tree;

    expect(node).not.toBeNull();
    expect(node?.children ?? []).toHaveLength(0);
  });
});
