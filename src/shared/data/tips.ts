/**
 * Tips shown to users while the agent is working.
 * Each tip is a markdown string that can include formatting and links.
 * Tips are displayed randomly during agent turns to help users discover features.
 */

export interface Tip {
  /** Unique identifier for the tip */
  id: string;
  /** Category for potential future filtering */
  category: 'keyboard' | 'voice' | 'workspace' | 'skills' | 'mcp' | 'settings' | 'productivity' | 'advanced';
  /** Markdown content of the tip */
  content: string;
}

export const tips: Tip[] = [
  // Keyboard shortcuts
  {
    id: 'keyboard-new-chat',
    category: 'keyboard',
    content: '**Tip:** Press **⌘N** (Mac) or **Ctrl+N** (Windows) to start a new conversation instantly.',
  },
  {
    id: 'keyboard-cycle-sessions',
    category: 'keyboard',
    content: '**Tip:** Use **Ctrl+Tab** to cycle through your pinned sessions quickly.',
  },
  {
    id: 'keyboard-voice-hotkey',
    category: 'keyboard',
    content: '**Tip:** The global voice hotkey (**Ctrl+Alt+Space** by default) works even when Rebel is in the background.',
  },
  {
    id: 'keyboard-edit-message',
    category: 'keyboard',
    content: '**Tip:** Press **⌘↑** (Mac) or **Ctrl+↑** (Windows) when the composer is empty to edit your last message.',
  },
  {
    id: 'keyboard-shortcuts-settings',
    category: 'keyboard',
    content: '**Tip:** View all keyboard shortcuts from the **Help** menu or press **⌘/** (Mac) / **Ctrl+/** (Windows).',
  },
  {
    id: 'keyboard-quick-open',
    category: 'keyboard',
    content: '**Tip:** Press **⌘O** (Mac) or **Ctrl+O** (Windows) to quick-open a file from your Library.',
  },
  {
    id: 'keyboard-auto-done',
    category: 'keyboard',
    content: '**Tip:** Press **⌘Enter** (Mac) or **Ctrl+Enter** (Windows) to mark the current chat as done. If a turn is still running, it toggles auto-done for when it finishes.',
  },
  {
    id: 'keyboard-esc-stop',
    category: 'keyboard',
    content: '**Tip:** Double-tap **Esc** to stop the current run (single **Esc** exits voice mode).',
  },
  {
    id: 'keyboard-queue-messages',
    category: 'keyboard',
    content: '**Tip:** While Rebel is busy, **Enter** (or Alt+Enter) queues your next message. To send immediately and interrupt the current turn, use the **Send now** button.',
  },
  {
    id: 'keyboard-inbox',
    category: 'keyboard',
    content: '**Tip:** Press **⌘I** (Mac) or **Ctrl+I** (Windows) to jump straight to Actions.',
  },

  // Voice features
  {
    id: 'voice-first',
    category: 'voice',
    content: '**Tip:** Rebel is voice-first! Talking is faster and gives richer context than typing.',
  },
  {
    id: 'voice-interrupt',
    category: 'voice',
    content: '**Tip:** If Rebel is speaking, click the speaker icon to mute and stop the current reply.',
  },
  {
    id: 'voice-customise-hotkey',
    category: 'voice',
    content: '**Tip:** Customise your voice activation hotkey in **Settings → Agents & Voice**.',
  },

  // Library & files
  {
    id: 'library-drawer',
    category: 'workspace',
    content: '**Tip:** Click the **Library** tab at the top of the Rebel window to browse and edit files in your Library folder.',
  },
  {
    id: 'library-markdown-preview',
    category: 'workspace',
    content: '**Tip:** The Library editor can toggle between edit and preview modes for Markdown files—click the preview button to see formatted output.',
  },
  {
    id: 'library-spaces',
    category: 'workspace',
    content: '**Tip:** Organise your work into Spaces, i.e. separate folders for personal, company, and other kinds of content.',
  },
  {
    id: 'library-chief-of-staff',
    category: 'workspace',
    content: '**Tip:** Your **Chief-of-Staff** folder is your personal command centre that spans all your spaces.',
  },

  // Skills & @ mentions
  {
    id: 'skills-at-mention',
    category: 'skills',
    content: '**Tip:** Type **@** and select a skill from the list to run it.',
  },
  {
    id: 'skills-create-own',
    category: 'skills',
    content: '**Tip:** You can edit your skills in your space\'s `skills/` folder with Rebel itself or any text editor.',
  },

  // Settings & customisation
  {
    id: 'settings-theme',
    category: 'settings',
    content: '**Tip:** Rebel has both light and dark themes—find your preference in **Settings → System → Appearance**.',
  },
  {
    id: 'settings-tool-safety',
    category: 'settings',
    content: '**Tip:** Adjust tool safety levels (permissive/balanced/cautious) in settings to control how Rebel handles risky operations.',
  },
  {
    id: 'settings-memory-safety',
    category: 'settings',
    content: '**Tip:** Configure memory safety per-space in Settings → Safety. Some spaces can auto-save while others always ask first.',
  },
  {
    id: 'settings-private-mode',
    category: 'settings',
    content: '**Tip:** Use the eye icon in the composer to enable Private Mode—Rebel will ask before writing files or taking actions.',
  },
  {
    id: 'settings-relaunch-onboarding',
    category: 'settings',
    content: '**Tip:** Need to reconfigure? Use **Settings → Support → Onboarding & Actions → Restart full onboarding** to start fresh.',
  },

  // Productivity
  {
    id: 'productivity-automations',
    category: 'productivity',
    content: '**Tip:** Set up Automations to run skills on a schedule—hourly, daily, weekly, or monthly (though Rebel must be open at the scheduled time).',
  },
  {
    id: 'productivity-memory',
    category: 'productivity',
    content: '**Tip:** Store frequently-used context in your **Chief-of-Staff/README.md**—it\'s auto-loaded into every session.',
  },
  {
    id: 'productivity-edit-message',
    category: 'productivity',
    content: '**Tip:** You can edit the last message to correct it, or to take the conversation in a different direction.',
  },
  {
    id: 'productivity-edit-any-message',
    category: 'productivity',
    content: '**Tip:** When Rebel is idle, hover over **any** of your earlier messages and click **Edit** to revise it—Rebel will re-run from that point.',
  },
  {
    id: 'productivity-steps-panel',
    category: 'productivity',
    content: '**Tip:** Click **Behind the scenes** at the top of a message to see what Rebel was up to.',
  },

  // Advanced features
  {
    id: 'advanced-subagents',
    category: 'advanced',
    content: '**Tip:** For complex tasks, ask Rebel to "use subagents" to tackle pieces of the job in parallel.',
  },
  {
    id: 'advanced-notion-sync',
    category: 'advanced',
    content: '**Tip:** For complex workflows, consider downloading long Notion pages as Markdown files into your Library for faster AI access.',
  },
  {
    id: 'advanced-workspace-search',
    category: 'advanced',
    content: '**Tip:** Start your message with **@files** to search across all your Library files for relevant context.',
  },
  {
    id: 'advanced-workspace-search-alt',
    category: 'workspace',
    content: '**Tip:** Need Rebel to look through your files? Use **@files** at the start of your message for a comprehensive search.',
  },

  // Helpful reminders
  {
    id: 'reminder-ask-ai',
    category: 'productivity',
    content: '**Tip:** Confused about something? Try asking "How do I..." and Rebel will guide you.',
  },
];

/**
 * Detect whether a thinking headline originated from a tip.
 * Tips always start with `**Tip:**` in their raw content; after the markdown
 * stripping in `activityDerivation.deriveCurrentActivity` this becomes `Tip:`.
 * Accepting both prefixes keeps the check callable against either the raw
 * `thinkingHeadline` or the derived `activity.statusLine`.
 */
export function isTipContent(text: string): boolean {
  return text.startsWith('**Tip:**') || text.startsWith('Tip:');
}

/**
 * Get a random tip, optionally filtered by category
 */
export function getRandomTip(category?: Tip['category']): Tip {
  const filtered = category ? tips.filter((t) => t.category === category) : tips;
  const index = Math.floor(Math.random() * filtered.length);
  return filtered[index] || tips[0];
}

/**
 * Get a random tip that hasn't been shown recently
 * @param recentIds - Array of recently shown tip IDs to avoid
 */
export function getRandomTipExcluding(recentIds: string[]): Tip {
  const available = tips.filter((t) => !recentIds.includes(t.id));
  if (available.length === 0) {
    // All tips shown recently, just pick any
    return tips[Math.floor(Math.random() * tips.length)];
  }
  return available[Math.floor(Math.random() * available.length)];
}


