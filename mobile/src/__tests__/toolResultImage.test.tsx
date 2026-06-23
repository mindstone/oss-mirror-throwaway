import React from 'react';
import type { ImageContentBlock } from '@rebel/cloud-client';
import { fireEvent, render } from '@testing-library/react-native';
import { ToolResultImage, ToolResultImages } from '../components/ToolResultImage';

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name }: { name: string }) => <Text>{name}</Text>,
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  }),
}));

const sampleImage: ImageContentBlock = {
  type: 'image',
  data: 'ZmFrZS1iYXNlNjQtaW1hZ2U=',
  mimeType: 'image/png',
};

describe('ToolResultImage', () => {
  it('renders image thumbnails without crashing', () => {
    const { getAllByLabelText } = render(
      <ToolResultImages images={[sampleImage, sampleImage]} />,
    );

    expect(getAllByLabelText('Tool result image, tap to expand')).toHaveLength(2);
  });

  it('shows fallback when the image load fails', () => {
    const { getByTestId, getByText } = render(<ToolResultImage image={sampleImage} />);

    fireEvent(getByTestId('tool-result-image'), 'error');

    expect(getByText('Image unavailable')).toBeTruthy();
    expect(getByTestId('tool-result-image-fallback')).toBeTruthy();
  });
});
