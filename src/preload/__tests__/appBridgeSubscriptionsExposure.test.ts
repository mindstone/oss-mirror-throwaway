import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const RENDERER_ROOT = path.join(REPO_ROOT, 'src/renderer');
const PRELOAD_INDEX_PATH = path.join(REPO_ROOT, 'src/preload/index.ts');
const CONNECTOR_STATUS_FACTORY_PATH = path.join(
  REPO_ROOT,
  'src/preload/connectorStatusSubscriptionFactory.ts',
);

async function collectRendererSourceFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') {
        continue;
      }
      files.push(...await collectRendererSourceFiles(entryPath));
      continue;
    }

    if (!/\.(ts|tsx)$/.test(entry.name)) {
      continue;
    }
    if (/\.(test|stories)\.(ts|tsx)$/.test(entry.name)) {
      continue;
    }
    files.push(entryPath);
  }

  return files;
}

function extractRendererConsumedSubscriptionMethods(sourceText: string): Set<string> {
  const methods = new Set<string>();
  const interfaceRegex = /interface\s+\w*Subscriptions\w*\s*\{([\s\S]*?)\n\}/g;

  for (const interfaceMatch of sourceText.matchAll(interfaceRegex)) {
    const interfaceBody = interfaceMatch[1] ?? '';
    for (const methodMatch of interfaceBody.matchAll(/\b(on[A-Z]\w*)\??\s*:/g)) {
      methods.add(methodMatch[1]);
    }
  }

  return methods;
}

function extractPreloadIndexSubscriptionMethods(sourceText: string): Set<string> {
  const start = sourceText.indexOf('const appBridgeSubscriptions = {');
  const end = sourceText.indexOf(
    "contextBridge.exposeInMainWorld('appBridgeSubscriptions'",
    start,
  );
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  const appBridgeSubscriptionsBlock = sourceText.slice(start, end);
  const methods = new Set<string>();
  for (const methodMatch of appBridgeSubscriptionsBlock.matchAll(/^\s{2}(on[A-Z]\w*)\s*:/gm)) {
    methods.add(methodMatch[1]);
  }
  return methods;
}

function extractConnectorStatusFactorySubscriptionMethods(sourceText: string): Set<string> {
  const methods = new Set<string>();
  for (const methodMatch of sourceText.matchAll(/^\s{4}(on[A-Z]\w*)\s*:/gm)) {
    methods.add(methodMatch[1]);
  }
  return methods;
}

describe('appBridgeSubscriptions preload exposure contract', () => {
  it('exposes every appBridgeSubscriptions method consumed by renderer code', async () => {
    const rendererFiles = await collectRendererSourceFiles(RENDERER_ROOT);
    const consumed = new Set<string>();

    for (const file of rendererFiles) {
      const sourceText = await fs.readFile(file, 'utf8');
      if (!sourceText.includes('appBridgeSubscriptions')) {
        continue;
      }
      for (const method of extractRendererConsumedSubscriptionMethods(sourceText)) {
        consumed.add(method);
      }
    }

    const preloadIndexText = await fs.readFile(PRELOAD_INDEX_PATH, 'utf8');
    const connectorStatusFactoryText = await fs.readFile(CONNECTOR_STATUS_FACTORY_PATH, 'utf8');
    const exposed = new Set([
      ...extractPreloadIndexSubscriptionMethods(preloadIndexText),
      ...extractConnectorStatusFactorySubscriptionMethods(connectorStatusFactoryText),
    ]);

    expect([...consumed].sort()).toEqual([
      'onConnectorStatusChanged',
      'onPendingApprovalUpdated',
      'onSlackWorkspaceChanged',
    ]);
    expect([...consumed].filter((method) => !exposed.has(method))).toEqual([]);
  });
});
