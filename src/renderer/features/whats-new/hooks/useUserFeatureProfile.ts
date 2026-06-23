import { useEffect, useState, useMemo } from 'react';
import { useSettings } from '@renderer/features/settings/SettingsProvider';
import { getSessionStoreState } from '@renderer/features/agent-session/store/sessionStore';

/**
 * User's feature profile for personalizing What's New highlights.
 * Aggregates signals from settings, MCP connections, and feature usage.
 */
export interface UserFeatureProfile {
  /** Loading state for async data */
  loading: boolean;
  
  /** MCP-related signals */
  mcp: {
    /** Names of connected MCP servers (lowercase for matching) */
    connectedServers: string[];
    /** Whether user has any MCP connections */
    hasConnections: boolean;
  };
  
  /** Feature usage signals from settings */
  features: {
    /** Voice is configured (has provider/keys) */
    voiceConfigured: boolean;
    /** Has any automations defined */
    hasAutomations: boolean;
    /** Has memory spaces configured */
    hasSpaces: boolean;
    /** Meeting bot is configured */
    meetingBotConfigured: boolean;
    /** Has used privacy mode */
    privacyModeUsed: boolean;
  };
  
  /** Onboarding signals */
  onboarding: {
    /** Which checklist steps were completed */
    completedSteps: string[];
    /** Whether personalized use cases were generated */
    hasUseCases: boolean;
  };
}

/**
 * Hook to gather user's feature profile for What's New personalization.
 * 
 * Data sources:
 * - AppSettings (voice, spaces, automations, meeting bot)
 * - MCP config summary (connected servers)
 * - Onboarding state (checklist, use cases)
 * 
 * All data fetching is optional/fault-tolerant - partial profiles are fine.
 * 
 * @param enabled - Whether to fetch data (skip MCP call when widget won't show)
 */
export function useUserFeatureProfile(enabled = true): UserFeatureProfile {
  const { settings } = useSettings();
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [loading, setLoading] = useState(enabled);
  
  // Fetch MCP connections only when enabled
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    
    const fetchMcpConnections = async () => {
      try {
        const summary = await window.settingsApi.mcpSummary({ skipMetadata: true });
        if (summary?.servers) {
          // Extract server names from healthy/configured servers, normalize to lowercase
          // Filter to servers with tools (actually functional connections)
          const serverNames = summary.servers
            .filter((s) => (s.toolCount ?? 0) > 0) // Only servers with tools
            .map((s) => s.name?.toLowerCase() || '')
            .filter(Boolean);
          setMcpServers(serverNames);
        }
      } catch {
        // Silently fail - just won't have MCP data for personalization
      } finally {
        setLoading(false);
      }
    };
    
    fetchMcpConnections();
  }, [enabled]);
  
  // Build profile from settings (synchronous, always available)
  const profile = useMemo<UserFeatureProfile>(() => {
    const voiceSettings = settings?.voice;
    const checklist = settings?.onboardingChecklist;
    const spaces = settings?.spaces ?? [];
    
    // Voice is configured if user has set up API keys for their provider
    const hasVoiceKeys = Boolean(
      voiceSettings?.openaiApiKey || 
      voiceSettings?.elevenlabsApiKey ||
      settings?.openRouter?.oauthToken
    );
    
    // Spaces: count non-default spaces (exclude Chief-of-Staff which is always there)
    const customSpaces = spaces.filter((s) => s.type !== 'chief-of-staff');
    
    // Meeting bot: consider configured if user has customized routing spaces
    // (Just checking enabled is too broad - it defaults to true)
    const meetingBotCustomized = Boolean(
      settings?.meetingBot?.oneOnOneSpaceId ||
      settings?.meetingBot?.groupMeetingSpaceId
    );
    
    // Check if user has ever used privacy mode by looking at session summaries
    // This is a lightweight check - summaries are already loaded in the store
    const sessionState = getSessionStoreState();
    const hasUsedPrivacyMode = sessionState.sessionSummaries?.some(
      (summary) => summary.privateMode === true
    ) ?? false;
    
    return {
      loading,
      mcp: {
        connectedServers: mcpServers,
        hasConnections: mcpServers.length > 0,
      },
      features: {
        voiceConfigured: hasVoiceKeys,
        // Note: automations live in a separate store, not AppSettings
        // For now, infer from onboarding completion and presence of spaces
        hasAutomations: Boolean(checklist?.completedSteps?.['4']), // Step 4 is automations/use cases
        hasSpaces: customSpaces.length > 0,
        meetingBotConfigured: meetingBotCustomized,
        // Privacy mode: check if any session has used it
        privacyModeUsed: hasUsedPrivacyMode,
      },
      onboarding: {
        completedSteps: checklist?.completedSteps 
          ? Object.keys(checklist.completedSteps).filter(k => checklist.completedSteps?.[Number(k) as keyof typeof checklist.completedSteps])
          : [],
        hasUseCases: Boolean(settings?.personalizedUseCases && settings.personalizedUseCases.length > 0),
      },
    };
  }, [settings, mcpServers, loading]);
  
  return profile;
}

/**
 * Feature keywords mapped to changelog content patterns.
 * Used to match highlights to user's feature profile.
 */
const FEATURE_KEYWORDS: Record<string, string[]> = {
  // MCP / Connectors
  mcp: ['mcp', 'connector', 'tool', 'connection', 'integration', 'account'],
  slack: ['slack', 'channel', 'dm', 'message'],
  google: ['google', 'gmail', 'calendar', 'drive', 'docs'],
  salesforce: ['salesforce', 'crm'],
  github: ['github', 'repository', 'pull request', 'issue'],
  
  // Voice
  voice: ['voice', 'recording', 'audio', 'speech', 'tts', 'stt', 'microphone', 'speak'],
  
  // Automations
  automations: ['automation', 'schedule', 'trigger', 'workflow', 'cron', 'event-triggered'],
  
  // Memory / Spaces
  memory: ['memory', 'space', 'knowledge', 'file', 'library', 'workspace'],
  
  // Meeting bot
  meetings: ['meeting', 'transcript', 'calendar', 'notetaker', 'recording', 'prep'],
  
  // Privacy
  privacy: ['privacy', 'security', 'sensitive', 'approval'],
};

/**
 * Calculate relevance score for a changelog highlight based on user profile.
 * Higher score = more relevant to this user.
 * 
 * @param highlight - The changelog highlight to score
 * @param profile - User's feature profile
 * @returns Score from 0-100 (0 = not relevant, 100 = highly relevant)
 */
export function calculateRelevanceScore(
  highlight: { title: string; description: string },
  profile: UserFeatureProfile
): number {
  const text = `${highlight.title} ${highlight.description}`.toLowerCase();
  let score = 50; // Base score - all features have some relevance
  
  // Boost for MCP-related if user has connections
  if (profile.mcp.hasConnections) {
    if (FEATURE_KEYWORDS.mcp.some(kw => text.includes(kw))) {
      score += 15;
    }
    // Extra boost if matches a specific connected server
    for (const server of profile.mcp.connectedServers) {
      if (text.includes(server)) {
        score += 25;
        break;
      }
    }
  }
  
  // Boost for voice-related if user has voice configured
  if (profile.features.voiceConfigured) {
    if (FEATURE_KEYWORDS.voice.some(kw => text.includes(kw))) {
      score += 20;
    }
  }
  
  // Boost for automation-related if user uses automations
  if (profile.features.hasAutomations) {
    if (FEATURE_KEYWORDS.automations.some(kw => text.includes(kw))) {
      score += 20;
    }
  }
  
  // Boost for memory/spaces if user has spaces
  if (profile.features.hasSpaces) {
    if (FEATURE_KEYWORDS.memory.some(kw => text.includes(kw))) {
      score += 15;
    }
  }
  
  // Boost for meeting-related if user has meeting bot
  if (profile.features.meetingBotConfigured) {
    if (FEATURE_KEYWORDS.meetings.some(kw => text.includes(kw))) {
      score += 20;
    }
  }
  
  // Boost for privacy-related if user uses privacy mode
  if (profile.features.privacyModeUsed) {
    if (FEATURE_KEYWORDS.privacy.some(kw => text.includes(kw))) {
      score += 15;
    }
  }
  
  // Cap at 100
  return Math.min(score, 100);
}
