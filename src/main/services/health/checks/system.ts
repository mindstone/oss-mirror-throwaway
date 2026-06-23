/**
 * System Health Checks
 */

import { getPlatformConfig } from '@core/platform';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { superMcpHttpManager } from '../../superMcpHttpManager';
import { getWindowsGitBashCandidatePaths } from '@main/utils/systemUtils';
import type { CheckResult } from '../types';

export async function checkNodeBundleHealth(): Promise<CheckResult> {
  const id = 'nodeBundleHealth';
  const name = 'Node.js Runtime';

  if (!getPlatformConfig().isPackaged) {
    return {
      id,
      name,
      status: 'pass',
      message: 'Using system Node.js (development mode)',
    };
  }

  const isWindows = process.platform === 'win32';
  const resourcesPath = process.resourcesPath;
  const bundleDir = isWindows
    ? path.join(resourcesPath, 'node-bundle')
    : path.join(resourcesPath, 'node-bundle', 'bin');

  const nodeExe = isWindows ? 'node.exe' : 'node';
  const npmExe = isWindows ? 'npm.cmd' : 'npm';
  const npxExe = isWindows ? 'npx.cmd' : 'npx';

  const nodePath = path.join(bundleDir, nodeExe);
  const npmPath = path.join(bundleDir, npmExe);
  const npxPath = path.join(bundleDir, npxExe);

  const missing: string[] = [];

  try {
    await fs.access(nodePath);
  } catch {
    missing.push('node');
  }

  try {
    await fs.access(npmPath);
  } catch {
    missing.push('npm');
  }

  try {
    await fs.access(npxPath);
  } catch {
    missing.push('npx');
  }

  if (missing.length > 0) {
    return {
      id,
      name,
      status: 'fail',
      message: `Missing executables: ${missing.join(', ')}`,
      details: { bundleDir, missing },
      remediation: 'Reinstall the application',
    };
  }

  return {
    id,
    name,
    status: 'pass',
    message: 'Bundled Node.js present',
    details: { bundleDir },
  };
}



const MSVC_RUNTIME_DLLS = [
  'concrt140.dll',
  'msvcp140.dll',
  'msvcp140_1.dll',
  'msvcp140_2.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
];

export async function checkMsvcRuntimeHealth(): Promise<CheckResult> {
  const id = 'msvcRuntimeHealth';
  const name = 'MSVC Runtime';

  if (process.platform !== 'win32') {
    return {
      id,
      name,
      status: 'skip',
      message: 'Not applicable on this platform',
    };
  }

  if (!getPlatformConfig().isPackaged) {
    return {
      id,
      name,
      status: 'pass',
      message: 'Using system MSVC runtime (development mode)',
    };
  }

  const exeDir = path.dirname(process.execPath);
  const nodeBundleDir = path.join(process.resourcesPath, 'node-bundle');

  const missingExe: string[] = [];
  const missingNodeBundle: string[] = [];

  for (const dll of MSVC_RUNTIME_DLLS) {
    try {
      await fs.access(path.join(exeDir, dll));
    } catch {
      missingExe.push(dll);
    }

    try {
      await fs.access(path.join(nodeBundleDir, dll));
    } catch {
      missingNodeBundle.push(dll);
    }
  }

  if (missingExe.length > 0 || missingNodeBundle.length > 0) {
    const parts: string[] = [];
    if (missingExe.length > 0) parts.push(`exe dir missing: ${missingExe.join(', ')}`);
    if (missingNodeBundle.length > 0) parts.push(`node-bundle missing: ${missingNodeBundle.join(', ')}`);

    return {
      id,
      name,
      status: 'fail',
      message: `Missing MSVC runtime DLLs (${parts.join(' | ')})`,
      details: {
        exeDir,
        nodeBundleDir,
        missingExe,
        missingNodeBundle,
      },
      remediation: 'Reinstall the application',
    };
  }

  return {
    id,
    name,
    status: 'pass',
    message: 'MSVC runtime DLLs present',
    details: { exeDir, nodeBundleDir, dlls: MSVC_RUNTIME_DLLS },
  };
}

export function checkEnvOverrides(): CheckResult {
  const id = 'envOverrides';
  const name = 'Environment Overrides';

  const overrideVars = [
    'MINDSTONE_FORCE_DIRECT_MCP',
    'MINDSTONE_FORCE_SUPER_MCP',
    'SUPER_MCP_HTTP_PORT',
    'SUPER_MCP_ROUTER_CLI',
    'MINDSTONE_LOG_LEVEL',
    'CLAUDE_CODE_STREAM_CLOSE_TIMEOUT',
  ];

  const activeOverrides: Record<string, string> = {};

  for (const varName of overrideVars) {
    const value = process.env[varName];
    if (value !== undefined && value.trim().length > 0) {
      activeOverrides[varName] = value;
    }
  }

  if (Object.keys(activeOverrides).length === 0) {
    return {
      id,
      name,
      status: 'pass',
      message: 'No environment overrides active',
    };
  }

  const count = Object.keys(activeOverrides).length;

  return {
    id,
    name,
    status: 'pass',
    message: `${count} override(s) active`,
    details: { overrides: activeOverrides },
  };
}

export function checkPortAvailable(): CheckResult {
  const id = 'portAvailable';
  const name = 'Network Ports';

  const state = superMcpHttpManager.getState();
  
  if (state.isRunning) {
    return {
      id,
      name,
      status: 'pass',
      message: `Port ${state.port} in use by Super-MCP`,
      details: { port: state.port },
    };
  }

  return {
    id,
    name,
    status: 'pass',
    message: 'Super-MCP not running (port check skipped)',
  };
}

/**
 * Diagnostic codes for Git Bash health check failures.
 * These map to PreflightDiagnosticCode in the IPC schema.
 */
export type GitBashDiagnosticCode =
  | 'GIT_BUNDLED_MISSING'      // Bundled Git not found (likely AV quarantine during install)
  | 'GIT_BUNDLED_BLOCKED'      // Bundled Git found but execution blocked (AV real-time protection)
  | 'GIT_SYSTEM_NOT_INSTALLED' // No system Git installation found
  | 'GIT_BASH_MISSING'         // Git installed but bash.exe component missing
  | 'GIT_EXECUTION_TIMEOUT';   // Git found but execution timed out

/**
 * Classify an execution error to determine the likely cause.
 */
function classifyExecError(error: Error & { code?: string }): 'blocked' | 'timeout' | 'other' {
  const message = error.message.toLowerCase();
  const code = error.code;
  
  // Timeout detection
  if (code === 'ETIMEDOUT' || message.includes('timeout') || message.includes('timed out')) {
    return 'timeout';
  }
  
  // Access denied / blocked by security software
  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    message.includes('access is denied') ||
    message.includes('permission denied') ||
    message.includes('operation not permitted') ||
    message.includes('cannot be loaded') || // PowerShell execution policy style
    message.includes('blocked')
  ) {
    return 'blocked';
  }
  
  return 'other';
}

export async function checkGitBashHealth(): Promise<CheckResult> {
  const id = 'gitBashHealth';
  const name = 'Git Bash';

  if (process.platform !== 'win32') {
    return {
      id,
      name,
      status: 'skip',
      message: 'Not applicable on this platform',
    };
  }

  // Check for git-bash in common locations or PATH
  // Claude Code on Windows requires git-bash for shell operations
  const customPath = process.env['CLAUDE_CODE_GIT_BASH_PATH'];

  // Track what we checked for diagnostic purposes
  const bundledPath = getPlatformConfig().isPackaged
    ? path.join(process.resourcesPath, 'git-bundle', 'usr', 'bin', 'bash.exe')
    : null;
  let bundledExists = false;
  let systemGitExists = false;

  // Build list of paths to check, prioritizing bundled version
  const pathsToCheck: string[] = [];

  // 1. Check CLAUDE_CODE_GIT_BASH_PATH (may already be set by setupGitEnvironment)
  if (customPath) {
    pathsToCheck.push(customPath);
  }

  // 2. Check bundled git-bundle in packaged app (PortableGit structure)
  if (bundledPath) {
    pathsToCheck.push(bundledPath);
  }

  // 3. Check common installation paths (shared with setupGitEnvironment)
  const systemPaths = getWindowsGitBashCandidatePaths();
  pathsToCheck.push(...systemPaths);

  const commonPaths = pathsToCheck.filter((p): p is string => Boolean(p));

  // Also check if bash is available in PATH
  let foundPath: string | null = null;
  let foundInPath = false;

  // Check common install locations
  for (const bashPath of commonPaths) {
    try {
      await fs.access(bashPath);
      foundPath = bashPath;
      
      // Track what we found for diagnostics
      if (bashPath === bundledPath) {
        bundledExists = true;
      } else if (systemPaths.includes(bashPath)) {
        systemGitExists = true;
      }
      break;
    } catch {
      // Continue to next path
    }
  }

  // Check PATH via 'where bash' command
  if (!foundPath) {
    try {
      const result = execSync('where bash', {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (result.trim()) {
        foundPath = result.trim().split('\n')[0].trim();
        foundInPath = true;
        systemGitExists = true;
      }
    } catch {
      // bash not in PATH
    }
  }

  // Check if bundled path exists even if we found system Git first
  if (bundledPath && !bundledExists) {
    try {
      await fs.access(bundledPath);
      bundledExists = true;
    } catch {
      // Bundled Git not present
    }
  }

  // Check if system Git exists even if we found bundled first
  if (!systemGitExists) {
    for (const sysPath of systemPaths) {
      try {
        await fs.access(sysPath);
        systemGitExists = true;
        break;
      } catch {
        // Continue
      }
    }
  }

  if (!foundPath) {
    // Determine the specific failure reason
    let diagnosticCode: GitBashDiagnosticCode;
    
    if (getPlatformConfig().isPackaged && !bundledExists) {
      // Packaged app but bundled Git is missing - likely AV quarantine
      diagnosticCode = 'GIT_BUNDLED_MISSING';
    } else if (!systemGitExists) {
      // No Git installation found anywhere
      diagnosticCode = 'GIT_SYSTEM_NOT_INSTALLED';
    } else {
      // Git exists somewhere but bash.exe specifically is missing
      diagnosticCode = 'GIT_BASH_MISSING';
    }

    return {
      id,
      name,
      status: 'fail',
      message: 'Git Bash not found (required for agent functionality)',
      details: {
        diagnosticCode,
        bundledExpected: getPlatformConfig().isPackaged,
        bundledExists,
        systemGitExists,
      },
      remediation: getPlatformConfig().isPackaged && !bundledExists
        ? 'The bundled Git Bash is missing. Please reinstall the application, or install Git for Windows from https://git-scm.com/downloads/win'
        : 'Install Git for Windows from https://git-scm.com/downloads/win',
    };
  }

  // Verify bash is functional
  try {
    const bashExe = foundPath;
    execSync(`"${bashExe}" -c "echo ok"`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const execError = error as Error & { code?: string };
    const errorType = classifyExecError(execError);
    const isBundledPath = foundPath === bundledPath;
    
    // Determine diagnostic code based on error type
    // Note: We use GIT_BUNDLED_BLOCKED for bundled Git exec failures,
    // but for system Git we still report it as blocked since the symptoms
    // and remediation are similar (security software interference)
    let diagnosticCode: GitBashDiagnosticCode;
    if (errorType === 'timeout') {
      diagnosticCode = 'GIT_EXECUTION_TIMEOUT';
    } else {
      // Both 'blocked' and 'other' error types indicate execution failure
      // Use GIT_BUNDLED_BLOCKED for bundled path (most common case),
      // which provides the most actionable hint about AV interference
      diagnosticCode = 'GIT_BUNDLED_BLOCKED';
    }

    return {
      id,
      name,
      status: 'fail',
      message: 'Git Bash found but not functional',
      details: {
        diagnosticCode,
        path: foundPath,
        isBundled: isBundledPath,
        errorType,
        errorCode: execError.code,
        // Truncate error message - may still contain paths but reduces exposure
        errorSummary: execError.message.substring(0, 200),
      },
      remediation: 'Reinstall Git for Windows or check file permissions.',
    };
  }

  return {
    id,
    name,
    status: 'pass',
    message: foundInPath
      ? 'Git Bash available in PATH'
      : `Git Bash found at ${foundPath}`,
    details: { path: foundPath, inPath: foundInPath },
  };
}

export async function checkPowerShellHealth(): Promise<CheckResult> {
  const id = 'powerShellHealth';
  const name = 'PowerShell';

  if (process.platform !== 'win32') {
    return {
      id,
      name,
      status: 'skip',
      message: 'Not applicable on this platform',
    };
  }

  try {
    const result = execSync(
      'powershell -NoProfile -NonInteractive -Command "Write-Output ok"',
      { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    if (!result.includes('ok')) {
      return {
        id,
        name,
        status: 'fail',
        message: 'PowerShell returned unexpected output',
        details: { output: result.trim().substring(0, 100) },
        remediation: 'Check PowerShell installation and execution policy',
      };
    }

    // Skip Expand-Archive check for packaged apps - it's only needed at build time
    // for bundling Node.js (scripts/bundle-node.mjs). End users don't need it.
    if (!getPlatformConfig().isPackaged) {
      try {
        execSync(
          'powershell -NoProfile -NonInteractive -Command "Get-Command Expand-Archive -ErrorAction Stop"',
          { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
      } catch {
        return {
          id,
          name,
          status: 'warn',
          message: 'Expand-Archive command not available (needed for development builds)',
          remediation: 'PowerShell 5.0+ is required for building the app. Update Windows PowerShell.',
        };
      }
    }

    return {
      id,
      name,
      status: 'pass',
      message: 'PowerShell available and functional',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (message.includes('not recognized') || message.includes('not found') || message.includes('ENOENT')) {
      return {
        id,
        name,
        status: 'fail',
        message: 'PowerShell not found',
        remediation: 'Install or repair Windows PowerShell',
      };
    }

    if (message.includes('restricted') || message.includes('disabled') || message.includes('not be loaded')) {
      return {
        id,
        name,
        status: 'fail',
        message: 'PowerShell execution is restricted',
        remediation: 'Run: Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned',
      };
    }

    if (message.includes('ETIMEDOUT') || message.includes('timeout')) {
      return {
        id,
        name,
        status: 'warn',
        message: 'PowerShell check timed out',
        remediation: 'PowerShell may be slow to start. Try running it manually to diagnose.',
      };
    }

    return {
      id,
      name,
      status: 'fail',
      message: `PowerShell check failed: ${message.substring(0, 100)}`,
      details: { error: message.substring(0, 200) },
      remediation: 'Check PowerShell installation',
    };
  }
}
