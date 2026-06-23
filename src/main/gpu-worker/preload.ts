/**
 * GPU Embedding Worker Preload Script
 *
 * Exposes minimal IPC bridge for GPU embedding communication.
 * Runs in a Hidden BrowserWindow with strict security settings.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { GPU_EMBEDDING_CHANNEL } from '@shared/ipc/gpuEmbeddingContract';
import type { GpuEmbedRequest, GpuEmbedResponse } from '@shared/ipc/gpuEmbeddingContract';

const gpuEmbeddingApi = {
  onRequest: (callback: (request: GpuEmbedRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: GpuEmbedRequest) => {
      callback(request);
    };
    ipcRenderer.on(GPU_EMBEDDING_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(GPU_EMBEDDING_CHANNEL, handler);
    };
  },

  sendResponse: (response: GpuEmbedResponse) => {
    ipcRenderer.send(`${GPU_EMBEDDING_CHANNEL}:response`, response);
  },
};

contextBridge.exposeInMainWorld('gpuEmbeddingApi', gpuEmbeddingApi);

declare global {
  interface Window {
    gpuEmbeddingApi: typeof gpuEmbeddingApi;
  }
}
