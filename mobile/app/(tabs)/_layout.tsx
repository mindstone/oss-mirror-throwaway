// mobile/app/(tabs)/_layout.tsx

import { useMemo } from 'react';
import { Tabs } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useInboxStore, useApprovalStore, useStagedFilesStore } from '@rebel/cloud-client';
import { useColors } from '../../src/theme/colors';
import { CustomTabBar } from '../../src/components/CustomTabBar';

export default function TabsLayout() {
  const activeCount = useInboxStore((s) => s.items.filter((i) => !i.archived).length);
  const approvalCount = useApprovalStore(
    (s) =>
      s.toolApprovals.length
      + s.stagedCalls.length
      + s.memoryApprovals.filter((approval) => !approval.staged).length,
  );
  const stagedFilesCount = useStagedFilesStore((s) => s.files.length);
  const colors = useColors();

  const screenOptions = useMemo(
    () => ({
      headerShown: false,
      tabBarActiveTintColor: colors.accent,
      tabBarInactiveTintColor: colors.textTertiary,
    }),
    [colors],
  );

  return (
    <Tabs screenOptions={screenOptions} tabBar={(props) => <CustomTabBar {...props} />}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Feather name="home" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="inbox"
        options={{
          title: 'Actions',
          tabBarIcon: ({ color, size }) => <Feather name="inbox" size={size} color={color} />,
          tabBarBadge:
            activeCount + approvalCount + stagedFilesCount > 0
              ? activeCount + approvalCount + stagedFilesCount
              : undefined,
        }}
      />
      <Tabs.Screen
        name="conversations"
        options={{
          title: 'Conversations',
          tabBarIcon: ({ color, size }) => (
            <Feather name="message-circle" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          href: null,
          title: 'Approvals',
          tabBarIcon: ({ color, size }) => (
            <Feather name="check-circle" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="help"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <Feather name="settings" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
