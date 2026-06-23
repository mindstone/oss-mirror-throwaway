import { Component, type ErrorInfo, type ReactNode } from 'react';
import { captureRendererException, recordRendererBreadcrumb } from '@renderer/src/sentry';
import { Button } from '@renderer/components/ui';
import styles from './SurfaceErrorBoundary.module.css';

type SurfaceErrorBoundaryProps = {
  /** Identifier for logging/reporting */
  surfaceName: string;
  /** Content to render */
  children: ReactNode;
  /** Optional custom fallback; receives error and reset callback */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Called when an error is caught */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
};

type SurfaceErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
};

/**
 * Error boundary for individual app surfaces (Session, Workspace, Tasks, etc.).
 * Isolates crashes to the affected surface, allowing the rest of the app to remain functional.
 *
 * @example
 * <SurfaceErrorBoundary surfaceName="workspace">
 *   <WorkspaceSurface />
 * </SurfaceErrorBoundary>
 */
export class SurfaceErrorBoundary extends Component<SurfaceErrorBoundaryProps, SurfaceErrorBoundaryState> {
  constructor(props: SurfaceErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): SurfaceErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const { surfaceName, onError } = this.props;

    recordRendererBreadcrumb({
      category: 'surface.error',
      level: 'error',
      message: `Error in ${surfaceName} surface`,
      data: {
        surfaceName,
        componentStack: errorInfo.componentStack
      }
    });

    captureRendererException(error, {
      tags: {
        surface: surfaceName,
        errorBoundary: 'SurfaceErrorBoundary'
      },
      extra: {
        componentStack: errorInfo.componentStack
      }
    });

    onError?.(error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    const { hasError, error } = this.state;
    const { surfaceName, children, fallback } = this.props;

    if (hasError && error) {
      if (fallback) {
        return fallback(error, this.handleReset);
      }

      return (
        <div className={styles.fallback}>
          <div className={styles.content}>
            <h3 className={styles.title}>
              {surfaceName} ran into trouble
            </h3>
            <p className={styles.message}>
              {error.message || "Something went sideways here — the rest of the app is fine."}
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={this.handleReset}
            >
              Try again
            </Button>
          </div>
        </div>
      );
    }

    return children;
  }
}
