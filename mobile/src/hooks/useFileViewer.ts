import {
  readWorkspaceFile,
  useFileViewerModel,
  type FileViewerState,
} from '@rebel/cloud-client';

export type UseFileViewerReturn = {
  viewerProps: FileViewerState & { onClose: () => void };
  openFile: (url: string) => void;
  openPath: (path: string) => void;
  close: () => void;
};

export function useFileViewer(): UseFileViewerReturn {
  const model = useFileViewerModel({ readFile: readWorkspaceFile });

  return {
    viewerProps: {
      ...model.state,
      onClose: model.close,
    },
    openFile: model.openUrl,
    openPath: model.openPath,
    close: model.close,
  };
}
