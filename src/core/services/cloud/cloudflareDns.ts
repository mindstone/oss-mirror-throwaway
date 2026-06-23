/**
 * Cloudflare DNS Service
 *
 * Thin wrapper around Cloudflare API v4 for DNS A-record management.
 * Used by cloud-service admin endpoints for DNS cleanup on deprovision.
 * DNS record creation is handled by the VM itself during cloud-init.
 */

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 10_000;

export interface DnsRecordResult {
  success: boolean;
  recordId?: string;
  error?: string;
}

interface CloudflareResponse {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: { id: string };
}

export async function createDnsRecord(params: {
  zoneId: string;
  apiToken: string;
  name: string;
  ip: string;
  comment?: string;
}): Promise<DnsRecordResult> {
  const { zoneId, apiToken, name, ip, comment } = params;
  const url = `${CF_API_BASE}/zones/${zoneId}/dns_records`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'A',
        name,
        content: ip,
        ttl: 60,
        proxied: false,
        ...(comment ? { comment } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const data = (await res.json()) as CloudflareResponse;

    if (!data.success || !data.result?.id) {
      const errMsg = data.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`;
      return { success: false, error: errMsg };
    }

    return { success: true, recordId: data.result.id };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function deleteDnsRecord(params: {
  zoneId: string;
  apiToken: string;
  recordId: string;
}): Promise<{ success: boolean; error?: string }> {
  const { zoneId, apiToken, recordId } = params;
  const url = `${CF_API_BASE}/zones/${zoneId}/dns_records/${recordId}`;

  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const data = (await res.json()) as CloudflareResponse;

    if (!data.success) {
      const errMsg = data.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`;
      return { success: false, error: errMsg };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
