import type { CloudHealthProbe } from '@core/services/cloud/cloudHealthProbe';

function buildHealthUrl(cloudUrl: string): string {
  return new URL('/api/health', cloudUrl).toString();
}

export const desktopCloudHealthProbe: CloudHealthProbe = {
  async probe({ cloudUrl, timeoutMs, signal }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort(signal?.reason);

    if (signal?.aborted) {
      abortFromCaller();
    } else {
      signal?.addEventListener('abort', abortFromCaller, { once: true });
    }

    try {
      const response = await fetch(buildHealthUrl(cloudUrl), {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = (await response.json()) as {
        status?: string;
        pressure?: { state?: string; oomRecent?: boolean; recentRestart?: boolean };
      };

      let pressure: import('@shared/types/cloudHealth').CloudPressureBasic | undefined;
      if (
        body.pressure &&
        typeof body.pressure.state === 'string' &&
        (body.pressure.state === 'ok' ||
          body.pressure.state === 'warning' ||
          body.pressure.state === 'critical' ||
          body.pressure.state === 'unknown')
      ) {
        pressure = {
          state: body.pressure.state,
          oomRecent: body.pressure.oomRecent ?? false,
          recentRestart: body.pressure.recentRestart ?? false,
        };
      }

      if (body.status === 'ok') {
        return { ok: true, status: response.status, pressure };
      }

      return { ok: false, status: response.status, raw: body, pressure };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  },
};
