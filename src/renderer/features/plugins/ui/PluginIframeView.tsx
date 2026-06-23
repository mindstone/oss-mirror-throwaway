/**
 * Plugin IframeView
 *
 * Sandboxed iframe renderer for rich plugin HTML content.
 * Uses blob URLs and a strict CSP with sandbox="allow-scripts".
 *
 * @see docs/plans/260327_plugin_wave5_infrastructure.md — Stage C2
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  injectCspMeta,
  isMessageFromAllowedSandboxFrame,
  STRICT_CSP,
} from '@renderer/components/sandbox/utilities';
import styles from './PluginIframeView.module.css';

export interface PluginIframeViewProps {
  html: string;
  height?: number | string;
  onMessage?: (data: unknown) => void;
}

function injectStrictCsp(html: string): string {
  return injectCspMeta(html, {
    mode: 'plugin',
    cspString: STRICT_CSP.join('; '),
  });
}

export function IframeView({ html, height = 320, onMessage }: PluginIframeViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const hasContent = html.trim().length > 0;

  const resolvedHeight = useMemo(
    () => (typeof height === 'number' ? `${height}px` : height),
    [height],
  );

  useEffect(() => {
    setLoadError(null);

    if (!hasContent) {
      setBlobUrl(null);
      return;
    }

    const sandboxedHtml = injectStrictCsp(html);
    const blob = new Blob([sandboxedHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);

    setBlobUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [html, hasContent]);

  useEffect(() => {
    if (!onMessage) return;

    const handleMessage = (event: MessageEvent) => {
      if (!isMessageFromAllowedSandboxFrame(event, [iframeRef.current?.contentWindow ?? null], ['null'])) {
        return;
      }
      onMessage(event.data);
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [onMessage]);

  if (!hasContent) {
    return <div className={styles.emptyState}>No content to display.</div>;
  }

  if (loadError) {
    return <div className={styles.emptyState}>{loadError}</div>;
  }

  return (
    <div className={styles.frameContainer} style={{ height: resolvedHeight }}>
      {blobUrl ? (
        <iframe
          ref={iframeRef}
          src={blobUrl}
          className={styles.iframe}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title="Plugin iframe view"
          onError={() => setLoadError('Unable to load iframe content.')}
        />
      ) : (
        <div className={styles.loadingState}>Preparing view...</div>
      )}
    </div>
  );
}
