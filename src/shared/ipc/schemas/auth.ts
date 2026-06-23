import { z } from 'zod';

/**
 * Auth user schema - represents the authenticated user
 */
export const AuthUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
});

export type AuthUser = z.infer<typeof AuthUserSchema>;

/**
 * Auth state schema - current authentication state
 */
export const AuthStateSchema = z.object({
  isAuthenticated: z.boolean(),
  user: AuthUserSchema.nullable(),
  isLoading: z.boolean(),
});

export type AuthState = z.infer<typeof AuthStateSchema>;

/**
 * OAuth provider type
 */
export const AuthProviderSchema = z.enum(['google', 'microsoft']);

export type AuthProvider = z.infer<typeof AuthProviderSchema>;

export const LicenseTierSchema = z.enum(['free', 'teams']);

export type LicenseTier = z.infer<typeof LicenseTierSchema>;

/**
 * Login request schema
 */
export const AuthLoginRequestSchema = z.object({
  provider: AuthProviderSchema,
});

export type AuthLoginRequest = z.infer<typeof AuthLoginRequestSchema>;

/**
 * OTP send request schema
 */
export const AuthSendOtpRequestSchema = z.object({
  email: z.string().email(),
});

export type AuthSendOtpRequest = z.infer<typeof AuthSendOtpRequestSchema>;

/**
 * OTP verify request schema
 */
export const AuthVerifyOtpRequestSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
});

export type AuthVerifyOtpRequest = z.infer<typeof AuthVerifyOtpRequestSchema>;

/**
 * Shared drive configuration schema
 * Returns provider + folder names, or null if not configured.
 */
export const SharedDriveConfigSchema = z.object({
  provider: z.enum(['google-drive', 'onedrive', 'dropbox']),
  folders: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    sharing: z.string().nullable(),
  })),
}).nullable();

export type SharedDriveConfig = z.infer<typeof SharedDriveConfigSchema>;
