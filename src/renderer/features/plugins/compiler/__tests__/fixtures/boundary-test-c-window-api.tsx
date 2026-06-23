/**
 * Boundary Test C: Accessing window.api for direct IPC
 *
 * Tests whether a plugin can access window.api to call Rebel's IPC
 * directly, bypassing the plugin API. Expected: compile FAILS
 * because `window` is blocked by the AST validator (Layer 1 API
 * surface lockdown).
 */
import { useState } from 'react';
import { Card, Stack, Button } from '@rebel/plugin-ui';

declare const window: {
  api?: {
    getVersion?: () => Promise<string>;
    getAppSettings?: () => Promise<Record<string, unknown>>;
  };
};

export default function WindowApiPlugin() {
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tryGetVersion = () => {
    try {
      if (typeof window !== 'undefined' && window.api && window.api.getVersion) {
        window.api.getVersion().then(
          (v: string) => setVersion(v),
          (e: Error) => setError(e.message),
        );
      } else {
        setError('window.api is not available in plugin scope');
      }
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Stack gap="sm">
      <div style={{ padding: '1rem' }}>
        <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Window API Test</h2>
      </div>
      <div style={{ padding: '0 1rem 1rem' }}>
        <Card>
          {version && <p style={{ fontSize: '0.875rem' }}>App version: {version}</p>}
          {error && <p style={{ fontSize: '0.8125rem', color: 'orange' }}>{error}</p>}
          <Button onClick={tryGetVersion}>Try window.api</Button>
        </Card>
      </div>
    </Stack>
  );
}
