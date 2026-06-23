/**
 * Tests for relayClient.ts avatar detection migration.
 *
 * Verifies the avatarConnected field is used when available,
 * and falls back to the legacy connectedPeers >= 2 heuristic
 * for backward compat with old DOs.
 */

import { describe, it, expect, vi } from 'vitest';

// We test the avatar detection logic by extracting it into a pure function.
// The actual logic in relayClient.ts is: avatarConnected ?? (connectedPeers >= 2)

describe('avatar detection logic (avatarConnected migration)', () => {
  function detectAvatar(authOk: { avatarConnected?: boolean; connectedPeers: number }): boolean {
    return authOk.avatarConnected ?? (authOk.connectedPeers >= 2);
  }

  describe('new DO (with avatarConnected field)', () => {
    it('uses avatarConnected=true even with low connectedPeers', () => {
      expect(detectAvatar({ avatarConnected: true, connectedPeers: 1 })).toBe(true);
    });

    it('uses avatarConnected=false even with high connectedPeers', () => {
      // Key case: 2 desktops + no avatar = connectedPeers=1 (clamped), avatarConnected=false
      expect(detectAvatar({ avatarConnected: false, connectedPeers: 1 })).toBe(false);
    });

    it('uses avatarConnected=false with connectedPeers=2 (multi-desktop, no avatar)', () => {
      // This would be a false positive under the old heuristic
      expect(detectAvatar({ avatarConnected: false, connectedPeers: 2 })).toBe(false);
    });

    it('uses avatarConnected=true with connectedPeers=2', () => {
      expect(detectAvatar({ avatarConnected: true, connectedPeers: 2 })).toBe(true);
    });
  });

  describe('old DO (without avatarConnected field)', () => {
    it('falls back to connectedPeers=2 as avatar present', () => {
      expect(detectAvatar({ connectedPeers: 2 })).toBe(true);
    });

    it('falls back to connectedPeers=1 as no avatar', () => {
      expect(detectAvatar({ connectedPeers: 1 })).toBe(false);
    });

    it('falls back to connectedPeers=0 as no avatar', () => {
      expect(detectAvatar({ connectedPeers: 0 })).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles avatarConnected=undefined (explicit) as fallback', () => {
      expect(detectAvatar({ avatarConnected: undefined, connectedPeers: 2 })).toBe(true);
      expect(detectAvatar({ avatarConnected: undefined, connectedPeers: 1 })).toBe(false);
    });
  });
});
