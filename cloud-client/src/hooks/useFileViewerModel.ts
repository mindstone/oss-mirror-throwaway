import { useCallback, useEffect, useRef, useState } from 'react';
import {
  extractLibraryPath,
  getFileExtension,
  getFilePreviewCategory,
  MOBILE_TEXT_VIEWABLE_EXTENSIONS,
  stripQueryAndFragmentFromPath,
} from '@rebel/shared';
import type { FilePreviewCategory } from '@rebel/shared';

export type FileViewerState = {
  visible: boolean;
  filePath: string | null;
  content: string | null;
  isLoading: boolean;
  error: string | null;
  truncated: boolean;
};

export type UseFileViewerModelOptions = {
  readFile: (path: string) => Promise<{ content: string }>;
  maxContentLength?: number;
  isViewable?: (path: string) => boolean;
  viewabilityErrorMessage?: (path: string, category: FilePreviewCategory) => string;
  loadErrorMessage?: (path: string, err: unknown) => string;
  openUrlErrorMessage?: string;
};

export type UseFileViewerModelReturn = {
  state: FileViewerState;
  openUrl: (libraryUrl: string) => void;
  openPath: (path: string) => void;
  close: () => void;
};

const DEFAULT_MAX_CONTENT_LENGTH = 102_400;

const CLOSED_STATE: FileViewerState = {
  visible: false,
  filePath: null,
  content: null,
  isLoading: false,
  error: null,
  truncated: false,
};

const defaultIsViewable = (path: string): boolean => {
  return MOBILE_TEXT_VIEWABLE_EXTENSIONS.has(getFileExtension(path));
};

const defaultViewabilityErrorMessage = (
  _path: string,
  category: FilePreviewCategory,
): string => {
  switch (category) {
    case 'image':
      return "Previewing images on mobile isn't supported yet — ask Rebel to describe it, or open it on desktop.";
    case 'video':
      return "Previewing videos on mobile isn't supported yet — open it on desktop to play.";
    case 'audio':
      return "Previewing audio on mobile isn't supported yet — open it on desktop to listen.";
    case 'pdf':
      return "Previewing PDFs on mobile isn't supported yet — open it on desktop to view.";
    case 'html':
      return "Previewing HTML files on mobile isn't supported yet — open it on desktop to render.";
    case 'tutorial':
      return "Previewing tutorials on mobile isn't supported yet — open it on desktop to read.";
    case 'unsupported':
      return "This file type can't be previewed on mobile — open it on desktop.";
    case 'text':
      return "This file can't be previewed.";
  }
};

const defaultLoadErrorMessage = (): string => {
  return 'Unable to load file. Please check your connection and try again.';
};

export function useFileViewerModel(
  options: UseFileViewerModelOptions,
): UseFileViewerModelReturn {
  const {
    readFile,
    maxContentLength = DEFAULT_MAX_CONTENT_LENGTH,
    isViewable = defaultIsViewable,
    viewabilityErrorMessage = defaultViewabilityErrorMessage,
    loadErrorMessage = defaultLoadErrorMessage,
    openUrlErrorMessage = 'Unable to open this link',
  } = options;
  const [state, setState] = useState<FileViewerState>(CLOSED_STATE);
  const requestIdRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const close = useCallback(() => {
    requestIdRef.current += 1;
    setState(CLOSED_STATE);
  }, []);

  const openPath = useCallback((rawPath: string) => {
    const path = stripQueryAndFragmentFromPath(rawPath);
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    if (!isViewable(path)) {
      const category = getFilePreviewCategory(path);
      setState({
        visible: true,
        filePath: path,
        content: null,
        isLoading: false,
        error: viewabilityErrorMessage(path, category),
        truncated: false,
      });
      return;
    }

    setState({
      visible: true,
      filePath: path,
      content: null,
      isLoading: true,
      error: null,
      truncated: false,
    });

    void (async () => {
      try {
        const result = await readFile(path);
        if (requestIdRef.current !== requestId || !isMountedRef.current) {
          return;
        }

        const truncated = result.content.length > maxContentLength;
        const content = truncated
          ? result.content.slice(0, maxContentLength)
          : result.content;

        setState({
          visible: true,
          filePath: path,
          content,
          isLoading: false,
          error: null,
          truncated,
        });
      } catch (err) {
        if (requestIdRef.current !== requestId || !isMountedRef.current) {
          return;
        }

        setState({
          visible: true,
          filePath: path,
          content: null,
          isLoading: false,
          error: loadErrorMessage(path, err),
          truncated: false,
        });
      }
    })();
  }, [isViewable, loadErrorMessage, maxContentLength, readFile, viewabilityErrorMessage]);

  const openUrl = useCallback((libraryUrl: string) => {
    const extractedPath = extractLibraryPath(libraryUrl);
    const strippedPath =
      extractedPath === null ? null : stripQueryAndFragmentFromPath(extractedPath);

    if (!strippedPath) {
      requestIdRef.current += 1;
      setState({
        ...CLOSED_STATE,
        visible: true,
        error: openUrlErrorMessage,
      });
      return;
    }

    openPath(strippedPath);
  }, [openPath, openUrlErrorMessage]);

  return {
    state,
    openUrl,
    openPath,
    close,
  };
}
