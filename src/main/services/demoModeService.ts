/**
 * Demo Mode Service
 *
 * Manages demo mode lifecycle with app restart for complete isolation.
 *
 * How it works:
 * 1. enterDemoMode() creates a temp dir, writes a flag file, and restarts the app
 * 2. On startup, ensureDemoModeUserData.ts reads the flag and calls app.setPath('userData', tempDir)
 * 3. All storage (electron-stores, sessions, etc.) automatically uses the temp dir
 * 4. exitDemoMode() clears the flag and restarts - temp dir is cleaned up on next normal startup
 *
 * This approach means ALL storage is isolated without needing isDemoModeActive() checks everywhere.
 */

import { getElectronModule } from '@core/lazyElectron';
import { getPlatformConfig } from '@core/platform';
import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createScopedLogger } from '@core/logger';
import {
  writeDemoModeFlag,
  clearDemoModeFlag,
} from '../startup/ensureDemoModeUserData';
import { INBOX_STORE_VERSION } from '@core/constants';
import { INDEX_VERSION as SESSION_INDEX_VERSION } from '@core/services/incrementalSessionStore';

const log = createScopedLogger({ service: 'demoMode' });

// How old a demo temp dir must be before we clean it up (7 days)
const ORPHAN_CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Check if we're currently running in demo mode.
 * This is determined by whether userData is under os.tmpdir().
 * 
 * Uses realpathSync to handle symlinks (e.g., macOS /tmp -> /private/tmp)
 * and path.relative() for proper containment check (avoids prefix edge cases).
 */
export const isDemoModeActive = (): boolean => {
  // E2E/test isolation places userData under os.tmpdir() too, which would make
  // the tmpdir-containment check below report a false positive (every test launch
  // would boot Demo Mode). These env vars are never set in production, so guarding
  // on them here cannot mask a real prod demo-mode bug.
  if (
    process.env.REBEL_TEST_MODE === '1' ||
    process.env.REBEL_E2E_TEST_MODE === '1' ||
    process.env.REBEL_TEST_USER_DATA_DIR
  ) {
    return false;
  }

  try {
    const userData = getPlatformConfig().userDataPath;
    const tempDir = os.tmpdir();
    
    // Resolve symlinks for robust comparison
    const realUserData = fs.realpathSync(userData);
    const realTempDir = fs.realpathSync(tempDir);
    
    // Use path.relative() for proper containment check
    // If relative path starts with '..' or is absolute, userData is not under tempDir
    const relativePath = path.relative(realTempDir, realUserData);
    return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
  } catch {
    // If paths can't be resolved, assume not in demo mode
    return false;
  }
};

/**
 * Get the current demo temp directory if in demo mode.
 */
export const getDemoTempDir = (): string | null => {
  if (!isDemoModeActive()) return null;
  return getPlatformConfig().userDataPath;
};

/**
 * Options for entering demo mode.
 */
export interface EnterDemoModeOptions {
  /** If true, copy API keys from current settings to demo settings */
  keepApiKeys?: boolean;
  /** If true, seed mock content (skills and memories) for UX testing */
  seedMockContent?: boolean;
  /** If true, show onboarding wizard instead of skipping it (for demoing the onboarding flow) */
  showOnboarding?: boolean;
}

/**
 * Enter demo mode by creating a temp directory and restarting the app.
 * The restart is required because app.setPath() must be called before any stores are created.
 * 
 * In development mode (npm run dev), the restart will kill the Vite dev server,
 * so we return a special flag to tell the UI to show manual restart instructions.
 * 
 * @param options - Options for demo mode entry
 * @param options.keepApiKeys - If true, copies Claude/OpenAI/ElevenLabs API keys to demo settings
 */
export const enterDemoMode = async (
  options: EnterDemoModeOptions = {}
): Promise<{ success: boolean; error?: string; requiresRestart: true; requiresManualRestart?: boolean }> => {
  const alreadyInDemo = isDemoModeActive();
  const currentDemoDir = alreadyInDemo ? getDemoTempDir() : null;
  
  if (alreadyInDemo) {
    log.info({ currentDemoDir }, 'Restarting demo mode - will create fresh environment');
  }

  const electron = getElectronModule();
  const isDevMode = !getPlatformConfig().isPackaged;

  try {
    // Create a unique temp directory for this demo session
    // Use both timestamp and random suffix to prevent collision
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
    const tempDir = path.join(os.tmpdir(), `mindstone-demo-${uniqueId}`);
    // Use restrictive permissions (0700) to protect any copied API keys
    await fsPromises.mkdir(tempDir, { recursive: true, mode: 0o700 });

    // Pre-seed the demo environment with workspace and optionally API keys
    // When restarting demo, copy keys from current demo settings if requested
    await seedDemoEnvironment(
      tempDir, 
      options.keepApiKeys ?? false, 
      alreadyInDemo,
      options.seedMockContent ?? false,
      options.showOnboarding ?? false
    );

    // If restarting demo, mark the old directory for cleanup
    if (currentDemoDir) {
      markDemoDirectoryForCleanup(currentDemoDir);
    }

    // Write the flag file that ensureDemoModeUserData.ts will read on restart
    writeDemoModeFlag(tempDir);

    log.info({ tempDir, keepApiKeys: options.keepApiKeys, isDevMode }, 'Demo mode flag set');

    if (isDevMode) {
      // In dev mode, app.relaunch() won't work properly because the Vite dev server
      // is killed when the parent npm process exits. Spawn a new terminal to restart.
      log.info('Development mode detected - spawning new terminal for restart');
      spawnDevModeRestart();
      electron?.app.quit();
    } else {
      // In packaged builds, restart works normally
      log.info({ tempDir }, 'Restarting app for demo mode');
      electron?.app.relaunch();
      electron?.app.quit();
    }

    // This won't actually return, but TypeScript needs it
    return { success: true, requiresRestart: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to enter demo mode';
    log.error({ err: error }, 'Failed to enter demo mode');
    return { success: false, error: message, requiresRestart: true };
  }
};

/**
 * Spawn a new terminal window to restart npm run dev.
 * This is needed in dev mode because app.relaunch() doesn't restart the Vite dev server.
 * Includes a delay to allow the old Vite server to release port 5173.
 */
function spawnDevModeRestart(): void {
  // Find the project directory (where package.json lives)
  // In dev mode, appPath returns the project root
  const projectDir = getPlatformConfig().appPath;
  
  // Add a delay before starting npm run dev to allow the old Vite server to release port 5173
  const delayCmd = 'sleep 2 &&';
  const delayWin = 'timeout /t 2 &&';
  
  if (process.platform === 'darwin') {
    // macOS: Use osascript to open a new Terminal window
    const script = `tell application "Terminal"
      activate
      do script "cd '${projectDir}' && ${delayCmd} npm run dev"
    end tell`;
    
    spawn('osascript', ['-e', script], {
      detached: true,
      stdio: 'ignore',
    });
    log.info({ projectDir }, 'Spawned new Terminal window for dev restart');
  } else if (process.platform === 'win32') {
    // Windows: Use start cmd to open a new command prompt
    spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `cd /d "${projectDir}" && ${delayWin} npm run dev`], {
      detached: true,
      stdio: 'ignore',
      shell: true,
    });
    log.info({ projectDir }, 'Spawned new cmd window for dev restart');
  } else {
    // Linux: Try common terminal emulators
    const terminals = ['gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
    for (const term of terminals) {
      try {
        if (term === 'gnome-terminal') {
          spawn(term, ['--', 'bash', '-c', `cd '${projectDir}' && ${delayCmd} npm run dev; exec bash`], {
            detached: true,
            stdio: 'ignore',
          });
        } else {
          spawn(term, ['-e', `bash -c "cd '${projectDir}' && ${delayCmd} npm run dev; exec bash"`], {
            detached: true,
            stdio: 'ignore',
          });
        }
        log.info({ projectDir, terminal: term }, 'Spawned terminal for dev restart');
        return;
      } catch {
        // Try next terminal
      }
    }
    log.warn({ projectDir }, 'Could not find terminal emulator for dev restart - user must restart manually');
  }
}

// =============================================================================
// Mock Content for UX Testing (ACME Corp Demo Scenario)
// =============================================================================

/**
 * Personalized use cases for The Spark page.
 * These appear as clickable suggestions instead of the "Generate Workflows" button.
 * Format: PersonalizedUseCase (from @shared/types/settings).
 * generatedAt is set dynamically in seedDemoEnvironment().
 */
const MOCK_USE_CASES = [
  {
    id: 'demo-uc-meeting-prep',
    title: 'Prepare for my next meeting',
    description: 'Get briefed on attendees, agenda, and key context before your next meeting',
    prompt: 'Prepare me for my next meeting. Check my calendar, research the attendees, and create a briefing document with key talking points, relevant context from recent communications, and suggested questions to ask.',
    icon: '📋',
  },
  {
    id: 'demo-uc-team-update',
    title: 'Draft a team update email',
    description: 'Compose a concise update email for your team or leadership',
    prompt: 'Draft a team update email for the engineering and product teams covering our progress this week on the Nova Platform v2.0 launch, any blockers we hit, and priorities for next week. Keep it under 300 words.',
    icon: '✉️',
  },
  {
    id: 'demo-uc-competitor-research',
    title: 'Research a competitor',
    description: 'Gather competitive intelligence on a specific company or product',
    prompt: 'Research our main competitors in the enterprise workflow automation space. Focus on recent product launches, pricing changes, and any features that overlap with our Nova Platform v2.0. Summarize the top 3 threats and opportunities.',
    icon: '🔍',
  },
  {
    id: 'demo-uc-weekly-summary',
    title: 'Summarize this week\'s activity',
    description: 'Generate a weekly review of accomplishments, decisions, and upcoming priorities',
    prompt: 'Create my weekly summary. Review my calendar, recent conversations, and any documents I worked on this week. Highlight key accomplishments, important decisions made, and flag anything that needs attention next week.',
    icon: '📊',
  },
  {
    id: 'demo-uc-project-brief',
    title: 'Create a project brief',
    description: 'Draft a structured project brief with goals, timeline, and stakeholders',
    prompt: 'Help me create a project brief for the Enterprise SSO integration project. Include the business case, technical requirements from Elena\'s discovery interviews, proposed timeline, resource needs, and success metrics.',
    icon: '📄',
  },
  {
    id: 'demo-uc-okr-review',
    title: 'Review my Q1 OKR progress',
    description: 'Check progress against quarterly objectives and flag items needing attention',
    prompt: 'Review my Q1 2026 OKR progress. Pull in the latest data on each key result, highlight which ones are on track vs at risk, and suggest specific actions I should take this week to improve any lagging metrics.',
    icon: '🎯',
  },
];

/**
 * Pre-seed the demo environment with a temporary workspace and optionally API keys.
 * This writes app-settings.json and creates a workspace directory before restart.
 * 
 * Creates folder structure that properly simulates production:
 * 
 * /tempDir/
 * ├── Rebel/                    <- coreDirectory (workspace)
 * │   └── chief-of-staff/       <- Pre-created personal space
 * └── ACME Corp/                <- Simulated "external" folder (like Google Drive)
 *     └── General/              <- Subfolder user can link as work space
 * 
 * This structure ensures ACME Corp is OUTSIDE the workspace, so when user
 * selects it in onboarding, it correctly triggers the symlink flow (just like
 * selecting a real Google Drive folder would in production).
 */
async function seedDemoEnvironment(
  tempDir: string, 
  keepApiKeys: boolean, 
  isRestart: boolean = false,
  seedMockContent: boolean = false,
  showOnboarding: boolean = false
): Promise<void> {
  // Create workspace directory (Rebel/) - this is coreDirectory
  const demoWorkspacePath = path.join(tempDir, 'Rebel');
  await fsPromises.mkdir(demoWorkspacePath, { recursive: true, mode: 0o700 });
  
  // Create Chief-of-Staff inside workspace (pre-created personal space)
  // Use canonical capitalization to match production behavior and avoid path mismatches
  const chiefOfStaffPath = path.join(demoWorkspacePath, 'Chief-of-Staff');
  await fsPromises.mkdir(chiefOfStaffPath, { recursive: true, mode: 0o700 });
  
  // Create ACME Corp folder OUTSIDE workspace (simulates Google Drive)
  // This is a sibling to the workspace, not inside it
  const acmeCorpPath = path.join(tempDir, 'ACME Corp');
  const generalPath = path.join(acmeCorpPath, 'General');
  await fsPromises.mkdir(generalPath, { recursive: true, mode: 0o700 });
  
  log.info({ 
    demoWorkspacePath, 
    chiefOfStaffPath, 
    acmeCorpPath,
    generalPath 
  }, 'Created demo environment with workspace and simulated external folder');

  const now = Date.now();

  // Base spaces — Chief-of-Staff is always present
  const spaces: Record<string, unknown>[] = [
    {
      name: 'Chief-of-Staff',
      path: 'Chief-of-Staff',
      type: 'chief-of-staff',
      isSymlink: false,
      sharing: 'private',
      createdAt: now,
      hasReadme: seedMockContent,
    },
  ];

  // When seeding mock content, add work spaces for the ACME Corp demo scenario
  if (seedMockContent) {
    spaces.push(
      {
        name: 'General',
        path: 'work/ACME Corp/General',
        type: 'company',
        isSymlink: false,
        companyName: 'ACME Corp',
        sharing: 'company-wide',
        createdAt: now,
        hasReadme: true,
      },
      {
        name: 'Product Team',
        path: 'work/ACME Corp/Product Team',
        type: 'team',
        isSymlink: false,
        companyName: 'ACME Corp',
        sharing: 'restricted',
        createdAt: now,
        hasReadme: true,
      }
    );
  }

  // Base demo settings — fully configured unless showOnboarding is requested
  const skipOnboarding = !showOnboarding;
  const demoSettings: Record<string, unknown> = {
    coreDirectory: demoWorkspacePath,
    workspaceName: 'Rebel',
    companyName: 'ACME Corp',
    onboardingCompleted: skipOnboarding,
    ...(skipOnboarding && {
      onboardingFirstCompletedAt: now,
      eulaAcceptedAt: now,
      onboardingChecklist: { step: 1 },
    }),
    userEmail: '[external-email]',
    userFirstName: 'Jordan',
    spaces,
  };

  // Optionally copy API keys from current settings
  if (keepApiKeys) {
    // When restarting demo, read from current demo's userData; otherwise from shared settings
    const settingsPath = isRestart 
      ? path.join(getPlatformConfig().userDataPath, 'app-settings.json')
      : path.join(getPlatformConfig().appDataPath, 'mindstone-rebel', 'app-settings.json');
    
    try {
      const content = await fsPromises.readFile(settingsPath, 'utf8');
      const currentSettings = JSON.parse(content) as Record<string, unknown>;
      
      const modelSettings = currentSettings.models as Record<string, unknown> | undefined;
      const voice = currentSettings.voice as Record<string, unknown> | undefined;
      
      demoSettings.models = {
        apiKey: modelSettings?.apiKey ?? null,
        // Also copy OAuth token if present (for Mindstone auth users)
        oauthToken: modelSettings?.oauthToken ?? null,
        authMethod: modelSettings?.authMethod ?? 'api-key',
        planMode: modelSettings?.planMode ?? (modelSettings as any)?.opusPlanMode ?? false,
        thinkingModel: modelSettings?.thinkingModel as string | undefined,
        // Enable extended context for longer conversations
        extendedContext: modelSettings?.extendedContext ?? true,
      };
      const platformDefaultProvider = (process.platform === 'darwin' || process.platform === 'win32')
        ? 'local-parakeet' : 'openai-whisper';
      const resolvedProvider = voice?.provider ?? platformDefaultProvider;
      const defaultModel = resolvedProvider === 'local-parakeet' ? 'parakeet-v3'
        : resolvedProvider === 'local-moonshine' ? 'moonshine-base'
        : resolvedProvider === 'elevenlabs-scribe' ? 'scribe_v2'
        : 'gpt-4o-mini-transcribe-2025-12-15';
      demoSettings.voice = {
        openaiApiKey: voice?.openaiApiKey ?? null,
        elevenlabsApiKey: voice?.elevenlabsApiKey ?? null,
        provider: resolvedProvider,
        model: voice?.model ?? defaultModel,
        ttsVoice: voice?.ttsVoice ?? 'nova',
      };

      const providerKeys = currentSettings.providerKeys as Record<string, unknown> | undefined;
      if (providerKeys && typeof providerKeys === 'object') {
        demoSettings.providerKeys = {
          openai: (providerKeys.openai as string) ?? null,
          google: (providerKeys.google as string) ?? null,
        };
      }

      // Copy OpenRouter settings so OR users don't lose auth in demo mode
      const openRouter = currentSettings.openRouter as Record<string, unknown> | undefined;
      if (openRouter && openRouter.enabled) {
        demoSettings.openRouter = {
          enabled: true,
          oauthToken: (openRouter.oauthToken as string) ?? null,
          selectedModel: (openRouter.selectedModel as string) ?? 'openai/gpt-5.5',
        };
      }

      // Copy active provider so the demo uses the same provider the user had selected
      if (currentSettings.activeProvider) {
        demoSettings.activeProvider = currentSettings.activeProvider;
      }

      // Copy model profiles and custom providers for advanced setups
      if (Array.isArray(currentSettings.modelProfiles) && currentSettings.modelProfiles.length > 0) {
        demoSettings.modelProfiles = currentSettings.modelProfiles;
      }
      if (Array.isArray(currentSettings.customProviders) && currentSettings.customProviders.length > 0) {
        demoSettings.customProviders = currentSettings.customProviders;
      }

      log.info({ hasClaudeKey: !!modelSettings?.apiKey, hasOpenaiKey: !!voice?.openaiApiKey, hasOpenRouter: !!openRouter?.enabled, activeProvider: currentSettings.activeProvider, isRestart }, 
        'Copied API keys and provider settings to demo settings');
    } catch (err) {
      log.warn({ err, settingsPath, isRestart }, 'Could not read current settings for API key copy');
    }
  }

  if (seedMockContent) {
    const DAY_MS = 24 * 60 * 60 * 1000;
    demoSettings.personalizedUseCases = MOCK_USE_CASES.map(uc => ({
      ...uc,
      generatedAt: now - 7 * DAY_MS,
    }));
  }

  // Write to the demo directory (electron-store will find this on restart)
  // Use restrictive permissions (0600) to protect any API keys
  const demoSettingsPath = path.join(tempDir, 'app-settings.json');
  await fsPromises.writeFile(demoSettingsPath, JSON.stringify(demoSettings, null, 2), { encoding: 'utf8', mode: 0o600 });
  
  // Optionally seed mock content for UX testing
  if (seedMockContent) {
    // Create work spaces inside the workspace for the ACME Corp demo scenario
    const workAcmePath = path.join(demoWorkspacePath, 'work', 'ACME Corp');
    const generalSpacePath = path.join(workAcmePath, 'General');
    const productTeamPath = path.join(workAcmePath, 'Product Team');
    await fsPromises.mkdir(generalSpacePath, { recursive: true, mode: 0o700 });
    await fsPromises.mkdir(productTeamPath, { recursive: true, mode: 0o700 });
    
    await seedMockContentFiles(chiefOfStaffPath);
    await seedWorkSpaceFiles(generalSpacePath, productTeamPath);
    await seedMockInbox(tempDir, now);
    await seedMockSessions(tempDir, now);
    log.info({ chiefOfStaffPath, generalSpacePath, productTeamPath }, 'Seeded mock content for UX testing');
  }
  
  log.info({ demoSettingsPath, demoWorkspacePath, keepApiKeys, seedMockContent }, 
    'Pre-seeded demo environment');
}

/**
 * Mock skills for the ACME Corp demo scenario.
 * These support UX testing with an Executive Assistant persona.
 */
const MOCK_SKILLS = {
  'meeting-prep/SKILL.md': `---
name: meeting-prep
description: "Prepares comprehensive meeting briefing documents with attendee research, context, and suggested talking points"
last_updated: 2026-01-15
agent_type: main_agent
---

[GOAL]
Create a comprehensive meeting briefing document that helps you arrive prepared and confident for any meeting.

[PROCESS]
1. **Identify the meeting**: Find the meeting on your calendar by name, time, or upcoming schedule
2. **Research attendees**: Look up attendee profiles, recent communications, and relevant context
3. **Gather context**: Pull relevant emails, documents, and prior meeting notes
4. **Generate briefing**: Create a structured briefing document with:
   - Meeting overview and objectives
   - Attendee profiles and relationships
   - Key topics and potential discussion points
   - Suggested questions to ask
   - Any prep tasks to complete beforehand

[USAGE EXAMPLES]
- "Prepare me for my 2pm meeting with the board"
- "Create a briefing for my call with Jordan Chen tomorrow"
- "What do I need to know for the Q1 planning session?"
- "Prep me for the investor update meeting"

[IMPORTANT]
- Check calendar access if meetings can't be found
- Flag any gaps in available context
- Prioritize recent and relevant information
- Include links to source documents when possible
`,

  'email-drafting/SKILL.md': `---
name: email-drafting
description: "Drafts professional emails matching your communication style and tone preferences"
last_updated: 2026-01-10
agent_type: main_agent
---

[GOAL]
Draft professional emails that match your voice and achieve your communication objectives.

[PROCESS]
1. **Understand the context**: Clarify the recipient, purpose, and desired outcome
2. **Review preferences**: Check your communication style preferences and relationship history
3. **Draft the email**: Create a draft with appropriate tone, length, and structure
4. **Offer variations**: Provide alternatives if the initial draft needs adjustment

[USAGE EXAMPLES]
- "Draft an email to Sarah declining the meeting politely"
- "Write a follow-up email to the board about the Q1 results"
- "Help me respond to Marcus about the project delay"
- "Compose a thank-you note to the team for the launch success"

[TONE GUIDELINES]
- **Internal team**: Direct, warm, collaborative
- **Executives/Board**: Concise, professional, data-driven
- **External partners**: Professional, relationship-focused
- **Clients**: Service-oriented, clear, solution-focused

[IMPORTANT]
- Never send emails automatically - always present for your review
- Maintain confidentiality - don't include sensitive details unnecessarily
- Match the formality level to the recipient and context
`,

  'weekly-summary/SKILL.md': `---
name: weekly-summary
description: "Generates a comprehensive weekly activity summary with key accomplishments, decisions, and upcoming priorities"
last_updated: 2026-01-08
agent_type: main_agent
---

[GOAL]
Create a weekly summary that captures key activities, decisions, and priorities to keep stakeholders informed and help you reflect on progress.

[PROCESS]
1. **Review the week**: Scan calendar, emails, and documents from the past week
2. **Identify highlights**: Extract key meetings, decisions, and accomplishments
3. **Note blockers**: Capture any issues or delays that need attention
4. **Look ahead**: Preview upcoming priorities and important dates
5. **Generate summary**: Create a structured summary document

[OUTPUT FORMAT]
## Week of [Date Range]

### Key Accomplishments
- [Major achievement 1]
- [Major achievement 2]

### Important Decisions Made
- [Decision 1]: [Brief context and outcome]

### Meetings & Conversations
- [Key meeting 1]: [Key takeaways]

### Blockers & Issues
- [Issue requiring attention]

### Next Week Priorities
1. [Priority 1]
2. [Priority 2]

[USAGE EXAMPLES]
- "Generate my weekly summary"
- "Create a summary of this week for Alex"
- "What did I accomplish this week?"
- "Prepare my weekly update email"

[IMPORTANT]
- Focus on high-impact items, not exhaustive lists
- Include context that helps recipients understand significance
- Flag items needing follow-up or decisions
`,
};

/**
 * Space README with frontmatter - goes at Chief-of-Staff/README.md (space root).
 * This is separate from memories because the space README is NOT inside memory/.
 */
const SPACE_README = `---
rebel_space_description: "Executive Assistant context for VP of Product at ACME Corp"
space_type: "chief-of-staff"
sharing: "private"
---

# Private Space

## Profile

- **Name**: Jordan Lee
- **Role**: VP of Product at ACME Corp
- **Email**: [external-email]
- **Location**: San Francisco, CA (Pacific Time)

## AI Working Context

- Prefers concise communication with key details upfront
- Likes to see options and recommendations, not just information dumps
- Values meeting prep that includes relationship context
- Working on: Q1 2026 product launch, board preparation

## Current Priorities

1. **Q1 Product Launch** - Nova Platform v2.0 releasing end of March
2. **Board Meeting Prep** - Quarterly board meeting in February
3. **Team Scaling** - Hiring 3 senior engineers by end of Q1

## Frequently Useful References

- [[stakeholders/acme-corp-contacts]] - Key internal contacts
- [[stakeholders/board-members]] - Board member profiles
- [[projects/q1-product-launch]] - Launch planning context
`;

/**
 * Mock memories for the ACME Corp demo scenario.
 * These provide realistic context for UX testing.
 * Note: The space README is NOT in this object - it goes at the space root.
 */
const MOCK_MEMORIES = {
  'README.md': `# Memory Index

This folder contains memories and context for your private space.

## Contents

- **exec-preferences.md** - Executive working style and preferences
- **stakeholders/** - Key contact profiles and relationship context
- **projects/** - Active project context and status
- **recurring/** - Recurring meeting notes and patterns
`,

  'exec-preferences.md': `# Executive Preferences

## Communication Style

### Written Communication
- **Email length**: Prefer concise emails (under 200 words for routine items)
- **Formatting**: Use bullet points and headers for scannability
- **Tone**: Professional but warm; no corporate-speak
- **Response time expectations**: Same-day for urgent, 24-48 hours for routine

### Meeting Preferences
- **Prep time needed**: 10-15 minutes of context before external meetings
- **Briefing format**: Executive summary at top, details below
- **Calendar management**: Buffer 15 minutes between back-to-back meetings
- **Focus time**: Protect Tuesday and Thursday mornings for deep work

## Decision-Making Style

- Values data-driven recommendations with clear options
- Appreciates when context includes "why this matters now"
- Prefers 2-3 options with a recommended path, not open-ended questions
- Wants to know risks and mitigation strategies upfront

## Working Hours

- **Core hours**: 9am - 6pm Pacific
- **Email check times**: Morning (8-9am), lunch (12-1pm), evening (5-6pm)
- **Do not disturb**: Before 8am, after 8pm, weekends unless urgent
- **Definition of urgent**: Customer escalation, security incident, board/investor communication

## Relationship Context

- Board Chair (Patricia Williams): Prefers formal communication, data-heavy
- CEO (Alex Rivera): Direct, appreciates proactive updates
- CTO (Jordan Chen): Technical peer, collaborative relationship
`,

  'stakeholders/acme-corp-contacts.md': `# ACME Corp Key Contacts

## Executive Team

### Alex Rivera - CEO
- **Email**: [external-email]
- **Working style**: Big-picture thinker, values speed
- **Communication**: Direct, prefers brief updates
- **Key priorities**: Revenue growth, market expansion, fundraising
- **Note**: Weekly 1:1 on Mondays at 2pm

### Jordan Chen - CTO
- **Email**: [external-email]
- **Working style**: Detail-oriented, technical deep-dives
- **Communication**: Appreciates technical context
- **Key priorities**: Platform reliability, engineering hiring, technical debt
- **Note**: Good partner for product-eng alignment discussions

### Sarah Kim - CFO
- **Email**: [external-email]
- **Working style**: Analytical, process-driven
- **Communication**: Needs data and financial impact
- **Key priorities**: Cash runway, unit economics, board reporting
- **Note**: Partner for headcount and budget discussions

## Direct Reports

### Marcus Thompson - Senior Product Manager
- **Email**: [external-email]
- **Focus area**: Nova Platform core features
- **Note**: Leading Q1 launch execution

### Elena Rodriguez - Senior Product Manager  
- **Email**: [external-email]
- **Focus area**: Enterprise features and integrations
- **Note**: Key contact for enterprise customer feedback

### David Park - Product Designer
- **Email**: [external-email]
- **Focus area**: UX and design system
- **Note**: Partner for user research insights
`,

  'stakeholders/board-members.md': `# ACME Corp Board Members

## Patricia Williams - Board Chair
- **Background**: Former CEO of TechCorp, 25 years in enterprise software
- **Focus areas**: Governance, strategic direction, CEO mentorship
- **Communication style**: Formal, appreciates thorough preparation
- **Key concerns**: Market positioning, competitive differentiation
- **Meeting prep tip**: Always have 3 data points ready for any claim

## Michael Foster - Board Member (Investor Representative)
- **Affiliation**: Summit Ventures (Series B lead)
- **Background**: Partner at Summit, former product executive
- **Focus areas**: Growth metrics, product-market fit, expansion strategy
- **Communication style**: Direct, metric-focused
- **Key concerns**: Path to profitability, customer acquisition costs
- **Meeting prep tip**: Know your ARR, NRR, and CAC/LTV by heart

## Dr. Aisha Patel - Board Member (Independent)
- **Background**: Stanford CS Professor, AI/ML research, technical advisory
- **Focus areas**: Technical strategy, AI product direction, R&D investments
- **Communication style**: Curious, asks probing questions
- **Key concerns**: Technical moat, innovation pipeline
- **Meeting prep tip**: Be prepared to discuss technical architecture decisions

## Jennifer Martinez - Board Observer
- **Affiliation**: Horizon Capital (Series A investor)
- **Background**: Early-stage investor, operational background
- **Focus areas**: Team building, operational efficiency
- **Communication style**: Supportive, offers practical advice
- **Meeting prep tip**: Good resource for hiring best practices
`,

  'projects/q1-product-launch.md': `# Q1 2026 Product Launch: Nova Platform v2.0

## Overview

**Launch Date**: March 31, 2026
**Product**: Nova Platform v2.0 - Next-generation workflow automation
**Target Market**: Mid-market and enterprise companies (500-5000 employees)

## Key Features

1. **AI-Powered Workflows** - Intelligent automation suggestions
2. **Enterprise SSO** - SAML/OIDC integration for security compliance
3. **Advanced Analytics** - Real-time dashboards and reporting
4. **API v2** - Enhanced developer experience with GraphQL

## Launch Timeline

| Phase | Dates | Status |
|-------|-------|--------|
| Feature complete | Feb 15 | 🟡 In Progress |
| Beta testing | Feb 15 - Mar 15 | ⬜ Upcoming |
| Marketing prep | Mar 1 - Mar 25 | ⬜ Upcoming |
| Launch | Mar 31 | ⬜ Upcoming |

## Key Stakeholders

- **Product Lead**: You (VP of Product)
- **Engineering Lead**: Jordan Chen (CTO)
- **Marketing Lead**: Rachel Torres (VP Marketing)
- **Sales Lead**: Kevin O'Brien (VP Sales)

## Current Risks

1. **Engineering capacity**: 2 senior engineers still needed
   - Mitigation: Prioritizing hires, considering contractors
   
2. **Beta customer recruitment**: Need 10 enterprise beta customers
   - Mitigation: Leveraging existing relationships, offering incentives

3. **Documentation timeline**: API docs may slip
   - Mitigation: Bringing in technical writer contractor

## Success Metrics

- 50 enterprise signups in first 30 days
- 90%+ feature adoption among beta customers
- <5 P1 bugs in first week
- Positive coverage in 3+ industry publications
`,

  'recurring/weekly-exec-meeting.md': `# Weekly Executive Team Meeting

## Meeting Details

- **When**: Every Monday, 10:00 AM - 11:00 AM Pacific
- **Where**: Conference Room A / Zoom (hybrid)
- **Attendees**: Alex (CEO), Jordan (CTO), Sarah (CFO), You (VP Product), Rachel (VP Marketing), Kevin (VP Sales)

## Standard Agenda

1. **Wins & Highlights** (10 min)
   - Each exec shares one win from past week
   
2. **Key Metrics Review** (15 min)
   - Revenue/pipeline update (Kevin)
   - Product/engineering velocity (You + Jordan)
   - Financial health (Sarah)
   
3. **Cross-functional Items** (20 min)
   - Issues needing group input
   - Resource allocation discussions
   
4. **Strategic Topics** (15 min)
   - Rotating deep-dive topic
   - Board prep when relevant

## Your Typical Contributions

- Product velocity metrics and sprint highlights
- Customer feedback themes
- Product roadmap updates
- Cross-functional dependencies

## Preparation Checklist

- [ ] Review product metrics dashboard
- [ ] Prepare 2-3 key highlights
- [ ] Identify any blockers needing exec input
- [ ] Review action items from last week
- [ ] Check for any customer escalations

## Recent Meeting Notes

### January 20, 2026
- Discussed Q1 launch timeline - on track
- Agreed to accelerate enterprise SSO feature
- Action: You to provide hiring update next week

### January 13, 2026
- Reviewed Q4 results - exceeded targets
- Discussed board meeting prep
- Action: Sarah to circulate financial deck draft
`,
};

// =============================================================================
// Work Space Content (ACME Corp General + Product Team)
// =============================================================================

const GENERAL_SPACE_README = `---
rebel_space_description: "Company-wide resources, policies, and announcements for ACME Corp"
organisation_name: "ACME Corp"
space_type: "company"
sharing: "company-wide"
---

# ACME Corp — General

Shared company resources and reference material.

## What belongs here

- Company announcements and updates
- Policies and procedures
- Org-wide OKRs and strategy documents
- Cross-functional project references
`;

const PRODUCT_TEAM_README = `---
rebel_space_description: "Product team workspace — roadmap, rituals, project tracking, and team context"
organisation_name: "ACME Corp"
space_type: "team"
sharing: "restricted"
---

# Product Team

Team workspace for the ACME Corp product organization.

## Team

| Name | Role | Focus |
|------|------|-------|
| Jordan Lee | VP of Product | Strategy, roadmap, board prep |
| Marcus Thompson | Senior PM | Nova Platform core features |
| Elena Rodriguez | Senior PM | Enterprise features & integrations |
| David Park | Product Designer | UX and design system |
| Priya Sharma | Product Analyst | Metrics, experimentation, user research |

## Current Focus

- **Q1 2026**: Nova Platform v2.0 launch (March 31)
- **Hiring**: 3 senior engineers by end of Q1
- **Enterprise**: SSO + advanced analytics for enterprise tier
`;

const PRODUCT_TEAM_MEMORIES: Record<string, string> = {
  'README.md': `# Product Team Memory

Context and institutional knowledge for the product team.

## Contents

- **team-roster.md** — Full team directory with working styles
- **team-rituals.md** — Meeting cadence, norms, and processes
- **active-projects.md** — Current projects and status
- **okrs-q1-2026.md** — Quarterly objectives and key results
`,

  'team-roster.md': `# Product Team Roster

## Leadership

### Jordan Lee — VP of Product
- **Reports to**: Alex Rivera (CEO)
- **Working style**: Strategic thinker, prefers data-backed proposals
- **1:1 cadence**: Weekly with each direct report (Tuesday/Wednesday)
- **Note**: Always come with a recommendation, not just options

## Product Managers

### Marcus Thompson — Senior Product Manager
- **Email**: [external-email]
- **Focus**: Nova Platform core features, Q1 launch execution
- **Working style**: Methodical, detail-oriented, excellent at execution
- **Strengths**: Sprint planning, stakeholder alignment, shipping on time
- **Growth area**: Big-picture strategic thinking
- **1:1 notes**: Prefers structured agendas, responds well to direct feedback

### Elena Rodriguez — Senior Product Manager
- **Email**: [external-email]
- **Focus**: Enterprise features and integrations
- **Working style**: Customer-obsessed, relationship builder
- **Strengths**: Customer discovery, enterprise sales support, competitive analysis
- **Growth area**: Technical depth, saying no to feature requests
- **1:1 notes**: Brings customer stories, needs help prioritizing

## Design

### David Park — Product Designer
- **Email**: [external-email]
- **Focus**: UX, design system, user research
- **Working style**: Creative, visual thinker, values craft
- **Strengths**: Interaction design, prototyping, design system stewardship
- **Growth area**: Design-engineering handoff, timeline estimation
- **1:1 notes**: Show-don't-tell; schedule design reviews, not status updates

## Analytics

### Priya Sharma — Product Analyst
- **Email**: [external-email]
- **Focus**: Product metrics, A/B testing, user research
- **Working style**: Rigorous, data-first, asks great questions
- **Strengths**: Experiment design, dashboards, insight synthesis
- **Growth area**: Presenting to non-technical audiences
- **1:1 notes**: Loves debugging metrics anomalies together
`,

  'team-rituals.md': `# Product Team Rituals

## Weekly Meetings

### Product Team Standup
- **When**: Monday, Wednesday, Friday — 9:30 AM Pacific (15 min)
- **Format**: Round-robin async update in Slack → live standup for blockers only
- **Norms**: No laptops, camera on, raise blockers early

### Product Team Weekly
- **When**: Tuesday 2:00 PM — 3:00 PM Pacific
- **Attendees**: Full product team
- **Agenda**:
  1. Wins from the week (5 min)
  2. Metrics review — Priya presents dashboard (10 min)
  3. In-flight project updates (15 min)
  4. Design review or customer insight share (15 min)
  5. Open discussion (15 min)
- **Norms**: Rotate facilitator weekly, decisions documented in meeting notes

### Product-Engineering Sync
- **When**: Wednesday 10:00 AM Pacific
- **Attendees**: Product team + engineering leads
- **Purpose**: Align on sprint priorities, surface technical concerns, unblock dependencies

## Monthly

### Product Strategy Review
- **When**: First Thursday of month, 1:00 PM Pacific
- **Attendees**: Product team + Alex (CEO) + Jordan (CTO)
- **Purpose**: Roadmap progress, strategic pivots, resource allocation

### Customer Insight Share
- **When**: Third Friday of month, 11:00 AM Pacific
- **Attendees**: Product team + Sales + CS representatives
- **Purpose**: Share customer feedback patterns, validate roadmap priorities

## Quarterly

### Quarterly Planning
- **When**: Last week of quarter (3-day offsite or intensive)
- **Purpose**: Set OKRs, prioritize roadmap, retrospective

## Norms

- **Decision-making**: DACI framework (Driver, Approver, Contributors, Informed)
- **Documentation**: All decisions captured in meeting notes within 24 hours
- **Async-first**: Use Slack threads for discussions; meetings for decisions
- **No-meeting blocks**: Thursday mornings reserved for deep work
`,

  'active-projects.md': `# Active Projects — Q1 2026

## P0: Nova Platform v2.0 Launch

| Field | Value |
|-------|-------|
| **Owner** | Marcus Thompson |
| **Launch** | March 31, 2026 |
| **Milestone** | Feature complete by Feb 15 |
| **Status** | 🟡 On Track (risks flagged) |

### Workstreams
1. **AI Workflows** — Feature complete, in QA
2. **Enterprise SSO** — SAML done, OIDC in progress
3. **Analytics Dashboard** — Design approved, eng in sprint 3/6
4. **API v2 (GraphQL)** — Alpha ready, docs behind schedule

### Risks
- API documentation timeline — contractor starting Feb 10
- Beta recruitment — 7/10 enterprise customers confirmed
- Engineering capacity — 2 open senior roles

## P1: Enterprise Tier Expansion

| Field | Value |
|-------|-------|
| **Owner** | Elena Rodriguez |
| **Target** | Q2 2026 |
| **Status** | 🟢 Discovery phase |

### Key deliverables
- Advanced RBAC (role-based access control)
- Audit logging and compliance dashboard
- Custom deployment options (VPC, on-prem)
- Enterprise onboarding automation

### Discovery findings
- 12 enterprise prospect interviews completed
- Top requests: RBAC, audit logs, SOC2 compliance proof
- Competitive gap: Competitor X launched RBAC in December

## P2: Mobile App Exploration

| Field | Value |
|-------|-------|
| **Owner** | David Park |
| **Target** | Q3 2026 (tentative) |
| **Status** | ⬜ Research |

### Open questions
- Native vs. PWA vs. React Native?
- Which use cases translate to mobile?
- Resource implications (need mobile engineer hire)

<!-- rebel-annotations
[
  {"id":"ann-demo-1","text":"Feature complete by Feb 15","comment":"Slipping — need to escalate to Jordan. Engineering capacity is the bottleneck.","createdAt":1741100000000,"prefix":"**Milestone** | ","suffix":" |","from":184,"to":210},
  {"id":"ann-demo-2","text":"7/10 enterprise customers confirmed","comment":"Elena is confident we'll hit 10. Two warm leads from last week's conference.","createdAt":1741100000000,"prefix":"Beta recruitment — ","suffix":"\\n- Engineering capacity","from":590,"to":625},
  {"id":"ann-demo-3","text":"API documentation timeline","comment":"Technical writer starts Feb 10 — this risk should be mitigated soon.","createdAt":1741100000000,"prefix":"### Risks\\n- ","suffix":" — contractor starting Feb","from":510,"to":536}
]
-->
`,

  'okrs-q1-2026.md': `# Product OKRs — Q1 2026

## Objective 1: Ship Nova Platform v2.0 on time and on quality

| Key Result | Target | Current | Status |
|------------|--------|---------|--------|
| Feature-complete by Feb 15 | 100% | 85% | 🟡 |
| 10 enterprise beta customers | 10 | 7 | 🟡 |
| <5 P1 bugs in launch week | <5 | — | ⬜ |
| API docs published by Mar 25 | Done | In progress | 🟡 |

**Owner**: Marcus Thompson
**Exec sponsor**: Jordan Lee (VP Product)

## Objective 2: Validate enterprise expansion opportunity

| Key Result | Target | Current | Status |
|------------|--------|---------|--------|
| 15 enterprise discovery interviews | 15 | 12 | 🟢 |
| Enterprise requirements doc approved | Done | Draft | 🟡 |
| Competitive analysis complete | Done | Done | 🟢 |
| Revenue sizing model validated by finance | Done | In progress | 🟡 |

**Owner**: Elena Rodriguez
**Exec sponsor**: Jordan Lee (VP Product)

## Objective 3: Improve product development velocity

| Key Result | Target | Current | Status |
|------------|--------|---------|--------|
| Reduce avg. cycle time by 20% | 20% | 12% | 🟡 |
| Ship design system v2 | Done | 80% | 🟡 |
| Hire 3 senior engineers | 3 | 1 hired, 2 in pipeline | 🟡 |
| Establish product analytics dashboard | Done | Done | 🟢 |

**Owner**: Jordan Lee (VP Product)
**Exec sponsor**: Alex Rivera (CEO)
`,
};

/**
 * Seed work space files (General + Product Team) for the ACME Corp demo.
 */
async function seedWorkSpaceFiles(generalPath: string, productTeamPath: string): Promise<void> {
  // General space: just a README
  await fsPromises.writeFile(
    path.join(generalPath, 'README.md'),
    GENERAL_SPACE_README,
    { encoding: 'utf8', mode: 0o600 }
  );

  // Product Team space: README + memory files
  await fsPromises.writeFile(
    path.join(productTeamPath, 'README.md'),
    PRODUCT_TEAM_README,
    { encoding: 'utf8', mode: 0o600 }
  );

  const memoryPath = path.join(productTeamPath, 'memory');
  await fsPromises.mkdir(memoryPath, { recursive: true, mode: 0o700 });

  for (const [relativePath, content] of Object.entries(PRODUCT_TEAM_MEMORIES)) {
    const fullPath = path.join(memoryPath, relativePath);
    const dirPath = path.dirname(fullPath);
    await fsPromises.mkdir(dirPath, { recursive: true, mode: 0o700 });
    await fsPromises.writeFile(fullPath, content, { encoding: 'utf8', mode: 0o600 });
  }

  log.debug({
    generalPath,
    productTeamPath,
    teamMemoryCount: Object.keys(PRODUCT_TEAM_MEMORIES).length,
  }, 'Seeded work space files');
}

/**
 * Seed mock content files (skills and memories) for UX testing.
 * Creates realistic ACME Corp content in the Chief-of-Staff space.
 * 
 * @param chiefOfStaffPath - Path to the Chief-of-Staff directory in the demo workspace
 */
async function seedMockContentFiles(chiefOfStaffPath: string): Promise<void> {
  // Write space README at space root (Chief-of-Staff/README.md)
  // This contains the rebel_space_description frontmatter for space discovery
  const spaceReadmePath = path.join(chiefOfStaffPath, 'README.md');
  await fsPromises.writeFile(spaceReadmePath, SPACE_README, { encoding: 'utf8', mode: 0o600 });
  
  // Create skills directory and seed skill files
  const skillsPath = path.join(chiefOfStaffPath, 'skills');
  await fsPromises.mkdir(skillsPath, { recursive: true, mode: 0o700 });
  
  for (const [relativePath, content] of Object.entries(MOCK_SKILLS)) {
    const fullPath = path.join(skillsPath, relativePath);
    const dirPath = path.dirname(fullPath);
    await fsPromises.mkdir(dirPath, { recursive: true, mode: 0o700 });
    await fsPromises.writeFile(fullPath, content, { encoding: 'utf8', mode: 0o600 });
  }
  
  // Create memory directory and seed memory files
  const memoryPath = path.join(chiefOfStaffPath, 'memory');
  await fsPromises.mkdir(memoryPath, { recursive: true, mode: 0o700 });
  
  for (const [relativePath, content] of Object.entries(MOCK_MEMORIES)) {
    const fullPath = path.join(memoryPath, relativePath);
    const dirPath = path.dirname(fullPath);
    await fsPromises.mkdir(dirPath, { recursive: true, mode: 0o700 });
    await fsPromises.writeFile(fullPath, content, { encoding: 'utf8', mode: 0o600 });
  }
  
  log.debug({ 
    skillsCount: Object.keys(MOCK_SKILLS).length,
    memoriesCount: Object.keys(MOCK_MEMORIES).length,
    chiefOfStaffPath 
  }, 'Seeded mock content files');
}

// =============================================================================
// Mock Inbox Items (ACME Corp Demo Scenario)
// =============================================================================

/**
 * Seed mock inbox items so the Inbox shows realistic content instead of "Inbox Zero".
 * Creates entry JSON files in tempDir/inbox/ and an index at tempDir/inbox-index.json.
 *
 * Index version uses INBOX_STORE_VERSION from @core/constants.
 * Entry file format must match what readEntryFile() expects in inboxStore.ts.
 */
async function seedMockInbox(tempDir: string, now: number): Promise<void> {
  const INBOX_VERSION = INBOX_STORE_VERSION;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;

  const inboxDir = path.join(tempDir, 'inbox');
  await fsPromises.mkdir(inboxDir, { recursive: true, mode: 0o700 });

  const items = [
    {
      id: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
      title: 'Review enterprise pricing proposal from Elena',
      text: 'Elena shared the updated enterprise pricing tiers for Nova Platform v2.0. She needs your sign-off before sending to the 3 enterprise prospects in the beta pipeline. Key changes: volume discounts for 1000+ seats, annual commitment pricing, and a new "Enterprise Plus" tier.',
      source: { kind: 'conversation' as const, sessionId: 'a7b8c9d0-e1f2-3456-abcd-456789012345', label: 'Elena R.' },
      references: [] as unknown[],
      addedAt: now - 4 * HOUR_MS,
      archived: false,
      urgent: true,
      important: true,
      category: 'follow-up' as const,
    },
    {
      id: 'b2c3d4e5-f6a7-4901-bcde-f01234567890',
      title: 'Send board meeting pre-read to Patricia',
      text: 'The quarterly board meeting is coming up. Patricia Williams (Board Chair) expects the pre-read deck at least 5 days in advance. The deck should cover Q1 progress, Nova v2.0 launch status, financial overview, and the enterprise expansion strategy.',
      source: { kind: 'text' as const, label: 'Board prep' },
      references: [] as unknown[],
      addedAt: now - 1 * DAY_MS,
      archived: false,
      urgent: false,
      important: true,
      relevantDate: now + 5 * DAY_MS,
      category: 'user-request' as const,
    },
    {
      id: 'c3d4e5f6-a7b8-4012-cdef-012345678901',
      title: 'Follow up with recruiting on senior engineer candidates',
      text: 'We need 3 senior engineers by end of Q1 to support the Nova v2.0 launch. One hire is confirmed, two are in pipeline. Check with recruiting on interview status and whether we need to expand the sourcing channels.',
      source: { kind: 'text' as const, label: 'Hiring' },
      references: [] as unknown[],
      addedAt: now - 2 * DAY_MS,
      archived: false,
      urgent: false,
      important: true,
      category: 'follow-up' as const,
    },
    {
      id: 'd4e5f6a7-b8c9-4123-defa-123456789012',
      title: 'Share Q1 launch timeline with marketing',
      text: 'Rachel Torres (VP Marketing) needs the finalized Q1 launch timeline so her team can align the marketing campaign, press outreach, and customer communications. Send the latest version of the launch plan with key dates.',
      source: { kind: 'automation' as const, automationId: 'weekly-review', automationName: 'Weekly Review', label: 'Weekly plan' },
      references: [] as unknown[],
      addedAt: now - 3 * DAY_MS,
      archived: false,
      urgent: false,
      important: false,
      category: 'automation' as const,
    },
  ];

  for (const item of items) {
    await fsPromises.writeFile(
      path.join(inboxDir, `${item.id}.json`),
      JSON.stringify(item, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
  }

  const indexEntries = items.map(item => ({
    id: item.id,
    title: item.title,
    archived: false,
    addedAt: item.addedAt,
    sourceKind: item.source?.kind,
    urgent: item.urgent,
    important: item.important,
    relevantDate: (item as Record<string, unknown>).relevantDate as number | undefined,
    category: item.category,
  }));

  const indexState = {
    version: INBOX_VERSION,
    entries: indexEntries,
    history: [],
    migrationComplete: true,
  };

  await fsPromises.writeFile(
    path.join(tempDir, 'inbox-index.json'),
    JSON.stringify(indexState, null, 2),
    { encoding: 'utf8', mode: 0o600 }
  );

  log.debug({ itemCount: items.length }, 'Seeded mock inbox items');
}

// =============================================================================
// Mock Conversations (ACME Corp Demo Scenario)
// =============================================================================

/**
 * Seed mock conversation sessions so the sidebar shows history instead of being empty.
 * Creates session JSON files in tempDir/sessions/ and an index at tempDir/sessions/index.json.
 *
 * Index version uses SESSION_INDEX_VERSION imported from incrementalSessionStore.ts.
 * Session file format must match what getSession() expects (AgentSession JSON).
 *
 * Hard-delete-ledger exemption: this writes raw session files into a FRESH demo
 * temp profile that has no `session-delete-ledger.json`, so it never needs (and
 * must not consult) the disk write-guard ledger in incrementalSessionStore.ts.
 */
async function seedMockSessions(tempDir: string, now: number): Promise<void> {
  const sessionIndexVer = SESSION_INDEX_VERSION;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const sessionsDir = path.join(tempDir, 'sessions');
  await fsPromises.mkdir(sessionsDir, { recursive: true, mode: 0o700 });

  const session1Id = 'e5f6a7b8-c9d0-1234-efab-234567890123';
  const session1CreatedAt = now - 2 * DAY_MS;
  const session1Turn1Id = 't1-board-prep';
  const session1Turn2Id = 't2-board-prep';
  const session1 = {
    id: session1Id,
    title: 'Meeting prep: Board quarterly review',
    createdAt: session1CreatedAt,
    updatedAt: session1CreatedAt + 10 * 60 * 1000,
    resolvedAt: session1CreatedAt + 12 * 60 * 1000,
    // Active session (doneAt null = Active).
    doneAt: null,
    starredAt: null,
    deletedAt: null,
    messages: [
      {
        id: 'm1-board',
        turnId: session1Turn1Id,
        role: 'user' as const,
        text: 'Help me prepare for the quarterly board meeting next week. I need a briefing on each board member, the key topics we should cover, and any risks I should be ready to address.',
        createdAt: session1CreatedAt,
      },
      {
        id: 'm2-board',
        turnId: session1Turn1Id,
        role: 'assistant' as const,
        text: 'Here\'s your board meeting briefing:\n\n**Board Members**\n\n1. **Patricia Williams (Chair)** — Former CEO of TechCorp. Expects data-heavy presentations. Focus: governance, strategic direction.\n2. **Michael Foster (Summit Ventures)** — Series B lead. Will want ARR, NRR, and CAC/LTV metrics. Focus: growth and path to profitability.\n3. **Dr. Aisha Patel (Independent)** — Stanford CS Professor. Will probe technical architecture decisions. Focus: technical moat.\n4. **Jennifer Martinez (Horizon Capital, Observer)** — Early-stage investor. Focus: team building, operational efficiency.\n\n**Suggested Agenda Topics**\n- Q1 product progress (Nova v2.0 launch timeline)\n- Financial health and runway update\n- Enterprise expansion strategy\n- Hiring plan and team scaling\n\n**Key Risks to Address**\n- API documentation timeline slipping\n- Beta customer recruitment (7/10 confirmed)\n- 2 open senior engineering roles\n\nWould you like me to draft the pre-read deck outline?',
        createdAt: session1CreatedAt + 3 * 60 * 1000,
      },
      {
        id: 'm3-board',
        turnId: session1Turn2Id,
        role: 'user' as const,
        text: 'Yes, draft the outline for the pre-read deck. Keep it to 10-12 slides max.',
        createdAt: session1CreatedAt + 5 * 60 * 1000,
      },
      {
        id: 'm4-board',
        turnId: session1Turn2Id,
        role: 'assistant' as const,
        text: 'Here\'s the pre-read deck outline (12 slides):\n\n1. **Cover** — Q1 2026 Board Update, ACME Corp\n2. **Executive Summary** — 3 key highlights, 1 risk flag\n3. **Q1 OKR Scorecard** — Traffic light status on all 3 objectives\n4. **Nova Platform v2.0** — Feature progress, launch timeline, beta status\n5. **Financial Overview** — Revenue, burn rate, runway (Sarah\'s data)\n6. **Customer Metrics** — ARR growth, NRR, churn, pipeline\n7. **Enterprise Expansion** — Discovery findings, TAM, competitive landscape\n8. **Engineering & Hiring** — Team velocity, open roles, hiring pipeline\n9. **Product Roadmap** — Q2-Q3 outlook, key bets\n10. **Competitive Landscape** — Market positioning, key differentiators\n11. **Key Risks & Mitigations** — Top 3 risks with action plans\n12. **Discussion & Asks** — Specific board input needed\n\nI can flesh out any of these slides with the data from your workspace. Want me to start with the OKR scorecard or financial overview?',
        createdAt: session1CreatedAt + 10 * 60 * 1000,
      },
    ],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    origin: 'manual' as const,
  };

  const session2Id = 'f6a7b8c9-d0e1-2345-fabc-345678901234';
  const session2CreatedAt = now - 1 * DAY_MS;
  const session2Turn1Id = 't1-email-draft';
  const session2 = {
    id: session2Id,
    title: 'Draft email to engineering about API v2 timeline',
    createdAt: session2CreatedAt,
    updatedAt: session2CreatedAt + 5 * 60 * 1000,
    resolvedAt: session2CreatedAt + 6 * 60 * 1000,
    // Done session (doneAt = resolvedAt).
    doneAt: session2CreatedAt + 6 * 60 * 1000,
    starredAt: null,
    deletedAt: null,
    messages: [
      {
        id: 'm1-email',
        turnId: session2Turn1Id,
        role: 'user' as const,
        text: 'Draft an email to Jordan Chen and the engineering team about the API v2 documentation timeline. We need to flag that docs are behind schedule and propose bringing in a technical writer contractor to help.',
        createdAt: session2CreatedAt,
      },
      {
        id: 'm2-email',
        turnId: session2Turn1Id,
        role: 'assistant' as const,
        text: 'Here\'s a draft:\n\n---\n\n**Subject: API v2 Documentation — Timeline Update & Contractor Proposal**\n\nHi Jordan and team,\n\nQuick update on the API v2 documentation timeline for the Nova Platform launch.\n\n**Current status:** The GraphQL API alpha is ready, but our documentation is running behind the March 25 target. At the current pace, we\'re looking at a 1-2 week slip, which would push past our March 31 launch date.\n\n**Proposal:** I\'d like to bring in a technical writer contractor starting Feb 10 to help close the gap. This would:\n- Free up engineering time to focus on the remaining beta features\n- Ensure docs meet our quality bar for enterprise customers\n- Keep us on track for the March 25 publish date\n\n**Budget impact:** Estimated 6-week engagement at ~$15K. I\'ve already flagged this with Sarah for budget approval.\n\n**Ask:** Can you review the current API docs draft and identify which sections need the most work? That\'ll help us scope the contractor engagement effectively.\n\nHappy to discuss in our Wednesday product-eng sync.\n\nBest,\nJordan\n\n---\n\nShall I adjust the tone or add any details?',
        createdAt: session2CreatedAt + 5 * 60 * 1000,
      },
    ],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    origin: 'manual' as const,
  };

  const session3Id = 'a7b8c9d0-e1f2-3456-abcd-456789012345';
  const session3CreatedAt = now - 3 * DAY_MS;
  const session3Turn1Id = 't1-sso-research';
  const session3Turn2Id = 't2-sso-research';
  const session3 = {
    id: session3Id,
    title: 'Research: Enterprise SSO competitors',
    createdAt: session3CreatedAt,
    updatedAt: session3CreatedAt + 15 * 60 * 1000,
    resolvedAt: session3CreatedAt + 18 * 60 * 1000,
    // Done session (doneAt = resolvedAt).
    doneAt: session3CreatedAt + 18 * 60 * 1000,
    starredAt: null,
    deletedAt: null,
    messages: [
      {
        id: 'm1-sso',
        turnId: session3Turn1Id,
        role: 'user' as const,
        text: 'I need competitive research on enterprise SSO implementations. Which of our competitors have shipped SAML/OIDC support, what does their implementation look like, and what can we learn from them?',
        createdAt: session3CreatedAt,
      },
      {
        id: 'm2-sso',
        turnId: session3Turn1Id,
        role: 'assistant' as const,
        text: 'Here\'s a competitive analysis of enterprise SSO implementations in the workflow automation space:\n\n**Competitor X (WorkflowPro)**\n- Shipped SAML + OIDC in December 2025\n- Supports major IdPs: Okta, Azure AD, OneLogin, Google Workspace\n- Notable: SCIM provisioning for automated user lifecycle management\n- Gap: No custom SAML attribute mapping\n\n**Competitor Y (AutomatePlatform)**\n- SAML only (no OIDC), launched Q3 2025\n- Limited to Enterprise tier ($99/user/month)\n- Notable: Built-in audit logging for compliance\n- Gap: No SSO-enforced login (optional only)\n\n**Competitor Z (FlowEngine)**\n- Full SSO suite since 2024, most mature implementation\n- SAML, OIDC, and LDAP support\n- Notable: Self-service SSO configuration wizard, zero-downtime migration\n- Gap: Complex pricing, SSO as paid add-on\n\n**Key Learnings for Our Implementation:**\n1. SCIM provisioning is becoming table-stakes for enterprise\n2. Self-service SSO setup significantly reduces support load\n3. Audit logging should be bundled with SSO, not a separate feature\n4. SSO enforcement (not just optional) is a common enterprise requirement\n\nWant me to dig deeper into any specific competitor or feature area?',
        createdAt: session3CreatedAt + 8 * 60 * 1000,
      },
      {
        id: 'm3-sso',
        turnId: session3Turn2Id,
        role: 'user' as const,
        text: 'Good overview. Can you summarize the pricing models? I want to understand how competitors are monetizing SSO specifically.',
        createdAt: session3CreatedAt + 10 * 60 * 1000,
      },
      {
        id: 'm4-sso',
        turnId: session3Turn2Id,
        role: 'assistant' as const,
        text: '**SSO Pricing Comparison:**\n\n| Competitor | SSO Pricing Model | Min Tier | Per-User Cost |\n|---|---|---|---|\n| WorkflowPro | Included in Business+ | $49/user/mo | No SSO add-on |\n| AutomatePlatform | Enterprise tier only | $99/user/mo | Bundled |\n| FlowEngine | Paid add-on | $29/user/mo + $15 SSO | Add-on |\n\n**Trends:**\n- The market is moving away from SSO as a paid add-on (the "SSO tax" is increasingly criticized)\n- Leading competitors include SSO in mid-tier plans to drive enterprise adoption\n- SCIM and advanced audit logging remain premium features\n\n**Recommendation for ACME Corp:**\n- Include basic SSO (SAML + OIDC) in our Business tier to differentiate\n- Reserve SCIM provisioning and advanced audit logging for Enterprise tier\n- This positions us competitively against WorkflowPro while maintaining premium upsell\n\nI can create a one-pager comparing these approaches if you\'d like to share with Elena for the enterprise requirements doc.',
        createdAt: session3CreatedAt + 15 * 60 * 1000,
      },
    ],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    origin: 'manual' as const,
  };

  // Session 4: Active (unresolved) — sets up live demo scenario
  const session4Id = 'b8c9d0e1-f2a3-4567-bcde-567890123456';
  const session4CreatedAt = now - 6 * 60 * 60 * 1000;
  const session4Turn1Id = 't1-q1-launch';
  const session4 = {
    id: session4Id,
    title: 'Q1 launch readiness check-in',
    createdAt: session4CreatedAt,
    updatedAt: session4CreatedAt + 5 * 60 * 1000,
    resolvedAt: null,
    // Done session (doneAt = updatedAt; resolvedAt absent).
    doneAt: session4CreatedAt + 5 * 60 * 1000,
    starredAt: null,
    deletedAt: null,
    messages: [
      {
        id: 'm1-launch',
        turnId: session4Turn1Id,
        role: 'user' as const,
        text: 'Can you pull together a readiness dashboard for our Q1 launch? I want to see where each workstream stands before the all-hands tomorrow.',
        createdAt: session4CreatedAt,
      },
      {
        id: 'm2-launch',
        turnId: session4Turn1Id,
        role: 'assistant' as const,
        text: 'Here\'s your Q1 Launch Readiness Dashboard:\n\n**Nova Platform v2.0 — Launch: March 31, 2026**\n\n| Workstream | Status | Owner | Notes |\n|---|---|---|---|\n| AI Workflows | ✅ Complete | Marcus T. | In QA, no blockers |\n| Enterprise SSO | 🟡 In Progress | Elena R. | SAML done, OIDC 80% |\n| Analytics Dashboard | 🟡 In Progress | David P. | Sprint 3 of 6 |\n| API v2 (GraphQL) | ⚠️ At Risk | Jordan C. | Alpha ready, docs behind |\n| Beta Program | 🟡 In Progress | Elena R. | 7/10 customers confirmed |\n| Marketing Prep | ⬜ Not Started | Rachel T. | Kicks off Mar 1 |\n\n**Overall Readiness: 65%**\n\n**Key Risks:**\n1. API documentation — 2 weeks behind, contractor starting Feb 10\n2. Beta recruitment — need 3 more enterprise customers\n3. Engineering capacity — 2 senior roles still open\n\n**Recommended Talking Points for All-Hands:**\n- Lead with the AI Workflows completion (team win)\n- Flag API docs risk transparently and share mitigation plan\n- Celebrate the 7 beta customers already onboard\n\nWant me to format this as slides for the all-hands?',
        createdAt: session4CreatedAt + 5 * 60 * 1000,
      },
    ],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    origin: 'manual' as const,
  };

  // Session 5: Starred + resolved — shows deck/Gamma workflow in history
  const session5Id = 'c9d0e1f2-a3b4-5678-cdef-678901234567';
  const session5CreatedAt = now - 4 * DAY_MS;
  const session5Turn1Id = 't1-board-deck';
  const session5Turn2Id = 't2-board-deck';
  const session5 = {
    id: session5Id,
    title: 'Board deck: Q4 results and Q1 outlook',
    createdAt: session5CreatedAt,
    updatedAt: session5CreatedAt + 20 * 60 * 1000,
    resolvedAt: session5CreatedAt + 25 * 60 * 1000,
    // Done session (doneAt = resolvedAt).
    doneAt: session5CreatedAt + 25 * 60 * 1000,
    starredAt: session5CreatedAt + 25 * 60 * 1000,
    deletedAt: null,
    messages: [
      {
        id: 'm1-deck',
        turnId: session5Turn1Id,
        role: 'user' as const,
        text: 'I need to create a board presentation covering Q4 results and Q1 outlook. Can you create an outline? This is for Patricia and the full board — keep it data-heavy and strategic.',
        createdAt: session5CreatedAt,
      },
      {
        id: 'm2-deck',
        turnId: session5Turn1Id,
        role: 'assistant' as const,
        text: 'Here\'s the board presentation outline:\n\n**ACME Corp — Q4 2025 Results & Q1 2026 Outlook**\n\n**1. Executive Summary** (1 slide)\n- Q4 revenue: exceeded target by 12%\n- Key wins: 3 enterprise deals closed, AI Workflows shipped\n- Q1 focus: Nova v2.0 launch + enterprise expansion\n\n**2. Financial Performance** (2 slides)\n- Revenue: $4.2M ARR (+35% YoY)\n- NRR: 118% (up from 112% in Q3)\n- Burn rate and runway: 18 months at current spend\n- Unit economics: CAC payback period down to 14 months\n\n**3. Product Highlights** (2 slides)\n- Nova Platform v2.0 development progress\n- AI Workflows feature adoption: 62% of active users\n- Enterprise SSO development update\n\n**4. Customer Metrics** (1 slide)\n- 847 active organizations (+28% QoQ)\n- Enterprise segment: 12 accounts, $1.8M ARR\n- Churn: 2.1% monthly (down from 2.8%)\n\n**5. Q1 Roadmap & Strategy** (2 slides)\n- Nova v2.0 launch plan (March 31)\n- Enterprise tier expansion strategy\n- Hiring plan: 3 senior engineers + technical writer\n\n**6. Risks & Mitigations** (1 slide)\n- Top 3 risks with status and action plans\n\n**7. Board Asks** (1 slide)\n- Input on enterprise pricing strategy\n- Introductions to potential beta customers\n\nI can generate this as a Gamma deck if you\'d like — that would give you a polished, presentation-ready version you can edit directly.',
        createdAt: session5CreatedAt + 8 * 60 * 1000,
      },
      {
        id: 'm3-deck',
        turnId: session5Turn2Id,
        role: 'user' as const,
        text: 'Yes, generate the Gamma deck. Use our standard board template with the navy and white color scheme.',
        createdAt: session5CreatedAt + 12 * 60 * 1000,
      },
      {
        id: 'm4-deck',
        turnId: session5Turn2Id,
        role: 'assistant' as const,
        text: 'I\'ve generated the board deck in Gamma:\n\n**"ACME Corp — Q4 Results & Q1 Outlook"** — 10 slides\n\nThe deck uses your navy and white board template with:\n- Data visualizations for financial metrics (ARR trend, NRR chart)\n- Product roadmap timeline graphic\n- Customer growth waterfall chart\n- Risk matrix with color-coded severity\n\nEach slide has speaker notes with talking points tailored for Patricia\'s preference for data-backed narratives.\n\nYou can edit the deck directly in Gamma, or I can make specific adjustments here. A few things you might want to review:\n- Slide 4 (Customer Metrics): I used Q3 baseline numbers — verify with Priya\'s latest dashboard\n- Slide 6 (Risks): The engineering capacity risk may need updated hiring pipeline numbers from recruiting\n- Slide 7 (Board Asks): Consider whether you want to ask about the Series C timeline\n\nWant me to refine any specific slides?',
        createdAt: session5CreatedAt + 20 * 60 * 1000,
      },
    ],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    origin: 'manual' as const,
  };

  // Session 6: Starred + active — sets up annotation demo
  const session6Id = 'd0e1f2a3-b4c5-6789-defa-789012345678';
  const session6CreatedAt = now - 12 * 60 * 60 * 1000;
  const session6Turn1Id = 't1-annotate';
  const session6Turn2Id = 't2-annotate';
  const session6 = {
    id: session6Id,
    title: 'Annotate product requirements doc',
    createdAt: session6CreatedAt,
    updatedAt: session6CreatedAt + 15 * 60 * 1000,
    resolvedAt: null,
    // Done session (doneAt = updatedAt; resolvedAt absent).
    doneAt: session6CreatedAt + 15 * 60 * 1000,
    starredAt: session6CreatedAt + 15 * 60 * 1000,
    deletedAt: null,
    messages: [
      {
        id: 'm1-ann',
        turnId: session6Turn1Id,
        role: 'user' as const,
        text: 'Can you review and annotate the enterprise requirements document in the Product Team space? I want your analysis of the current project status and any risks that need attention.',
        createdAt: session6CreatedAt,
      },
      {
        id: 'm2-ann',
        turnId: session6Turn1Id,
        role: 'assistant' as const,
        text: 'I\'ve reviewed the active projects document and added annotations highlighting key concerns:\n\n**Annotations added to active-projects.md:**\n\n1. **Feature complete by Feb 15** — Flagged as slipping. Engineering capacity is the primary bottleneck with 2 open senior roles.\n\n2. **Beta recruitment (7/10 confirmed)** — Elena is tracking well here. Two warm leads from last week\'s conference should close the gap.\n\n3. **API documentation timeline** — Mitigated by the technical writer starting Feb 10, but worth monitoring.\n\n**Overall Assessment:**\nThe P0 launch is achievable but tight. The biggest risk is the engineering capacity constraint affecting both the Feb 15 feature-complete milestone and the API documentation. I\'d recommend escalating the hiring priority in your next exec meeting.\n\nWant me to dig into any specific area?',
        createdAt: session6CreatedAt + 5 * 60 * 1000,
      },
      {
        id: 'm3-ann',
        turnId: session6Turn2Id,
        role: 'user' as const,
        text: 'Good analysis. Can you give me more specific feedback on the Enterprise SSO section? I want to understand if the OIDC implementation is on track to complete before beta testing starts.',
        createdAt: session6CreatedAt + 8 * 60 * 1000,
      },
      {
        id: 'm4-ann',
        turnId: session6Turn2Id,
        role: 'assistant' as const,
        text: 'Here\'s a detailed analysis of the Enterprise SSO workstream:\n\n**SAML Implementation: ✅ Complete**\n- Supports major IdPs (Okta, Azure AD, OneLogin, Google Workspace)\n- Tested with 3 beta customers already\n\n**OIDC Implementation: 🟡 80% Complete**\n- Core auth flow working\n- Token refresh and session management in progress\n- Remaining: custom claims mapping, logout flow, error handling\n- Estimated completion: ~2 weeks (Feb 12-14)\n\n**Risk Assessment:**\nThe OIDC work should complete just before the Feb 15 feature-complete milestone, but there\'s almost no buffer. If the 2 remaining senior engineer hires close soon, one could be assigned to accelerate this.\n\n**Recommendation:**\n1. Ask Elena for a daily status update on OIDC progress through Feb 15\n2. Have Jordan Chen identify a current engineer who could assist if OIDC slips\n3. Consider phasing: launch beta with SAML-only, add OIDC in week 2 of beta\n\nThe phased approach would reduce launch risk significantly. Want me to draft a proposal for that?',
        createdAt: session6CreatedAt + 15 * 60 * 1000,
      },
    ],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    origin: 'manual' as const,
  };

  const sessions = [session1, session2, session3, session4, session5, session6];

  for (const session of sessions) {
    await fsPromises.writeFile(
      path.join(sessionsDir, `${session.id}.json`),
      JSON.stringify(session),
      { encoding: 'utf8', mode: 0o600 }
    );
  }

  const createSnippet = (text: string, maxLen = 80): string => {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen).trim()}…` : trimmed;
  };

  // Stage 3 write-stamp exemption: demo sessions are synthetic seed fixtures,
  // not runtime checkpoints. They intentionally bypass IncrementalSessionStore's
  // persistence choke point; keep index/session liveness consistent by deriving
  // busy scalars from the exact same in-memory fixture objects below.
  const indexEntries = sessions.map((session, idx) => {
    const messages = session.messages;
    const firstMsg = messages[0];
    const lastMsg = messages[messages.length - 1];
    const turnCount = Math.floor(messages.length / 2);

    // Must match computeFingerprint() in incrementalSessionStore.ts
    const metaFields = [
      session.title,
      session.doneAt ?? 0, // canonical lifecycle field; mirrors computeFingerprint order
      session.starredAt ?? 0,
      session.deletedAt ?? 0,
      session.resolvedAt ?? 0,
      0, // privateMode
      session.lastError ?? '',
      session.activeTurnId ?? '',
      session.isBusy ? 1 : 0,
      session.origin ?? 'manual',
      0, // memoryUpdateStatusByTurn length
      0, // timeSavedStatusByTurn length
      0, // compactionBoundaries length
    ];
    const fingerprint = `${session.updatedAt}:${messages.length}:0:${JSON.stringify(metaFields)}`;

    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      resolvedAt: session.resolvedAt,
      doneAt: session.doneAt ?? null, // canonical lifecycle field (non-null = Done)
      starredAt: session.starredAt ?? null,
      deletedAt: session.deletedAt ?? null,
      origin: session.origin,
      isCorrupted: false,
      preview: createSnippet(lastMsg.text),
      firstMessagePreview: createSnippet(firstMsg.text, 200),
      messageCount: messages.length,
      hasDraft: false,
      draftPreview: null,
      draftUpdatedAt: null,
      usage: {
        costUsd: 0.08 + idx * 0.04,
        inputTokens: 2000 + idx * 500,
        outputTokens: 1500 + idx * 300,
        turnCount,
      },
      // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- Demo-mode seeding exemption: synthetic index fixture mirrors the already-constructed in-memory demo session object.
      activeTurnId: session.activeTurnId ?? null,
      // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- Demo-mode synthetic fixture intentionally carries seeded busy scalar to keep index/session seed data aligned.
      isBusy: session.isBusy,
      lastError: session.lastError ?? null,
      fingerprint,
    };
  });

  const sessionIndex = {
    version: sessionIndexVer,
    lastUpdated: now,
    sessions: indexEntries,
  };

  await fsPromises.writeFile(
    path.join(sessionsDir, 'index.json'),
    JSON.stringify(sessionIndex),
    { encoding: 'utf8', mode: 0o600 }
  );

  log.debug({ sessionCount: sessions.length }, 'Seeded mock conversation sessions');
}

/**
 * Exit demo mode by clearing the flag, cleaning up the temp directory, and restarting.
 * The temp directory is deleted immediately to leave no trace.
 */
export const exitDemoMode = async (): Promise<{ success: boolean; error?: string; requiresRestart: true }> => {
  if (!isDemoModeActive()) {
    log.warn('Not in demo mode');
    return { success: true, requiresRestart: true };
  }

  try {
    const tempDir = getDemoTempDir();

    // Clear the flag so the next startup uses normal userData
    clearDemoModeFlag();

    // Schedule cleanup of the temp directory after restart
    // We can't delete it now because the app is still using it, but we can
    // mark it for immediate deletion on next normal startup
    if (tempDir) {
      markDemoDirectoryForCleanup(tempDir);
    }

    const electronMod = getElectronModule();
    const isDevMode = !getPlatformConfig().isPackaged;
    log.info({ tempDir, isDevMode }, 'Demo mode flag cleared, temp dir marked for cleanup, restarting app');

    if (isDevMode) {
      // In dev mode, app.relaunch() won't work properly because the Vite dev server
      // is killed when the parent npm process exits. Spawn a new terminal to restart.
      log.info('Development mode detected - spawning new terminal for restart');
      spawnDevModeRestart();
      electronMod?.app.quit();
    } else {
      // In packaged builds, restart works normally
      electronMod?.app.relaunch();
      electronMod?.app.quit();
    }

    // This won't actually return, but TypeScript needs it
    return { success: true, requiresRestart: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to exit demo mode';
    log.error({ err: error }, 'Failed to exit demo mode');
    return { success: false, error: message, requiresRestart: true };
  }
};

// File path for marking directories for immediate cleanup
const CLEANUP_MARKER_FILENAME = 'mindstone-demo-cleanup.txt';

/**
 * Mark a demo directory for immediate cleanup on next normal startup.
 */
function markDemoDirectoryForCleanup(dirPath: string): void {
  try {
    const markerPath = path.join(os.tmpdir(), CLEANUP_MARKER_FILENAME);
    // Append to marker file (may have multiple if user enters/exits demo mode multiple times)
    fs.appendFileSync(markerPath, dirPath + '\n', { mode: 0o600 });
    log.debug({ dirPath, markerPath }, 'Marked demo directory for cleanup');
  } catch (err) {
    log.warn({ err, dirPath }, 'Failed to mark demo directory for cleanup');
  }
}

/**
 * Clean up demo directories that were marked for immediate deletion.
 * Call this on normal (non-demo) startup before cleanupOrphanedDemoDirs.
 */
export const cleanupMarkedDemoDirs = async (): Promise<void> => {
  if (isDemoModeActive()) {
    return;
  }

  const markerPath = path.join(os.tmpdir(), CLEANUP_MARKER_FILENAME);
  
  try {
    const content = await fsPromises.readFile(markerPath, 'utf8');
    const dirsToClean = content.split('\n').filter(line => line.trim());
    
    for (const dirPath of dirsToClean) {
      try {
        await fsPromises.rm(dirPath, { recursive: true, force: true });
        log.info({ dirPath }, 'Cleaned up marked demo directory');
      } catch (err) {
        log.debug({ dirPath, err }, 'Failed to clean marked demo directory (may already be deleted)');
      }
    }
    
    // Remove the marker file
    await fsPromises.unlink(markerPath);
  } catch (err) {
    // Marker file doesn't exist - nothing to clean
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.debug({ err }, 'Failed to read demo cleanup marker');
    }
  }
};

/**
 * Clean up orphaned demo directories that are older than ORPHAN_CLEANUP_AGE_MS.
 * Call this on normal (non-demo) startup to prevent disk space accumulation.
 */
export const cleanupOrphanedDemoDirs = async (): Promise<void> => {
  if (isDemoModeActive()) {
    // Don't clean up while in demo mode
    return;
  }

  try {
    const tempDir = os.tmpdir();
    const entries = await fsPromises.readdir(tempDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('mindstone-demo-')) {
        continue;
      }

      const dirPath = path.join(tempDir, entry.name);

      try {
        const stat = await fsPromises.stat(dirPath);
        const age = Date.now() - stat.mtimeMs;

        if (age > ORPHAN_CLEANUP_AGE_MS) {
          log.info({ dirPath, agedays: Math.round(age / (24 * 60 * 60 * 1000)) }, 'Cleaning up orphaned demo directory');
          await fsPromises.rm(dirPath, { recursive: true, force: true });
        }
      } catch (err) {
        // Individual dir cleanup failed, continue with others
        log.debug({ dirPath, err }, 'Failed to check/clean demo directory');
      }
    }
  } catch (error) {
    log.warn({ err: error }, 'Failed to cleanup orphaned demo directories');
  }
};

// ============================================================================
// Legacy compatibility - these are no longer needed with app.setPath() approach
// but kept for backward compatibility during migration
// ============================================================================

/** @deprecated Demo mode now uses app.setPath() - inbox uses normal storage */
export const getDemoInbox = (): null => null;

/** @deprecated Demo mode now uses app.setPath() - inbox uses normal storage */
export const setDemoInbox = (_state: unknown): void => {
  // No-op - inbox is now stored in the redirected userData
};

/** @deprecated Demo mode now uses app.setPath() */
export const getDemoTaskQueue = getDemoInbox;

/** @deprecated Demo mode now uses app.setPath() */
export const setDemoTaskQueue = setDemoInbox;

/** @deprecated Listeners not needed - demo mode change requires restart */
export const onDemoModeChange = (_listener: (active: boolean) => void): (() => void) => {
  // No-op - demo mode changes require restart, so runtime listeners aren't useful
  return () => {};
};

/** @deprecated Internal function no longer needed */
export const broadcastDemoModeChange = (_active: boolean): void => {
  // No-op
};
