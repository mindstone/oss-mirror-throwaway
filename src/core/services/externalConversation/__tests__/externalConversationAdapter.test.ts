/**
 * @intent-marker Unified External Conversation Architecture Stage 1
 *
 * Contract tests for the adapter interface, DeliveryResult discriminator,
 * WebhookAuthError, and resumePendingDeliveries presence.
 *
 * Invariants (per docs/plans/260502_unified_external_conversation_architecture.md):
 *  - Transport-agnostic core (§3 invariant 2)
 *  - Cross-surface parity (§3 invariant 5)
 *  - Provenance on every cross-surface broadcast (§3 Spec Reader)
 *  - Adapter-shaped extension point (§2 success criteria)
 *  - D5: Four-state DeliveryResult, observable, never silent
 *  - D5: resumePendingDeliveries is mandatory (persistence-before-send)
 *
 * @see docs/plans/260502_unified_external_conversation_architecture.md §5 D5
 */

import { describe, expect, it } from 'vitest';
import {
  WebhookAuthError,
  type DeliveryResult,
  type ExternalConversationAdapter,
} from '../externalConversationAdapter';
import type { SlackThreadContext } from '../externalContext';

describe('DeliveryResult discriminator', () => {
  it('narrows on `delivered`', () => {
    const r: DeliveryResult = { status: 'delivered' };
    if (r.status === 'delivered') {
      expect(r.status).toBe('delivered');
    } else {
      expect.fail('Should narrow to delivered');
    }
  });

  it('narrows on `pending-confirmation` with required fields', () => {
    const r: DeliveryResult = {
      status: 'pending-confirmation',
      reason: 'awaiting Slack chunk receipt',
      confirmationDeadline: Date.now() + 60_000,
    };
    if (r.status === 'pending-confirmation') {
      expect(r.reason).toBeTruthy();
      expect(typeof r.confirmationDeadline).toBe('number');
    } else {
      expect.fail('Should narrow to pending-confirmation');
    }
  });

  it('narrows on `transient-failure`', () => {
    const r: DeliveryResult = {
      status: 'transient-failure',
      reason: 'rate limited',
      retryAt: Date.now() + 2_000,
    };
    if (r.status === 'transient-failure') {
      expect(r.reason).toBe('rate limited');
      expect(typeof r.retryAt).toBe('number');
    } else {
      expect.fail('Should narrow to transient-failure');
    }
  });

  it('narrows on `permanent-failure` with userActionable flag', () => {
    const r: DeliveryResult = {
      status: 'permanent-failure',
      reason: 'token revoked',
      userActionable: true,
    };
    if (r.status === 'permanent-failure') {
      expect(r.userActionable).toBe(true);
    } else {
      expect.fail('Should narrow to permanent-failure');
    }
  });

  it('exhaustively covers all four states', () => {
    const states: DeliveryResult['status'][] = [
      'delivered',
      'pending-confirmation',
      'transient-failure',
      'permanent-failure',
    ];
    expect(states).toHaveLength(4);
  });
});

describe('WebhookAuthError', () => {
  it('is a typed Error with code and userActionable', () => {
    const err = new WebhookAuthError('signature mismatch', 'INVALID_SIGNATURE', false);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WebhookAuthError);
    expect(err.name).toBe('WebhookAuthError');
    expect(err.code).toBe('INVALID_SIGNATURE');
    expect(err.userActionable).toBe(false);
    expect(err.message).toBe('signature mismatch');
  });

  it('carries userActionable=true for reauth-class errors', () => {
    const err = new WebhookAuthError('Slack token revoked', 'TOKEN_REVOKED', true);
    expect(err.userActionable).toBe(true);
  });
});

describe('ExternalConversationAdapter interface shape', () => {
  it('mandatory methods exist on a minimal implementation', () => {
    const adapter: ExternalConversationAdapter<SlackThreadContext> = {
      kind: 'slack-thread',
      async deliverResponse() {
        return { status: 'delivered' };
      },
      getContextTools() {
        return [];
      },
      async resumePendingDeliveries() {
        // No-op for this minimal adapter.
      },
    };

    expect(adapter.kind).toBe('slack-thread');
    expect(typeof adapter.deliverResponse).toBe('function');
    expect(typeof adapter.getContextTools).toBe('function');
    // resumePendingDeliveries is mandatory (per D5 persistence invariant) — not optional.
    expect(typeof adapter.resumePendingDeliveries).toBe('function');
    // verifyInbound and renderAttribution are optional.
    expect(adapter.verifyInbound).toBeUndefined();
    expect(adapter.renderAttribution).toBeUndefined();
  });

  it('verifyInbound when present accepts rawBody and headers', async () => {
    const adapter: ExternalConversationAdapter<SlackThreadContext> = {
      kind: 'slack-thread',
      async deliverResponse() {
        return { status: 'delivered' };
      },
      getContextTools() {
        return [];
      },
      async resumePendingDeliveries() {
        /* no-op */
      },
      async verifyInbound() {
        return {
          kind: 'slack-thread',
          identity: { teamId: 'T', channelId: 'C', threadTs: 'ts' },
          metadata: {},
        };
      },
    };

    expect(typeof adapter.verifyInbound).toBe('function');
    const headers = { get: () => null };
    const ctx = await adapter.verifyInbound!(Buffer.from(''), headers);
    expect(ctx.kind).toBe('slack-thread');
  });
});
