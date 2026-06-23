const RECALL_REST_BASE = 'https://us-west-2.recall.ai/api/v1';

export interface RecallApiKeyTestResult {
  success: boolean;
  message?: string;
  error?: string;
  recoverable?: boolean;
}

export async function testRecallApiKey(apiKey: string): Promise<RecallApiKeyTestResult> {
  const trimmedKey = apiKey.trim();

  if (!trimmedKey) {
    return {
      success: false,
      recoverable: true,
      error: 'Add a Recall API key, then try again. Nothing was saved.',
    };
  }

  try {
    const response = await fetch(`${RECALL_REST_BASE}/sdk_upload/`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        Authorization: `Token ${trimmedKey}`,
      },
    });

    if (response.ok) {
      return {
        success: true,
        message: 'Connected. New recordings will go straight to your Recall account.',
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        recoverable: true,
        error: 'That key did not work. Recall rejected it, so nothing was saved. Check you copied the whole key from your Recall dashboard, then try again.',
      };
    }

    return {
      success: false,
      recoverable: true,
      error: 'Could not check that key with Recall. Recall answered unexpectedly, so nothing was saved. Try again in a minute.',
    };
  } catch {
    return {
      success: false,
      recoverable: true,
      error: 'Could not reach Recall to check the key. Check your connection and try again. Nothing was saved.',
    };
  }
}
