import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { FileViewerModal } from '../components/FileViewerModal';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name, testID }: { name: string; testID?: string }) => (
      <Text testID={testID}>{name}</Text>
    ),
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('@ronradtke/react-native-markdown-display', () => {
  const React = require('react');
  const { Text, TouchableOpacity } = require('react-native');
  const MarkdownMock = ({
    children,
    onLinkPress,
  }: {
    children: string;
    onLinkPress?: (url: string) => boolean;
  }) => {
    // Emit a clickable proxy whenever the fixture contains a recognisable markdown link.
    // Test fixtures below pass strings like "Open [Doc](library://nested.md)" — we extract
    // the first URL and expose it via a tappable element so the test can assert that
    // onLinkPress is wired end-to-end.
    const match = typeof children === 'string' ? children.match(/\]\(([^)]+)\)/) : null;
    const url = match ? match[1] : null;
    return (
      <>
        <Text testID="markdown-content">{children}</Text>
        {url && onLinkPress ? (
          <TouchableOpacity
            testID={`markdown-link-${url}`}
            onPress={() => onLinkPress(url)}
          >
            <Text>link</Text>
          </TouchableOpacity>
        ) : null}
      </>
    );
  };
  return {
    __esModule: true,
    default: MarkdownMock,
    MarkdownIt: jest.fn(() => {
      const instance: { validateLink: (url: string) => boolean } = {
        validateLink: () => true,
      };
      return instance;
    }),
  };
});

// ---------------------------------------------------------------------------
// FileViewerModal component tests
// ---------------------------------------------------------------------------

describe('FileViewerModal', () => {
  const defaultProps = {
    visible: true,
    filePath: null as string | null,
    content: null as string | null,
    onClose: jest.fn(),
    isLoading: false,
    error: null as string | null,
    truncated: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders loading state with ActivityIndicator', () => {
    const { getByTestId } = render(
      <FileViewerModal {...defaultProps} isLoading={true} filePath="notes.md" />,
    );
    expect(getByTestId('file-viewer-loading')).toBeTruthy();
  });

  it('renders error state with error message', () => {
    const { getByTestId, getByText } = render(
      <FileViewerModal
        {...defaultProps}
        error="Something went wrong"
        filePath="notes.md"
      />,
    );
    expect(getByTestId('file-viewer-error')).toBeTruthy();
    expect(getByText('Something went wrong')).toBeTruthy();
  });

  it('renders markdown content for .md files', () => {
    const { getByTestId } = render(
      <FileViewerModal
        {...defaultProps}
        filePath="docs/readme.md"
        content="# Hello World"
      />,
    );
    expect(getByTestId('markdown-content')).toBeTruthy();
    expect(getByTestId('file-viewer-content')).toBeTruthy();
  });

  it('renders plain text for non-markdown files', () => {
    const { getByTestId } = render(
      <FileViewerModal
        {...defaultProps}
        filePath="config.json"
        content='{"key": "value"}'
      />,
    );
    expect(getByTestId('file-viewer-plain-text')).toBeTruthy();
  });

  it('extracts filename from full path', () => {
    const { getByTestId } = render(
      <FileViewerModal
        {...defaultProps}
        filePath="some/deep/nested/path/report.txt"
        content="file content"
      />,
    );
    expect(getByTestId('file-viewer-filename').props.children).toBe('report.txt');
  });

  it('extracts filename from Windows-style path', () => {
    const { getByTestId } = render(
      <FileViewerModal
        {...defaultProps}
        filePath="C:\\Users\\docs\\notes.md"
        content="# Notes"
      />,
    );
    expect(getByTestId('file-viewer-filename').props.children).toBe('notes.md');
  });

  it('calls onClose when close button is pressed', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(
      <FileViewerModal {...defaultProps} onClose={onClose} filePath="test.txt" content="hi" />,
    );
    fireEvent.press(getByTestId('file-viewer-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows truncation note when truncated is true', () => {
    const { getByTestId } = render(
      <FileViewerModal
        {...defaultProps}
        filePath="large-file.log"
        content="lots of content..."
        truncated={true}
      />,
    );
    expect(getByTestId('file-viewer-truncation-note')).toBeTruthy();
  });

  it('does not show truncation note when truncated is false', () => {
    const { queryByTestId } = render(
      <FileViewerModal
        {...defaultProps}
        filePath="small-file.txt"
        content="small content"
        truncated={false}
      />,
    );
    expect(queryByTestId('file-viewer-truncation-note')).toBeNull();
  });

  it('treats .MD (uppercase) as markdown', () => {
    const { getByTestId } = render(
      <FileViewerModal
        {...defaultProps}
        filePath="README.MD"
        content="# Readme"
      />,
    );
    expect(getByTestId('markdown-content')).toBeTruthy();
  });

  // Stage 4: nested links inside a viewed markdown file are clickable.
  it('routes nested markdown links through onLinkPress', () => {
    const onLinkPress = jest.fn().mockReturnValue(false);
    const { getByTestId } = render(
      <FileViewerModal
        {...defaultProps}
        filePath="notes.md"
        content="Open [Sibling](library://nested.md)"
        onLinkPress={onLinkPress}
      />,
    );
    fireEvent.press(getByTestId('markdown-link-library://nested.md'));
    expect(onLinkPress).toHaveBeenCalledWith('library://nested.md');
  });

  // Nested links only render inside markdown, not plain text (non-markdown files).
  it('does not route links for non-markdown files', () => {
    const onLinkPress = jest.fn();
    const { queryByTestId } = render(
      <FileViewerModal
        {...defaultProps}
        filePath="notes.txt"
        content="Open [Sibling](library://nested.md)"
        onLinkPress={onLinkPress}
      />,
    );
    expect(queryByTestId('markdown-link-library://nested.md')).toBeNull();
    expect(onLinkPress).not.toHaveBeenCalled();
  });
});
