/** @see docs/project/UI_SETTINGS_AND_FORMS.md — "Search Index Sync" section for design rationale */
import type { SettingsDestinationId } from '@shared/navigation/settingsNavigationContract';
import { resolveSettingsNavigation } from '@shared/navigation/settingsNavigationContract';
import type { SettingsTabId } from '@shared/navigation/types';

export type SearchEntry = {
  tab: SettingsTabId;
  section?: string;
  label: string;
  keywords: string[];
};

export const SETTINGS_DESTINATION_LABELS: Record<SettingsDestinationId, string> = {
  agent_voice: 'Agent & Voice',
  connectors: 'Connectors',
  privacy_safety: 'Privacy & Safety',
  meetings: 'Meetings',
  workspace: 'Workspace',
  account_preferences: 'Account & Preferences',
  usage: 'Usage',
  advanced: 'Advanced',
};

export const SETTINGS_TAB_LABELS: Record<SettingsTabId, string> = {
  tools: 'Connectors',
  spaces: 'Spaces',
  plugins: 'Plugins',
  agents: 'AI & Models',
  voice: 'Voice',
  meetings: 'Meetings',
  safety: 'Safety',
  system: 'General',
  cloud: 'Continuity & Messaging',
  usage: 'Usage',
  diagnostics: 'Support',
  developer: 'Developer',
  account: 'Account',
};

export const SETTINGS_SEARCH_INDEX: SearchEntry[] = [
  // Plugins
  { tab: 'plugins', label: 'Plugins', keywords: ['plugin', 'extension', 'custom tab'] },
  { tab: 'plugins', section: 'pluginsActive', label: 'Active plugins', keywords: ['installed plugins', 'enabled plugins', 'import plugin'] },
  { tab: 'plugins', section: 'pluginsArchived', label: 'Archived plugins', keywords: ['disabled plugins', 'archived', 'inactive plugins'] },
  { tab: 'plugins', section: 'pluginsAvailableFromSpaces', label: 'Plugins from spaces', keywords: ['space plugins', 'shared plugins'] },

  // Connectors & tools
  { tab: 'tools', section: 'connectors', label: 'Connectors', keywords: ['mcp', 'integration', 'gmail', 'slack', 'calendar', 'notion'] },
  { tab: 'tools', section: 'connectors', label: 'Request connector', keywords: ['request', 'integration request', 'connector request'] },
  { tab: 'tools', section: 'experimental-connectors', label: 'Allow external MCP access', keywords: ['mcp server', 'cursor', 'claude desktop', 'external tools'] },
  { tab: 'tools', section: 'experimental-connectors', label: 'MCP client configuration', keywords: ['json', 'copy config', 'headless cli'] },
  { tab: 'tools', section: 'experimental-connectors', label: 'Interactive Views', keywords: ['mcp apps', 'rich views', 'tool ui'] },

  // Spaces
  { tab: 'spaces', section: 'spaces', label: 'Spaces', keywords: ['workspace', 'project', 'folder', 'context'] },
  { tab: 'spaces', section: 'spaces', label: 'Create a space', keywords: ['new space', 'add space', 'project space'] },
  { tab: 'spaces', section: 'moveToNewComputer', label: 'Move to a new computer', keywords: ['migrate', 'migration', 'transfer file', 'new machine', 'export', 'move rebel', 'switch computer'] },
  { tab: 'spaces', section: 'migrationReauthChecklist', label: 'Finish settling in', keywords: ['reconnect', 're-authenticate', 'after migration', 'sign in again', 'reauth', 'finish setup'] },

  // AI & model — connections (provider keys)
  { tab: 'agents', section: 'subscription', label: 'Mindstone subscription', keywords: ['subscription', 'mindstone', 'plan', 'billing', 'dash', 'dash plan', 'rogue', 'rogue plan', 'tier', 'managed', 'stripe', 'payment'] },
  { tab: 'agents', section: 'providerKeys', label: 'Authentication', keywords: ['provider', 'api key', 'anthropic', 'openai', 'google', 'cerebras', 'together', 'connection', 'authentication'] },
  { tab: 'agents', section: 'codex', label: 'ChatGPT Pro', keywords: ['chatgpt', 'openai', 'codex', 'pro', 'subscription', 'recommended'] },
  { tab: 'agents', section: 'openrouter', label: 'OpenRouter', keywords: ['openrouter', 'relay', 'oauth'] },
  { tab: 'agents', section: 'apiKey', label: 'Anthropic', keywords: ['claude', 'anthropic', 'default provider'] },
  { tab: 'agents', section: 'apiKey', label: 'Anthropic API key', keywords: ['claude', 'sk-ant', 'api key', 'primary'] },
  { tab: 'agents', section: 'openai', label: 'OpenAI API key', keywords: ['openai', 'provider key', 'sk-'] },
  { tab: 'agents', section: 'google', label: 'Google Gemini API key', keywords: ['google', 'gemini', 'aistudio'] },
  { tab: 'agents', section: 'together', label: 'Together AI API key', keywords: ['together', 'provider key'] },
  { tab: 'agents', section: 'cerebras', label: 'Cerebras API key', keywords: ['cerebras', 'provider key'] },
  { tab: 'agents', section: 'customProviders', label: 'Custom Providers', keywords: ['custom provider', 'gateway', 'proxy', 'litellm', 'openai compatible'] },
  // AI & model — backup connections (multi-provider failover, 260618_multiprovider-foundation Stage 6)
  { tab: 'agents', section: 'backupConnections', label: 'Backup connections', keywords: ['backup', 'backup connection', 'fallback', 'failover', 'rate limit', 'rate limited', 'provider order', 'priority', 'backup provider', 'multi-provider', 'switch providers', 'when rebel hits a limit'] },
  // AI & model — section-title labels (renamed in Stage 1 of 260510_models_settings_ia_simplification)
  { tab: 'agents', section: 'model', label: 'Available models', keywords: ['available models', 'models rebel can use', 'connected models', 'usable models'] },
  { tab: 'agents', section: 'model', label: 'Added by you', keywords: ['your models', 'added models', 'custom profiles', 'gateway', 'profile manager'] },
  { tab: 'agents', section: 'connectionCatalog', label: 'Included with your connections', keywords: ['catalog', 'subscriptions', 'credits', 'connection catalog', 'plan models'] },
  { tab: 'agents', section: 'codexCatalog', label: 'ChatGPT Pro models', keywords: ['chatgpt pro models', 'chatgpt pro catalog', 'codex catalog', 'gpt models', 'subscription models'] },
  { tab: 'agents', section: 'openrouterCatalog', label: 'OpenRouter models', keywords: ['openrouter models', 'openrouter catalog', 'pool models'] },
  { tab: 'agents', section: 'anthropicCatalog', label: 'Anthropic models', keywords: ['anthropic models', 'anthropic catalog', 'claude models', 'thinking effort'] },
  { tab: 'agents', section: 'geminiCatalog', label: 'Gemini models', keywords: ['gemini models', 'gemini catalog', 'google models'] },
  { tab: 'agents', section: 'defaultModelJobs', label: 'Model jobs', keywords: ['model jobs', 'default model jobs', 'roles', 'planner', 'main work', 'behind the scenes'] },
  // AI & model — configuration
  { tab: 'agents', section: 'defaultModelJobs', label: 'Planner', keywords: ['planner', 'thinking model', 'reasoning model', 'planning model', 'Deep thinking is now Planner.'] },
  { tab: 'agents', section: 'defaultModelJobs', label: 'Planner availability fallback', keywords: ['planner fallback', 'thinking fallback', 'model fallback', 'backup model', 'Deep thinking availability fallback is now Planner availability fallback.'] },
  { tab: 'agents', section: 'defaultModelJobs', label: 'Main work', keywords: ['working model', 'main model', 'assistant model'] },
  { tab: 'agents', section: 'defaultModelJobs', label: 'Main work long-conversation fallback', keywords: ['working fallback', 'long-conversation fallback', 'compaction', 'overflow', 'Recovery folds into Main work — set a fallback for long conversations.', 'recovery', 'long conversations'] },
  { tab: 'agents', section: 'defaultModelJobs', label: 'Behind the Scenes availability fallback', keywords: ['background fallback', 'model fallback', 'backup model'] },
  { tab: 'agents', section: 'defaultModelJobs', label: 'Behind the Scenes', keywords: ['background model', 'auxiliary model', 'safety checks', 'background services', 'Background tasks is now Behind the Scenes.'] },
  { tab: 'agents', section: 'modelTeam', label: 'Smart model picking', keywords: ['smart picking', 'model team', 'optional model team', 'multi-model', 'pick models for plan steps', 'Adaptive routing has been renamed to Smart model picking.'] },
  { tab: 'agents', section: 'modelTeam', label: 'Included in Smart picking', keywords: ["'Routing eligible' is now 'Included in Smart picking.'", 'smart picking chip', 'model team', 'member chips', 'council'] },
  { tab: 'agents', section: 'model', label: 'Thinking effort', keywords: ['reasoning effort', 'high medium low'] },
  { tab: 'agents', section: 'advancedModelOptions', label: 'Permission mode', keywords: ['advanced options', 'plan only', 'bypass permissions', 'tool execution'] },
  { tab: 'agents', section: 'advancedModelOptions', label: 'Auto memory updates', keywords: ['advanced options', 'memory', 'auto save facts', 'remember'] },
  { tab: 'agents', section: 'advancedModelOptions', label: 'Expose keys in agent shell', keywords: ['advanced options', 'environment variables', 'provider keys', 'shell'] },
  { tab: 'agents', section: 'behindTheScenesDetails', label: 'Behind the Scenes task overrides', keywords: ['bts overrides', 'model overrides', 'per-task', 'summary', 'conversation wrap-up', 'workspace memory sync', 'safety and security', 'memory', 'coaching', 'meetings', 'for you', 'search', 'foraging'] },
  { tab: 'agents', section: 'heroChoiceRunMode', label: 'Daily recommendations', keywords: ['hero choice', 'recommendations', 'daily suggestions', 'run mode', 'ask automatic off', 'homepage'] },
  { tab: 'agents', section: 'dailySparkMode', label: 'Daily Spark', keywords: ['daily spark', 'personalisation', 'personalization', 'haiku', 'limerick', 'note', 'homepage', 'mondays only', 'every day', 'subtle'] },
  { tab: 'agents', section: 'advancedModelOptions', label: 'File Indexing', keywords: ['advanced options', 'indexing', 'library', 'semantic search', 'embeddings'] },
  { tab: 'agents', section: 'fileIndexing', label: 'Use GPU to speed up file indexing', keywords: ['gpu embeddings', 'index performance'] },

  // Voice
  { tab: 'voice', section: 'voiceAudio', label: 'Voice provider', keywords: ['openai whisper', 'elevenlabs', 'local parakeet'] },
  { tab: 'voice', section: 'voiceAudio', label: 'OpenAI Whisper settings', keywords: ['openai voice', 'transcribe', 'stt'] },
  { tab: 'voice', section: 'voiceAudio', label: 'ElevenLabs Scribe settings', keywords: ['elevenlabs', 'scribe', 'tts voice'] },
  { tab: 'voice', section: 'voiceAudio', label: 'Local transcription (Parakeet)', keywords: ['local stt', 'on-device', 'parakeet'] },
  { tab: 'voice', section: 'voiceAudio', label: 'Voice input language', keywords: ['language', 'speech language', 'auto detect'] },
  { tab: 'voice', section: 'voiceAudio', label: 'Custom vocabulary', keywords: ['vocabulary', 'terms', 'acronyms', 'speech recognition'] },
  { tab: 'voice', section: 'voiceAudio', label: 'Text-to-Speech voice', keywords: ['tts', 'voice preview', 'spoken responses'] },
  { tab: 'voice', section: 'voiceAudio', label: 'Global voice activation hotkey', keywords: ['hotkey', 'shortcut', 'push to talk'] },
  { tab: 'voice', section: 'voiceAudio', label: 'After the hotkey sends…', keywords: ['voice mode', 'spoken answers', 'switch mode'] },

  // Meetings
  { tab: 'meetings', section: 'notetaker', label: 'Meeting Notetaker', keywords: ['meeting bot', 'meeting assistant', 'avatar'] },
  { tab: 'meetings', section: 'notetaker', label: 'Rebel avatar', keywords: ['dash', 'glitch', 'rogue', 'scout', 'spark'] },
  { tab: 'meetings', section: 'notetaker', label: 'Trigger phrase', keywords: ['hey rebel', 'wake phrase', 'meeting name'] },
  { tab: 'meetings', section: 'notetaker', label: 'Speak responses aloud', keywords: ['voice replies', 'meeting chat', 'spoken response'] },
  { tab: 'meetings', section: 'join-behavior', label: 'Join behavior', keywords: ['ask me first', 'auto-join', 'dont join'] },
  { tab: 'meetings', section: 'join-behavior', label: 'Ask me first', keywords: ['prompt minutes before', 'meeting reminder'] },
  { tab: 'meetings', section: 'join-behavior', label: 'Auto-join meetings', keywords: ['join automatically', 'auto join'] },
  { tab: 'meetings', section: 'join-behavior', label: 'Transcript storage', keywords: ['meeting notes space', '1:1 transcripts', 'group transcripts'] },
  { tab: 'meetings', section: 'voice-recorders', label: 'Voice recorders', keywords: ['physical recorder', 'recordings import'] },
  { tab: 'meetings', section: 'voice-recorders', label: 'Limitless Pendant', keywords: ['bluetooth recorder', 'pendant recording'] },
  { tab: 'meetings', section: 'voice-recorders', label: 'Plaud recordings', keywords: ['plaud', 'sync recordings', 'import recordings'] },
  { tab: 'meetings', section: 'advanced', label: 'Import from other services', keywords: ['fireflies', 'fathom', 'api key import'] },

  // Safety
  { tab: 'safety', section: 'safetyRules', label: 'Your safety rules', keywords: ['safety prompt', 'rules', 'guardrails'] },
  { tab: 'safety', section: 'standingPermissions', label: 'Trusted tools', keywords: ['always allow tools', 'tool approvals'] },
  { tab: 'safety', section: 'standingPermissions', label: 'Memory space permissions', keywords: ['space safety level', 'save without asking', 'always ask'] },
  { tab: 'safety', section: 'safetyActivity', label: 'Safety activity log', keywords: ['activity', 'safety decisions', 'what was allowed'] },
  { tab: 'safety', label: 'Built-in protections', keywords: ['safe patterns', 'read-only operations'] },
  { tab: 'safety', section: 'privacySafety', label: 'Privacy & Data', keywords: ['privacy', 'data', 'local-first', 'gdpr', 'privacy policy', 'data protection'] },
  { tab: 'safety', section: 'privacySafety', label: 'No AI training on your data', keywords: ['ai training', 'model training', 'data usage', 'anthropic', 'openai'] },
  { tab: 'safety', section: 'privacySafety', label: 'Secrets stay local', keywords: ['api keys', 'credentials', 'oauth tokens', 'local storage'] },
  { tab: 'safety', section: 'privacySafety', label: 'Privacy Mode', keywords: ['privacy mode', 'sensitive work', 'lock icon'] },

  // General/system
  { tab: 'system', section: 'coreDirectory', label: 'Core Directory', keywords: ['library root', 'workspace folder', 'directory path'] },
  { tab: 'system', section: 'appearance', label: 'Theme', keywords: ['appearance', 'dark', 'light', 'system theme'] },
  { tab: 'system', section: 'appearance', label: 'Estimate time saved', keywords: ['time saved estimation', 'weekly totals'] },
  { tab: 'system', section: 'appearance', label: 'Stream responses as they generate', keywords: ['streaming', 'progressive output'] },
  { tab: 'system', section: 'appearance', label: 'Accent color', keywords: ['accent', 'color', 'theme color', 'highlight color'] },
  { tab: 'system', section: 'appearance', label: 'Font size', keywords: ['text size', 'font scale', 'small', 'large', 'text too small', 'make text bigger'] },
  { tab: 'system', section: 'appearance', label: 'UI density', keywords: ['compact', 'comfortable', 'spacious', 'layout density', 'compact view', 'spacious view'] },
  { tab: 'system', section: 'appearance', label: 'Conversation width', keywords: ['narrow', 'medium', 'wide', 'chat width'] },
  { tab: 'system', section: 'notifications', label: 'Desktop Notifications', keywords: ['notifications', 'alerts', 'background notifications', 'when task finishes'] },
  { tab: 'system', section: 'notifications', label: 'Automation notifications', keywords: ['automations', 'automation complete', 'automation alerts', 'background task done'] },
  { tab: 'system', section: 'notifications', label: 'Conversation notifications', keywords: ['conversations', 'conversation complete', 'conversation alerts', 'reply ready'] },
  { tab: 'system', section: 'scratchpad', label: 'Scratchpad excluded folders', keywords: ['recent files', 'exclude folders', 'scratchpad'] },
  { tab: 'system', section: 'powerPerformance', label: 'Efficiency Mode', keywords: ['efficiency mode', 'performance', 'power', 'battery', 'low power', 'low spec', 'older laptop', 'fan noise', 'reduce motion', 'animations off', 'lite mode'] },
  { tab: 'system', section: 'advancedOperations', label: 'Advanced operations', keywords: ['danger zone', 'workspace operations'] },
  { tab: 'system', section: 'advancedOperations', label: 'Rename workspace folder', keywords: ['rename workspace', 'move folder name'] },
  { tab: 'system', section: 'localInference', label: 'Local Models', keywords: ['local inference', 'ollama', 'on-device', 'offline', 'download model'] },
  { tab: 'system', section: 'focus', label: 'Focus', keywords: ['focus', 'strategic planning', 'goals', 'calendar analysis', 'weekly planning', 'meeting audit'] },
  { tab: 'system', section: 'contextCompaction', label: 'Context Compaction', keywords: ['compact', 'compaction', 'context management', 'summarise', 'long conversations', 'context window'] },
  { tab: 'system', section: 'adaptiveRouting', label: 'Smart model picking toggle', keywords: ['smart model picking', 'smart picking', 'model selection', 'cost optimization', 'planner model choice', 'multi-model'] },
  { tab: 'system', section: 'preventSleep', label: 'Prevent Sleep', keywords: ['prevent sleep', 'keep awake', 'power save', 'system sleep', 'agent turns', 'wake lock'] },
  { tab: 'system', section: 'suggestions', label: 'Community events near you', keywords: ['suggestions', 'community events', 'meetups', 'nearby', 'location'] },
  { tab: 'meetings', section: 'experimental-meetings', label: 'Meeting Notetaker access', keywords: ['meeting bot unlock', 'experimental meetings'] },

  // Cloud
  { tab: 'cloud', section: 'messagingChannels', label: 'Slack listener', keywords: ['slack mentions', 'slack threads', 'messaging channels'] },
  { tab: 'cloud', section: 'messagingChannels', label: 'Connect Slack', keywords: ['slack connector', 'add slack', 'messaging channels'] },
  { tab: 'cloud', section: 'who-can-message-rebel', label: 'Who can message Rebel', keywords: ['owner only', 'allowlist', 'blocklist', 'trusted channels', 'other rebels', 'inbound author policy'] },
  { tab: 'cloud', section: 'who-can-message-rebel', label: 'Review who can message Rebel', keywords: ['upgrade review', 'review who can message', 'legacy permissive'] },
  { tab: 'cloud', section: 'recent-message-attempts', label: 'Recent message attempts', keywords: ['blocked attempts', 'allow this id', 'block this id', 'unknown slack user', 'recent senders'] },
  { tab: 'cloud', section: 'who-can-message-rebel', label: 'More than one Rebel is connected', keywords: ['multi rebel', 'peer instance count', 'other rebel installs'] },
  { tab: 'cloud', section: 'messagingChannels', label: 'Telegram (coming soon)', keywords: ['telegram', 'messaging channels'] },
  { tab: 'cloud', section: 'messagingChannels', label: 'WhatsApp (coming soon)', keywords: ['whatsapp', 'messaging channels'] },
  { tab: 'cloud', section: 'messagingChannels', label: 'Microsoft Teams (coming soon)', keywords: ['teams', 'microsoft teams', 'messaging channels'] },
  { tab: 'cloud', section: 'cloudCapacity', label: 'Cloud capacity', keywords: ['cloud capacity', 'cloud size', 'cloud speed', 'cloud storage', 'cloud resources'] },
  { tab: 'cloud', section: 'cloudCapacity', label: 'Cloud speed', keywords: ['cloud speed', 'cloud tier', 'vm tier', 'machine size', 'cpu', 'memory', 'fly machine', 'switch speed'] },
  { tab: 'cloud', section: 'cloudCapacity', label: 'Cloud storage', keywords: ['cloud storage', 'storage size', 'volume size', 'add storage', 'resize storage', 'fly volume', 'disk space'] },
  { tab: 'cloud', section: 'cloudSync', label: 'Cloud continuity mode', keywords: ['desktop only', 'add cloud continuity', 'sync across devices'] },
  { tab: 'cloud', section: 'cloudSync', label: 'Fly.io access token', keywords: ['fly token', 'cloud provisioning', 'set up cloud sync'] },
  { tab: 'cloud', section: 'cloudSync', label: 'Manual cloud connection', keywords: ['server url', 'access token', 'connect manually'] },
  { tab: 'cloud', section: 'cloudSync', label: 'Sync now', keywords: ['force sync', 'sync queue', 'outbox'] },
  { tab: 'cloud', section: 'cloudSync', label: 'Check cloud status', keywords: ['health check', 'cloud health', 'status'] },
  { tab: 'cloud', section: 'cloudSync', label: 'Remove continuity', keywords: ['disconnect cloud', 'remove cloud', 'unlink'] },
  { tab: 'cloud', section: 'cloudSync', label: 'Cloud update channel', keywords: ['beta channel', 'stable channel', 'cloud updates'] },
  { tab: 'cloud', section: 'cloudSync', label: 'Continue on mobile', keywords: ['pair mobile', 'mobile qr', 'copy token'] },
  { tab: 'cloud', section: 'cloudSync', label: 'Continue on web', keywords: ['web qr', 'copy web link', 'browser continuity'] },
  { tab: 'cloud', section: 'cloudSync', label: 'Full resync', keywords: ['resync', 'upload everything', 'sync stuck'] },
  { tab: 'cloud', section: 'cloudSync', label: 'Destroy cloud instance', keywords: ['deprovision', 'delete instance', 'fly destroy'] },

  // Usage
  { tab: 'usage', label: 'Usage overview', keywords: ['cost', 'tokens', 'spend', 'usage'] },
  { tab: 'usage', label: 'Cost breakdown', keywords: ['categories', 'conversations vs background', 'expenses'] },
  { tab: 'usage', label: 'Daily breakdown', keywords: ['daily usage', 'per day', 'usage table'] },
  { tab: 'usage', label: 'Export usage CSV', keywords: ['csv export', 'download usage report'] },

  // Support/diagnostics
  { tab: 'diagnostics', section: 'systemHealth', label: 'System health check', keywords: ['diagnostics', 'run system check', 'health report'] },
  { tab: 'diagnostics', section: 'systemHealth', label: 'Download diagnostics logs', keywords: ['standard report', 'detailed bundle', 'export logs'] },
  { tab: 'diagnostics', section: 'recentActivity', label: 'Recent activity', keywords: ['recent diagnostics', 'last events', 'copy for support', 'things broke'] },
  { tab: 'diagnostics', section: 'toolsConnection', label: 'Restart tools connection', keywords: ['restart', 'super-mcp', 'mcp', 'tools', 'connection'] },
  { tab: 'diagnostics', section: 'appUpdates', label: 'App updates', keywords: ['check for updates', 'download update', 'changelog'] },
  { tab: 'diagnostics', section: 'safeMode', label: 'Safe Mode', keywords: ['troubleshooting', 'tools disabled', 'restart safe mode'] },
  { tab: 'diagnostics', section: 'onboarding', label: 'Onboarding actions', keywords: ['restart onboarding', 'reset checklist'] },
  { tab: 'diagnostics', section: 'diagnosticsAdvanced', label: 'Developer mode', keywords: ['developer', 'dev mode', 'advanced settings', 'developer tab', 'enable developer'] },
  // Developer (only visible when Developer Mode is enabled)
  { tab: 'developer', section: 'demoMode', label: 'Demo Mode', keywords: ['demo data', 'showcase mode'] },
  { tab: 'developer', section: 'developerDebug', label: 'Developer debug', keywords: ['mcp mode', 'force direct mcp', 'restart super-mcp'] },
  { tab: 'developer', section: 'advancedOverrides', label: 'Advanced overrides', keywords: ['safety guard skill path', 'memory update path'] },
  { tab: 'developer', section: 'frequentTools', label: 'Frequent tools', keywords: ['tool statistics', 'reset statistics'] },
  { tab: 'developer', section: 'analytics', label: 'Analytics & telemetry', keywords: ['rudderstack', 'telemetry', 'analytics status'] },

  // Account
  { tab: 'account', section: 'profile', label: 'Profile', keywords: ['account', 'avatar', 'email'] },
  { tab: 'account', section: 'profile', label: 'Your name', keywords: ['display name', 'first name', 'meeting speaker detection'] },
  { tab: 'account', section: 'profile', label: 'Guest mode', keywords: ['exit guest mode', 'sign in'] },
  { tab: 'account', section: 'profile', label: 'Sign out', keywords: ['logout', 'end session'] },
];

const normalize = (value: string): string => value.trim().toLowerCase();

/** Score a search entry against a normalized query. Higher = better match. Returns 0 for no match. */
function scoreEntry(entry: SearchEntry, normalizedQuery: string): number {
  const label = normalize(entry.label);

  // Exact label match
  if (label === normalizedQuery) return 5;

  // Label starts with query
  if (label.startsWith(normalizedQuery)) return 4;

  // Label contains query
  if (label.includes(normalizedQuery)) return 3;

  // Exact keyword match (curated synonyms like "workspace" or "text too small")
  if (entry.keywords.some((kw) => normalize(kw) === normalizedQuery)) return 2;

  // Keyword contains query
  if (entry.keywords.some((kw) => normalize(kw).includes(normalizedQuery))) return 1;

  return 0;
}

export const filterSettingsSearchIndex = (query: string): SearchEntry[] => {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];

  return SETTINGS_SEARCH_INDEX
    .map((entry) => ({ entry, score: scoreEntry(entry, normalizedQuery) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry);
};

/** Destination ids that contain at least one search hit (for sidebar dim/highlight). */
export const getMatchingDestinationsForQuery = (query: string): SettingsDestinationId[] => {
  const matches = filterSettingsSearchIndex(query);
  const set = new Set<SettingsDestinationId>();
  for (const entry of matches) {
    const r = resolveSettingsNavigation({
      tab: entry.tab,
      section: entry.section,
    });
    set.add(r.destination);
  }
  return [...set];
};
