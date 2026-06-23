import type { UserFeatureProfile } from '../hooks/useUserFeatureProfile';

/**
 * Changelog highlight structure (duplicated to avoid circular import)
 */
interface ChangelogHighlight {
  title: string;
  description: string;
}

/**
 * A personalized prompt with optional context about why it's relevant.
 */
export interface PersonalizedPrompt {
  /** The prompt to send to start a conversation */
  prompt: string;
  /** Optional: Why this prompt was chosen (for debugging/display) */
  relevanceHint?: string;
}

/**
 * Feature prompt definition with personalization rules.
 */
interface FeaturePromptDef {
  /** Keywords that match this feature (from title/description) */
  keywords: string[];
  /** Generate personalized prompt based on user profile */
  getPrompt: (profile: UserFeatureProfile, highlight: ChangelogHighlight) => PersonalizedPrompt;
}

/**
 * Feature-to-prompt mapping registry.
 * Each entry defines keywords to match and a function to generate personalized prompts.
 */
const FEATURE_PROMPTS: FeaturePromptDef[] = [
  // MCP / Multi-Account connections (specific keywords to avoid false matches)
  {
    keywords: ['multi-account', 'multiple accounts', 'second account', 'another account'],
    getPrompt: (profile, highlight) => {
      const servers = profile.mcp.connectedServers;
      if (servers.some(s => s.includes('google') || s.includes('gmail'))) {
        return {
          prompt: "I'd like to connect a second Google account—maybe my personal Gmail alongside my work one. Can you help me set that up and show me how account switching works?",
          relevanceHint: "You use Google"
        };
      }
      if (servers.some(s => s.includes('slack'))) {
        return {
          prompt: "Can you help me add another Slack workspace? I'd like to have both my work and personal Slack connected so I can triage messages across both.",
          relevanceHint: "You use Slack"
        };
      }
      if (profile.mcp.hasConnections && servers.length > 0) {
        const primary = servers[0];
        return {
          prompt: `I'm using ${primary}. Can you show me how to add a second account for the same service and explain when that's useful?`,
          relevanceHint: `You use ${primary}`
        };
      }
      return { 
        prompt: `The "${highlight.title}" feature sounds useful. When would I need multiple accounts for the same service?`
      };
    }
  },

  // Slack-specific features
  {
    keywords: ['slack channel', 'slack', 'channel access', 'public channel'],
    getPrompt: (profile) => {
      if (profile.mcp.connectedServers.some(s => s.includes('slack'))) {
        return {
          prompt: "I'd like to explore public Slack channels I haven't joined yet. Can you show me what's available in my workspace and summarize any discussions that might be relevant to my work?",
          relevanceHint: "You use Slack"
        };
      }
      return {
        prompt: "Tell me about the Slack channel access feature. What can I do with public channels I haven't joined?"
      };
    }
  },

  // Voice Recording features
  {
    keywords: ['voice', 'recording', 'audio', 'speech', 'microphone'],
    getPrompt: (profile) => {
      if (profile.features.voiceConfigured) {
        return {
          prompt: "I use voice regularly. Can you help me test the improvements? Let's start a voice interaction where I can see how the new features work in practice.",
          relevanceHint: "You use voice"
        };
      }
      return {
        prompt: "Tell me about the voice improvements. I haven't set up voice yet—is it worth configuring?"
      };
    }
  },

  // Automations / Scheduling
  {
    keywords: ['automation', 'automate', 'schedule', 'trigger', 'workflow', 'event-triggered', 'cron'],
    getPrompt: (profile) => {
      if (profile.features.hasAutomations) {
        return {
          prompt: "I already have some automations set up. Can you show me what's new and help me upgrade one of my existing workflows to use the latest features?",
          relevanceHint: "You use automations"
        };
      }
      if (profile.features.meetingBotConfigured) {
        return {
          prompt: "I have meeting recordings coming in. Can you help me set up an automation that runs when a new transcript arrives—like auto-generating action items?",
          relevanceHint: "You use meeting transcripts"
        };
      }
      return {
        prompt: "Help me set up my first automation. What are some useful workflows you'd recommend for someone just getting started?"
      };
    }
  },

  // Meeting / Calendar / Notetaker
  {
    keywords: ['meeting', 'transcript', 'calendar', 'prep', 'notetaker', 'agenda'],
    getPrompt: (profile) => {
      if (profile.features.meetingBotConfigured) {
        return {
          prompt: "Show me my upcoming meetings and help me prep for the next one. I'd like to see how the meeting workflow has improved.",
          relevanceHint: "You use meeting bot"
        };
      }
      if (profile.mcp.connectedServers.some(s => s.includes('calendar') || s.includes('outlook') || s.includes('google'))) {
        return {
          prompt: "I have my calendar connected. Walk me through the meeting prep features—what can you do with transcripts and follow-ups?",
          relevanceHint: "Calendar connected"
        };
      }
      return {
        prompt: "Tell me about the meeting features. What would I need to set up to use meeting prep and transcription?"
      };
    }
  },

  // Memory / Spaces / Library
  {
    keywords: ['memory', 'space', 'knowledge', 'library', 'workspace', 'file'],
    getPrompt: (profile) => {
      if (profile.features.hasSpaces) {
        return {
          prompt: "I have some memory spaces set up. Show me what you've learned recently and help me organize any pending memories that need attention.",
          relevanceHint: "You use Spaces"
        };
      }
      return {
        prompt: "Tell me about memory spaces. How do they help organize knowledge, and what's a good way to structure them?"
      };
    }
  },

  // Privacy features
  {
    keywords: ['privacy', 'private', 'security', 'sensitive', 'approval'],
    getPrompt: (profile) => {
      if (profile.features.privacyModeUsed) {
        return {
          prompt: "I've used privacy mode before. What's new with privacy controls? Any improvements to how sensitive conversations are handled?",
          relevanceHint: "You've used privacy mode"
        };
      }
      return {
        prompt: "Tell me about the privacy features. When should I use privacy mode, and how does it protect sensitive information?"
      };
    }
  },

  // Connector / Tool connections
  {
    keywords: ['connector', 'connection', 'tool', 'integration', 'self-service', 'mcp'],
    getPrompt: (profile) => {
      if (!profile.mcp.hasConnections) {
        return {
          prompt: "Help me connect my first tool. What integrations are available and which would you recommend starting with for my workflow?",
          relevanceHint: "No tools connected yet"
        };
      }
      const count = profile.mcp.connectedServers.length;
      return {
        prompt: `I have ${count} tool${count === 1 ? '' : 's'} connected. Show me what new connectors are available—I might want to add more integrations.`,
        relevanceHint: `${count} tool${count === 1 ? '' : 's'} connected`
      };
    }
  },

  // Search features
  {
    keywords: ['search', 'find', 'semantic', 'discovery'],
    getPrompt: (profile) => {
      if (profile.features.hasSpaces) {
        return {
          prompt: "Let's test the search improvements. Find something related to one of my recent projects—search by meaning, not just keywords.",
          relevanceHint: "You have files to search"
        };
      }
      return {
        prompt: "Show me how the smart search works. What makes it different from regular keyword search?"
      };
    }
  },

  // Conversation features (drafts, mentions, UI)
  {
    keywords: ['conversation', 'draft', 'mention', '@mention', 'compose', 'message'],
    getPrompt: (_profile, highlight) => ({
      prompt: `The "${highlight.title}" feature sounds useful. Can you show me how it works with a quick demonstration?`
    })
  },

  // UI / Display improvements
  {
    keywords: ['display', 'tab', 'panel', 'redesign', 'view', 'layout'],
    getPrompt: (_profile, highlight) => ({
      prompt: `Walk me through the "${highlight.title}" changes. What's different and how does it improve the workflow?`
    })
  }
];

/**
 * Generate a personalized "Try It" prompt for a changelog highlight.
 * 
 * Logic:
 * 1. Try to match highlight to a feature definition via keywords
 * 2. If matched, use the feature's getPrompt() with user profile
 * 3. If no match, use smart fallback based on profile
 */
export function generateTryItPrompt(
  highlight: ChangelogHighlight,
  profile: UserFeatureProfile
): PersonalizedPrompt {
  const text = `${highlight.title} ${highlight.description}`.toLowerCase();
  
  // Find matching feature definition
  const matchedFeature = FEATURE_PROMPTS.find(def => 
    def.keywords.some(kw => text.includes(kw.toLowerCase()))
  );
  
  if (matchedFeature) {
    try {
      const result = matchedFeature.getPrompt(profile, highlight);
      if (result.prompt) return result;
    } catch {
      // Fall through to fallback
    }
  }
  
  // Smart fallback based on profile
  return generateSmartFallback(highlight, profile);
}

/**
 * Generate a contextual fallback when no specific feature match exists.
 */
function generateSmartFallback(
  highlight: ChangelogHighlight,
  profile: UserFeatureProfile
): PersonalizedPrompt {
  const hasContext = profile.mcp.hasConnections || 
                     profile.features.hasSpaces || 
                     profile.features.voiceConfigured;
  
  if (hasContext) {
    // User has some setup - offer to show how feature fits their workflow
    return {
      prompt: `I'm curious about "${highlight.title}". How does this fit with my current setup, and what's the best way to try it?`
    };
  }
  
  // New user - ask for explanation and setup guidance
  return {
    prompt: `Tell me about "${highlight.title}". What would I need to set up to use it effectively?`
  };
}
