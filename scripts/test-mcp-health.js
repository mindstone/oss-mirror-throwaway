#!/usr/bin/env node
/**
 * MCP Health Check Utility
 * 
 * Tests MCP servers by spawning them and calling listTools.
 * Useful for:
 * - AI agents to verify MCP fixes before asking users to restart
 * - CI/CD pipeline health checks
 * - Debugging MCP registration/schema issues
 * 
 * Usage:
 *   node scripts/test-mcp-health.js                    # Test core MCPs (default)
 *   node scripts/test-mcp-health.js rebel-inbox        # Test specific MCP
 *   node scripts/test-mcp-health.js --all              # Test all configured MCPs
 * 
 * Exit codes:
 *   0 - Success (all tools listed)
 *   1 - Error (MCP failed to start or listTools failed)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const NODE_MODULES = path.join(PROJECT_ROOT, 'node_modules');
const RESOURCES_MCP = path.join(PROJECT_ROOT, 'resources', 'mcp');

// Temp file for mock bridge state (used in CI or when app not running)
let mockBridgeStatePath = null;

/**
 * Get or create a bridge state file path.
 * In CI or when the app isn't running, creates a mock file with dummy values.
 * The bridge is only used for tool execution, not tool registration,
 * so listTools works fine with mock values.
 */
function getOrCreateBridgeStatePath() {
  // Try real locations first (when app is running)
  const realLocations = [
    process.env.HOME && path.join(process.env.HOME, 'Library/Application Support/mindstone-rebel/mcp/rebel-inbox-bridge.json'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'mindstone-rebel/mcp/rebel-inbox-bridge.json'),
    process.env.HOME && path.join(process.env.HOME, '.config/mindstone-rebel/mcp/rebel-inbox-bridge.json')
  ].filter(Boolean);
  
  for (const loc of realLocations) {
    if (fs.existsSync(loc)) {
      return loc;
    }
  }
  
  // No real bridge state found - create a mock one for CI/testing
  // This allows the server to start and register tools, even though
  // actual tool execution would fail (which is fine for listTools test)
  if (!mockBridgeStatePath) {
    mockBridgeStatePath = path.join(os.tmpdir(), `rebel-test-bridge-${process.pid}.json`);
    fs.writeFileSync(mockBridgeStatePath, JSON.stringify({ port: 1, token: 'test-health-check' }));
    console.log(`[Setup] Created mock bridge state: ${mockBridgeStatePath}`);
  }
  
  return mockBridgeStatePath;
}

// Clean up mock bridge state on exit
process.on('exit', () => {
  if (mockBridgeStatePath && fs.existsSync(mockBridgeStatePath)) {
    try {
      fs.unlinkSync(mockBridgeStatePath);
    } catch {}
  }
});

// Core bundled MCPs - these are tested by default and in CI
// Note: rebel-internal was split into 7 separate MCPs (Jan 2026), we test rebel-inbox as representative
const CORE_MCPS = ['rebel-inbox', 'rebel-diagnostics'];

// MCP server configurations
const MCP_CONFIGS = {
  'rebel-inbox': {
    script: path.join(RESOURCES_MCP, 'rebel-inbox', 'server.cjs'),
    env: () => ({
      MINDSTONE_REBEL_BRIDGE_STATE: getOrCreateBridgeStatePath(),
      NODE_PATH: NODE_MODULES
    }),
    expectedMinTools: 9 // RebelInbox has 9 tools
  },
  'rebel-diagnostics': {
    script: path.join(RESOURCES_MCP, 'rebel-diagnostics', 'server.cjs'),
    env: () => ({
      MINDSTONE_REBEL_BRIDGE_STATE: getOrCreateBridgeStatePath(),
      NODE_PATH: NODE_MODULES
    }),
    expectedMinTools: 6
  }
};

async function testMcpServer(name, config) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let resolved = false;
    
    console.log(`\n[${name}] Testing MCP server...`);
    console.log(`[${name}] Script: ${config.script}`);
    
    if (!fs.existsSync(config.script)) {
      console.log(`[${name}] ERROR: Script not found`);
      resolve({ name, success: false, error: 'Script not found' });
      return;
    }

    // env can be a function (for lazy evaluation) or an object
    const envVars = typeof config.env === 'function' ? config.env() : config.env;
    
    const child = spawn('node', [config.script], {
      env: { ...process.env, ...envVars },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderr = '';
    let stdout = '';
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      
      // Try to parse JSON-RPC responses
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 1 && !resolved) {
            resolved = true;
            const elapsed = Date.now() - startTime;
            
            if (parsed.error) {
              console.log(`[${name}] ERROR: ${parsed.error.message}`);
              child.kill();
              resolve({ 
                name, 
                success: false, 
                error: parsed.error.message,
                elapsed 
              });
            } else if (parsed.result?.tools) {
              const toolCount = parsed.result.tools.length;
              const success = toolCount >= (config.expectedMinTools || 1);
              console.log(`[${name}] ${success ? 'SUCCESS' : 'WARNING'}: ${toolCount} tools (expected >= ${config.expectedMinTools})`);
              if (toolCount > 0) {
                console.log(`[${name}] First 5 tools: ${parsed.result.tools.slice(0, 5).map(t => t.name).join(', ')}`);
              }
              child.kill();
              resolve({ 
                name, 
                success, 
                toolCount,
                elapsed 
              });
            }
          }
        } catch (e) {
          // Not valid JSON yet, continue accumulating
        }
      }
    });

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        console.log(`[${name}] ERROR: Failed to spawn: ${err.message}`);
        resolve({ name, success: false, error: err.message });
      }
    });

    // Wait for server to start, then send listTools request
    setTimeout(() => {
      if (resolved) return;
      
      const request = JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1
      });
      
      try {
        child.stdin.write(request + '\n');
      } catch (e) {
        if (!resolved) {
          resolved = true;
          console.log(`[${name}] ERROR: Failed to write to stdin: ${e.message}`);
          resolve({ name, success: false, error: e.message });
        }
      }
    }, 500);

    // Timeout after 10 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        console.log(`[${name}] ERROR: Timeout waiting for response`);
        if (stderr) {
          console.log(`[${name}] Stderr: ${stderr.slice(0, 500)}`);
        }
        resolve({ name, success: false, error: 'Timeout' });
      }
    }, 10000);
  });
}

async function main() {
  const args = process.argv.slice(2);
  let mcpsToTest = [];

  if (args.includes('--all')) {
    mcpsToTest = Object.keys(MCP_CONFIGS);
  } else if (args.length > 0 && !args[0].startsWith('-')) {
    const name = args[0];
    if (!MCP_CONFIGS[name]) {
      console.error(`Unknown MCP: ${name}`);
      console.error(`Available: ${Object.keys(MCP_CONFIGS).join(', ')}`);
      process.exit(1);
    }
    mcpsToTest = [name];
  } else {
    // Default to core MCPs (used in CI)
    mcpsToTest = CORE_MCPS;
  }

  console.log('='.repeat(60));
  console.log('MCP Health Check');
  console.log('='.repeat(60));

  const results = [];
  for (const name of mcpsToTest) {
    const result = await testMcpServer(name, MCP_CONFIGS[name]);
    results.push(result);
  }

  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  
  let allSuccess = true;
  for (const r of results) {
    const status = r.success ? '✓ PASS' : '✗ FAIL';
    const details = r.success ? `${r.toolCount} tools, ${r.elapsed}ms` : r.error;
    console.log(`${status} ${r.name}: ${details}`);
    if (!r.success) allSuccess = false;
  }

  process.exit(allSuccess ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
