import { describe, expect, it, vi } from 'vitest';

// Mock electron before any imports that touch ipcRenderer
vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: vi.fn(),
    sendSync: vi.fn(),
  },
}));

import { ipcContract } from '@shared/ipc/contracts';
import * as ipcBridgeExports from '../ipcBridge';
import { channelToMethodName } from '../ipcBridgeBuilder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive the expected API export name from a domain key (e.g. 'settings' → 'settingsApi'). */
function domainToApiName(domain: string): string {
  return `${domain}Api`;
}

// ---------------------------------------------------------------------------
// Test: Every ipcContract domain has a corresponding API export
// ---------------------------------------------------------------------------

describe('ipcBridge integration — domain coverage', () => {
  const domainKeys = Object.keys(ipcContract);

  it.each(domainKeys)('domain "%s" has a corresponding exported API object', (domain) => {
    const apiName = domainToApiName(domain);
    const api = (ipcBridgeExports as Record<string, unknown>)[apiName];
    expect(api).toBeDefined();
    expect(typeof api).toBe('object');
    expect(api).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test: API exports are objects whose values are all functions
// ---------------------------------------------------------------------------

describe('ipcBridge integration — API method types', () => {
  const domainKeys = Object.keys(ipcContract);

  it.each(domainKeys)('"%sApi" methods are all functions', (domain) => {
    const apiName = domainToApiName(domain);
    const api = (ipcBridgeExports as Record<string, unknown>)[apiName] as Record<string, unknown>;

    const methods = Object.entries(api);
    expect(methods.length).toBeGreaterThan(0);

    for (const [methodName, method] of methods) {
      expect(typeof method).toBe('function');
      // Sanity: method name should be a non-empty string
      expect(methodName.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Channel-to-method mapping spot checks
// ---------------------------------------------------------------------------

describe('ipcBridge integration — channel-to-method correctness', () => {
  const spotChecks: Array<{ domain: string; channel: string; expectedMethod: string }> = [
    { domain: 'settings', channel: 'settings:get', expectedMethod: 'get' },
    { domain: 'settings', channel: 'settings:get-default-workspace', expectedMethod: 'getDefaultWorkspace' },
    { domain: 'sessions', channel: 'sessions:load', expectedMethod: 'load' },
    { domain: 'sessions', channel: 'sessions:list', expectedMethod: 'list' },
    { domain: 'library', channel: 'library:list-files', expectedMethod: 'listFiles' },
    { domain: 'library', channel: 'library:read-file-base64', expectedMethod: 'readFileBase64' },
    { domain: 'agent', channel: 'agent:turn', expectedMethod: 'turn' },
    { domain: 'agent', channel: 'agent:stop-turn', expectedMethod: 'stopTurn' },
    { domain: 'demo', channel: 'demo:enter', expectedMethod: 'enter' },
    { domain: 'auth', channel: 'auth:login', expectedMethod: 'login' },
  ];

  it.each(spotChecks)(
    '$channel → $domain Api.$expectedMethod',
    ({ domain, channel, expectedMethod }) => {
      // Verify channelToMethodName produces the expected name
      expect(channelToMethodName(channel)).toBe(expectedMethod);

      // Verify the API object actually has that method as a function
      const apiName = domainToApiName(domain);
      const api = (ipcBridgeExports as Record<string, unknown>)[apiName] as Record<string, unknown>;
      expect(typeof api[expectedMethod]).toBe('function');
    },
  );
});

// ---------------------------------------------------------------------------
// Test: Legacy compatibility aliases
// ---------------------------------------------------------------------------

describe('ipcBridge integration — legacy compatibility aliases', () => {
  const { legacyApiMethods } = ipcBridgeExports;

  it('legacyApiMethods is exported and is a non-null object', () => {
    expect(legacyApiMethods).toBeDefined();
    expect(typeof legacyApiMethods).toBe('object');
    expect(legacyApiMethods).not.toBeNull();
  });

  const sampleAliases = [
    'listWorkspaceFiles',
    'readWorkspaceFile',
    'getSettings',
    'updateSettings',
    'openUrl',
    'exportToPdf',
    'transcribeAudio',
    'startAgentTurn',
    'loadAgentSessions',
    'loadInbox',
    'enterDemoMode',
    'getAnalyticsStatus',
    'generateConversationTitle',
  ];

  it.each(sampleAliases)('legacy alias "%s" is a function', (alias) => {
    const method = (legacyApiMethods as Record<string, unknown>)[alias];
    expect(method).toBeDefined();
    expect(typeof method).toBe('function');
  });

  it('legacy aliases reference the same functions as domain APIs', () => {
    // Verify a few aliases point to the exact same function reference
    expect(legacyApiMethods.listWorkspaceFiles).toBe(ipcBridgeExports.libraryApi.listFiles);
    expect(legacyApiMethods.getSettings).toBe(ipcBridgeExports.settingsApi.get);
    expect(legacyApiMethods.startAgentTurn).toBe(ipcBridgeExports.agentApi.turn);
    expect(legacyApiMethods.enterDemoMode).toBe(ipcBridgeExports.demoApi.enter);
  });
});
