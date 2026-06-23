/**
 * PluginRenderer
 *
 * Reusable component that compiles plugin TSX source and renders the result.
 * Handles loading states, compile errors, runtime errors (via error boundary),
 * and provides PluginContext to the rendered component.
 *
 * Extracted from PluginSurface.tsx to support multiple rendering contexts
 * (main-pane tabs, homepage widgets, etc.).
 *
 * @see docs/plans/260327_plugin_wave5_infrastructure.md — Stage C1
 */

import { Component, useEffect, useMemo, useState, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { loadPlugin } from '../runtime/pluginLoader';
import { recordPluginCrash } from '../runtime/pluginDiagnostics';
import type { PluginCompileError } from '../compiler/types';
import { PluginContext } from '../api/PluginContext';

// ── Error Boundary ──────────────────────────────────────────────────────

interface PluginErrorBoundaryProps {
  pluginId: string;
  revision: number;
  children: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface PluginErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  lastRevision: number;
}

export class PluginErrorBoundary extends Component<PluginErrorBoundaryProps, PluginErrorBoundaryState> {
  constructor(props: PluginErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, lastRevision: props.revision };
  }

  static getDerivedStateFromProps(props: PluginErrorBoundaryProps, state: PluginErrorBoundaryState): Partial<PluginErrorBoundaryState> | null {
    if (props.revision !== state.lastRevision) {
      return { hasError: false, error: null, lastRevision: props.revision };
    }
    return null;
  }

  static getDerivedStateFromError(error: Error): Partial<PluginErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[PluginRenderer] Plugin "${this.props.pluginId}" crashed:`, error, errorInfo.componentStack);
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      return (
        <div style={{ padding: '1rem' }}>
          <div style={{ color: 'var(--color-error, #dc2626)', border: '1px solid var(--color-error, #dc2626)', borderRadius: '8px', padding: '1rem' }}>
            <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.875rem', fontWeight: 600 }}>Plugin crashed</h3>
            <p style={{ margin: '0 0 0.75rem', fontSize: '0.8rem', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
              {this.state.error.message}
            </p>
            <button
              type="button"
              onClick={this.handleRetry}
              style={{ padding: '0.25rem 0.5rem', borderRadius: '6px', border: '1px solid var(--color-border, #e2e8f0)', cursor: 'pointer', fontSize: '0.8rem', background: 'var(--color-bg, transparent)' }}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Compile Error Display ───────────────────────────────────────────────

export function CompileErrorDisplay({ errors, pluginId, compact }: { errors: PluginCompileError[]; pluginId: string; compact?: boolean }) {
  const padding = compact ? '0.75rem' : '2rem';
  const fontSize = compact ? '0.8rem' : '0.875rem';
  return (
    <div style={{ padding }}>
      <div style={{ color: 'var(--color-error, #dc2626)', border: '1px solid var(--color-error, #dc2626)', borderRadius: '8px', padding: '1rem' }}>
        <h3 style={{ margin: '0 0 0.5rem', fontSize, fontWeight: 600 }}>
          Plugin &ldquo;{pluginId}&rdquo; failed to compile
        </h3>
        {errors.map((err, i) => (
          <div key={i} style={{ marginBottom: '0.5rem' }}>
            <p style={{ margin: '0', fontSize: compact ? '0.75rem' : '0.875rem', fontFamily: 'monospace' }}>
              {err.line != null ? `Line ${err.line}: ` : ''}{err.message}
            </p>
            {!compact && err.snippet && (
              <pre style={{ margin: '0.25rem 0 0', padding: '0.5rem', background: 'var(--color-bg-secondary, #f1f5f9)', borderRadius: '4px', fontSize: '0.8rem', overflow: 'auto' }}>
                {err.snippet}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────

export interface PluginRendererProps {
  pluginId: string;
  source?: string;
  /** Compact mode for smaller rendering contexts like widgets */
  compact?: boolean;
  /** Custom loading fallback — replaces default "Compiling plugin..." */
  loadingFallback?: ReactNode;
  /** Custom empty state fallback — replaces default "No plugin source" */
  emptyFallback?: ReactNode;
}

export function PluginRenderer({ pluginId, source, compact, loadingFallback, emptyFallback }: PluginRendererProps) {
  const [loadedComponent, setLoadedComponent] = useState<ComponentType | null>(null);
  const [compileErrors, setCompileErrors] = useState<PluginCompileError[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!source) {
      setLoadedComponent(null);
      setCompileErrors(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setCompileErrors(null);

    loadPlugin(source, pluginId).then(result => {
      if (cancelled) return;
      if (result.ok) {
        setLoadedComponent(() => result.component);
        setCompileErrors(null);
        setRevision(result.revision);
      } else {
        setLoadedComponent(null);
        setCompileErrors(result.errors);
      }
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [source, pluginId]);

  const PluginComponent = loadedComponent;
  const textSize = compact ? '0.8rem' : '0.875rem';
  const padding = compact ? '1rem' : '2rem';

  return useMemo(() => {
    if (loading) {
      return loadingFallback ?? (
        <div style={{ padding, textAlign: 'center', color: 'var(--color-text-secondary, #64748b)', fontSize: textSize }}>
          Compiling plugin…
        </div>
      );
    }

    if (compileErrors) {
      return <CompileErrorDisplay errors={compileErrors} pluginId={pluginId} compact={compact} />;
    }

    if (!PluginComponent) {
      if (!source) {
        return emptyFallback ?? (
          <div style={{ padding, textAlign: 'center', color: 'var(--color-text-secondary, #64748b)', fontSize: textSize }}>
            No plugin source provided.
          </div>
        );
      }
      return (
        <div style={{ padding, textAlign: 'center', color: 'var(--color-text-secondary, #64748b)', fontSize: textSize }}>
          Plugin loaded but has no component to render.
        </div>
      );
    }

    return (
      <PluginContext.Provider value={{ pluginId }}>
        <PluginErrorBoundary
          pluginId={pluginId}
          revision={revision}
          onError={(error, errorInfo) => {
            recordPluginCrash(pluginId, error, errorInfo.componentStack);
          }}
        >
          <PluginComponent />
        </PluginErrorBoundary>
      </PluginContext.Provider>
    );
  }, [loading, compileErrors, PluginComponent, pluginId, source, revision, compact, loadingFallback, emptyFallback, padding, textSize]);
}
