import React from 'react';
import { render } from '@testing-library/react-native';
import type { FileLocation } from '@rebel/shared';

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name, testID }: { name: string; testID?: string }) => (
      <Text testID={testID}>{name}</Text>
    ),
  };
});

import { FileLocationBadge } from '../FileLocationBadge';
let consoleWarnSpy: jest.SpyInstance;

function legacyLocation(): FileLocation {
  return {
    kind: 'legacy-missing-location',
    fileName: 'notes.md',
    spaceName: 'Project',
    legacyPath: 'Project/notes.md',
  };
}

describe('FileLocationBadge', () => {
  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('warns once per process when rendering legacy-missing-location repeatedly', () => {
    const location = legacyLocation();
    const first = render(<FileLocationBadge location={location} />);
    first.unmount();

    render(<FileLocationBadge location={location} />);

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleWarnSpy.mock.calls[0]?.[0])).toContain('[WARN] [FileLocationBadge]');
    expect(String(consoleWarnSpy.mock.calls[0]?.[0])).toContain('Rendering degraded FileLocationBadge');
    expect(String(consoleWarnSpy.mock.calls[0]?.[0])).toContain('"warnKey":"notes.md|Project / notes.md"');
  });
});
