import { Loader2 } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import styles from './SettingsSurface.module.css';

interface AccountDisconnectButtonProps {
  label: string;
  isRemoving: boolean;
  disabled?: boolean;
  onClick: (e: React.MouseEvent) => void;
}

/**
 * Shared disconnect button for multi-account connector rows.
 * Shows explicit "Disconnect" text instead of an X icon for clarity.
 * Used by AccountInstancesList and McpAccountsExtension.
 */
export function AccountDisconnectButton({ label, isRemoving, disabled, onClick }: AccountDisconnectButtonProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={isRemoving || disabled}
      aria-label={isRemoving ? `Disconnecting ${label}` : `Disconnect ${label}`}
      className={styles.mcpExtensionItemDisconnect}
    >
      {isRemoving ? (
        <>
          <Loader2 size={12} className={styles.spinnerIcon} />
          Disconnecting...
        </>
      ) : (
        'Disconnect'
      )}
    </Button>
  );
}
