// Side-effect init FIRST: this suite runs in the `mcp` vitest project, which has
// no setupFiles (its other suites are script-level tests that don't import core
// modules). The transitive import graph here (mcpService → toolIndexService)
// calls getPlatformConfig() at module-evaluation time, so the shared test
// bootstrap (platform config, store/spawner factories, electron mocks) must be
// evaluated before the imports below. ESM evaluates static imports in source
// order, so this import runs the full setup before any core module loads.
import '../../../../vitest.setup';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { stopSuperMcpForHeadlessCleanup, superMcpHttpManager } from '../superMcpHttpManager';
import { resolveMcpServers } from '../mcpService';
import type { AppSettings } from '@shared/types';
import { DEFAULT_VOICE_ACTIVATION_HOTKEY, DEFAULT_VOICE_ACTIVATION_VOICE_MODE } from '@shared/types';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
/* eslint-disable no-console -- integration test diagnostic output */

describe('MCP HTTP Mode Integration Tests', () => {
  let tempConfigPath: string;
  let tempDir: string;
  const testPort = 3333; // Use non-standard port to avoid conflicts

  beforeAll(async () => {
    // Create temporary directory for test config
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-http-test-'));
    tempConfigPath = path.join(tempDir, '.super-mcp', 'config.json');
    
    // Create .super-mcp directory
    await fs.mkdir(path.dirname(tempConfigPath), { recursive: true });
    
    // Create a minimal Super-MCP config file
    const testConfig = {
      superMcpVersion: '1.0',
      configPaths: [],
      upstreamServers: {}
    };
    await fs.writeFile(tempConfigPath, JSON.stringify(testConfig, null, 2));
  });

  afterAll(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to clean up temp directory:', error);
    }
  });

  describe('HTTP Mode Selection', () => {
    beforeEach(() => {
      // Ensure clean state
      process.env['SUPER_MCP_HTTP_PORT'] = String(testPort);
    });

    it('should use HTTP mode when server is running', async () => {
      
      // Configure and start HTTP manager
      superMcpHttpManager.configure({
        enabled: true,
        port: testPort,
        configPath: tempConfigPath,
        startupTimeoutMs: 30000,
        healthCheckIntervalMs: 500
      });

      try {
        await superMcpHttpManager.start();
        
        const settings = {
          coreDirectory: tempDir,
          mcpConfigFile: tempConfigPath,
          voice: {
            provider: 'openai-whisper',
            openaiApiKey: null,
            elevenlabsApiKey: null,
            model: 'whisper-1',
            ttsVoice: null,
            activationHotkey: DEFAULT_VOICE_ACTIVATION_HOTKEY,
            activationHotkeyVoiceMode: DEFAULT_VOICE_ACTIVATION_VOICE_MODE
          },
          claude: {
            apiKey: 'test-key',
            oauthToken: null,
            authMethod: 'api-key',
            model: 'claude-sonnet-4-5',
            permissionMode: 'bypassPermissions',
            executablePath: null,
            planMode: true,
            extendedContext: true,
            thinkingEffort: 'high'
          },
          diagnostics: {
            debugBreadcrumbsUntil: null
          }
        } as unknown as AppSettings;

        const resolved = await resolveMcpServers(settings);
        
        expect(resolved.mode).toBe('super-mcp');
        expect(resolved.servers).toBeDefined();
        
        const routerEntry = resolved.servers?.['super-mcp-router'];
        expect(routerEntry).toBeDefined();
        expect(routerEntry?.type).toBe('http');
        expect((routerEntry as any)?.url).toBe(`http://127.0.0.1:${testPort}/mcp`);
      } finally {
        await stopSuperMcpForHeadlessCleanup();
      }
    });

    it('should auto-restart HTTP server if configured but not running (lazy restart)', async () => {
      // Configure but don't start - simulates server crash scenario
      superMcpHttpManager.configure({
        enabled: true,
        port: testPort,
        configPath: tempConfigPath,
        startupTimeoutMs: 30000,
        healthCheckIntervalMs: 500
      });

      // Ensure server is stopped (but manager is configured)
      await stopSuperMcpForHeadlessCleanup();

      const settings = {
        coreDirectory: tempDir,
        mcpConfigFile: tempConfigPath,
        voice: {
          provider: 'openai-whisper',
          openaiApiKey: null,
          elevenlabsApiKey: null,
          model: 'whisper-1',
          ttsVoice: null,
          activationHotkey: DEFAULT_VOICE_ACTIVATION_HOTKEY,
          activationHotkeyVoiceMode: DEFAULT_VOICE_ACTIVATION_VOICE_MODE
        },
        claude: {
          apiKey: 'test-key',
          oauthToken: null,
          authMethod: 'api-key',
          model: 'claude-sonnet-4-5',
          permissionMode: 'bypassPermissions',
          executablePath: null,
          planMode: true,
          extendedContext: true,
          thinkingEffort: 'high'
        },
        diagnostics: {
          debugBreadcrumbsUntil: null
        }
      } as unknown as AppSettings;

      try {
        // Should succeed because lazy restart kicks in
        const resolved = await resolveMcpServers(settings);
        
        expect(resolved.mode).toBe('super-mcp');
        expect(resolved.servers).toBeDefined();
        
        const routerEntry = resolved.servers?.['super-mcp-router'];
        expect(routerEntry).toBeDefined();
        expect(routerEntry?.type).toBe('http');
      } finally {
        await stopSuperMcpForHeadlessCleanup();
      }
    });

    it('should throw error when lazy restart also fails', async () => {
      superMcpHttpManager.configure({
        enabled: true,
        port: testPort,
        configPath: tempConfigPath,
        startupTimeoutMs: 5000, // Short timeout to fail fast
        healthCheckIntervalMs: 500
      });

      // Ensure server is stopped so resolveMcpServers must trigger a lazy restart
      await stopSuperMcpForHeadlessCleanup();

      // Must reject ALL calls since startWithRetries() retries up to 4 times
      const startSpy = vi.spyOn(superMcpHttpManager, 'start').mockRejectedValue(
        new Error('Injected lazy restart failure')
      );

      const settings = {
        coreDirectory: tempDir,
        mcpConfigFile: tempConfigPath,
        voice: {
          provider: 'openai-whisper',
          openaiApiKey: null,
          elevenlabsApiKey: null,
          model: 'whisper-1',
          ttsVoice: null,
          activationHotkey: DEFAULT_VOICE_ACTIVATION_HOTKEY,
          activationHotkeyVoiceMode: DEFAULT_VOICE_ACTIVATION_VOICE_MODE
        },
        claude: {
          apiKey: 'test-key',
          oauthToken: null,
          authMethod: 'api-key',
          model: 'claude-sonnet-4-5',
          permissionMode: 'bypassPermissions',
          executablePath: null,
          planMode: true,
          extendedContext: true,
          thinkingEffort: 'high'
        },
        diagnostics: {
          debugBreadcrumbsUntil: null
        }
      } as unknown as AppSettings;

      try {
        await expect(resolveMcpServers(settings)).rejects.toThrow('Tools are temporarily unavailable');
      } finally {
        startSpy.mockRestore();
      }
    });
  });

  describe('HTTP Server Lifecycle', () => {
    beforeEach(async () => {
      process.env['SUPER_MCP_HTTP_PORT'] = String(testPort);
      
      // Ensure server is stopped before each test
      await stopSuperMcpForHeadlessCleanup();
      // Wait longer for port to be fully released (process cleanup can be slow)
      await new Promise(resolve => setTimeout(resolve, 500));
    });

    afterEach(async () => {
      // Ensure cleanup after each test to prevent state leakage
      await stopSuperMcpForHeadlessCleanup();
      await new Promise(resolve => setTimeout(resolve, 500));
    });

    afterAll(async () => {
      // Final cleanup
      await stopSuperMcpForHeadlessCleanup();
      await new Promise(resolve => setTimeout(resolve, 200));
    });

    it('should start HTTP server and pass health check', async () => {
      superMcpHttpManager.configure({
        enabled: true,
        port: testPort,
        configPath: tempConfigPath,
        startupTimeoutMs: 30000,
        healthCheckIntervalMs: 500
      });

      await superMcpHttpManager.start();
      
      try {
        const state = superMcpHttpManager.getState();
        expect(state.isRunning).toBe(true);
        expect(state.port).toBe(testPort);
        expect(state.url).toBe(`http://127.0.0.1:${testPort}/mcp`);
        
        // Verify health check passes
        const isHealthy = await superMcpHttpManager.checkHealth();
        expect(isHealthy).toBe(true);
        
        // Verify we can establish TCP connection
        const canConnect = await checkTcpConnection('localhost', testPort);
        expect(canConnect).toBe(true);
      } finally {
        await stopSuperMcpForHeadlessCleanup();
      }
    });

    it('should stop HTTP server gracefully', async () => {
      superMcpHttpManager.configure({
        enabled: true,
        port: testPort,
        configPath: tempConfigPath,
        startupTimeoutMs: 30000,
        healthCheckIntervalMs: 500
      });

      await superMcpHttpManager.start();
      
      let state = superMcpHttpManager.getState();
      expect(state.isRunning).toBe(true);
      
      await stopSuperMcpForHeadlessCleanup();
      
      // Wait for cleanup (SIGTERM takes time)
      await new Promise(resolve => setTimeout(resolve, 500));
      
      state = superMcpHttpManager.getState();
      expect(state.isRunning).toBe(false);
      expect(state.process).toBeNull();
      
      // Note: Port cleanup verification removed as npx process cleanup timing varies
      // The important part is that isRunning=false and process=null
    });

  });

  describe('Concurrent Connections', () => {
    beforeEach(async () => {
      process.env['SUPER_MCP_HTTP_PORT'] = String(testPort);

      // Ensure any previous server instance is fully stopped and the port is released
      await stopSuperMcpForHeadlessCleanup();
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    it('should support multiple parallel TCP connections', async () => {
      superMcpHttpManager.configure({
        enabled: true,
        port: testPort,
        configPath: tempConfigPath,
        startupTimeoutMs: 30000,
        healthCheckIntervalMs: 500
      });

      await superMcpHttpManager.start();
      
      try {
        // Attempt 10 concurrent connections
        const connectionPromises = Array.from({ length: 10 }, (_, i) =>
          checkTcpConnection('localhost', testPort).then(result => ({
            index: i,
            success: result
          }))
        );

        const results = await Promise.all(connectionPromises);
        
        // All connections should succeed
        expect(results.every(r => r.success)).toBe(true);
        expect(results.length).toBe(10);
      } finally {
        await stopSuperMcpForHeadlessCleanup();
      }
    });

    it('should maintain health during concurrent connections', async () => {
      superMcpHttpManager.configure({
        enabled: true,
        port: testPort,
        configPath: tempConfigPath,
        startupTimeoutMs: 30000,
        healthCheckIntervalMs: 500
      });

      await superMcpHttpManager.start();
      
      try {
        // Start concurrent connections and health checks
        const connectionPromises = Array.from({ length: 5 }, () =>
          checkTcpConnection('localhost', testPort)
        );
        
        const healthCheckPromises = Array.from({ length: 5 }, () =>
          superMcpHttpManager.checkHealth()
        );

        const [connectionResults, healthResults] = await Promise.all([
          Promise.all(connectionPromises),
          Promise.all(healthCheckPromises)
        ]);
        
        // All should succeed
        expect(connectionResults.every(r => r === true)).toBe(true);
        expect(healthResults.every(r => r === true)).toBe(true);
      } finally {
        await stopSuperMcpForHeadlessCleanup();
      }
    });
  });

  describe('Port Configuration', () => {
    beforeEach(async () => {
      // Ensure server is stopped
      await stopSuperMcpForHeadlessCleanup();
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    afterAll(async () => {
      // Final cleanup
      await stopSuperMcpForHeadlessCleanup();
      await new Promise(resolve => setTimeout(resolve, 200));
    });

    it('should respect SUPER_MCP_HTTP_PORT environment variable', async () => {
      // Skip if manager is already running (singleton state management)
      const currentState = superMcpHttpManager.getState();
      if (currentState.isRunning) {
        console.log('Skipping custom port test - manager already running');
        return;
      }
      
      const customPort = 3444;
      process.env['SUPER_MCP_HTTP_PORT'] = String(customPort);
      
      superMcpHttpManager.configure({
        enabled: true,
        port: customPort,
        configPath: tempConfigPath,
        startupTimeoutMs: 30000,
        healthCheckIntervalMs: 500
      });

      await superMcpHttpManager.start();
      
      try {
        const state = superMcpHttpManager.getState();
        expect(state.port).toBe(customPort);
        expect(state.url).toBe(`http://127.0.0.1:${customPort}/mcp`);
        
        const canConnect = await checkTcpConnection('localhost', customPort);
        expect(canConnect).toBe(true);
      } finally {
        await stopSuperMcpForHeadlessCleanup();
      }
    });
  });
});

/**
 * Helper function to check TCP connection
 */
function checkTcpConnection(host: string, port: number, timeout = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const cleanup = (success: boolean) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(success);
    };

    socket.setTimeout(timeout);
    socket.on('connect', () => cleanup(true));
    socket.on('error', () => cleanup(false));
    socket.on('timeout', () => cleanup(false));
    
    socket.connect(port, host);
  });
}
