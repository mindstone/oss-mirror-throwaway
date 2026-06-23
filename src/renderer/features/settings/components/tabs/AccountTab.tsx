import { useCallback, useMemo } from 'react';
import { Button, Input } from '@renderer/components/ui';
import { LogOut, User } from 'lucide-react';
import { useAuth } from '@renderer/features/auth/hooks/useAuth';
import type { AppSettings } from '@shared/types';
import { validateAttributionName } from '@shared/schemas/contributionRelay';
import type { UpdateRoot } from './types';
import styles from '../SettingsSurface.module.css';
import { SettingRow } from '../SettingRow';
import { SettingSection } from '../SettingSection';

export type AccountTabProps = {
  draftSettings: AppSettings;
  updateDraft: UpdateRoot;
};

/**
 * Account settings tab - displays user info, editable display name, and sign out option.
 */
export const AccountTab = ({ draftSettings, updateDraft }: AccountTabProps) => {
  const { user, logout, isGuestMode, exitGuestMode } = useAuth();

  const handleSignOut = useCallback(async () => {
    try {
      await logout();
    } catch {
      // Ignore logout errors - UI state already updated
    }
  }, [logout]);

  const handleExitGuestMode = useCallback(() => {
    exitGuestMode();
  }, [exitGuestMode]);

  // Stage 6.1 M2 (260420 OSS MCP backend relay): surface the contribution-relay's
  // attributionName validation inline so users with names like "O'Brien" or
  // "Smith, Jr." see the problem here rather than at the end of a connector
  // submit. Only flags an error when the user has actually typed something
  // invalid — empty input is allowed (falls back to user.name at picker time).
  // 80/20 scope: visual feedback only; we don't block typing or gate save —
  // the relay schema is the backstop at submit time. Hook must be called
  // unconditionally (before early returns) to satisfy Rules of Hooks; the
  // computed value is only consumed in the authenticated branch below.
  const userFirstNameError = useMemo<string | null>(() => {
    const draft = draftSettings.userFirstName;
    if (draft === null || draft === undefined || draft.trim() === '') return null;
    return validateAttributionName(draft);
  }, [draftSettings.userFirstName]);

  // Guest mode UI
  if (isGuestMode && !user) {
    return (
      <SettingSection
        title="Guest Mode"
        description="You're currently using Rebel as a guest. Sign in to sync your settings and access all features."
      >
        <SettingRow
          label="Account access"
          description="Exit guest mode to sign in with your account."
          variant="stacked"
        >
          <Button onClick={handleExitGuestMode}>
            <LogOut size={16} />
            Exit Guest Mode
          </Button>
        </SettingRow>
      </SettingSection>
    );
  }

  // Not authenticated
  if (!user) {
    return (
      <SettingSection
        title="Account"
        description="Sign in to access your account."
      >
        {null}
      </SettingSection>
    );
  }

  // Authenticated user UI
  const initials = user.name
    ? user.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    : user.email[0].toUpperCase();

  return (
    <>
      <SettingSection
        title="Profile"
        description="Manage your account settings and profile details."
        data-section="profile"
        data-testid="settings-section-account-profile"
      >
        <div className={styles.accountProfile}>
          <div className={styles.accountAvatar}>
            {user.image ? (
              <img 
                src={user.image} 
                alt="" 
                className={styles.accountAvatarImage}
                referrerPolicy="no-referrer" 
              />
            ) : (
              <div className={styles.accountAvatarFallback}>
                {initials || <User size={24} />}
              </div>
            )}
          </div>
          <div className={styles.accountInfo}>
            {user.name && (
              <span className={styles.accountName}>{user.name}</span>
            )}
            <span className={styles.accountEmail}>{user.email}</span>
          </div>
        </div>

        <SettingRow
          label="Your name"
          description="Used for greetings, meeting bot speaker detection, and personalization. Also used when you share connectors under your Rebel name."
          variant="stacked"
          htmlFor="user-first-name"
        >
          <Input
            id="user-first-name"
            type="text"
            value={draftSettings.userFirstName ?? ''}
            onChange={(e) => updateDraft('userFirstName', e.target.value || null)}
            placeholder={user.name?.split(' ')[0] || 'Your first name'}
            maxLength={60}
            data-testid="account-user-first-name"
            aria-invalid={userFirstNameError !== null ? true : undefined}
            aria-describedby={userFirstNameError !== null ? 'user-first-name-error' : undefined}
          />
          {userFirstNameError !== null && (
            <div
              id="user-first-name-error"
              role="alert"
              className={styles.settingFieldError}
              data-testid="account-user-first-name-error"
            >
              {userFirstNameError}
            </div>
          )}
        </SettingRow>
      </SettingSection>

      <SettingSection
        title="Sign Out"
        description="Sign out of your account on this device."
      >
        <SettingRow
          label="Current session"
          description="End your account session on this device."
          variant="stacked"
        >
          <Button 
            variant="outline" 
            onClick={() => void handleSignOut()}
            data-testid="account-sign-out-button"
          >
            <LogOut size={16} />
            Sign out
          </Button>
        </SettingRow>
      </SettingSection>
    </>
  );
};
