import { describe, expect, it } from 'vitest';
import { captureAnthropicResponseMetadata } from '../anthropicClient';

describe('captureAnthropicResponseMetadata', () => {
  it('preserves OpenRouter provider capture on OR responses', async () => {
    const response = new Response(
      JSON.stringify({
        usage: { cost: 0.0234 },
        provider: 'DeepInfra',
        model: 'anthropic/claude-sonnet-4-6',
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-rebel-or-provider': 'Fireworks',
        },
      },
    );

    const captured = await captureAnthropicResponseMetadata(response, {
      isOpenRouterPassthrough: true,
    });

    expect(captured.responseCost).toBe(0.0234);
    expect(captured.responseProvider).toBe('Fireworks');
    expect(captured.fulfillmentProvider).toBeUndefined();
  });

  it('captures anthropic-direct server hints from allowlisted headers', async () => {
    const response = new Response(
      JSON.stringify({
        model: 'claude-sonnet-4-6',
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cf-ray': 'ray-123',
          'x-served-by': 'iad-1',
        },
      },
    );

    const captured = await captureAnthropicResponseMetadata(response, {
      isOpenRouterPassthrough: false,
    });

    expect(captured.fulfillmentProvider).toEqual({
      name: null,
      transport: 'anthropic-direct',
      source: 'response-headers-hints',
      serverHints: {
        'cf-ray': 'ray-123',
        'x-served-by': 'iad-1',
      },
    });
  });

  it('uses response-body-echo source for anthropic-direct responses without hints', async () => {
    const response = new Response(
      JSON.stringify({
        model: 'claude-sonnet-4-6',
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    );

    const captured = await captureAnthropicResponseMetadata(response, {
      isOpenRouterPassthrough: false,
    });

    expect(captured.fulfillmentProvider).toEqual({
      name: null,
      transport: 'anthropic-direct',
      source: 'response-body-echo',
    });
  });

  it('does not leak organization-id or request-id headers even when present', async () => {
    const response = new Response(
      JSON.stringify({
        model: 'claude-sonnet-4-6',
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cf-ray': 'ray-123',
          'anthropic-organization-id': 'org-secret-leak',
          'x-request-id': 'req-abc-123',
          authorization: 'Bearer should-never-be-captured',
        },
      },
    );

    const captured = await captureAnthropicResponseMetadata(response, {
      isOpenRouterPassthrough: false,
    });

    const hints = captured.fulfillmentProvider?.serverHints;
    expect(hints).toBeDefined();
    expect(hints && 'anthropic-organization-id' in hints).toBe(false);
    expect(hints && 'x-request-id' in hints).toBe(false);
    expect(hints && 'authorization' in hints).toBe(false);
    expect(hints?.['cf-ray']).toBe('ray-123');
  });
});
