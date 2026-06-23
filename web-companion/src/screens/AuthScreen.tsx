// web-companion/src/screens/AuthScreen.tsx

import { useState, useCallback } from 'react';
import { useAuthStore } from '@rebel/cloud-client';
import { fireAndForget } from '../utils/fireAndForget';

export function AuthScreen() {
  const { pair, isValidating, error, clearError } = useAuthStore();
  const [urlInput, setUrlInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');

  const canConnect = urlInput.trim().length > 0 && tokenInput.trim().length > 0 && !isValidating;

  const handleConnect = useCallback(() => {
    if (!canConnect) return;
    fireAndForget(pair(urlInput, tokenInput), 'AuthScreen:handleConnect:pair');
  }, [canConnect, urlInput, tokenInput, pair]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && canConnect) {
        handleConnect();
      }
    },
    [canConnect, handleConnect],
  );

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-header">
          <h1 className="auth-title">Rebel</h1>
          <p className="auth-subtitle">Let&apos;s get you paired</p>
        </div>

        {error && (
          <div className="auth-error" data-testid="auth-error">
            <p>{error}</p>
          </div>
        )}

        <div className="auth-form">
          <div className="auth-field">
            <label className="auth-label" htmlFor="auth-url">
              Cloud URL
            </label>
            <input
              id="auth-url"
              className="auth-input"
              data-testid="auth-url-input"
              type="url"
              value={urlInput}
              onChange={(e) => {
                setUrlInput(e.target.value);
                clearError();
              }}
              onKeyDown={handleKeyDown}
              placeholder="https://your-rebel-cloud.fly.dev"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="auth-token">
              Access Token
            </label>
            <input
              id="auth-token"
              className="auth-input"
              data-testid="auth-token-input"
              type="password"
              value={tokenInput}
              onChange={(e) => {
                setTokenInput(e.target.value);
                clearError();
              }}
              onKeyDown={handleKeyDown}
              placeholder="Your bridge token"
            />
          </div>

          <button
            className="auth-button"
            data-testid="auth-connect-button"
            onClick={handleConnect}
            disabled={!canConnect}
          >
            {isValidating ? (
              <span className="auth-button-loading">
                <span className="loading-spinner small" />
                Connecting…
              </span>
            ) : (
              'Connect'
            )}
          </button>
        </div>

        <p className="auth-hint">
          Scan the QR code from Rebel&apos;s Cloud settings. Or type, if you prefer the manual approach.
          <span className="auth-attribution">
            Rebel by{' '}
            <a
              href="https://www.mindstone.com"
              target="_blank"
              rel="noopener noreferrer"
              className="auth-attribution-link"
            >
              Mindstone
            </a>
          </span>
        </p>
      </div>
    </div>
  );
}
