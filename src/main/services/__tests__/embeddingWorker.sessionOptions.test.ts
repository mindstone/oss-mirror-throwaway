import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PIPELINE_CALL_KEY = '__embeddingWorkerPipelineCall';
const originalParentPort = Reflect.get(process, 'parentPort');

type PipelineCall = {
  task: string;
  model: string;
  options: {
    dtype: string;
    device: string;
    session_options: Record<string, unknown>;
  };
};

const tempDirs: string[] = [];

function createFakeTransformersPackage(): string {
  const packageRoot = mkdtempSync(path.join(tmpdir(), 'embedding-worker-test-'));
  tempDirs.push(packageRoot);

  mkdirSync(path.join(packageRoot, 'node_modules', '@huggingface', 'transformers'), {
    recursive: true,
  });
  writeFileSync(path.join(packageRoot, '.package-lock.json'), '{}');
  writeFileSync(
    path.join(packageRoot, 'node_modules', '@huggingface', 'transformers', 'index.js'),
    `
const pipelineCallKey = ${JSON.stringify(PIPELINE_CALL_KEY)};
const env = {};

async function pipeline(task, model, options) {
  globalThis[pipelineCallKey] = {
    task,
    model,
    options,
    envSnapshot: { ...env },
  };

  return async function fakeEmbeddingPipeline() {
    return {
      tolist() {
        return [[0]];
      },
      dispose() {},
    };
  };
}

module.exports = { env, pipeline };
`
  );

  return packageRoot;
}

function restoreParentPort(): void {
  if (originalParentPort === undefined) {
    Reflect.deleteProperty(process, 'parentPort');
    return;
  }

  Object.defineProperty(process, 'parentPort', {
    value: originalParentPort,
    configurable: true,
  });
}

async function runInitMessage(initMessage: Record<string, unknown>): Promise<PipelineCall> {
  let messageListener: ((event: { data: unknown }) => void) | undefined;

  const readyPromise = new Promise<void>((resolve, reject) => {
    Object.defineProperty(process, 'parentPort', {
      value: {
        on: vi.fn((event: string, listener: (payload: { data: unknown }) => void) => {
          if (event === 'message') {
            messageListener = listener;
          }
        }),
        postMessage: vi.fn((message: { type?: string; error?: string }) => {
          if (message.type === 'ready') {
            resolve();
            return;
          }
          if (message.type === 'error') {
            reject(new Error(message.error ?? 'worker init failed'));
          }
        }),
      },
      configurable: true,
    });
  });

  await import('../../workers/embeddingWorker');
  expect(messageListener).toBeTypeOf('function');

  messageListener?.({ data: initMessage });
  await readyPromise;

  return (globalThis as Record<string, unknown>)[PIPELINE_CALL_KEY] as PipelineCall;
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>)[PIPELINE_CALL_KEY];
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  restoreParentPort();
});

afterAll(() => {
  restoreParentPort();
});

describe('embeddingWorker init session_options plumbing', () => {
  it('passes session_options.intraOpNumThreads through to pipeline()', async () => {
    const pipelineCall = await runInitMessage({
      type: 'init',
      cacheDir: '/tmp/rebel-cache',
      unpackedNodeModules: createFakeTransformersPackage(),
      onnxIntraOpThreads: 3,
    });

    expect(pipelineCall).toMatchObject({
      task: 'feature-extraction',
      model: 'Xenova/bge-small-en-v1.5',
      options: {
        dtype: 'fp32',
        device: 'cpu',
        session_options: {
          intraOpNumThreads: 3,
        },
      },
    });
  });

  it('passes an empty session_options object when onnxIntraOpThreads is omitted', async () => {
    const pipelineCall = await runInitMessage({
      type: 'init',
      cacheDir: '/tmp/rebel-cache',
      unpackedNodeModules: createFakeTransformersPackage(),
    });

    expect(pipelineCall.options.session_options).toEqual({});
    expect(pipelineCall.options.session_options).not.toHaveProperty('intraOpNumThreads');
  });
});
