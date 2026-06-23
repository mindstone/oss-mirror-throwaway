import React, { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useFileViewerModel } from '../hooks/useFileViewerModel';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const CLOSED_STATE = {
  visible: false,
  filePath: null,
  content: null,
  isLoading: false,
  error: null,
  truncated: false,
};

const strictModeWrapper = ({ children }: { children: React.ReactNode }) => {
  return React.createElement(StrictMode, null, children);
};

describe('useFileViewerModel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads content for a viewable path', async () => {
    const file = deferred<{ content: string }>();
    const readFile = vi.fn().mockReturnValue(file.promise);
    const { result } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openPath('notes.md');
    });

    expect(result.current.state).toEqual({
      visible: true,
      filePath: 'notes.md',
      content: null,
      isLoading: true,
      error: null,
      truncated: false,
    });

    await act(async () => {
      file.resolve({ content: '# Notes' });
      await file.promise;
    });

    expect(result.current.state).toEqual({
      visible: true,
      filePath: 'notes.md',
      content: '# Notes',
      isLoading: false,
      error: null,
      truncated: false,
    });
  });

  it('surfaces a load error when reading fails', async () => {
    const file = deferred<{ content: string }>();
    const readFile = vi.fn().mockReturnValue(file.promise);
    const { result } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openPath('notes.md');
    });

    await act(async () => {
      file.reject(new Error('nope'));
      await Promise.resolve();
    });

    expect(result.current.state).toEqual({
      visible: true,
      filePath: 'notes.md',
      content: null,
      isLoading: false,
      error: 'Unable to load file. Please check your connection and try again.',
      truncated: false,
    });
  });

  it('truncates long content when it exceeds maxContentLength', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'abcdef' });
    const { result } = renderHook(() =>
      useFileViewerModel({ readFile, maxContentLength: 4 }),
    );

    act(() => {
      result.current.openPath('notes.md');
    });

    await waitFor(() => {
      expect(result.current.state).toEqual({
        visible: true,
        filePath: 'notes.md',
        content: 'abcd',
        isLoading: false,
        error: null,
        truncated: true,
      });
    });
  });

  it('keeps the latest request active when concurrent opens race', async () => {
    const a = deferred<{ content: string }>();
    const b = deferred<{ content: string }>();
    const readFile = vi.fn((path: string) => {
      if (path === 'a.md') return a.promise;
      return b.promise;
    });
    const { result } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openPath('a.md');
      result.current.openPath('b.md');
    });

    expect(result.current.state).toEqual({
      visible: true,
      filePath: 'b.md',
      content: null,
      isLoading: true,
      error: null,
      truncated: false,
    });

    await act(async () => {
      a.resolve({ content: 'old' });
      await a.promise;
    });

    expect(result.current.state).toEqual({
      visible: true,
      filePath: 'b.md',
      content: null,
      isLoading: true,
      error: null,
      truncated: false,
    });

    await act(async () => {
      b.resolve({ content: 'new' });
      await b.promise;
    });

    expect(result.current.state.content).toBe('new');
  });

  it('stays closed when a late resolve arrives after close', async () => {
    const file = deferred<{ content: string }>();
    const readFile = vi.fn().mockReturnValue(file.promise);
    const { result } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openPath('a.md');
      result.current.close();
    });

    await act(async () => {
      file.resolve({ content: 'content' });
      await file.promise;
    });

    expect(result.current.state).toEqual(CLOSED_STATE);
  });

  it('stays closed when a late reject arrives after close', async () => {
    const file = deferred<{ content: string }>();
    const readFile = vi.fn().mockReturnValue(file.promise);
    const { result } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openPath('a.md');
      result.current.close();
    });

    await act(async () => {
      file.reject(new Error('late'));
      await Promise.resolve();
    });

    expect(result.current.state).toEqual(CLOSED_STATE);
  });

  it('does not log errors when unmounted before a late resolve', async () => {
    const file = deferred<{ content: string }>();
    const readFile = vi.fn().mockReturnValue(file.promise);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result, unmount } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openPath('a.md');
    });
    unmount();

    await act(async () => {
      file.resolve({ content: 'content' });
      await file.promise;
    });

    expect(consoleError).not.toHaveBeenCalled();
  });

  it('does not log errors when unmounted before a late reject', async () => {
    const file = deferred<{ content: string }>();
    const readFile = vi.fn().mockReturnValue(file.promise);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result, unmount } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openPath('a.md');
    });
    unmount();

    await act(async () => {
      file.reject(new Error('late'));
      await Promise.resolve();
    });

    expect(consoleError).not.toHaveBeenCalled();
  });

  it('survives StrictMode lifecycle replay', async () => {
    const file = deferred<{ content: string }>();
    const readFile = vi.fn().mockReturnValue(file.promise);
    const { result } = renderHook(() => useFileViewerModel({ readFile }), {
      wrapper: strictModeWrapper,
    });

    act(() => {
      result.current.openPath('a.md');
    });

    await act(async () => {
      file.resolve({ content: 'ok' });
      await file.promise;
    });

    expect(result.current.state.content).toBe('ok');
  });

  it('lets close be called repeatedly without changing the closed state', () => {
    const readFile = vi.fn();
    const { result } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.close();
      result.current.close();
    });

    expect(result.current.state).toEqual(CLOSED_STATE);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('shows a category-aware error for non-viewable files without reading them', () => {
    const readFile = vi.fn();
    const { result } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openPath('image.png');
    });

    expect(result.current.state).toEqual({
      visible: true,
      filePath: 'image.png',
      content: null,
      isLoading: false,
      error: "Previewing images on mobile isn't supported yet — ask Rebel to describe it, or open it on desktop.",
      truncated: false,
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('openPath for *.html triggers a category-aware error instead of reading the file', () => {
    const readFile = vi.fn().mockResolvedValue({ content: '<html></html>' });
    const { result } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openPath('guide.html');
    });

    expect(readFile).not.toHaveBeenCalled();
    expect(result.current.state.error).toContain('HTML');
  });

  it('openPath for tutorial paths triggers a tutorial-specific error instead of reading the file', () => {
    const readFile = vi.fn().mockResolvedValue({ content: '<html></html>' });
    const { result } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openPath('rebel-system/help-for-humans/tutorials/guide.html');
    });

    expect(readFile).not.toHaveBeenCalled();
    expect(result.current.state.error).toContain('tutorial');
  });

  it('openPath for *.svg triggers an image-specific error instead of reading the file', () => {
    const readFile = vi.fn().mockResolvedValue({ content: '<svg />' });
    const { result } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openPath('icon.svg');
    });

    expect(readFile).not.toHaveBeenCalled();
    expect(result.current.state.error).toContain('images');
  });

  it('opens a library URL by reading its extracted path', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'notes' });
    const { result } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openUrl('library://notes.md');
    });

    await waitFor(() => {
      expect(readFile).toHaveBeenCalledWith('notes.md');
      expect(result.current.state.content).toBe('notes');
    });
  });

  it('shows an open-url error when the stripped path is empty', () => {
    const readFile = vi.fn();
    const { result } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openUrl('library://?q=1');
    });

    expect(result.current.state).toEqual({
      ...CLOSED_STATE,
      visible: true,
      error: 'Unable to open this link',
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('strips URL fragments before reading a library URL', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'notes' });
    const { result } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openUrl('library://notes.md#heading');
    });

    await waitFor(() => {
      expect(readFile).toHaveBeenCalledWith('notes.md');
      expect(result.current.state.filePath).toBe('notes.md');
    });
  });

  it('strips query strings from direct openPath calls', async () => {
    const readFile = vi.fn().mockResolvedValue({ content: 'hi' });
    const { result } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openPath('notes.md?v=1');
    });

    await waitFor(() => {
      expect(readFile).toHaveBeenCalledWith('notes.md');
      expect(result.current.state.filePath).toBe('notes.md');
    });
  });

  it('shows an open-url error for invalid library URLs', () => {
    const readFile = vi.fn();
    const { result } = renderHook(() => useFileViewerModel({ readFile }));

    act(() => {
      result.current.openUrl('not-a-library-url');
    });

    expect(result.current.state).toEqual({
      ...CLOSED_STATE,
      visible: true,
      error: 'Unable to open this link',
    });
    expect(readFile).not.toHaveBeenCalled();
  });
});
