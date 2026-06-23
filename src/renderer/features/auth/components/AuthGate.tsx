import { type ReactNode, type ReactElement } from 'react';
import { useAuth } from '../hooks/useAuth';
import { LoginScreen } from './LoginScreen';
import styles from './AuthGate.module.css';

interface AuthGateProps {
  children: ReactNode;
}

/**
 * Auth gate component that wraps the app.
 * Shows the login screen when not authenticated, otherwise renders children.
 */
export function AuthGate({ children }: AuthGateProps): ReactElement {
  const { isAuthenticated, isLoading, isGuestMode, login, skipAuth } = useAuth();

  // Show loading state while checking auth
  if (isLoading) {
    return (
      <div className={styles.loading} data-testid="auth-gate-loading">
        <div className={styles.loadingSpinner} />
      </div>
    );
  }

  // Show login screen when not authenticated and not in guest mode
  if (!isAuthenticated && !isGuestMode) {
    return <LoginScreen onLogin={login} onSkip={skipAuth} />;
  }

  // Render app when authenticated
  return <>{children}</>;
}
