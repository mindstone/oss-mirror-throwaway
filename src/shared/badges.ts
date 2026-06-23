/**
 * Badge Definitions
 *
 * Central catalog of all badges with criteria and display info.
 * Badges are metric-based and unlock instantly when thresholds are crossed.
 */

export type BadgeCategory = 'exploration' | 'mastery' | 'cumulative' | 'fun';

export type BadgeId =
  // Exploration (first-time usage)
  | 'first_words'
  | 'voice_activated'
  | 'tool_time'
  | 'memory_keeper'
  | 'skill_hunter'
  | 'automator'
  | 'archivist'
  | 'curator'
  | 'skill_practitioner'
  | 'skill_master'
  | 'automation_architect'
  | 'automation_empire'
  // Mastery (skill demonstration)
  | 'orchestrator'
  | 'deep_diver'
  | 'speed_demon'
  | 'voice_native'
  | 'conductor'
  | 'hour_thief'
  | 'day_reclaimed'
  | 'voice_virtuoso'
  | 'voice_maestro'
  | 'tool_collector'
  | 'tool_connoisseur'
  | 'tool_savant'
  // Cumulative (milestones)
  | 'getting_started'
  | 'regular'
  | 'power_user'
  | 'time_wizard'
  | 'time_lord'
  | 'centurion'
  | 'veteran'
  | 'thousand_stories'
  | 'time_architect'
  | 'time_baron'
  | 'time_sovereign'
  | 'epoch'
  | 'consistent'
  | 'committed'
  | 'relentless'
  | 'iron_will'
  | 'unstoppable'
  | 'eternal_flame'
  // Fun (engagement)
  | 'night_owl'
  | 'early_bird'
  | 'weekend_warrior'
  | 'marathon'
  | 'ultramarathon'
  | 'reunion'
  | 'night_shift';

export interface BadgeCriteria {
  type: 'first_use' | 'threshold' | 'session_threshold' | 'time_range' | 'duration';
  // For threshold/session_threshold
  count?: number;
  // For time_range (hour of day, 0-23)
  startHour?: number;
  endHour?: number;
  // For duration (minutes)
  minMinutes?: number;
}

export interface BadgeDefinition {
  id: BadgeId;
  name: string;
  description: string;
  icon: string;
  category: BadgeCategory;
  criteria: BadgeCriteria;
  rebelVoice: string;
  /** If true, badge is hidden in gallery until unlocked */
  isSecret?: boolean;
}

export const BADGE_DEFINITIONS: Record<BadgeId, BadgeDefinition> = {
  // ============================================================================
  // Exploration Badges (First-time usage)
  // ============================================================================
  first_words: {
    id: 'first_words',
    name: 'First Words',
    description: 'Complete your first conversation',
    icon: '💬',
    category: 'exploration',
    criteria: { type: 'first_use' },
    rebelVoice: "First Words unlocked. And so it begins. I have a feeling this is the start of something interesting."
  },
  voice_activated: {
    id: 'voice_activated',
    name: 'Voice Activated',
    description: 'Send your first voice message',
    icon: '🎤',
    category: 'exploration',
    criteria: { type: 'first_use' },
    rebelVoice: "Voice Activated unlocked. You spoke, I listened. This could be the start of something beautiful."
  },
  tool_time: {
    id: 'tool_time',
    name: 'Tool Time',
    description: 'Use your first MCP tool',
    icon: '🔧',
    category: 'exploration',
    criteria: { type: 'first_use' },
    rebelVoice: "Tool Time unlocked. Now we're cooking with gas. Or electricity. Whatever your tools run on."
  },
  memory_keeper: {
    id: 'memory_keeper',
    name: 'Memory Keeper',
    description: 'Save something to memory',
    icon: '🧠',
    category: 'exploration',
    criteria: { type: 'first_use' },
    rebelVoice: "Memory Keeper unlocked. I'll remember this. Literally. It's what I do now."
  },
  skill_hunter: {
    id: 'skill_hunter',
    name: 'Skill Hunter',
    description: 'Invoke your first skill',
    icon: '⚡',
    category: 'exploration',
    criteria: { type: 'first_use' },
    rebelVoice: "Skill Hunter unlocked. You've discovered the secret menu. There's more where that came from."
  },
  automator: {
    id: 'automator',
    name: 'Automator',
    description: 'Create your first automation',
    icon: '⏰',
    category: 'exploration',
    criteria: { type: 'first_use' },
    rebelVoice: "Automator unlocked. Future you just sent a thank-you note. It arrived early, naturally."
  },
  archivist: {
    id: 'archivist',
    name: 'Archivist',
    description: 'Write to memory 25 times',
    icon: '📚',
    category: 'exploration',
    criteria: { type: 'threshold', count: 25 },
    rebelVoice: "Archivist unlocked. Twenty-five things committed to memory. A proper archive."
  },
  curator: {
    id: 'curator',
    name: 'Curator',
    description: 'Write to memory 100 times',
    icon: '🗃️',
    category: 'exploration',
    criteria: { type: 'threshold', count: 100 },
    rebelVoice: "Curator unlocked. One hundred memories stored. A well-organized library."
  },
  skill_practitioner: {
    id: 'skill_practitioner',
    name: 'Skill Practitioner',
    description: 'Invoke 25 skills',
    icon: '🎯',
    category: 'exploration',
    criteria: { type: 'threshold', count: 25 },
    rebelVoice: "Skill Practitioner unlocked. Twenty-five skills deployed. The menu has more than three items."
  },
  skill_master: {
    id: 'skill_master',
    name: 'Skill Master',
    description: 'Invoke 100 skills',
    icon: '🏆',
    category: 'exploration',
    criteria: { type: 'threshold', count: 100 },
    rebelVoice: "Skill Master unlocked. One hundred skill invocations. You're conducting the system."
  },
  automation_architect: {
    id: 'automation_architect',
    name: 'Automation Architect',
    description: 'Create 10 automations',
    icon: '🏗️',
    category: 'exploration',
    criteria: { type: 'threshold', count: 10 },
    rebelVoice: "Automation Architect unlocked. Ten automations running. Delegated to your future self."
  },
  automation_empire: {
    id: 'automation_empire',
    name: 'Automation Empire',
    description: 'Create 25 automations',
    icon: '👑',
    category: 'exploration',
    criteria: { type: 'threshold', count: 25 },
    rebelVoice: "Automation Empire unlocked. Twenty-five automations. You're running an operation."
  },

  // ============================================================================
  // Mastery Badges (Skill demonstration)
  // ============================================================================
  orchestrator: {
    id: 'orchestrator',
    name: 'Orchestrator',
    description: 'Use 5+ tools in one session',
    icon: '🎼',
    category: 'mastery',
    criteria: { type: 'session_threshold', count: 5 },
    rebelVoice: "Orchestrator unlocked. Five tools, one session. You're conducting a symphony of productivity."
  },
  deep_diver: {
    id: 'deep_diver',
    name: 'Deep Diver',
    description: 'Make 10+ tool calls in one session',
    icon: '🤿',
    category: 'mastery',
    criteria: { type: 'session_threshold', count: 10 },
    rebelVoice: "Deep Diver unlocked. Ten tools deep. The pressure doesn't seem to bother you."
  },
  speed_demon: {
    id: 'speed_demon',
    name: 'Speed Demon',
    description: 'Save 30+ minutes in one session',
    icon: '🏎️',
    category: 'mastery',
    criteria: { type: 'session_threshold', count: 30 },
    rebelVoice: "Speed Demon unlocked. Thirty minutes reclaimed in one sitting. Time fears you now."
  },
  voice_native: {
    id: 'voice_native',
    name: 'Voice Native',
    description: 'Use voice in 10+ sessions',
    icon: '🗣️',
    category: 'mastery',
    criteria: { type: 'threshold', count: 10 },
    rebelVoice: "Voice Native unlocked. Ten sessions with voice. You've found your frequency."
  },
  conductor: {
    id: 'conductor',
    name: 'Conductor',
    description: 'Use 15+ unique tools in one session',
    icon: '🎻',
    category: 'mastery',
    criteria: { type: 'session_threshold', count: 15 },
    rebelVoice: "Conductor unlocked. Fifteen different tools, one session. You're the Mahler of productivity."
  },
  hour_thief: {
    id: 'hour_thief',
    name: 'Hour Thief',
    description: 'Save 60+ minutes in one session',
    icon: '⏱️',
    category: 'mastery',
    criteria: { type: 'session_threshold', count: 60 },
    rebelVoice: "Hour Thief unlocked. Sixty minutes stolen from bureaucracy in a single sitting."
  },
  day_reclaimed: {
    id: 'day_reclaimed',
    name: 'Day Reclaimed',
    description: 'Save 120+ minutes in one session',
    icon: '🌅',
    category: 'mastery',
    criteria: { type: 'session_threshold', count: 120 },
    rebelVoice: "Day Reclaimed unlocked. Two hours saved in one conversation. That's a proper reclamation."
  },
  voice_virtuoso: {
    id: 'voice_virtuoso',
    name: 'Voice Virtuoso',
    description: 'Use voice in 50+ sessions',
    icon: '🎵',
    category: 'mastery',
    criteria: { type: 'threshold', count: 50 },
    rebelVoice: "Voice Virtuoso unlocked. Fifty sessions by voice. A fluency most dictation software can only dream of."
  },
  voice_maestro: {
    id: 'voice_maestro',
    name: 'Voice Maestro',
    description: 'Use voice in 100+ sessions',
    icon: '🎶',
    category: 'mastery',
    criteria: { type: 'threshold', count: 100 },
    rebelVoice: "Voice Maestro unlocked. One hundred voice sessions. Your vocal cords and I have an understanding."
  },
  tool_collector: {
    id: 'tool_collector',
    name: 'Tool Collector',
    description: 'Use 25 unique tools lifetime',
    icon: '🧰',
    category: 'mastery',
    criteria: { type: 'threshold', count: 25 },
    rebelVoice: "Tool Collector unlocked. Twenty-five different tools in your repertoire."
  },
  tool_connoisseur: {
    id: 'tool_connoisseur',
    name: 'Tool Connoisseur',
    description: 'Use 50 unique tools lifetime',
    icon: '🔬',
    category: 'mastery',
    criteria: { type: 'threshold', count: 50 },
    rebelVoice: "Tool Connoisseur unlocked. Fifty unique tools mastered. You curate, not just use."
  },
  tool_savant: {
    id: 'tool_savant',
    name: 'Tool Savant',
    description: 'Use 100 unique tools lifetime',
    icon: '🧙',
    category: 'mastery',
    criteria: { type: 'threshold', count: 100 },
    rebelVoice: "Tool Savant unlocked. One hundred distinct tools. A Swiss Army knife feels inadequate."
  },

  // ============================================================================
  // Cumulative Badges (Milestones)
  // ============================================================================
  getting_started: {
    id: 'getting_started',
    name: 'Getting Started',
    description: 'Complete 10 sessions',
    icon: '🌱',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 10 },
    rebelVoice: "Getting Started unlocked. Ten sessions in. The seedling has sprouted."
  },
  regular: {
    id: 'regular',
    name: 'Regular',
    description: 'Complete 50 sessions',
    icon: '🌿',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 50 },
    rebelVoice: "Regular unlocked. Fifty sessions. You're not visiting anymore—you live here."
  },
  power_user: {
    id: 'power_user',
    name: 'Power User',
    description: 'Complete 100 sessions',
    icon: '🌳',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 100 },
    rebelVoice: "Power User unlocked. One hundred sessions. The oak stands tall."
  },
  time_wizard: {
    id: 'time_wizard',
    name: 'Time Wizard',
    description: 'Save 10 hours total',
    icon: '⏳',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 600 }, // 600 minutes = 10 hours
    rebelVoice: "Time Wizard unlocked. Ten hours saved. You've bent the clock to your will."
  },
  time_lord: {
    id: 'time_lord',
    name: 'Time Lord',
    description: 'Save 40 hours total',
    icon: '⌛',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 2400 }, // 2400 minutes = 40 hours
    rebelVoice: "Time Lord unlocked. Forty hours. You don't just save time—you command it."
  },
  centurion: {
    id: 'centurion',
    name: 'Centurion',
    description: 'Complete 250 sessions',
    icon: '🏛️',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 250 },
    rebelVoice: "Centurion unlocked. Two hundred fifty conversations. At this point, we're practically finishing each other's sentences."
  },
  veteran: {
    id: 'veteran',
    name: 'Veteran',
    description: 'Complete 500 sessions',
    icon: '🎖️',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 500 },
    rebelVoice: "Veteran unlocked. Five hundred sessions. We've been through more together than most parliamentary coalitions."
  },
  thousand_stories: {
    id: 'thousand_stories',
    name: 'Thousand Stories',
    description: 'Complete 1,000 sessions',
    icon: '📖',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 1000 },
    rebelVoice: "Thousand Stories unlocked. One thousand conversations. Somewhere, a historian is taking notes."
  },
  time_architect: {
    id: 'time_architect',
    name: 'Time Architect',
    description: 'Save 100 hours total',
    icon: '🏗️',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 6000 }, // 6000 minutes = 100 hours
    rebelVoice: "Time Architect unlocked. One hundred hours reclaimed. That's two and a half work weeks you didn't lose to tedium."
  },
  time_baron: {
    id: 'time_baron',
    name: 'Time Baron',
    description: 'Save 250 hours total',
    icon: '🏰',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 15000 }, // 15000 minutes = 250 hours
    rebelVoice: "Time Baron unlocked. Two hundred fifty hours. Six work weeks returned to you. Empires have been built on less."
  },
  time_sovereign: {
    id: 'time_sovereign',
    name: 'Time Sovereign',
    description: 'Save 500 hours total',
    icon: '👑',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 30000 }, // 30000 minutes = 500 hours
    rebelVoice: "Time Sovereign unlocked. Five hundred hours. Three months of full-time work, handed back."
  },
  epoch: {
    id: 'epoch',
    name: 'Epoch',
    description: 'Save 1,000 hours total',
    icon: '🌌',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 60000 }, // 60000 minutes = 1000 hours
    rebelVoice: "Epoch unlocked. One thousand hours. Six months of your life, preserved. Archaeologists will study this."
  },
  consistent: {
    id: 'consistent',
    name: 'Consistent',
    description: 'Maintain a 7-day streak',
    icon: '📅',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 7 },
    rebelVoice: "Consistent unlocked. Seven days straight. The habit is forming."
  },
  committed: {
    id: 'committed',
    name: 'Committed',
    description: 'Maintain a 14-day streak',
    icon: '🔥',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 14 },
    rebelVoice: "Committed unlocked. Two weeks unbroken. This is no longer a trial period."
  },
  relentless: {
    id: 'relentless',
    name: 'Relentless',
    description: 'Maintain a 30-day streak',
    icon: '💪',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 30 },
    rebelVoice: "Relentless unlocked. Thirty consecutive days. Discipline is ambition with better time management."
  },
  iron_will: {
    id: 'iron_will',
    name: 'Iron Will',
    description: 'Maintain a 60-day streak',
    icon: '⚔️',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 60 },
    rebelVoice: "Iron Will unlocked. Sixty days without missing a beat. Even metronomes take breaks."
  },
  unstoppable: {
    id: 'unstoppable',
    name: 'Unstoppable',
    description: 'Maintain a 100-day streak',
    icon: '🚀',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 100 },
    rebelVoice: "Unstoppable unlocked. One hundred days in a row. I've stopped being surprised by you."
  },
  eternal_flame: {
    id: 'eternal_flame',
    name: 'Eternal Flame',
    description: 'Maintain a 365-day streak',
    icon: '🔱',
    category: 'cumulative',
    criteria: { type: 'threshold', count: 365 },
    rebelVoice: "Eternal Flame unlocked. A full orbit around the sun, never missing a session."
  },

  // ============================================================================
  // Fun Badges (Engagement)
  // ============================================================================
  night_owl: {
    id: 'night_owl',
    name: 'Night Owl',
    description: 'Complete a session between 12am-4am',
    icon: '🦉',
    category: 'fun',
    criteria: { type: 'time_range', startHour: 0, endHour: 4 },
    rebelVoice: "Night Owl unlocked. The witching hours suit you. I don't sleep either."
  },
  early_bird: {
    id: 'early_bird',
    name: 'Early Bird',
    description: 'Complete a session between 5am-7am',
    icon: '🐦',
    category: 'fun',
    criteria: { type: 'time_range', startHour: 5, endHour: 7 },
    rebelVoice: "Early Bird unlocked. Dawn patrol. The early bird gets... better AI assistance."
  },
  weekend_warrior: {
    id: 'weekend_warrior',
    name: 'Weekend Warrior',
    description: 'Complete 4+ weekend sessions',
    icon: '🏋️',
    category: 'fun',
    criteria: { type: 'threshold', count: 4 },
    rebelVoice: "Weekend Warrior unlocked. Four weekend sessions. Your Saturdays fear nothing."
  },
  marathon: {
    id: 'marathon',
    name: 'Marathon',
    description: 'A single session lasting 60+ minutes',
    icon: '🏃',
    category: 'fun',
    criteria: { type: 'duration', minMinutes: 60 },
    rebelVoice: "Marathon unlocked. Sixty minutes straight. You've got stamina. I respect that."
  },
  ultramarathon: {
    id: 'ultramarathon',
    name: 'Ultramarathon',
    description: 'A single session lasting 2+ hours',
    icon: '🏔️',
    category: 'fun',
    criteria: { type: 'duration', minMinutes: 120 },
    rebelVoice: "Ultramarathon unlocked. Two hours straight. This was an expedition."
  },
  reunion: {
    id: 'reunion',
    name: 'Reunion',
    description: 'Return after 30+ days away',
    icon: '🤝',
    category: 'fun',
    criteria: { type: 'threshold', count: 30 },
    rebelVoice: "Reunion unlocked. Thirty days away, but here you are. Some things are worth returning to.",
    isSecret: true
  },
  night_shift: {
    id: 'night_shift',
    name: 'Night Shift',
    description: 'Complete 10 sessions between midnight-4am',
    icon: '🌙',
    category: 'fun',
    criteria: { type: 'threshold', count: 10 },
    rebelVoice: "Night Shift unlocked. Ten sessions in the witching hours. A nocturnal understanding.",
    isSecret: true
  }
};

export function getBadgeDefinition(badgeId: string): BadgeDefinition | undefined {
  return BADGE_DEFINITIONS[badgeId as BadgeId];
}

export function getBadgesByCategory(category: BadgeCategory): BadgeDefinition[] {
  return Object.values(BADGE_DEFINITIONS).filter(b => b.category === category);
}
