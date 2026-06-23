import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

/** Meeting UI state for title bar indicator */
export const MeetingStateSchema = z.enum([
  'no_meetings',
  'preview',
  'detected',
  'detected_external_provider',
  'dispatching',
  'joining',
  'recording',
  'waiting_too_long',
  'rejected',
  'done',
  // Collaborator state - another Mindstone user's bot is already in the meeting
  'collaborator_recording',
  // Local recording states
  'recording_local',
  'uploading_local',
  'processing_local',
  'upload_failed',
  // Physical recording states (Limitless Pendant)
  'recording_physical',
  'transcribing_physical',
  'done_physical',
  // Quick capture recording states (laptop microphone)
  'recording_quick_capture',
  'transcribing_quick_capture',
  'done_quick_capture',
]);
export type MeetingState = z.infer<typeof MeetingStateSchema>;

/** Source of meeting status update for precedence handling */
export const MeetingStatusSourceSchema = z.enum([
  'desktop_sdk',        // Meeting detection only (lowest precedence)
  'cloud_bot',          // Cloud bot dispatching/joining/recording
  'local_recording',    // Local recording active
  'quick_capture',      // Quick capture recording via laptop microphone
  'physical_recording', // Physical recording via Limitless Pendant (highest precedence)
]);
export type MeetingStatusSource = z.infer<typeof MeetingStatusSourceSchema>;

/** Active participation mode for meeting bot behavior */
export const PresenceModeSchema = z.enum(['silent', 'coach', 'participant']);
export type PresenceMode = z.infer<typeof PresenceModeSchema>;

/** Status of a pending meeting transcript */
export const PendingTranscriptStatusSchema = z.enum([
  'scheduled',
  'in_meeting',
  'processing',
  'ready',
  'failed',
]);
export type PendingTranscriptStatus = z.infer<typeof PendingTranscriptStatusSchema>;

/** Transcript quality level */
export const TranscriptQualitySchema = z.enum(['captions', 'recallai_async']);
export type TranscriptQuality = z.infer<typeof TranscriptQualitySchema>;

/** Status of async transcription upgrade */
export const AsyncUpgradeStatusSchema = z.enum([
  'pending',      // Waiting for recording.done
  'processing',   // Async transcription triggered, waiting for transcript.done
  'ready',        // Async transcript available
  'failed',       // Async transcription failed
  'complete',     // User has fetched and saved the async transcript
  'timed_out',    // Polling timed out after max duration (captions still available)
]);
export type AsyncUpgradeStatus = z.infer<typeof AsyncUpgradeStatusSchema>;

/** Schema for pending transcript metadata */
export const PendingTranscriptSchema = z.object({
  botId: z.string(),
  meetingUrl: z.string(),
  meetingTitle: z.string().optional(),
  scheduledAt: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  status: PendingTranscriptStatusSchema,
  errorMessage: z.string().optional(),
  /** Per-bot secret for secure transcript retrieval (generated client-side) */
  clientSecret: z.string().optional(),
  /** Path where transcript was saved (set on successful save) */
  savedPath: z.string().optional(),
  /** Number of save attempts (for retry limiting) */
  saveAttempts: z.number().optional(),
  /** Timestamp when background analysis should run (ISO string, 10min after save) */
  scheduledAnalysisAt: z.string().optional(),
  /** Timestamp when background analysis was triggered (ISO string) */
  analysisTriggered: z.string().optional(),
  /** Whether background analysis completed successfully */
  analysisCompleted: z.boolean().optional(),
  /** Recording ID for async transcription (from Recall) */
  recordingId: z.string().optional(),
  /** Current transcript quality level */
  transcriptQuality: TranscriptQualitySchema.optional(),
  /** Status of async transcription upgrade */
  asyncUpgradeStatus: AsyncUpgradeStatusSchema.optional(),
  /** Timestamp when async upgrade polling started (ISO string, for timeout calculation) */
  asyncUpgradeStartedAt: z.string().optional(),
  /** Count of consecutive 400 errors during status polling (for stale bot cleanup) */
  consecutiveErrors: z.number().optional(),
  /** Timestamp of last retry attempt (ISO string, for infinite retry prevention) */
  lastRetryAt: z.string().optional(),
  /** Timestamp when next retry should be attempted (ISO string, for backoff logic) */
  nextRetryAt: z.string().optional(),
  /**
   * Baseline for the max-retry-duration (MAX_RETRY_HOURS) window. Set when a failed
   * transcript is re-armed for recovery (e.g. after a code fix) so the retry-age cap
   * is measured from the reset, not from createdAt — otherwise a transcript older than
   * MAX_RETRY_HOURS could never be recovered even within the KV-retention window.
   * Falls back to createdAt when absent.
   */
  retryWindowStartedAt: z.string().optional(),
  /** Reason for failure if status is 'failed' (for debugging/forensics) */
  failureReason: z.string().optional(),
  /** Calendar event ID for linking transcript to calendar meeting */
  calendarEventId: z.string().optional(),
  /** Calendar source (google, microsoft) for collision-safe meeting ID */
  calendarSource: z.string().optional(),
  /** Relay bot ID for WebSocket reconnection after restart (differs from botId which is Recall ID) */
  relayBotId: z.string().optional(),
  /** Timestamp when recording started (ms since epoch, for duration display after restart) */
  recordingStartTimeMs: z.number().optional(),
  /** Path to live transcript file being written during meeting (for agent access and upgrade) */
  liveTranscriptPath: z.string().optional(),
  /** Selected coach skill path for live coaching (persisted for restart recovery) */
  coachSkillPath: z.string().optional(),
  /** Companion session ID for live coaching (persisted for restart recovery) */
  companionSessionId: z.string().optional(),
  /** Active participation mode (persisted for restart recovery) */
  presenceMode: PresenceModeSchema.optional(),
  /** JSON-serialized conversation state for restart recovery */
  conversationState: z.string().optional(),
  /** Whether this transcript was staged for sensitivity review (not yet saved to disk) */
  stagedForReview: z.boolean().optional(),
  /** Whether this transcript belongs to a collaborator (another user's bot is recording) */
  isCollaborator: z.boolean().optional(),
  /** Name of the bot owner (set for collaborator transcripts, for UI display on restart) */
  ownerName: z.string().optional(),
});
export type PendingTranscript = z.infer<typeof PendingTranscriptSchema>;

/** Request to send a meeting bot */
const SendBotRequestSchema = z.object({
  meetingUrl: z.string(),
  meetingTitle: z.string().optional(),
  avatarId: z.string().optional(),
  scheduledFor: z.string().optional(),
  /** Calendar event ID for linking transcript to calendar meeting */
  calendarEventId: z.string().optional(),
  /** Calendar source (google, microsoft) for collision-safe meeting ID */
  calendarSource: z.string().optional(),
  /** Force sending own bot even if another bot is already in meeting */
  forceJoin: z.boolean().optional(),
});

/** Response from sending a meeting bot */
const SendBotResponseSchema = z.object({
  success: z.boolean(),
  botId: z.string().optional(),
  error: z.string().optional(),
  /** Whether this user owns the bot (false if another user's bot is already in meeting) */
  isOwner: z.boolean().optional(),
  /** Name of the existing bot owner (when isOwner is false) */
  ownerName: z.string().optional(),
  /** Whether user can override and send their own bot anyway */
  canOverride: z.boolean().optional(),
});

export const meetingBotChannels = {
  'meeting-bot:send': defineInvokeChannel({
    channel: 'meeting-bot:send',
    request: SendBotRequestSchema,
    response: SendBotResponseSchema,
    description: 'Send a meeting bot to join a meeting',
  }),

  'meeting-bot:cancel': defineInvokeChannel({
    channel: 'meeting-bot:cancel',
    request: z.object({ botId: z.string() }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
      recoverable: z.boolean().optional(),
    }),
    description: 'Cancel a scheduled or in-progress meeting bot',
  }),

  'meeting-bot:process-and-save': defineInvokeChannel({
    channel: 'meeting-bot:process-and-save',
    request: z.object({ botId: z.string() }),
    response: z.object({
      success: z.boolean(),
      filePath: z.string().optional(),
      spacePath: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Fetch transcript, generate AI summary, and save to appropriate space',
  }),

  // Desktop SDK channels
  'meeting-bot:start-recording': defineInvokeChannel({
    channel: 'meeting-bot:start-recording',
    request: z.object({ uploadToken: z.string() }),
    response: z.object({ success: z.boolean(), error: z.string().optional() }),
    description: 'Start recording the current detected meeting via Desktop SDK',
  }),

  'meeting-bot:stop-recording': defineInvokeChannel({
    channel: 'meeting-bot:stop-recording',
    request: z.void(),
    response: z.object({ success: z.boolean(), error: z.string().optional() }),
    description: 'Stop recording the current meeting via Desktop SDK',
  }),

  'meeting-bot:get-current-meeting': defineInvokeChannel({
    channel: 'meeting-bot:get-current-meeting',
    request: z.void(),
    response: z.object({
      windowId: z.string(),
      title: z.string(),
      url: z.string(),
      platform: z.string(),
    }).nullable(),
    description: 'Get the currently detected meeting from Desktop SDK',
  }),

  'meeting-bot:is-sdk-ready': defineInvokeChannel({
    channel: 'meeting-bot:is-sdk-ready',
    request: z.void(),
    response: z.boolean(),
    description: 'Check if the Desktop SDK is initialized and ready',
  }),

  'meeting-bot:is-recorder-installed': defineInvokeChannel({
    channel: 'meeting-bot:is-recorder-installed',
    request: z.void(),
    response: z.object({
      installed: z.boolean(),
    }),
    description: 'Check whether the Recall Desktop SDK package is installed on this desktop runtime',
  }),

  'meeting-bot:install-recorder': defineInvokeChannel({
    channel: 'meeting-bot:install-recorder',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      /** A usable recorder was already present; nothing was installed. */
      alreadyInstalled: z.boolean().optional(),
      /** Recall ships no recorder for this OS (e.g. Linux); npm was not run. */
      unsupportedPlatform: z.boolean().optional(),
      /** The user cancelled; the UI returns to idle (not a failure). */
      cancelled: z.boolean().optional(),
      /** Friendly, non-technical failure message for the UI. Absent on success or user-cancel. */
      error: z.string().optional(),
    }),
    description:
      'Run the pinned on-demand install of the Recall Desktop SDK (desktop-only). Succeeds only when the platform-native recorder is actually present afterward.',
  }),

  'meeting-bot:cancel-recorder-install': defineInvokeChannel({
    channel: 'meeting-bot:cancel-recorder-install',
    request: z.void(),
    response: z.object({
      /** True if there was an in-flight install to abort. */
      cancelled: z.boolean(),
    }),
    description: 'Abort an in-flight recorder install (main-owned; a renderer AbortController cannot reach invoke()).',
  }),

  'meeting-bot:is-recorder-installing': defineInvokeChannel({
    channel: 'meeting-bot:is-recorder-installing',
    request: z.void(),
    response: z.object({
      installing: z.boolean(),
    }),
    description: 'Whether a recorder install is currently running (lets the UI rediscover state after a remount).',
  }),

  // External provider channels
  'meeting-bot:test-external-provider': defineInvokeChannel({
    channel: 'meeting-bot:test-external-provider',
    request: z.object({
      provider: z.enum(['fireflies', 'fathom']),
      apiKey: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      message: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Test connection to an external transcript provider',
  }),

  'meeting-bot:test-recall-api-key': defineInvokeChannel({
    channel: 'meeting-bot:test-recall-api-key',
    request: z.object({
      apiKey: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      message: z.string().optional(),
      error: z.string().optional(),
      recoverable: z.boolean().optional(),
    }),
    description: 'Test connection to Recall with a user-supplied API key',
  }),

  'meeting-bot:sync-external-provider': defineInvokeChannel({
    channel: 'meeting-bot:sync-external-provider',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      provider: z.enum(['fireflies', 'fathom']).optional(),
      imported: z.number(),
      message: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Trigger manual sync of external provider transcripts',
  }),

  // Local recording channels
  'meeting-bot:start-local-recording': defineInvokeChannel({
    channel: 'meeting-bot:start-local-recording',
    request: z.object({
      meetingTitle: z.string().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      uploadId: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Start local recording for the current detected meeting',
  }),

  'meeting-bot:stop-local-recording': defineInvokeChannel({
    channel: 'meeting-bot:stop-local-recording',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Stop local recording and begin upload',
  }),

  'meeting-bot:get-local-recording-status': defineInvokeChannel({
    channel: 'meeting-bot:get-local-recording-status',
    request: z.void(),
    response: z.object({
      isRecording: z.boolean(),
      uploadId: z.string().optional(),
      meetingTitle: z.string().optional(),
      startTime: z.string().optional(),
    }),
    description: 'Get current local recording status',
  }),

  'meeting-bot:check-local-recording-permissions': defineInvokeChannel({
    channel: 'meeting-bot:check-local-recording-permissions',
    request: z.void(),
    response: z.object({
      supported: z.boolean(),
      unsupportedReason: z.string().optional(),
      permissions: z.object({
        microphone: z.boolean(),
        screenCapture: z.boolean(),
        accessibility: z.boolean(),
      }).optional(),
      allGranted: z.boolean(),
    }),
    description: 'Check if local recording is supported and permissions are granted',
  }),

  'meeting-bot:request-local-recording-permissions': defineInvokeChannel({
    channel: 'meeting-bot:request-local-recording-permissions',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      permissions: z.object({
        microphone: z.boolean(),
        screenCapture: z.boolean(),
        accessibility: z.boolean(),
      }),
    }),
    description: 'Request permissions needed for local recording',
  }),

  'meeting-bot:is-local-recording-supported': defineInvokeChannel({
    channel: 'meeting-bot:is-local-recording-supported',
    request: z.void(),
    response: z.object({
      supported: z.boolean(),
      reason: z.string().optional(),
    }),
    description: 'Check if local recording is supported on this platform',
  }),

  'meeting-bot:get-current-status': defineInvokeChannel({
    channel: 'meeting-bot:get-current-status',
    request: z.void(),
    response: z.object({
      state: MeetingStateSchema,
      source: MeetingStatusSourceSchema.optional(),
      meeting: z.object({
        id: z.string(),
        title: z.string(),
        startTime: z.string(),
        meetingUrl: z.string(),
        prepPath: z.string().optional(),
      }).optional(),
      botId: z.string().optional(),
      quip: z.string().optional(),
      recordingDuration: z.number().optional(),
      /** Whether the interactive avatar is connected to the relay (enables "hey Spark", live Q&A) */
      avatarConnected: z.boolean().optional(),
      /** Whether live captions are actively flowing (true = active, false = stale, undefined = unknown) */
      captionsActive: z.boolean().optional(),
      /** Active participation mode for the current bot session */
      presenceMode: PresenceModeSchema.optional(),
      /** Collaborator info when another user's bot is already recording */
      collaborator: z.object({
        ownerName: z.string().optional(),
        botId: z.string(),
      }).optional(),
    }),
    description: 'Get the current meeting status for UI initialization (includes state, source, and meeting info)',
  }),

  'meeting-bot:get-recording-count': defineInvokeChannel({
    channel: 'meeting-bot:get-recording-count',
    request: z.void(),
    response: z.object({
      /** Number of cloud bots currently recording (status === 'in_meeting') */
      recordingCount: z.number(),
      /** Total number of active bots (scheduled + in_meeting) */
      activeCount: z.number(),
    }),
    description: 'Get count of cloud bots currently recording for multi-bot badge',
  }),

  'meeting-bot:fetch-local-recording-transcript': defineInvokeChannel({
    channel: 'meeting-bot:fetch-local-recording-transcript',
    request: z.object({
      uploadId: z.string(),
      clientSecret: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      transcript: z.string().optional(),
      participants: z.array(z.string()).optional(),
      duration: z.number().optional(),
      meetingTitle: z.string().optional(),
      startTime: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Fetch transcript for a completed local recording upload',
  }),

  'meeting-bot:set-knowledge-access': defineInvokeChannel({
    channel: 'meeting-bot:set-knowledge-access',
    request: z.object({
      botId: z.string(),
      enabled: z.boolean(),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Enable or disable knowledge base access for Q&A during a meeting',
  }),

  'meeting-bot:get-knowledge-access': defineInvokeChannel({
    channel: 'meeting-bot:get-knowledge-access',
    request: z.object({
      botId: z.string(),
    }),
    response: z.object({
      enabled: z.boolean(),
    }),
    description: 'Get the current knowledge access state for a bot',
  }),

  'meeting-bot:stop-speaking': defineInvokeChannel({
    channel: 'meeting-bot:stop-speaking',
    request: z.object({
      botId: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Stop bot from speaking (interrupt)',
  }),

  'meeting-bot:is-speaking': defineInvokeChannel({
    channel: 'meeting-bot:is-speaking',
    request: z.object({
      botId: z.string(),
    }),
    response: z.object({
      speaking: z.boolean(),
    }),
    description: 'Check if bot is currently speaking',
  }),

  'meeting-bot:has-pending-response': defineInvokeChannel({
    channel: 'meeting-bot:has-pending-response',
    request: z.object({
      botId: z.string(),
    }),
    response: z.object({
      pending: z.boolean(),
    }),
    description: 'Check if bot has a pending response waiting to be spoken',
  }),

  'meeting-bot:speak-pending-response': defineInvokeChannel({
    channel: 'meeting-bot:speak-pending-response',
    request: z.object({
      botId: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Trigger the bot to speak its pending response (Let Spark speak button)',
  }),

  'meeting-bot:chat-pending-response': defineInvokeChannel({
    channel: 'meeting-bot:chat-pending-response',
    request: z.object({
      botId: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
      rateLimited: z.boolean().optional(),
    }),
    description: 'Send the pending proactive contribution as a chat message instead of speaking it',
  }),

  'meeting-bot:get-teams-url-permission-status': defineInvokeChannel({
    channel: 'meeting-bot:get-teams-url-permission-status',
    request: z.void(),
    response: z.object({
      /** Whether Full Disk Access is required (macOS only) */
      required: z.boolean(),
      /** Whether Full Disk Access is granted */
      granted: z.boolean(),
      /** Platform - 'darwin' for macOS, 'win32' for Windows */
      platform: z.string(),
    }),
    description: 'Check if Full Disk Access is granted for Teams URL extraction (macOS only)',
  }),

  'meeting-bot:request-teams-url-permission': defineInvokeChannel({
    channel: 'meeting-bot:request-teams-url-permission',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      /** Whether the permission was already granted */
      alreadyGranted: z.boolean(),
    }),
    description: 'Request Full Disk Access permission for Teams URL extraction (opens System Settings on macOS)',
  }),

  'meeting-bot:set-coach': defineInvokeChannel({
    channel: 'meeting-bot:set-coach',
    request: z.union([
      z.object({
        coachSkillPath: z.string(),
        companionSessionId: z.string(),
      }),
      z.null(),
    ]),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Set or clear the live coach for the active meeting bot',
  }),

  'meeting-bot:set-presence-mode': defineInvokeChannel({
    channel: 'meeting-bot:set-presence-mode',
    request: z.object({
      mode: PresenceModeSchema,
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Set active participation presence mode for the current meeting bot',
  }),

  'meeting-bot:get-coach': defineInvokeChannel({
    channel: 'meeting-bot:get-coach',
    request: z.void(),
    response: z.union([
      z.object({
        hasCoach: z.literal(false),
      }),
      z.object({
        hasCoach: z.literal(true),
        coachSkillPath: z.string(),
        companionSessionId: z.string().optional(),
      }),
    ]),
    description: 'Get the current live coach selection for the active meeting bot',
  }),


  'meeting-bot:get-contribution-preview': defineInvokeChannel({
    channel: 'meeting-bot:get-contribution-preview',
    request: z.object({ botId: z.string() }),
    response: z.object({
      text: z.string(),
      scores: z.object({
        relevance: z.number(),
        helpfulness: z.number(),
        timing: z.number(),
      }).nullable().optional(),
      triggerType: z.string().optional(),
      triggerExcerpt: z.string().optional(),
    }).nullable(),
    description: 'Get the pending contribution preview text and quality scores',
  }),

  'meeting-bot:dismiss-contribution': defineInvokeChannel({
    channel: 'meeting-bot:dismiss-contribution',
    request: z.object({ botId: z.string() }),
    response: z.object({ success: z.boolean() }),
    description: 'Dismiss the pending proactive contribution without speaking it',
  }),

  'meeting-bot:dismiss-status': defineInvokeChannel({
    channel: 'meeting-bot:dismiss-status',
    request: z.void(),
    response: z.object({ success: z.boolean() }),
    description: 'Dismiss the meeting bot status indicator',
  }),

  'meeting-bot:skip-meeting': defineInvokeChannel({
    channel: 'meeting-bot:skip-meeting',
    request: z.object({ meetingUrl: z.string() }),
    response: z.object({ success: z.boolean() }),
    description: 'Skip sending a bot to the current detected meeting',
  }),

} as const;
