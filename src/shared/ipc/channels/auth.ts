import { z } from 'zod';
import { defineInvokeChannel } from '../schemas/common';
import {
  AuthStateSchema,
  AuthUserSchema,
  AuthLoginRequestSchema,
  AuthSendOtpRequestSchema,
  AuthVerifyOtpRequestSchema,
  LicenseTierSchema,
  SharedDriveConfigSchema,
} from '../schemas/auth';

const ApiReachabilityResultSchema = z.discriminatedUnion('reachable', [
  z.object({
    reachable: z.literal(true),
  }),
  z.object({
    reachable: z.literal(false),
    reason: z.enum(['tls', 'timeout', 'network', 'http', 'unknown']),
    status: z.number().int().optional(),
  }),
]);

const ManagedDefaultModelsSchema = z.object({
  working: z.string().optional(),
  thinking: z.string().optional(),
  bts: z.string().optional(),
});

const ManagedProviderInfoSchema = z.object({
  provider: z.string(),
  keyHash: z.string(),
  allowedModels: z.array(z.string()),
  defaultModels: ManagedDefaultModelsSchema.optional(),
  /**
   * Monthly credit limit in USD.
   * Omitted means the server has not populated allowance data yet.
   */
  creditLimitMonthly: z.number().optional(),
  /**
   * Credit used this month in USD.
   * Omitted means the server has not populated allowance data yet.
   */
  creditUsedMonthly: z.number().optional(),
  /**
   * ISO-8601 timestamp of when the monthly allowance window ends and credits reset.
   * Optional for forward-compatibility with older servers that don't yet emit it;
   * the renderer meter falls back to "data unavailable" when missing.
   */
  resetsAt: z.string().optional(),
  /** Currency code for the credit amounts. Currently always 'USD' but typed openly for future. */
  currency: z.string().optional(),
  /** Reset period cadence. Currently always 'month'. */
  period: z.literal('month').optional(),
});

export const AuthConfigPresenceSchema = z.object({
  hasVoiceProvider: z.boolean(),
  hasVoiceApiKey: z.boolean(),
  hasAnthropicApiKey: z.boolean(),
  hasSharedDriveConfig: z.boolean(),
  recommendedConnectors: z.array(z.string()),
  companyDisplayName: z.string().optional(),
  hasSpaces: z.boolean(),
  sharedDriveProvider: z.string().optional(),
  licenseTier: LicenseTierSchema,
  disabledConnectorTools: z.record(z.string(), z.object({ disabledTools: z.array(z.string()) })).default({}),
  managedProvider: ManagedProviderInfoSchema.optional(),
  hasManagedKey: z.boolean(),
  isOssBuild: z.boolean().optional().default(false),
});

export type AuthConfigPresence = z.infer<typeof AuthConfigPresenceSchema>;

export const authChannels = {
  'auth:get-state': defineInvokeChannel({
    channel: 'auth:get-state',
    request: z.void(),
    response: AuthStateSchema,
    description: 'Get the current authentication state',
  }),

  'auth:login': defineInvokeChannel({
    channel: 'auth:login',
    request: AuthLoginRequestSchema,
    response: z.void(),
    description: 'Initiate OAuth login flow with the specified provider',
  }),

  'auth:logout': defineInvokeChannel({
    channel: 'auth:logout',
    request: z.void(),
    response: z.void(),
    description: 'Sign out the current user',
  }),

  'auth:get-user': defineInvokeChannel({
    channel: 'auth:get-user',
    request: z.void(),
    response: AuthUserSchema.nullable(),
    description: 'Get the current authenticated user info',
  }),

  'auth:get-access-token': defineInvokeChannel({
    channel: 'auth:get-access-token',
    request: z.void(),
    response: z.string().nullable(),
    description: 'Get a valid access token for API calls',
  }),

  'auth:cancel': defineInvokeChannel({
    channel: 'auth:cancel',
    request: z.void(),
    response: z.void(),
    description: 'Cancel pending OAuth login flow',
  }),

  'auth:send-otp': defineInvokeChannel({
    channel: 'auth:send-otp',
    request: AuthSendOtpRequestSchema,
    response: z.void(),
    description: 'Send OTP code to email address',
  }),

  'auth:verify-otp': defineInvokeChannel({
    channel: 'auth:verify-otp',
    request: AuthVerifyOtpRequestSchema,
    response: z.void(),
    description: 'Verify OTP code and complete login',
  }),

  'auth:test-loopback': defineInvokeChannel({
    channel: 'auth:test-loopback',
    request: z.void(),
    response: z.boolean(),
    description: 'Test if loopback connectivity works (for OAuth callback). Returns false if blocked by firewall/security software.',
  }),

  'auth:test-api-reachability': defineInvokeChannel({
    channel: 'auth:test-api-reachability',
    request: z.void(),
    response: ApiReachabilityResultSchema,
    description: 'Test if API is reachable via POST. Returns a structured result (e.g. TLS validation failure vs timeout) for login UX.',
  }),

  'auth:get-config': defineInvokeChannel({
    channel: 'auth:get-config',
    request: z.void(),
    response: AuthConfigPresenceSchema.nullable(),
    description: 'Get cached auth config presence indicators and org-level settings. Returns null if not available. Never exposes actual API keys.',
  }),

  'auth:refresh-config': defineInvokeChannel({
    channel: 'auth:refresh-config',
    request: z.void(),
    response: z.void(),
    description: 'Request a debounced server refresh of auth config and managed subscription metadata.',
  }),

  'auth:get-shared-drive-config': defineInvokeChannel({
    channel: 'auth:get-shared-drive-config',
    request: z.void(),
    response: SharedDriveConfigSchema,
    description: 'Get cached shared drive configuration (provider and folder names). Returns null if not available.',
  }),
};
