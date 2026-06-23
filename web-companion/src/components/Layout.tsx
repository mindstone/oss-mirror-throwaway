// web-companion/src/components/Layout.tsx

import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useApprovalStore, useInboxStore } from '@rebel/cloud-client';
import {
  HomeIcon,
  InboxIcon,
  MessageCircleIcon,
  CheckCircleIcon,
  HelpCircleIcon,
} from './icons';
import type { IconProps } from './icons';
import { ConnectivityBanner } from './ConnectivityBanner';
import styles from './Layout.module.css';
import { fireAndForget } from '../utils/fireAndForget';

interface LayoutProps {
  children: ReactNode;
}

interface NavItem {
  to: string;
  end: boolean;
  icon: ComponentType<IconProps>;
  label: string;
  showBadge?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', end: true, icon: HomeIcon, label: 'Home' },
  { to: '/inbox', end: false, icon: InboxIcon, label: 'Actions', showBadge: true },
  { to: '/conversations', end: false, icon: MessageCircleIcon, label: 'Chats' },
  { to: '/approvals', end: false, icon: CheckCircleIcon, label: 'Approvals', showBadge: true },
  { to: '/help', end: false, icon: HelpCircleIcon, label: 'Help' },
];

function NavItems({ approvalCount, inboxCount }: { approvalCount: number; inboxCount: number }) {
  const getBadgeCount = (to: string): number => {
    if (to === '/inbox') return inboxCount;
    if (to === '/approvals') return approvalCount;
    return 0;
  };

  return (
    <>
      {NAV_ITEMS.map(({ to, end, icon: IconComponent, label, showBadge }) => {
        const badgeCount = showBadge ? getBadgeCount(to) : 0;
        return (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `${styles.navLink} ${isActive ? styles.navLinkActive : ''}`
            }
          >
            <span className={styles.navIcon}>
              <IconComponent size={20} />
            </span>
            {badgeCount > 0 && (
              <span className={styles.navBadge}>{badgeCount}</span>
            )}
            <span className={styles.navLabel}>{label}</span>
          </NavLink>
        );
      })}
    </>
  );
}

function getInitialOnlineStatus(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(getInitialOnlineStatus);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}

export function Layout({ children }: LayoutProps) {
  const approvalCount = useApprovalStore(
    (s) => s.toolApprovals.length + s.stagedCalls.length + (s.memoryApprovals?.length ?? 0),
  );
  const inboxCount = useInboxStore(
    (s) => s.items.filter((i) => !i.archived).length,
  );
  const fetchInbox = useInboxStore((s) => s.fetchInbox);
  const isOnline = useOnlineStatus();

  useEffect(() => { fireAndForget(fetchInbox(), 'Layout:mount:fetchInbox'); }, [fetchInbox]);

  return (
    <div className={styles.layout}>
      {/* Sidebar nav — visible on desktop (>1024px) */}
      <aside className={styles.sidebar}>
        <span className={styles.sidebarLogo}>Rebel</span>
        <nav className={styles.sidebarNav}>
          <NavItems approvalCount={approvalCount} inboxCount={inboxCount} />
        </nav>
      </aside>

      <div className={styles.mainColumn}>
        {/* Header — visible on mobile/tablet only */}
        <header className={styles.header}>
          <span className={styles.logo}>Rebel</span>
        </header>

        <ConnectivityBanner isOnline={isOnline} />

        <main className={styles.main}>{children}</main>

        {/* Bottom nav — visible on mobile/tablet only */}
        <nav className={styles.bottomNav}>
          <NavItems approvalCount={approvalCount} inboxCount={inboxCount} />
        </nav>
      </div>
    </div>
  );
}
