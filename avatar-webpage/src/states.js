/**
 * Avatar State Management
 * 
 * Handles state transitions, GIF swapping, and personality triggers.
 */

// All possible avatar states
export const STATES = {
  // Core states (looping)
  IDLE: 'idle',
  LISTENING: 'listening', 
  THINKING: 'thinking',
  SPEAKING: 'speaking',
  READY_TO_SPEAK: 'ready_to_speak', // Has response queued, waiting for trigger
  
  // One-shot states (play once, return to idle)
  WAVE: 'wave',
  GOODBYE: 'goodbye',
  CELEBRATION: 'celebration',
  
  // Personality states (rare, context-triggered)
  EYE_ROLL: 'eye_roll',
  YAWN: 'yawn',
  NOD: 'nod',
};

// States that loop continuously
export const LOOPING_STATES = [
  STATES.IDLE,
  STATES.LISTENING,
  STATES.THINKING,
  STATES.SPEAKING,
  STATES.READY_TO_SPEAK,
];

// States that play once then return to idle
export const ONE_SHOT_STATES = [
  STATES.WAVE,
  STATES.GOODBYE,
  STATES.CELEBRATION,
  STATES.EYE_ROLL,
  STATES.YAWN,
  STATES.NOD,
];

// Default durations for one-shot states (ms)
// All animation videos are 5 seconds
export const ONE_SHOT_DURATIONS = {
  [STATES.WAVE]: 5000,
  [STATES.GOODBYE]: 5000,
  [STATES.CELEBRATION]: 5000,
  [STATES.EYE_ROLL]: 5000,
  [STATES.YAWN]: 5000,
  [STATES.NOD]: 5000,
};

// =============================================================================
// STATUS TEXT ARRAYS (Rebel's voice - dry wit, confident humility)
// =============================================================================

export const STATUS_TEXT = {
  // Idle - calm, attentive presence with archival gravitas
  [STATES.IDLE]: [
    'Taking notes...',
    'Cataloging the proceedings.',
    'Recording for posterity. And the recap.',
    'Capturing the minutes. The important ones.',
    'On the record.',
    'Transcribing with appropriate reverence.',
    'Documenting the discourse.',
    'Present and archiving.',
    'All ears. Some judgment.',
    'Attending with quiet diligence.',
  ],
  
  // Listening - engaged attention
  [STATES.LISTENING]: [
    'Listening...',
    'Taking this in.',
    'Noted.',
  ],
  
  // Thinking - processing with dry wit
  [STATES.THINKING]: [
    'Consulting the archives...',
    'The jury is deliberating.',
    'Connecting dots...',
    'Reviewing the evidence.',
    'Cross-referencing...',
    'Considering the angles.',
    'Running diagnostics on that thought.',
  ],
  
  // Speaking - confident but humble
  [STATES.SPEAKING]: [
    'Speaking...',
    'Sharing thoughts...',
  ],
  
  // Ready to speak - waiting for cue
  [STATES.READY_TO_SPEAK]: [
    'I have something...',
    'At your signal.',
    'Ready when you are.',
    'Awaiting my cue.',
  ],
  
  // One-shots
  [STATES.WAVE]: ['Hello.', 'Greetings.'],
  [STATES.GOODBYE]: ['Until next time.', 'That\'s a wrap.'],
  [STATES.CELEBRATION]: ['Well done.', 'Excellent.', 'Noted with admiration.'],
  [STATES.EYE_ROLL]: ['...'],
  [STATES.YAWN]: ['...'],
  [STATES.NOD]: ['Noted.', 'Acknowledged.'],
};

// Get a random status text for a state
export function getRandomStatusText(stateName) {
  const texts = STATUS_TEXT[stateName];
  if (!texts || texts.length === 0) return 'Taking notes...';
  return texts[Math.floor(Math.random() * texts.length)];
}

// Personality trigger configuration
export const PERSONALITY_CONFIG = {
  [STATES.EYE_ROLL]: {
    minMeetingMinutes: 45,
    probability: 0.05, // 5% chance when conditions met
    maxPerMeeting: 1,
  },
  [STATES.YAWN]: {
    minMeetingMinutes: 60,
    probability: 0.10, // 10% chance when conditions met
    maxPerMeeting: 1,
  },
  [STATES.NOD]: {
    minSpeakerSeconds: 30, // After someone speaks for 30+ seconds
    probability: 0.15,
    cooldownMs: 120000, // 2 minute cooldown between nods
  },
};

/**
 * Build the URL for a state's MP4 asset
 */
export function getStateAssetUrl(avatarId, state, baseUrl) {
  // Map state names to actual file names (handle underscore vs no underscore)
  const stateToFile = {
    'idle': 'idle',
    'listening': 'listening',
    'thinking': 'thinking',
    'speaking': 'speaking',
    'ready_to_speak': 'hand_raised', // Dedicated hand-raised animation for pending response
    'wave': 'wave',
    'goodbye': 'wave', // Reuse wave for goodbye
    'celebration': 'celebration',
    'eye_roll': 'eyeroll',
    'yawn': 'yawn',
    'nod': 'nod',
  };
  const fileName = stateToFile[state] || state;
  return `${baseUrl}/${avatarId}_${fileName}.mp4`;
}

/**
 * Check if a GIF exists (with caching)
 */
const assetCache = new Map();

export async function checkAssetExists(url) {
  if (assetCache.has(url)) {
    return assetCache.get(url);
  }
  
  try {
    const response = await fetch(url, { method: 'HEAD' });
    const exists = response.ok;
    assetCache.set(url, exists);
    return exists;
  } catch {
    assetCache.set(url, false);
    return false;
  }
}

/**
 * Get the best available asset URL with fallbacks
 * Returns null if no assets found (caller should use idle fallback)
 */
export async function resolveAssetUrl(avatarId, state, baseUrl, defaultAvatar = 'spark') {
  // For default avatar, skip existence check for known states (we know they exist)
  // This avoids latency and CORS issues from HEAD requests
  const knownStates = [...LOOPING_STATES, ...ONE_SHOT_STATES];
  if (avatarId === defaultAvatar && knownStates.includes(state)) {
    console.log(`[Avatar] Using known asset for ${avatarId}_${state} (skipping HEAD check)`);
    return getStateAssetUrl(avatarId, state, baseUrl);
  }
  
  // Try requested avatar + state
  let url = getStateAssetUrl(avatarId, state, baseUrl);
  if (await checkAssetExists(url)) {
    return url;
  }
  
  // Fallback: requested avatar + idle
  if (state !== STATES.IDLE) {
    url = getStateAssetUrl(avatarId, STATES.IDLE, baseUrl);
    if (await checkAssetExists(url)) {
      console.warn(`[Avatar] Missing ${avatarId}_${state}.mp4, falling back to idle`);
      return url;
    }
  }
  
  // Fallback: default avatar + state
  if (avatarId !== defaultAvatar) {
    url = getStateAssetUrl(defaultAvatar, state, baseUrl);
    if (await checkAssetExists(url)) {
      console.warn(`[Avatar] Missing ${avatarId} assets, falling back to ${defaultAvatar}`);
      return url;
    }
  }
  
  // Fallback: default avatar + idle
  url = getStateAssetUrl(defaultAvatar, STATES.IDLE, baseUrl);
  if (await checkAssetExists(url)) {
    console.warn(`[Avatar] Using final fallback: ${defaultAvatar}_idle.mp4`);
    return url;
  }
  
  // Return null - caller will use hardcoded fallback
  console.warn(`[Avatar] No assets found for ${avatarId}_${state}`);
  return null;
}

/**
 * State machine for avatar
 */
// Animation cycle duration in ms (all looping animations are 5 seconds)
const ANIMATION_CYCLE_MS = 5000;

export class AvatarStateMachine {
  constructor(avatarId, baseUrl, onStateChange) {
    this.avatarId = avatarId;
    this.baseUrl = baseUrl;
    this.onStateChange = onStateChange;
    
    this.currentState = STATES.IDLE;
    this.meetingStartTime = Date.now();
    this.personalityTriggerCounts = {};
    this.lastNodTime = 0;
    this.speakerStartTime = null;
    this.oneShotTimer = null;
    this.animationStartTime = Date.now(); // Track when current animation started
  }
  
  /**
   * Get time remaining in current animation cycle (ms)
   * Returns 0 if we're past the cycle duration
   */
  getTimeToAnimationEnd() {
    const elapsed = Date.now() - this.animationStartTime;
    const remaining = ANIMATION_CYCLE_MS - (elapsed % ANIMATION_CYCLE_MS);
    return remaining;
  }
  
  /**
   * Wait for current animation cycle to complete before executing callback
   * For looping states, waits until the current 5-second cycle ends
   */
  async waitForAnimationCycle() {
    const remaining = this.getTimeToAnimationEnd();
    // Only wait if there's meaningful time left (more than 500ms)
    if (remaining > 500) {
      console.log('[StateMachine] Waiting', remaining, 'ms for animation cycle to complete');
      await new Promise(resolve => setTimeout(resolve, remaining));
    }
  }
  
  async setState(newState, options = {}) {
    const { force = false, duration = null, statusText = null } = options;
    
    // Don't interrupt one-shot animations unless forced
    if (!force && ONE_SHOT_STATES.includes(this.currentState) && this.oneShotTimer) {
      return;
    }
    
    // Skip redundant same-state transitions for looping states (prevents flickering
    // from rapid calls like audio detection firing setState every animation frame)
    if (newState === this.currentState && LOOPING_STATES.includes(newState) && !force) {
      return;
    }
    
    console.log('[StateMachine] setState:', this.currentState, '->', newState, statusText ? `(${statusText})` : '');
    
    // Clear any pending one-shot timer
    if (this.oneShotTimer) {
      clearTimeout(this.oneShotTimer);
      this.oneShotTimer = null;
    }
    
    const previousState = this.currentState;
    this.currentState = newState;
    this.animationStartTime = Date.now();
    
    // Resolve the asset URL (with fallbacks)
    const assetUrl = await resolveAssetUrl(this.avatarId, newState, this.baseUrl);
    
    // Notify listener (pass statusText so it travels with this specific transition)
    if (this.onStateChange) {
      this.onStateChange(newState, previousState, assetUrl, statusText);
    }
    
    // Set up return-to-idle for one-shot states
    if (ONE_SHOT_STATES.includes(newState)) {
      const stateDuration = duration || ONE_SHOT_DURATIONS[newState] || 2000;
      console.log('[StateMachine] Setting up one-shot timer for', newState, 'duration:', stateDuration);
      this.oneShotTimer = setTimeout(() => {
        console.log('[StateMachine] One-shot timer fired, returning to IDLE');
        this.oneShotTimer = null;
        this.setState(STATES.IDLE);
      }, stateDuration);
    }
    
    return assetUrl;
  }
  
  getMeetingDurationMinutes() {
    return (Date.now() - this.meetingStartTime) / 60000;
  }
  
  /**
   * Check and potentially trigger a personality state
   */
  checkPersonalityTrigger() {
    const minutes = this.getMeetingDurationMinutes();
    
    // Check eye roll
    const eyeRollConfig = PERSONALITY_CONFIG[STATES.EYE_ROLL];
    if (
      minutes >= eyeRollConfig.minMeetingMinutes &&
      (this.personalityTriggerCounts[STATES.EYE_ROLL] || 0) < eyeRollConfig.maxPerMeeting &&
      Math.random() < eyeRollConfig.probability
    ) {
      this.personalityTriggerCounts[STATES.EYE_ROLL] = (this.personalityTriggerCounts[STATES.EYE_ROLL] || 0) + 1;
      this.setState(STATES.EYE_ROLL);
      return true;
    }
    
    // Check yawn
    const yawnConfig = PERSONALITY_CONFIG[STATES.YAWN];
    if (
      minutes >= yawnConfig.minMeetingMinutes &&
      (this.personalityTriggerCounts[STATES.YAWN] || 0) < yawnConfig.maxPerMeeting &&
      Math.random() < yawnConfig.probability
    ) {
      this.personalityTriggerCounts[STATES.YAWN] = (this.personalityTriggerCounts[STATES.YAWN] || 0) + 1;
      this.setState(STATES.YAWN);
      return true;
    }
    
    return false;
  }
  
  /**
   * Track speaker duration for nod triggers
   */
  onSpeakerStart() {
    this.speakerStartTime = Date.now();
  }
  
  onSpeakerEnd() {
    if (!this.speakerStartTime) return;
    
    const speakerDuration = (Date.now() - this.speakerStartTime) / 1000;
    const nodConfig = PERSONALITY_CONFIG[STATES.NOD];
    
    if (
      speakerDuration >= nodConfig.minSpeakerSeconds &&
      Date.now() - this.lastNodTime > nodConfig.cooldownMs &&
      Math.random() < nodConfig.probability
    ) {
      this.lastNodTime = Date.now();
      this.setState(STATES.NOD);
    }
    
    this.speakerStartTime = null;
  }
  
  /**
   * Trigger celebration
   */
  celebrate() {
    this.setState(STATES.CELEBRATION);
  }
  
  /**
   * Trigger wave (usually on join)
   */
  wave() {
    this.setState(STATES.WAVE, { force: true });
  }
  
  /**
   * Trigger goodbye
   */
  goodbye() {
    this.setState(STATES.GOODBYE, { force: true });
  }
}
