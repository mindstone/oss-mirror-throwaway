/**
 * User profile tool — Stage 6.
 *
 * Plan: docs/plans/260515_mixpanel_mcp.md
 */
import { z } from 'zod';

import { MixpanelClient, redactUrlTokensDeep } from '../client.js';
import { MixpanelError } from '../types.js';

export const getUserProfileSchema = z.object({
  distinct_id: z.string().optional().describe('Mixpanel distinct_id. One of distinct_id or email required.'),
  email: z.string().email().optional().describe('User email. One of distinct_id or email required.'),
});

export type GetUserProfileArgs = z.infer<typeof getUserProfileSchema>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const errorToResponse = (err: unknown): Record<string, unknown> => {
  if (err instanceof MixpanelError) {
    return {
      ok: false,
      code: err.code,
      error: err.message,
      resolution: err.resolution,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, code: 'API_ERROR', error: message, resolution: 'Try again.' };
};

export async function mixpanelGetUserProfile(client: MixpanelClient, args: GetUserProfileArgs): Promise<string> {
  if (!args.distinct_id && !args.email) {
    return JSON.stringify({
      ok: false,
      code: 'CONFIG_MISSING',
      error: 'Either distinct_id or email is required.',
      resolution: 'Provide a distinct_id or email.',
    });
  }

  try {
    const result = await client.getEngageProfile({ distinctId: args.distinct_id, email: args.email });
    const redacted = redactUrlTokensDeep(result);
    if (!isRecord(redacted)) {
      return JSON.stringify({
        ok: false,
        code: 'RESPONSE_INVALID',
        error: 'Mixpanel returned an unexpected engage response shape.',
        resolution: 'Try again.',
      });
    }
    const results = Array.isArray(redacted.results) ? redacted.results : [];
    if (results.length === 0) {
      return JSON.stringify({
        ok: true,
        no_match: true,
        count: 0,
        summary: `No Mixpanel profile found for ${args.distinct_id ?? args.email}.`,
      });
    }
    const first = isRecord(results[0]) ? results[0] : {};
    const props = isRecord(first.$properties) ? first.$properties : {};
    const lastSeen = typeof props.$last_seen === 'string' ? props.$last_seen : undefined;
    const name = typeof props.$name === 'string' ? props.$name : undefined;
    const email = typeof props.$email === 'string' ? props.$email : undefined;
    return JSON.stringify({
      ok: true,
      summary: {
        distinct_id: first.$distinct_id ?? null,
        name: name ?? null,
        email: email ?? null,
        last_seen: lastSeen ?? null,
        property_count: Object.keys(props).length,
      },
      count: results.length,
      data: results,
    });
  } catch (err) {
    return JSON.stringify(errorToResponse(err));
  }
}
