/**
 * Network Health Checks
 */

import type { CheckResult } from '@core/services/health/types';
import { safeCheck } from '@core/services/health/utils';

// Timeout for network health checks
// Windows often needs more time due to antivirus scanning, DNS, and firewall checks
const NETWORK_CHECK_TIMEOUT_MS = 15000;

export async function checkAnthropicReachable(): Promise<CheckResult> {
  return safeCheck(
    async (signal) => {
      const id = 'anthropicReachable';
      const name = 'Anthropic API';

      try {
        const response = await fetch('https://api.anthropic.com/', {
          method: 'HEAD',
          signal,
        });

        return {
          id,
          name,
          status: 'pass',
          message: 'Anthropic API reachable',
          details: { statusCode: response.status },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const isTimeout = message.includes('abort') || message.includes('timeout');
        
        if (isTimeout) {
          throw new Error(`Health check timed out after ${NETWORK_CHECK_TIMEOUT_MS}ms`);
        }
        
        return {
          id,
          name,
          status: 'fail',
          message: `Cannot reach Anthropic API: ${message}`,
          remediation: 'Check your internet connection and firewall settings',
        };
      }
    },
    'anthropicReachable',
    'Anthropic API',
    { timeoutMs: NETWORK_CHECK_TIMEOUT_MS }
  );
}


