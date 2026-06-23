/**
 * Rebel Avatar - Interactive Meeting Bot Webpage
 * 
 * This webpage is displayed as the bot's video tile in meetings via Recall.ai's Output Media API.
 * It operates in two tiers:
 * - Tier 1 (Standalone): Works without desktop connection - audio-level detection, pre-recorded clips
 * - Tier 2 (Enhanced): Connected to desktop via WebSocket relay - dynamic TTS, Q&A responses
 */

import { AvatarStateMachine, STATES, getRandomStatusText, LOOPING_STATES } from './states.js';

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  // Base URL for GIF assets
  gifBaseUrl: 'https://pub-15a8bb8fa4a2468086761a85641af2c8.r2.dev/rebel-avatar-states',
  
  // Default avatar variant
  defaultAvatar: 'spark',
  // Relay WebSocket URL (set via URL param or default)
  relayUrl: null,
  
  // Recall transcript WebSocket URL (available from inside bot browser, can override via URL param)
  transcriptWsUrl: 'wss://meeting-data.bot.recall.ai/api/v1/transcript',
  
  // Video transition timeout (ms) - remove .transitioning class if preload stalls
  videoTransitionTimeoutMs: 5000,
  
  // Audio detection thresholds
  audioThresholds: {
    silence: 0.02,
    low: 0.05,
    medium: 0.15,
    high: 0.3,
  },
  
  // How long to stay in 'listening' state after audio stops (ms)
  listeningDebounceMs: 1500,
  
  // Reconnection settings
  reconnect: {
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
  },
  
  // Pre-recorded audio clips (Tier 1)
  preRecordedClips: {
    join: null, // Will be loaded if available
    leave: null,
    fallback: null,
  },
};

// =============================================================================
// State Management
// =============================================================================

const state = {
  tier: 1, // 1 = standalone, 2 = connected to desktop
  avatarState: 'idle', // idle, listening, thinking, speaking
  
  // State machine (handles GIF transitions, personality triggers)
  stateMachine: null,
  
  // Audio detection
  audioContext: null,
  analyser: null,
  audioStream: null,
  muteAudioDetection: false, // True when bot is speaking
  lastAudioTime: 0,
  isSpeaking: false, // Tracks if someone in meeting is speaking
  
  // TTS audio analysis (for amplitude-reactive glow during bot speech)
  ttsAudioContext: null,     // Dedicated AudioContext for TTS (may differ from mic audioContext)
  ttsAnalyser: null,         // AnalyserNode for TTS audio output
  ttsAmplitudeActive: false, // Whether amplitude monitoring rAF loop is running
  
  // Caption text to show when audio.onplay fires (deferred so captions appear
  // with audible audio, not before). Set when play_audio relay msg arrives,
  // consumed in audio.onplay.
  pendingCaptionText: null,
  
  // Personality check timer
  personalityCheckTimer: null,
  
  // Status text rotation timer
  statusRotationTimer: null,
  lastStatusText: null,
  
  // Video transition tracking (prevents race conditions)
  currentTransitionId: 0,
  transitionTimeoutId: null,
  preloadVideo: null, // Reusable preload video element
  
  // WebSocket relay (Tier 2)
  ws: null,
  wsReconnectDelay: CONFIG.reconnect.initialDelayMs,
  wsReconnectTimer: null,
  
  // Transcript WebSocket (for voice triggers)
  transcriptWs: null,
  
  // Token (from URL fragment)
  sessionToken: null,
  
  // User info (from URL params)
  userName: null,
  meetingTitle: null,
  avatarId: null, // spark, flame, etc.
  triggerPhrase: null, // Custom trigger phrase from settings (e.g., "Spark")
  
  // Knowledge access toggle (controlled by desktop)
  knowledgeAccessEnabled: false,
  
  // Caption activity tracking
  lastCaptionAt: 0,
  captionCount: 0,
  captionCheckTimer: null,
  
  // Stop detection (Web Speech API for fast local "stop" detection while speaking)
  stopDetection: null, // SpeechRecognition instance
  stopDetectionActive: false,
};

// =============================================================================
// DOM Elements
// =============================================================================

const elements = {
  avatar: document.getElementById('avatar'),
  avatarVideo: document.getElementById('avatarVideo'),
  botName: document.getElementById('botName'),
  botStatus: document.getElementById('botStatus'),
  connectionIndicator: document.getElementById('connectionIndicator'),
  captionIndicator: document.getElementById('captionIndicator'),
  captionBar: document.getElementById('captionBar'),
  knowledgeIndicator: document.getElementById('knowledgeIndicator'),
  audioPlayer: document.getElementById('audioPlayer'),
  pulseRing: document.getElementById('pulseRing'),
  // Trigger legend elements
  triggerLegend: document.getElementById('triggerLegend'),
  triggerAsk: document.getElementById('triggerAsk'),
  triggerInterrupt: document.getElementById('triggerInterrupt'),
  triggerInterruptItem: document.getElementById('triggerInterruptItem'),
};

// =============================================================================
// Initialization
// =============================================================================

function init() {
  console.log('[Rebel Avatar] ========== INITIALIZING ==========');
  
  // Parse URL parameters and fragment
  parseUrlConfig();
  
  // Initialize state machine
  console.log('[Rebel Avatar] Creating state machine with avatarId:', state.avatarId || CONFIG.defaultAvatar);
  console.log('[Rebel Avatar] Asset base URL:', CONFIG.gifBaseUrl);
  state.stateMachine = new AvatarStateMachine(
    state.avatarId || CONFIG.defaultAvatar,
    CONFIG.gifBaseUrl,
    handleStateChange
  );
  
  // Set initial video immediately
  const avatarId = state.avatarId || CONFIG.defaultAvatar;
  const initialVideoUrl = `${CONFIG.gifBaseUrl}/${avatarId}_idle.mp4`;
  console.log('[Rebel Avatar] Setting initial video URL:', initialVideoUrl);
  elements.avatarVideo.src = initialVideoUrl;
  elements.avatarVideo.loop = true;
  
  // Add video event listeners for debugging
  elements.avatarVideo.onloadstart = () => console.log('[Rebel Avatar] Video loadstart');
  elements.avatarVideo.onloadeddata = () => console.log('[Rebel Avatar] Video loadeddata - ready to play');
  elements.avatarVideo.onplay = () => console.log('[Rebel Avatar] Video playing');
  elements.avatarVideo.onerror = (e) => console.error('[Rebel Avatar] Video error:', e, elements.avatarVideo.error);
  elements.avatarVideo.onstalled = () => console.warn('[Rebel Avatar] Video stalled');
  
  elements.avatarVideo.play().catch((e) => {
    console.error('[Rebel Avatar] Video autoplay blocked:', e);
  });
  console.log('[Rebel Avatar] Video element configured');
  
  // Set up UI with initial values
  updateBotName();
  
  // Initialize audio detection (Tier 1)
  initAudioDetection();
  
  // Initialize TTS audio analysis (amplitude-reactive glow during bot speech)
  initTtsAudioAnalysis();
  
  // Initialize stop detection (Web Speech API for fast local "stop" detection)
  initStopDetection();
  
  // Try to connect to relay (Tier 2)
  tryConnectToRelay();
  
  // Connect to Recall transcript WebSocket (for voice triggers)
  connectToTranscript();
  
  // Set initial state with wave animation
  state.stateMachine.wave();
  setStatus('Taking notes...');
  
  // Start personality check timer (every 5 minutes)
  state.personalityCheckTimer = setInterval(() => {
    if (state.tier === 1 && state.avatarState === STATES.IDLE) {
      state.stateMachine.checkPersonalityTrigger();
    }
  }, 5 * 60 * 1000);
  
  console.log('[Rebel Avatar] Initialized', {
    tier: state.tier,
    userName: state.userName,
    avatarId: state.avatarId,
    hasToken: !!state.sessionToken,
  });
}

/**
 * Handle state change from state machine
 */
function handleStateChange(newState, previousState, assetUrl, statusText) {
  state.avatarState = newState;
  
  // Update avatar CSS class for styling
  elements.avatar.className = `avatar ${newState}`;
  
  // Toggle body class for ready_to_speak/speaking background change
  document.body.classList.remove('ready-to-speak', 'speaking');
  if (newState === 'ready_to_speak') {
    document.body.classList.add('ready-to-speak');
  } else if (newState === 'speaking') {
    document.body.classList.add('speaking');
  }
  
  // Update status text (use explicit text if provided, otherwise random from pool)
  updateStatusText(newState, statusText);
  
  // Update trigger legend visibility (show interrupt when speaking)
  updateTriggerLegend(newState);
  
  // Determine if this state should loop
  const shouldLoop = LOOPING_STATES.includes(newState);
  console.log('[Rebel Avatar] Should loop:', shouldLoop);
  
  // Get the URL to load
  let urlToLoad = assetUrl;
  if (!urlToLoad) {
    const avatarId = state.avatarId || CONFIG.defaultAvatar;
    urlToLoad = `${CONFIG.gifBaseUrl}/${avatarId}_idle.mp4`;
    console.log('[Rebel Avatar] No asset URL, using fallback:', urlToLoad);
  }
  
  // Skip if same URL (avoid flash on redundant state changes)
  if (elements.avatarVideo.src === urlToLoad) {
    console.log('[Rebel Avatar] Same URL, skipping video change');
    return;
  }
  
  console.log('[Rebel Avatar] Preloading new video:', urlToLoad);
  
  // Increment transition ID to invalidate any pending transitions (prevents race conditions)
  const transitionId = ++state.currentTransitionId;
  
  // Clear any pending transition timeout
  if (state.transitionTimeoutId) {
    clearTimeout(state.transitionTimeoutId);
    state.transitionTimeoutId = null;
  }
  
  // Add transitioning class for crossfade effect
  elements.avatarVideo.classList.add('transitioning');
  
  // Set timeout to remove transitioning class if preload stalls
  state.transitionTimeoutId = setTimeout(() => {
    if (state.currentTransitionId === transitionId) {
      console.warn('[Rebel Avatar] Video preload timeout, removing transitioning class');
      elements.avatarVideo.classList.remove('transitioning');
    }
  }, CONFIG.videoTransitionTimeoutMs);
  
  // Reuse or create preload video element (prevents memory pressure)
  if (!state.preloadVideo) {
    state.preloadVideo = document.createElement('video');
    state.preloadVideo.muted = true;
    state.preloadVideo.playsInline = true;
    state.preloadVideo.preload = 'auto';
  }
  
  const preloadVideo = state.preloadVideo;
  
  // Clear previous handlers and src to release resources
  preloadVideo.oncanplay = null;
  preloadVideo.onerror = null;
  preloadVideo.src = '';
  
  // Set up new preload
  preloadVideo.src = urlToLoad;
  
  // When the new video has enough data, swap it in with crossfade
  preloadVideo.oncanplay = () => {
    // Ignore if this transition is stale (a newer transition started)
    if (state.currentTransitionId !== transitionId) {
      console.log('[Rebel Avatar] Ignoring stale transition', transitionId, 'current is', state.currentTransitionId);
      return;
    }
    
    // Clear the timeout since preload succeeded
    if (state.transitionTimeoutId) {
      clearTimeout(state.transitionTimeoutId);
      state.transitionTimeoutId = null;
    }
    
    console.log('[Rebel Avatar] New video ready, swapping with crossfade');
    elements.avatarVideo.loop = shouldLoop;
    elements.avatarVideo.src = urlToLoad;
    elements.avatarVideo.play().then(() => {
      // Remove transitioning class after a brief delay to complete crossfade
      setTimeout(() => {
        elements.avatarVideo.classList.remove('transitioning');
      }, 100);
    }).catch((e) => {
      console.error('[Rebel Avatar] Failed to play video:', e);
      elements.avatarVideo.classList.remove('transitioning');
    });
  };
  
  // Handle preload errors
  preloadVideo.onerror = () => {
    if (state.currentTransitionId !== transitionId) return;
    console.error('[Rebel Avatar] Video preload failed');
    elements.avatarVideo.classList.remove('transitioning');
    if (state.transitionTimeoutId) {
      clearTimeout(state.transitionTimeoutId);
      state.transitionTimeoutId = null;
    }
  };
  
  // Start preloading
  preloadVideo.load();
  
  console.log('[Rebel Avatar] State change initiated (waiting for preload, id:', transitionId, ')');
}

/**
 * Update status text based on state, with rotation for looping states
 */
function updateStatusText(newState, explicitText) {
  // Clear any existing rotation timer
  if (state.statusRotationTimer) {
    clearInterval(state.statusRotationTimer);
    state.statusRotationTimer = null;
  }
  
  // Use explicit text if provided (from relay or internal callers), otherwise random from pool
  const text = explicitText || getRandomStatusText(newState);
  setStatus(text);
  state.lastStatusText = text;
  
  // For looping states (idle), rotate status text every 30-45 seconds
  if (newState === STATES.IDLE) {
    state.statusRotationTimer = setInterval(() => {
      // Get a different text than last time
      let newText = getRandomStatusText(STATES.IDLE);
      let attempts = 0;
      while (newText === state.lastStatusText && attempts < 5) {
        newText = getRandomStatusText(STATES.IDLE);
        attempts++;
      }
      setStatus(newText);
      state.lastStatusText = newText;
    }, 30000 + Math.random() * 15000); // 30-45 seconds
  }
}

/**
 * Update trigger legend based on current state
 */
function updateTriggerLegend(newState) {
  if (!elements.triggerInterruptItem) return;
  
  // Show interrupt trigger when speaking
  if (newState === STATES.SPEAKING) {
    elements.triggerInterruptItem.style.display = 'flex';
  } else {
    elements.triggerInterruptItem.style.display = 'none';
  }
}

function parseUrlConfig() {
  const params = new URLSearchParams(window.location.search);
  const hash = window.location.hash;
  
  console.log('[Rebel Avatar] === STARTUP ===');
  // Don't log full URL, hash, or search params - may contain tokens and PII
  console.log('[Rebel Avatar] Has search params:', params.toString().length > 0);
  console.log('[Rebel Avatar] Has hash fragment:', !!hash);
  
  // Parse URL fragment for sensitive data (security: not logged)
  // Fragment contains: token, name, title, trigger
  if (hash) {
    const fragmentParams = new URLSearchParams(hash.slice(1));
    state.sessionToken = fragmentParams.get('token');
    state.userName = fragmentParams.get('name') || null;
    state.meetingTitle = fragmentParams.get('title') || null;
    state.triggerPhrase = fragmentParams.get('trigger') || null;
    console.log('[Rebel Avatar] Token present:', !!state.sessionToken);
    console.log('[Rebel Avatar] Name present:', !!state.userName);
    console.log('[Rebel Avatar] Trigger phrase present:', !!state.triggerPhrase);
  } else {
    console.log('[Rebel Avatar] WARNING: No hash fragment - no token!');
  }
  
  // Parse query params for non-sensitive config
  state.avatarId = params.get('avatar') || CONFIG.defaultAvatar;
  
  // GIF base URL can be overridden via param
  if (params.get('gifBaseUrl')) {
    CONFIG.gifBaseUrl = params.get('gifBaseUrl');
  }
  
  // Relay URL can be overridden via param
  const relayFromParam = params.get('relay');
  if (relayFromParam) {
    CONFIG.relayUrl = relayFromParam;
    console.log('[Rebel Avatar] Relay URL present:', !!CONFIG.relayUrl);
  } else {
    console.log('[Rebel Avatar] WARNING: No relay param');
  }
  
  // Transcript WebSocket URL can be overridden via param
  const transcriptWsFromParam = params.get('transcriptWs');
  if (transcriptWsFromParam) {
    CONFIG.transcriptWsUrl = transcriptWsFromParam;
    console.log('[Rebel Avatar] Transcript WS URL overridden');
  }
  
  console.log('[Rebel Avatar] Config parsed', {
    hasUserName: !!state.userName,
    hasMeetingTitle: !!state.meetingTitle,
    avatarId: state.avatarId,
    hasToken: !!state.sessionToken,
    hasRelayUrl: !!CONFIG.relayUrl,
  });
}

function updateBotName() {
  if (state.userName) {
    elements.botName.textContent = `${state.userName}'s Rebel`;
  } else {
    elements.botName.textContent = 'Rebel';
  }
  
  // Update trigger legend with personalized trigger phrases
  updateTriggerPhrases();
}

function updateTriggerPhrases() {
  // Use custom trigger phrase from settings, or fall back to "{firstName}'s Rebel"
  let triggerName;
  if (state.triggerPhrase?.trim()) {
    // Custom trigger phrase (e.g., "Spark")
    triggerName = state.triggerPhrase.trim();
  } else if (state.userName) {
    // Default: "{firstName}'s Rebel"
    const firstName = state.userName.split(/\s+/)[0] || 'User';
    triggerName = `${firstName}'s Rebel`;
  } else {
    triggerName = 'Spark';
  }
  
  // For short triggers, use "Hey X" / "Okay X"
  // For longer triggers like "Josh's Rebel", just show the trigger itself
  const isShortTrigger = triggerName.length <= 12;
  const askPhrase = isShortTrigger ? `Hey ${triggerName}` : triggerName;
  const interruptPhrase = isShortTrigger ? `Okay ${triggerName}` : `Okay ${triggerName}`;
  
  if (elements.triggerAsk) {
    elements.triggerAsk.textContent = askPhrase;
  }
  if (elements.triggerInterrupt) {
    elements.triggerInterrupt.textContent = interruptPhrase;
  }
}

// =============================================================================
// State Management
// =============================================================================

function setStatus(text) {
  elements.botStatus.textContent = text;
}

function setAudioLevel(level) {
  // Only set level attribute when listening
  if (state.avatarState === 'listening') {
    let levelClass = 'low';
    if (level > CONFIG.audioThresholds.high) {
      levelClass = 'high';
    } else if (level > CONFIG.audioThresholds.medium) {
      levelClass = 'medium';
    }
    elements.avatar.setAttribute('data-level', levelClass);
  } else {
    elements.avatar.removeAttribute('data-level');
  }
}

function setConnectionStatus(connected) {
  if (connected) {
    elements.connectionIndicator.classList.add('connected');
    elements.connectionIndicator.querySelector('.connection-text').textContent = 'Connected';
    state.tier = 2;
  } else {
    elements.connectionIndicator.classList.remove('connected');
    elements.connectionIndicator.querySelector('.connection-text').textContent = 'Standalone';
    state.tier = 1;
  }
}

// =============================================================================
// Caption Status Indicator
// =============================================================================

const CAPTION_STALE_THRESHOLD_MS = 30_000;

function onCaptionReceived() {
  state.lastCaptionAt = Date.now();
  state.captionCount++;
  updateCaptionIndicator();
  
  // Start periodic check if not already running
  if (!state.captionCheckTimer) {
    state.captionCheckTimer = setInterval(updateCaptionIndicator, 5000);
  }
}

function updateCaptionIndicator() {
  const el = elements.captionIndicator;
  if (!el) return;
  
  if (state.captionCount === 0) {
    // No captions received yet
    el.classList.remove('active', 'warning');
    el.querySelector('.caption-text').textContent = 'Waiting for captions';
    return;
  }
  
  const elapsed = Date.now() - state.lastCaptionAt;
  if (elapsed <= CAPTION_STALE_THRESHOLD_MS) {
    el.classList.add('active');
    el.classList.remove('warning');
    el.querySelector('.caption-text').textContent = 'Captions flowing';
  } else {
    el.classList.remove('active');
    el.classList.add('warning');
    el.querySelector('.caption-text').textContent = 'No captions detected';
  }
}

function setKnowledgeAccess(enabled) {
  state.knowledgeAccessEnabled = enabled;
  elements.knowledgeIndicator.style.display = enabled ? 'flex' : 'none';
}

// =============================================================================
// Audio Detection (Tier 1)
// =============================================================================

async function initAudioDetection() {
  try {
    console.log('[Rebel Avatar] Requesting audio access...');
    
    // In Recall's bot Chromium, getUserMedia should work without user gesture
    state.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    console.log('[Rebel Avatar] Got audio stream');
    
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = state.audioContext.createMediaStreamSource(state.audioStream);
    
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 256;
    state.analyser.smoothingTimeConstant = 0.8;
    
    source.connect(state.analyser);
    
    // Start audio level monitoring
    monitorAudioLevels();
    
    console.log('[Rebel Avatar] Audio detection initialized');
  } catch (error) {
    console.error('[Rebel Avatar] Failed to initialize audio detection:', error);
    // Continue without audio detection - avatar will be static
  }
}

function monitorAudioLevels() {
  if (!state.analyser) return;
  
  const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
  
  function update() {
    if (!state.analyser) return;
    
    state.analyser.getByteFrequencyData(dataArray);
    
    // Calculate RMS level
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i] * dataArray[i];
    }
    const rms = Math.sqrt(sum / dataArray.length) / 255;
    
    // Process audio level (unless muted for bot speech)
    if (!state.muteAudioDetection) {
      processAudioLevel(rms);
    }
    
    requestAnimationFrame(update);
  }
  
  update();
}

function processAudioLevel(level) {
  const now = Date.now();
  
  // In Tier 2, desktop controls state - only use audio for visualization hints
  if (state.tier === 2) {
    setAudioLevel(level);
    return;
  }
  
  // Tier 1: Derive state from audio levels
  if (level > CONFIG.audioThresholds.silence) {
    const wasIdle = !state.isSpeaking;
    state.isSpeaking = true;
    state.lastAudioTime = now;
    
    // Track speaker start for nod triggers
    if (wasIdle && state.stateMachine) {
      state.stateMachine.onSpeakerStart();
    }
    
    // Only transition to listening if not already listening or speaking
    if (state.avatarState !== STATES.SPEAKING && state.avatarState !== STATES.LISTENING) {
      state.stateMachine?.setState(STATES.LISTENING, { statusText: 'Listening...' });
    }
    
    setAudioLevel(level);
  } else {
    // Check if we should transition back to idle
    if (state.isSpeaking && state.avatarState === STATES.LISTENING) {
      if (now - state.lastAudioTime > CONFIG.listeningDebounceMs) {
        state.isSpeaking = false;
        
        // Track speaker end for nod triggers
        if (state.stateMachine) {
          state.stateMachine.onSpeakerEnd();
        }
        
        state.stateMachine?.setState(STATES.IDLE, { statusText: 'Taking notes...' });
        setAudioLevel(0);
      }
    }
  }
}

// =============================================================================
// TTS Audio Analysis (amplitude-reactive glow during bot speech)
// =============================================================================

/**
 * Initialize the TTS AnalyserNode. Connects the <audio> element to the Web Audio
 * graph so we can read real-time frequency data during playback.
 *
 * createMediaElementSource() can only be called ONCE per element, so this must
 * be called exactly once during init. On failure (unsupported environment),
 * the CSS animation `speaking-glow` remains as a fallback.
 */
function initTtsAudioAnalysis() {
  try {
    // Create a dedicated AudioContext for TTS analysis. We cannot reuse
    // state.audioContext because initAudioDetection() is async and may not
    // have finished yet (or may overwrite state.audioContext later).
    // Storing a separate reference ensures resume() targets the correct context.
    state.ttsAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // createMediaElementSource can only be called ONCE per element
    const source = state.ttsAudioContext.createMediaElementSource(elements.audioPlayer);
    
    state.ttsAnalyser = state.ttsAudioContext.createAnalyser();
    state.ttsAnalyser.fftSize = 256;
    state.ttsAnalyser.smoothingTimeConstant = 0.8;
    
    // Route: audioPlayer → ttsAnalyser → destination (so audio still audible)
    source.connect(state.ttsAnalyser);
    state.ttsAnalyser.connect(state.ttsAudioContext.destination);
    
    console.log('[Rebel Avatar] TTS audio analysis initialized');
  } catch (error) {
    console.error('[Rebel Avatar] Failed to init TTS audio analysis:', error);
    // Fallback: CSS animation continues working
    state.ttsAnalyser = null;
    state.ttsAudioContext = null;
  }
}

/**
 * Start the rAF loop that reads TTS amplitude and drives the speaking glow.
 * The loop guards on state.avatarState === STATES.SPEAKING, so it does no work
 * during keepAnimation flows (wave/goodbye announcements).
 */
function startTtsAmplitudeMonitor() {
  if (!state.ttsAnalyser || state.ttsAmplitudeActive) return;
  
  state.ttsAmplitudeActive = true;
  const dataArray = new Uint8Array(state.ttsAnalyser.frequencyBinCount);
  
  function update() {
    // Exit loop when no longer speaking (onSpeakingAudioEnd clears the flag)
    if (!state.ttsAmplitudeActive) return;
    
    // CRITICAL: Only update glow when in SPEAKING state (not during wave/goodbye
    // announcements where keepAnimation=true means we DON'T enter speaking state)
    if (state.avatarState === STATES.SPEAKING) {
      state.ttsAnalyser.getByteFrequencyData(dataArray);
      
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const amplitude = Math.sqrt(sum / dataArray.length) / 255;
      
      updateSpeakingGlow(amplitude);
    }
    
    requestAnimationFrame(update);
  }
  
  update();
}

/**
 * Drive the speaking glow from amplitude (0–1 normalized).
 * Inline styles override the CSS `speaking-glow` animation.
 */
function updateSpeakingGlow(amplitude) {
  const glow = elements.avatar.querySelector('.avatar-glow');
  if (!glow) return;
  
  // Map amplitude to scale: 1.1 (silent) → 1.3 (loud)
  const scale = 1.1 + amplitude * 0.2;
  // Map amplitude to opacity: 0.6 (silent) → 1.0 (loud)
  const opacity = 0.6 + amplitude * 0.4;
  
  // CSS animations have higher priority than inline styles for the properties
  // they animate, so we must disable the fallback animation when JS is driving.
  glow.style.animation = 'none';
  glow.style.transform = `scale(${scale})`;
  glow.style.opacity = opacity;
}

/**
 * Clear inline styles so CSS animations resume for whatever state the avatar
 * transitions to next (idle, listening, thinking, etc.).
 */
function resetSpeakingGlow() {
  const glow = elements.avatar.querySelector('.avatar-glow');
  if (!glow) return;
  
  // Clear all inline overrides so CSS animations resume for whatever state comes next
  glow.style.animation = '';
  glow.style.transform = '';
  glow.style.opacity = '';
}

/**
 * Show the caption bar with the given spoken text.
 * Called from audio.onplay so captions align with audible audio.
 */
function showCaption(text) {
  if (!elements.captionBar) return;
  elements.captionBar.textContent = text;
  elements.captionBar.classList.add('visible');
}

/**
 * Hide the caption bar. Fades out via CSS, then clears text after the
 * transition so stale content doesn't flash if the bar is shown again quickly.
 */
function hideCaption() {
  if (!elements.captionBar) return;
  elements.captionBar.classList.remove('visible');
  // Clear text after fade-out transition (200ms CSS transition + buffer)
  setTimeout(() => {
    if (!elements.captionBar.classList.contains('visible')) {
      elements.captionBar.textContent = '';
    }
  }, 300);
}

/**
 * Centralized cleanup helper for the end of a speaking-audio playback.
 * Called from audio.onended, audio.onerror, handleStopDetected, and the
 * stop_audio relay handler. Replaces duplicated reset logic across those paths.
 */
function onSpeakingAudioEnd() {
  state.muteAudioDetection = false;
  state.ttsAmplitudeActive = false;
  stopStopDetection();
  resetSpeakingGlow();
  hideCaption();
}

// =============================================================================
// Audio Playback
// =============================================================================

async function playAudio(url, keepAnimation = false) {
  console.log('[Rebel Avatar] ===== playAudio() CALLED =====');
  console.log('[Rebel Avatar] URL length:', url?.length);
  console.log('[Rebel Avatar] URL type:', url?.startsWith('data:') ? 'data URL' : 'remote URL');
  console.log('[Rebel Avatar] keepAnimation:', keepAnimation);
  
  // Wait for current animation cycle to complete before switching to speaking
  // This prevents cutting animations mid-way
  // Wait if we're in thinking or ready_to_speak state - if idle, play immediately
  const currentState = state.stateMachine?.currentState;
  if (state.stateMachine && !keepAnimation && (currentState === STATES.THINKING || currentState === STATES.READY_TO_SPEAK)) {
    console.log('[Rebel Avatar] In', currentState, 'state, waiting for animation cycle before playing audio');
    await state.stateMachine.waitForAnimationCycle();
  }
  
  return new Promise((resolve, reject) => {
    const audio = elements.audioPlayer;
    
    // Mute audio detection BEFORE playback starts (local, no latency)
    audio.onplay = () => {
      state.muteAudioDetection = true;
      // Start listening for "stop" commands (fast local detection)
      startStopDetection();
      // Resume TTS AudioContext if suspended (browser autoplay policy)
      if (state.ttsAudioContext?.state === 'suspended') {
        state.ttsAudioContext.resume();
      }
      // Only set speaking state if we're not keeping current animation (wave/goodbye)
      if (!keepAnimation) {
        state.stateMachine?.setState(STATES.SPEAKING, { force: true });
        console.log('[Rebel Avatar] Audio onplay fired, setting state to SPEAKING');
      } else {
        console.log('[Rebel Avatar] Audio onplay fired, keeping current animation');
      }
      // Start amplitude-driven glow (only does work when in SPEAKING state)
      startTtsAmplitudeMonitor();
      // Show caption when audio actually starts (deferred from relay receipt so
      // it aligns with audible audio). Skip during keepAnimation flows
      // (wave/goodbye announcements) — captions belong to normal speech only.
      if (state.pendingCaptionText && !keepAnimation) {
        showCaption(state.pendingCaptionText);
        state.pendingCaptionText = null;
      } else if (keepAnimation) {
        state.pendingCaptionText = null; // Discard caption for announcement flows
      }
    };
    
    audio.onloadstart = () => {
      console.log('[Rebel Avatar] Audio loadstart');
    };
    
    audio.oncanplay = () => {
      console.log('[Rebel Avatar] Audio canplay - ready to play');
    };
    
    // Resume detection AFTER playback ends (local, no latency)
    audio.onended = async () => {
      onSpeakingAudioEnd();
      console.log('[Rebel Avatar] Audio onended fired');
      
      // Wait for speaking animation cycle to complete before going to idle
      if (state.stateMachine && !keepAnimation) {
        await state.stateMachine.waitForAnimationCycle();
      }
      
      state.stateMachine?.setState(STATES.IDLE, { statusText: 'Taking notes...' });
      console.log('[Rebel Avatar] Sending audio_ended to desktop');
      
      // Notify desktop that audio finished (for join/leave sequencing)
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ v: 1, type: 'audio_ended' }));
        console.log('[Rebel Avatar] audio_ended message sent');
      } else {
        console.warn('[Rebel Avatar] WebSocket not open, cannot send audio_ended');
      }
      
      resolve();
    };
    
    audio.onerror = (e) => {
      onSpeakingAudioEnd();
      state.stateMachine?.setState(STATES.IDLE, { statusText: 'Taking notes...' });
      console.error('[Rebel Avatar] Audio onerror fired:', e);
      console.error('[Rebel Avatar] Audio error details:', audio.error);
      
      // Notify desktop that audio finished (even on error) so it doesn't wait 30s
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ v: 1, type: 'audio_ended', error: true }));
        console.log('[Rebel Avatar] audio_ended (error) message sent');
      }
      
      reject(new Error('Audio playback failed'));
    };
    
    console.log('[Rebel Avatar] Setting audio.src');
    audio.src = url;
    console.log('[Rebel Avatar] Calling audio.play()');
    audio.play().then(() => {
      console.log('[Rebel Avatar] audio.play() promise resolved');
    }).catch((err) => {
      console.error('[Rebel Avatar] audio.play() promise rejected:', err);
      reject(err);
    });
  });
}

// =============================================================================
// Stop Detection (Web Speech API for fast local "stop" detection)
// =============================================================================

/**
 * Initialize the Web Speech API for stop detection.
 * This provides much faster response to "stop" commands (~200-500ms) compared to
 * waiting for Recall's transcript processing (~2-3 seconds).
 * 
 * Only active while the bot is speaking - not always listening.
 */
function initStopDetection() {
  // Check for Web Speech API support
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.log('[Rebel Avatar] Web Speech API not supported, stop detection disabled');
    return;
  }
  
  try {
    state.stopDetection = new SpeechRecognition();
    state.stopDetection.continuous = true;
    state.stopDetection.interimResults = true; // Get results faster
    state.stopDetection.lang = 'en-US';
    state.stopDetection.maxAlternatives = 3; // Check multiple interpretations
    
    state.stopDetection.onresult = (event) => {
      // Get trigger phrase (default to 'spark' if not set)
      const triggerLower = (state.triggerPhrase || 'spark').toLowerCase();
      
      // Check all results (including interim) for stop phrases WITH trigger
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        // Check all alternatives
        for (let j = 0; j < result.length; j++) {
          const transcript = result[j].transcript.toLowerCase().trim();
          
          // Require BOTH a stop word AND the trigger phrase to avoid false positives
          // e.g., "okay spark", "stop spark", "cancel spark"
          const hasStopWord = transcript.includes('stop') || 
                              transcript.includes('okay') || 
                              transcript.includes('cancel') ||
                              transcript.includes('thanks') ||
                              transcript.includes('thank you');
          const hasTrigger = transcript.includes(triggerLower);
          
          if (hasStopWord && hasTrigger) {
            console.log('[Rebel Avatar] Stop phrase detected locally:', transcript);
            handleStopDetected();
            return;
          }
        }
      }
    };
    
    state.stopDetection.onerror = (event) => {
      // Don't log 'no-speech' or 'aborted' errors - these are expected
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        console.warn('[Rebel Avatar] Stop detection error:', event.error);
      }
    };
    
    state.stopDetection.onend = () => {
      // Auto-restart if still supposed to be active (speech recognition can stop unexpectedly)
      if (state.stopDetectionActive) {
        console.log('[Rebel Avatar] Stop detection ended, restarting...');
        try {
          state.stopDetection.start();
        } catch (e) {
          // Ignore errors from rapid start/stop
        }
      }
    };
    
    console.log('[Rebel Avatar] Stop detection initialized (Web Speech API)');
  } catch (error) {
    console.error('[Rebel Avatar] Failed to initialize stop detection:', error);
    state.stopDetection = null;
  }
}

/**
 * Start listening for "stop" commands.
 * Called when audio playback begins.
 */
function startStopDetection() {
  if (!state.stopDetection) return;
  if (state.stopDetectionActive) return;
  
  try {
    state.stopDetectionActive = true;
    state.stopDetection.start();
    console.log('[Rebel Avatar] Stop detection started');
  } catch (error) {
    // Reset flag on failure so we can retry next time
    state.stopDetectionActive = false;
    console.warn('[Rebel Avatar] Failed to start stop detection:', error);
  }
}

/**
 * Stop listening for "stop" commands.
 * Called when audio playback ends.
 */
function stopStopDetection() {
  if (!state.stopDetection) return;
  if (!state.stopDetectionActive) return;
  
  try {
    state.stopDetectionActive = false;
    state.stopDetection.stop();
    console.log('[Rebel Avatar] Stop detection stopped');
  } catch (error) {
    // Ignore errors from stopping already-stopped recognition
  }
}

/**
 * Handle detection of a stop command.
 * Immediately pauses audio and notifies desktop.
 */
function handleStopDetected() {
  // Only act if we're actually playing audio
  if (!state.muteAudioDetection) {
    console.log('[Rebel Avatar] Stop detected but not currently speaking, ignoring');
    return;
  }
  
  console.log('[Rebel Avatar] ===== STOP DETECTED (local) =====');
  
  // Immediately stop audio playback
  elements.audioPlayer.pause();
  elements.audioPlayer.currentTime = 0;
  elements.audioPlayer.src = '';
  
  // Centralized reset (muteAudioDetection, ttsAmplitudeActive, stopDetection, glow)
  onSpeakingAudioEnd();
  state.stateMachine?.setState(STATES.IDLE, { statusText: 'Taking notes...' });
  
  // Notify desktop that audio was stopped by user
  sendMessage({ v: 1, type: 'audio_stopped', reason: 'user_stop_local' });
  
  console.log('[Rebel Avatar] Audio stopped via local detection');
}

// =============================================================================
// Transcript WebSocket (Recall real-time transcripts)
// =============================================================================

function connectToTranscript() {
  console.log('[Rebel Avatar] Connecting to transcript WebSocket...');
  
  try {
    state.transcriptWs = new WebSocket(CONFIG.transcriptWsUrl);
    
    state.transcriptWs.onopen = () => {
      console.log('[Rebel Avatar] Transcript WebSocket connected');
    };
    
    state.transcriptWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleTranscriptMessage(data);
      } catch (error) {
        console.error('[Rebel Avatar] Failed to parse transcript message:', error);
      }
    };
    
    state.transcriptWs.onclose = (event) => {
      console.log('[Rebel Avatar] Transcript WebSocket closed', { code: event.code, reason: event.reason });
      // Try to reconnect after 5 seconds
      setTimeout(connectToTranscript, 5000);
    };
    
    state.transcriptWs.onerror = (error) => {
      console.error('[Rebel Avatar] Transcript WebSocket error:', error);
    };
  } catch (error) {
    console.error('[Rebel Avatar] Failed to create transcript WebSocket:', error);
    // Try to reconnect after 5 seconds
    setTimeout(connectToTranscript, 5000);
  }
}

function handleTranscriptMessage(data) {
  // Recall sends transcript data with format: { transcript: { words: [...] } }
  // See: https://docs.recall.ai/docs/real-time-transcription#events
  if (!data.transcript?.words) {
    return;
  }
  
  const words = data.transcript.words;
  const text = words.map(w => w.text).join(' ');
  const speaker = data.transcript.speaker || 'Unknown';
  
  // Don't log transcript content or speaker names - PII
  console.log('[Rebel Avatar] Transcript received, length:', text.length);
  
  // Track caption activity for status indicator
  onCaptionReceived();
  
  // Forward transcript to desktop via relay (Tier 2)
  if (state.tier === 2 && state.ws?.readyState === WebSocket.OPEN) {
    sendMessage({
      v: 1,
      type: 'transcript',
      segments: [{
        speaker,
        text,
        timestamp: Date.now(),
        isFinal: data.transcript.is_final ?? true,
      }],
    });
  }
}

// =============================================================================
// WebSocket Relay (Tier 2)
// =============================================================================

function tryConnectToRelay() {
  // Only connect if we have a token
  if (!state.sessionToken) {
    console.log('[Rebel Avatar] No session token, staying in Tier 1 mode');
    return;
  }
  
  connectToRelay();
}

function connectToRelay() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    return;
  }
  
  console.log('[Rebel Avatar] Connecting to relay...', { url: CONFIG.relayUrl });
  
  try {
    // Connect WITHOUT token in URL (security: avoid logging)
    state.ws = new WebSocket(CONFIG.relayUrl);
    
    state.ws.onopen = () => {
      console.log('[Rebel Avatar] WebSocket connected, sending auth...');
      
      // Send token as first message (not in URL)
      sendMessage({
        v: 1,
        type: 'auth',
        role: 'avatar',
        token: state.sessionToken,
      });
    };
    
    state.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleRelayMessage(msg);
      } catch (error) {
        console.error('[Rebel Avatar] Failed to parse relay message:', error);
      }
    };
    
    state.ws.onclose = (event) => {
      console.log('[Rebel Avatar] WebSocket closed', { code: event.code, reason: event.reason });
      setConnectionStatus(false);
      scheduleReconnect();
    };
    
    state.ws.onerror = (error) => {
      console.error('[Rebel Avatar] WebSocket error:', error);
    };
  } catch (error) {
    console.error('[Rebel Avatar] Failed to create WebSocket:', error);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (state.wsReconnectTimer) {
    clearTimeout(state.wsReconnectTimer);
  }
  
  console.log('[Rebel Avatar] Scheduling reconnect in', state.wsReconnectDelay, 'ms');
  
  state.wsReconnectTimer = setTimeout(() => {
    connectToRelay();
    
    // Exponential backoff
    state.wsReconnectDelay = Math.min(
      state.wsReconnectDelay * CONFIG.reconnect.backoffMultiplier,
      CONFIG.reconnect.maxDelayMs
    );
  }, state.wsReconnectDelay);
}

function sendMessage(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function handleRelayMessage(msg) {
  // Don't log full message payload - may contain user content/PII
  console.log('[Rebel Avatar] Relay message:', msg.type);
  
  switch (msg.type) {
    case 'auth_ok':
      console.log('[Rebel Avatar] Auth successful, upgrading to Tier 2');
      setConnectionStatus(true);
      // Reset reconnect delay on successful connection
      state.wsReconnectDelay = CONFIG.reconnect.initialDelayMs;
      // Notify desktop that avatar is connected
      console.log('[Rebel Avatar] Sending avatar_connected message to desktop');
      sendMessage({ v: 1, type: 'avatar_connected' });
      break;
      
    case 'auth_error':
      console.error('[Rebel Avatar] Auth failed:', msg.error);
      state.ws?.close();
      break;
      
    case 'state':
      // Desktop is controlling state -- thread status through setState so it arrives
      // in the same callback as the state change (no race with updateStatusText)
      console.log('[Rebel Avatar] Desktop requesting state change:', msg.state, 'status:', msg.status);
      if (msg.state) {
        state.stateMachine?.setState(msg.state, { force: true, statusText: msg.status || null });
      } else if (msg.status) {
        setStatus(msg.status);
      }
      break;
      
    case 'play_audio': {
      // Desktop wants us to play TTS audio
      console.log('[Rebel Avatar] ===== PLAY AUDIO REQUEST =====');
      console.log('[Rebel Avatar] Audio URL length:', msg.url?.length || 0);
      console.log('[Rebel Avatar] Status:', msg.status);
      console.log('[Rebel Avatar] Caption text present:', !!msg.text);
      // Check if we should keep current animation (for wave/goodbye during announcements)
      const keepAnimation = msg.keepAnimation === true;
      if (msg.url) {
        // Store caption text for deferred display (shown on audio.onplay, not on relay receipt)
        // so captions appear WITH audible audio rather than before.
        state.pendingCaptionText = msg.text || null;
        setStatus(msg.status || 'Speaking...');
        console.log('[Rebel Avatar] Calling playAudio(), keepAnimation:', keepAnimation);
        playAudio(msg.url, keepAnimation).then(() => {
          console.log('[Rebel Avatar] playAudio() completed successfully');
        }).catch((err) => {
          console.error('[Rebel Avatar] playAudio() failed:', err);
        });
      } else {
        console.error('[Rebel Avatar] play_audio message has no URL!');
      }
      break;
    }
      
    case 'wave':
      console.log('[Rebel Avatar] Wave animation triggered, current state:', state.stateMachine?.currentState);
      state.stateMachine?.wave();
      console.log('[Rebel Avatar] After wave(), state is now:', state.stateMachine?.currentState);
      break;
      
    case 'celebrate':
      console.log('[Rebel Avatar] Celebration animation triggered');
      state.stateMachine?.celebrate();
      break;
      
    case 'goodbye':
      console.log('[Rebel Avatar] Goodbye animation triggered, current state:', state.stateMachine?.currentState);
      state.stateMachine?.goodbye();
      break;

    case 'stop_audio':
      console.log('[Rebel Avatar] Stop audio requested');
      elements.audioPlayer.pause();
      elements.audioPlayer.currentTime = 0;
      elements.audioPlayer.src = '';
      // Centralized reset (muteAudioDetection, ttsAmplitudeActive, stopDetection, glow)
      onSpeakingAudioEnd();
      state.stateMachine?.setState(STATES.IDLE, { statusText: 'Taking notes...' });
      sendMessage({ v: 1, type: 'audio_stopped' });
      break;
      
    case 'knowledge_access':
      // Desktop toggled knowledge access
      setKnowledgeAccess(msg.enabled);
      break;
      
    case 'desktop_connected':
      console.log('[Rebel Avatar] Desktop reconnected, upgrading to Tier 2');
      setConnectionStatus(true);
      break;
      
    case 'desktop_disconnected':
      console.log('[Rebel Avatar] Desktop disconnected, falling back to Tier 1');
      setConnectionStatus(false);
      break;
      
    case 'ping':
      sendMessage({ v: 1, type: 'pong' });
      break;
      
    default:
      console.log('[Rebel Avatar] Unknown message type:', msg.type);
  }
}

// =============================================================================
// Public API (for testing/debugging)
// =============================================================================

window.RebelAvatar = {
  getState: () => ({ ...state }),
  setStatus,
  playAudio,
  setKnowledgeAccess,
  // State machine controls
  setState: (s, opts) => state.stateMachine?.setState(s, opts),
  wave: () => state.stateMachine?.wave(),
  celebrate: () => state.stateMachine?.celebrate(),
  goodbye: () => state.stateMachine?.goodbye(),
  // Constants
  STATES,
};

// =============================================================================
// Start
// =============================================================================

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
