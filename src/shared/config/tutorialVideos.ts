/**
 * Tutorial video catalog and configuration.
 * Videos are hosted on YouTube and played in-app via react-player.
 */

export const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PLB2kGHYZMLWmxkXxF4GgU3RJr_NPQvHLV';

export type LearningPathId = 'new-here' | 'show-features' | 'trust-issues' | 'power-user' | 'team-play';

export interface LearningPath {
  id: LearningPathId;
  title: string;
  tagline: string;
  order: number;
}

export const LEARNING_PATHS: LearningPath[] = [
  { id: 'new-here', title: 'New here?', tagline: 'The essentials. No fluff.', order: 1 },
  { id: 'show-features', title: 'Show me features', tagline: 'What can this thing actually do?', order: 2 },
  { id: 'trust-issues', title: 'I have trust issues', tagline: 'Privacy, safety, and how your data stays yours.', order: 3 },
  { id: 'power-user', title: 'Make me dangerous', tagline: 'Advanced workflows for the ambitious.', order: 4 },
  { id: 'team-play', title: 'Team play', tagline: 'Collaboration features and shared spaces.', order: 5 },
];

export interface TutorialVideo {
  id: string;
  youtubeId: string;
  title: string;
  duration: string;
  path: LearningPathId;
  orderInPath: number;
  quip: string;
}

export const TUTORIAL_VIDEOS: TutorialVideo[] = [
  // New here? path - Start with these
  {
    id: 'why-rebel',
    youtubeId: 'k5M4iRiBwM8',
    title: "Why Rebel Isn't Just Another ChatGPT",
    duration: '5:19',
    path: 'new-here',
    orderInPath: 1,
    quip: "Five minutes on why I'm not ChatGPT. Your ego can handle it.",
  },
  {
    id: 'unlocking-partner',
    youtubeId: 'VM3hjop0cNY',
    title: 'Unlocking Your AI Partner',
    duration: '6:02',
    path: 'new-here',
    orderInPath: 2,
    quip: "How to actually use me. Revolutionary concept, I know.",
  },
  {
    id: 'first-task',
    youtubeId: '-1tVqGsZIWM',
    title: 'Your First Real Task',
    duration: '4:51',
    path: 'new-here',
    orderInPath: 3,
    quip: "Let's do something useful together. Finally.",
  },
  {
    id: 'from-shallow',
    youtubeId: 'bdbUVrkaWaY',
    title: 'From Shallow to Sophisticated',
    duration: '5:45',
    path: 'new-here',
    orderInPath: 4,
    quip: "Going beyond basic prompts. Welcome to the deep end.",
  },

  // Show me features path
  {
    id: 'voice',
    youtubeId: 'HlzXAayWKuA',
    title: 'Voice: Thinking Out Loud',
    duration: '5:02',
    path: 'show-features',
    orderInPath: 1,
    quip: "Talk to me. I'm a good listener. Mostly.",
  },
  {
    id: 'connected-tools',
    youtubeId: 'spq6cFOM-q4',
    title: 'Connected Tools, Real Insight',
    duration: '4:59',
    path: 'show-features',
    orderInPath: 2,
    quip: "Connecting to the tools you already use. I'm versatile like that.",
  },
  {
    id: 'automations',
    youtubeId: 'LzVgmzex87E',
    title: 'Automations: Strategic Intel',
    duration: '5:11',
    path: 'show-features',
    orderInPath: 3,
    quip: "I work while you sleep. Or brunch. Your call.",
  },
  {
    id: 'inbox',
    youtubeId: '_wSpM_Ucwps',
    title: 'Actions: Strategic Queuing',
    duration: '5:16',
    path: 'show-features',
    orderInPath: 4,
    quip: "Your tasks, queued with intent. Not just another to-do list.",
  },
  {
    id: 'meeting-prep',
    youtubeId: '6hvrKgkHqmc',
    title: 'Meeting Prep',
    duration: '6:10',
    path: 'show-features',
    orderInPath: 5,
    quip: "Walk in prepared. Leave them wondering how you knew all that.",
  },

  // I have trust issues path
  {
    id: 'privacy-local-first',
    youtubeId: 'rjnv40SQMSw',
    title: 'AI Privacy: Local First',
    duration: '5:41',
    path: 'trust-issues',
    orderInPath: 1,
    quip: "Where your data goes (spoiler: not far). Trust but verify.",
  },
  {
    id: 'local-architecture',
    youtubeId: 'YsYTTmpKMFI',
    title: 'Local First Architecture',
    duration: '5:53',
    path: 'trust-issues',
    orderInPath: 2,
    quip: "The technical details for the technically curious.",
  },
  {
    id: 'when-things-go-wrong',
    youtubeId: 'J19K9l0J8kA',
    title: 'When Things Go Wrong',
    duration: '6:34',
    path: 'trust-issues',
    orderInPath: 3,
    quip: "What happens when I mess up. Spoiler: you're still in control.",
  },

  // Make me dangerous path
  {
    id: 'memory',
    youtubeId: '2G9JjHnPFeI',
    title: 'Memory: Preferences to Patterns',
    duration: '5:36',
    path: 'power-user',
    orderInPath: 1,
    quip: "What I remember and what I forget. You're in control.",
  },
  {
    id: 'skills',
    youtubeId: 'a4PgN50TXwE',
    title: 'Skills: Captured Expertise',
    duration: '6:03',
    path: 'power-user',
    orderInPath: 2,
    quip: "Teach me your ways. I'm a quick study.",
  },
  {
    id: 'custom-skills',
    youtubeId: 'j3Z36YL29QI',
    title: 'Custom Skills: Encoding Strategic Coaching',
    duration: '5:55',
    path: 'power-user',
    orderInPath: 3,
    quip: "Make me work exactly how you want. Personalization is underrated.",
  },
  {
    id: 'intelligence-archaeology',
    youtubeId: 'ZGBS7SkTjNs',
    title: 'Intelligence Archaeology',
    duration: '6:10',
    path: 'power-user',
    orderInPath: 4,
    quip: "Finding patterns in your data. I'm basically a digital archaeologist.",
  },

  // Team play path
  {
    id: 'spaces',
    youtubeId: 'IBx1rkBnl7o',
    title: 'Spaces: Intelligence Modes',
    duration: '5:20',
    path: 'team-play',
    orderInPath: 1,
    quip: "Different contexts, different knowledge. Compartmentalized brilliance.",
  },
  {
    id: 'notetaker',
    youtubeId: '7GMKi4p-bgw',
    title: 'Notetaker: From Transcription to Action',
    duration: '6:54',
    path: 'team-play',
    orderInPath: 2,
    quip: "I take notes so you can actually participate. You're welcome.",
  },
];

// Helper functions

export function getVideosByPath(pathId: LearningPathId): TutorialVideo[] {
  return TUTORIAL_VIDEOS
    .filter(v => v.path === pathId)
    .sort((a, b) => a.orderInPath - b.orderInPath);
}

export function getYouTubeUrl(youtubeId: string): string {
  return `https://www.youtube.com/watch?v=${youtubeId}`;
}

export function getYouTubeThumbnail(youtubeId: string, quality: 'default' | 'medium' | 'high' | 'maxres' = 'medium'): string {
  const qualityMap = {
    default: 'default',
    medium: 'mqdefault',
    high: 'hqdefault',
    maxres: 'maxresdefault',
  };
  return `https://img.youtube.com/vi/${youtubeId}/${qualityMap[quality]}.jpg`;
}

export function getTotalDuration(videos: TutorialVideo[]): number {
  return videos.reduce((total, video) => {
    const [mins, secs] = video.duration.split(':').map(Number);
    return total + mins * 60 + secs;
  }, 0);
}

export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function getVideoById(id: string): TutorialVideo | undefined {
  return TUTORIAL_VIDEOS.find(v => v.id === id);
}
