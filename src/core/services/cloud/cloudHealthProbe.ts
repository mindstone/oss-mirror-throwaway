import type { CloudPressureBasic } from '@shared/types/cloudHealth';

export interface CloudHealthProbeResult {
  ok: boolean;
  status?: number;
  raw?: unknown;
  /** Pressure observation parsed from the basic /api/health response body.
   *  Absent when the cloud predates the 'cloud-resource-pressure' capability. */
  pressure?: CloudPressureBasic;
}

export interface CloudHealthProbe {
  probe(args: { cloudUrl: string; timeoutMs: number; signal?: AbortSignal }): Promise<CloudHealthProbeResult>;
}
