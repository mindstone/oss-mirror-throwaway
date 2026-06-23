/**
 * Native Architecture Detection
 *
 * Detects the true CPU architecture even when running under emulation
 * (Rosetta on macOS, Windows ARM x64 emulation).
 *
 * This enables auto-migration of users who installed the wrong architecture
 * build to the correct native version on their next update.
 */

import os from 'os';

/**
 * Get the native CPU architecture, even when running under emulation.
 *
 * Uses os.machine() (Node 18.9+) which returns the actual hardware architecture,
 * not the emulated one. Falls back to process.arch if unavailable.
 *
 * @example
 * // On Apple Silicon running x64 binary via Rosetta:
 * process.arch     // 'x64'
 * getNativeArch()  // 'arm64'
 *
 * @returns The native architecture in Electron format ('arm64', 'x64', etc.)
 */
export function getNativeArch(): string {
  try {
    // os.machine() returns native CPU architecture (Node 18.9+)
    // e.g., 'arm64' on Apple Silicon even when running x64 binary via Rosetta
    const nativeMachine = os.machine?.();
    if (nativeMachine) {
      // Normalize to lowercase for case-insensitive matching
      const normalized = nativeMachine.toLowerCase();
      // Map native values to Electron arch format
      if (normalized === 'arm64' || normalized === 'aarch64') return 'arm64';
      if (normalized === 'x86_64' || normalized === 'x64' || normalized === 'amd64') return 'x64';
      // For other values (e.g., 'i386', 'i686'), fall through to process.arch
    }
  } catch {
    // os.machine() not available or failed - fall back to process.arch
  }
  return process.arch;
}

/**
 * Check if the running binary architecture differs from native.
 * Useful for detecting Rosetta/emulation scenarios.
 */
export function isRunningUnderEmulation(): boolean {
  return getNativeArch() !== process.arch;
}
