/**
 * Cloud Health Check
 *
 * Probes the cloud service's detailed health endpoint and aggregates results.
 * Uses the shared CheckResult type from @core so desktop and cloud health
 * results are directly mergeable in diagnostic bundles.
 */

import type { CheckResult } from '@core/services/health/types';
import type { AppSettings } from '@shared/types';
import type { CloudPressureDetailed } from '@shared/types/cloudHealth';

interface CloudHealthResponse {
  status: string;
  version: string;
  uptime: number;
  checks?: CheckResult[];
  pressure?: CloudPressureDetailed;
}

export async function checkCloudServiceHealth(settings: AppSettings): Promise<CheckResult> {
  const cloudUrl = settings.cloudInstance?.cloudUrl;
  const cloudToken = settings.cloudInstance?.cloudToken;

  if (!cloudUrl || !cloudToken) {
    return { id: 'cloudServiceHealth', name: 'Cloud Service', status: 'skip', message: 'Cloud not configured' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${cloudUrl.replace(/\/+$/, '')}/api/health?detailed=true`, {
      headers: { Authorization: `Bearer ${cloudToken}` },
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        id: 'cloudServiceHealth',
        name: 'Cloud Service',
        status: 'fail',
        message: `Cloud returned HTTP ${res.status}`,
        remediation: 'Check that your cloud instance is running and the token is valid.',
      };
    }

    const data = (await res.json()) as CloudHealthResponse;
    const checks = data.checks || [];

    const failures = checks.filter(c => c.status === 'fail');
    const warnings = checks.filter(c => c.status === 'warn');

    if (failures.length > 0) {
      return {
        id: 'cloudServiceHealth',
        name: 'Cloud Service',
        status: 'fail',
        message: `Cloud has ${failures.length} failing check(s): ${failures.map(c => c.name).join(', ')}`,
        details: { cloudStatus: data.status, version: data.version, uptime: data.uptime, checks, pressure: data.pressure },
        remediation: failures[0].remediation || 'Check the cloud instance diagnostics for details.',
      };
    }

    if (warnings.length > 0) {
      return {
        id: 'cloudServiceHealth',
        name: 'Cloud Service',
        status: 'warn',
        message: `Cloud has ${warnings.length} warning(s): ${warnings.map(c => c.name).join(', ')}`,
        details: { cloudStatus: data.status, version: data.version, uptime: data.uptime, checks, pressure: data.pressure },
      };
    }

    return {
      id: 'cloudServiceHealth',
      name: 'Cloud Service',
      status: 'pass',
      message: `Cloud healthy (v${data.version}, uptime ${Math.round(data.uptime)}s, ${checks.length} checks passed)`,
      details: { cloudStatus: data.status, version: data.version, uptime: data.uptime, checks, pressure: data.pressure },
    };
  } catch (err) {
    const message = err instanceof Error && err.name === 'AbortError'
      ? 'Cloud health check timed out (8s)'
      : `Could not reach cloud: ${err instanceof Error ? err.message : String(err)}`;

    return {
      id: 'cloudServiceHealth',
      name: 'Cloud Service',
      status: 'warn',
      message,
      remediation: 'Check your internet connection and cloud instance status.',
    };
  } finally {
    clearTimeout(timeout);
  }
}
