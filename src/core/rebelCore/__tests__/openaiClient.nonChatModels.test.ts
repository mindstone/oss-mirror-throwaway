import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIClient } from '../clients/openaiClient';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

describe('OpenAIClient non-chat model guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects known OpenAI embedding models before calling chat completions', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient({
      provider: 'OpenAI',
      providerType: 'openai',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });

    await expect(
      client.create({
        model: unsafeAssertRoutingModelId('text-embedding-3-large'),
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 100,
      }),
    ).rejects.toThrow('is not a chat model');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects known OpenAI completion-only models before streaming chat completions', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient({
      provider: 'OpenAI',
      providerType: 'openai',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });

    await expect(
      client.stream(
        {
          model: unsafeAssertRoutingModelId('gpt-3.5-turbo-instruct'),
          systemPrompt: '',
          messages: [{ role: 'user', content: 'hello' }],
          maxTokens: 100,
        },
        vi.fn(),
      ),
    ).rejects.toThrow('is not a chat model');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks Codex connection before sending subscription requests', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient({
      provider: 'Codex',
      providerType: 'openai',
      codexMode: {
        endpointUrl: 'https://chatgpt.com/backend-api/codex',
        isConnected: () => false,
        getAccessToken: vi.fn(async () => null),
        getAccountId: vi.fn(() => null),
        forceRefreshToken: vi.fn(async () => null),
      },
    });

    await expect(
      client.create({
        model: unsafeAssertRoutingModelId('gpt-5.3-codex'),
        systemPrompt: '',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 100,
      }),
    ).rejects.toThrow('Open Settings → AI Providers → ChatGPT');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows an actionable reconnect message when Codex token lookup fails', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenAIClient({
      provider: 'Codex',
      providerType: 'openai',
      codexMode: {
        endpointUrl: 'https://chatgpt.com/backend-api/codex',
        isConnected: () => true,
        getAccessToken: vi.fn(async () => null),
        getAccountId: vi.fn(() => null),
        forceRefreshToken: vi.fn(async () => null),
      },
    });

    await expect(
      client.stream(
        {
          model: unsafeAssertRoutingModelId('gpt-5.3-codex'),
          systemPrompt: '',
          messages: [{ role: 'user', content: 'hello' }],
          maxTokens: 100,
        },
        vi.fn(),
      ),
    ).rejects.toThrow('Open Settings → AI Providers → ChatGPT');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
