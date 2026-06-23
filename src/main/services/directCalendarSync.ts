/**
 * Direct Calendar Sync Service
 * 
 * Fetches calendar events directly from Google Calendar API and Microsoft Graph API
 * using stored OAuth tokens. No MCP or LLM involvement - just direct REST API calls.
 * 
 * Cost: $0 (no LLM, no MCP overhead)
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { createScopedLogger } from '@core/logger';
import { getSettings } from '@core/services/settingsStore';
import { extractServerRecord, resolveMcpConfigPath } from '@core/services/mcp/mcpConfigResolver';
import { getDataPath } from '@core/utils/dataPaths';
import { atomicCredentialWrite } from '@core/utils/atomicCredentialWrite';
import { CachedMeeting, setCachedMeetings, reapplySkipState, renderSyncIssue, makeSyncIssue, type SyncIssue } from './meetingCacheStore';
import { classifySyncErrorCause } from '@shared/ipc/channels/calendar';
import { markCalendarSyncAttempted } from '@core/services/calendarSyncAttempt';
import { attachPrepPathsFromDisk } from './meetingPrepReconciler';
import { googleCredentialSource, resolveOAuthCredentials } from './oauthCredentials';
import { fetchMicrosoftGraph } from './microsoftGraphFetch';
import {
  classifyGoogleEmailDomain,
  parseGoogleErrorCode,
  recordGoogleOAuthRefreshFailure,
  type DomainClass,
} from './oauthRefreshTelemetry';
import * as oauthRefreshFailureStore from './oauthRefreshFailureStore';

const logger = createScopedLogger({ service: 'direct-calendar-sync' });

// Google Calendar color palette (colorId -> hex colors)
// These are the standard Google Calendar event colors (1-11)
// Fetched via colors.get API, but we provide static fallback for reliability
export interface CalendarColor {
  background: string;
  foreground: string;
}

export interface CalendarColorPalette {
  event: Record<string, CalendarColor>;
  fetchedAt?: number;
}

// Static fallback palette (as of 2025, rarely changes)
const GOOGLE_CALENDAR_COLOR_PALETTE: CalendarColorPalette = {
  event: {
    '1': { background: '#a4bdfc', foreground: '#1d1d1d' },  // Lavender
    '2': { background: '#7ae7bf', foreground: '#1d1d1d' },  // Sage
    '3': { background: '#dbadff', foreground: '#1d1d1d' },  // Grape
    '4': { background: '#ff887c', foreground: '#1d1d1d' },  // Flamingo
    '5': { background: '#fbd75b', foreground: '#1d1d1d' },  // Banana
    '6': { background: '#ffb878', foreground: '#1d1d1d' },  // Tangerine
    '7': { background: '#46d6db', foreground: '#1d1d1d' },  // Peacock
    '8': { background: '#e1e1e1', foreground: '#1d1d1d' },  // Graphite
    '9': { background: '#5484ed', foreground: '#1d1d1d' },  // Blueberry
    '10': { background: '#51b749', foreground: '#1d1d1d' }, // Basil
    '11': { background: '#dc2127', foreground: '#1d1d1d' }, // Tomato
  },
};

// Cached color palette (fetched from API when available)
let cachedColorPalette: CalendarColorPalette | null = null;
const COLOR_PALETTE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get Google Calendar color palette.
 * Returns cached palette if available, otherwise static fallback.
 */
export function getGoogleCalendarColorPalette(): CalendarColorPalette {
  return cachedColorPalette || GOOGLE_CALENDAR_COLOR_PALETTE;
}

/**
 * Fetch fresh color palette from Google Calendar API
 */
async function fetchGoogleColorPalette(accessToken: string): Promise<void> {
  try {
    // Skip if cache is still fresh
    if (cachedColorPalette?.fetchedAt && 
        Date.now() - cachedColorPalette.fetchedAt < COLOR_PALETTE_CACHE_TTL) {
      return;
    }

    const response = await fetch(
      'https://www.googleapis.com/calendar/v3/colors',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Failed to fetch color palette, using fallback');
      return;
    }

    const data = await response.json();
    if (data.event) {
      cachedColorPalette = {
        event: data.event,
        fetchedAt: Date.now(),
      };
      logger.info('Fetched Google Calendar color palette');
    }
  } catch (error) {
    logger.warn({ error }, 'Error fetching color palette, using fallback');
  }
}

/**
 * Get hex color for a Google Calendar event colorId
 */
export function getGoogleEventColor(colorId: string | undefined): CalendarColor | undefined {
  if (!colorId) return undefined;
  const palette = getGoogleCalendarColorPalette();
  return palette.event[colorId];
}

// Token file structures
interface GoogleToken {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type: string;
  scope: string;
}

interface GoogleAccount {
  email: string;
  category?: string;
  description?: string;
}

interface MicrosoftAccount {
  email: string;
  displayName?: string;
}

// Google Calendar API types
interface GoogleCalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType: string; uri: string }>;
  };
  creator?: { email?: string; displayName?: string; self?: boolean };
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: Array<{
    email: string;
    displayName?: string;
    self?: boolean;
    responseStatus?: string;
  }>;
  /** Event color ID (1-11). Use colors.get API to map to hex values. */
  colorId?: string;
}

// Microsoft Graph API types
interface MicrosoftCalendarEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  isCancelled?: boolean;
  responseStatus?: { response?: string };
  start?: { dateTime: string; timeZone?: string };
  end?: { dateTime: string; timeZone?: string };
  location?: { displayName?: string };
  onlineMeeting?: { joinUrl?: string };
  organizer?: { emailAddress?: { address?: string; name?: string } };
  attendees?: Array<{
    emailAddress?: { address?: string; name?: string };
    status?: { response?: string };
  }>;
  /** Categories assigned to the event (used for color coding in Outlook). */
  categories?: string[];
}

interface GoogleCalendarListEntry {
  id?: string;
  summary?: string;
  accessRole?: 'freeBusyReader' | 'reader' | 'writer' | 'owner';
  primary?: boolean;
}

interface GoogleCalendarListResponse {
  items?: GoogleCalendarListEntry[];
  nextPageToken?: string;
}

interface MicrosoftCalendarListEntry {
  id?: string;
  name?: string;
  isDefaultCalendar?: boolean;
}

interface MicrosoftCalendarListResponse {
  value?: MicrosoftCalendarListEntry[];
  '@odata.nextLink'?: string;
}

export interface AvailableCalendar {
  id: string;
  name: string;
  isPrimary: boolean;
  provider: 'google' | 'microsoft';
  accountEmail: string;
}

export type GoogleAuthResult =
  | { ok: true; token: string; email: string }
  | { ok: false; reason: 'no_account' | 'reauth_required' | 'transient'; slug: string; emailDomain?: string };

export type GoogleCalendarListResult =
  | { ok: true; calendars: AvailableCalendar[] }
  | { ok: false; reason: 'no_account' | 'reauth_required' | 'transient'; needsReconnect: boolean };

export interface DiscoveredCalendarAccount {
  calendarSource: string;
  provider: 'google' | 'microsoft';
  email: string;
  accountSlug?: string;
  needsReconnect?: boolean;
}

/**
 * Get the user data path for credential storage
 */
function getUserDataPath(): string {
  return getDataPath();
}

function isMissingFileError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ENOENT';
}

async function readPrimaryGoogleAccount(accountSlug: string): Promise<GoogleAccount | null> {
  const accountsPath = path.join(getUserDataPath(), 'google-workspace-mcp', accountSlug, 'accounts.json');
  try {
    const accountsData = await fs.readFile(accountsPath, 'utf-8');
    const { accounts } = JSON.parse(accountsData) as { accounts: GoogleAccount[] };
    return accounts?.[0] ?? null;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

function getGoogleTokenPath(accountSlug: string, accountEmail: string): string {
  const tokenFileName = accountEmail.replace(/@/g, '-').replace(/\./g, '-') + '.token.json';
  return path.join(getUserDataPath(), 'google-workspace-mcp', accountSlug, 'credentials', tokenFileName);
}

class GoogleAuthFailureError extends Error {
  reason: 'reauth_required' | 'transient';
  slug: string;
  emailDomain?: string;

  constructor(reason: 'reauth_required' | 'transient', slug: string, emailDomain?: string) {
    super(reason === 'reauth_required' ? 'Google account requires reconnect' : 'Google auth transient failure');
    this.name = 'GoogleAuthFailureError';
    this.reason = reason;
    this.slug = slug;
    this.emailDomain = emailDomain;
  }
}

/**
 * Refresh a Google OAuth token.
 *
 * On non-2xx, reports a redacted failure event to Sentry via
 * {@link recordGoogleOAuthRefreshFailure} (domain class + tenant hash + Google
 * error code, no PII), then throws a sanitized Error. The raw response body
 * is read locally for parsing only and is never forwarded to Sentry.
 */
async function refreshGoogleToken(
  token: GoogleToken,
  tokenPath: string,
  domainClass: DomainClass,
  emailDomain: string,
  accountSlug: string,
): Promise<string> {
  const credentials = resolveOAuthCredentials(googleCredentialSource);
  if (!credentials) {
    throw new Error('Google Workspace OAuth credentials are not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your environment.');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    const errorCode = parseGoogleErrorCode(bodyText);
    const now = Date.now();
    const failureState = oauthRefreshFailureStore.recordFailure(accountSlug, errorCode, now, { provider: 'google' });

    if (oauthRefreshFailureStore.shouldReportToSentry(accountSlug, now)) {
      recordGoogleOAuthRefreshFailure({
        httpStatus: response.status,
        responseBodyText: bodyText,
        emailDomain,
        domainClass,
      });
    }

    // Sanitized error: the raw body must not appear in the Sentry exception
    // value (covered above) nor in any future log line wrapping this error.
    throw new GoogleAuthFailureError(
      failureState.needsReconnect ? 'reauth_required' : 'transient',
      accountSlug,
      emailDomain,
    );
  }

  const newToken = await response.json();
  const updatedToken: GoogleToken = {
    ...token,
    access_token: newToken.access_token,
    expiry_date: Date.now() + (newToken.expires_in * 1000),
  };

  await atomicCredentialWrite(tokenPath, JSON.stringify(updatedToken, null, 2), { mode: 0o600 });
  await fs.chmod(tokenPath, 0o600).catch(() => undefined);
  oauthRefreshFailureStore.recordSuccess(accountSlug, { provider: 'google' });
  logger.info('Refreshed Google token');
  return updatedToken.access_token;
}

/**
 * Get a valid Google access token, refreshing if needed
 */
export async function getGoogleAccessToken(accountSlug: string): Promise<GoogleAuthResult> {
  const account = await readPrimaryGoogleAccount(accountSlug);
  if (!account) {
    return { ok: false, reason: 'no_account', slug: accountSlug };
  }

  const emailDomain = account.email.split('@')[1]?.toLowerCase() ?? '';
  const domainClass = classifyGoogleEmailDomain(account.email);
  const tokenPath = getGoogleTokenPath(accountSlug, account.email);

  try {
    const tokenData = await fs.readFile(tokenPath, 'utf-8');
    const token = JSON.parse(tokenData) as GoogleToken;
    const now = Date.now();
    const shouldShortCircuit = oauthRefreshFailureStore.shouldShortCircuit(accountSlug, now);
    const isTokenExpiringSoon = token.expiry_date < now + 5 * 60 * 1000;

    // Stage 1 containment: short-circuit before a refresh network call.
    if (shouldShortCircuit.skip && isTokenExpiringSoon) {
      return {
        ok: false,
        reason: shouldShortCircuit.reason ?? 'transient',
        slug: accountSlug,
        emailDomain,
      };
    }

    if (isTokenExpiringSoon) {
      const newAccessToken = await refreshGoogleToken(
        token,
        tokenPath,
        domainClass,
        emailDomain,
        accountSlug,
      );
      return { ok: true, token: newAccessToken, email: account.email };
    }

    if (shouldShortCircuit.skip) {
      // Token is still valid; clear stale failure state and continue using it.
      oauthRefreshFailureStore.recordSuccess(accountSlug, { provider: 'google' });
    }

    return { ok: true, token: token.access_token, email: account.email };
  } catch (error) {
    if (error instanceof GoogleAuthFailureError) {
      return {
        ok: false,
        reason: error.reason,
        slug: error.slug,
        emailDomain: error.emailDomain,
      };
    }

    if (isMissingFileError(error)) {
      return {
        ok: false,
        reason: 'no_account',
        slug: accountSlug,
        emailDomain,
      };
    }

    // Pino's stack/message serializer is keyed on `err`, not `error`. With `error`,
    // pino fell back to JSON.stringify, which emits `{}` for Error instances because
    // their message/stack are non-enumerable.
    //
    // Also: do not include `accountSlug` here. createScopedLogger forwards warn/error
    // logs to Sentry as breadcrumbs, and beforeBreadcrumb does not redact slugified
    // emails like `GoogleWorkspace-teammember-mindstone-com`. Domain class is safe.
    logger.warn({ err: error, domainClass }, 'Failed to get Google access token');
    return {
      ok: false,
      reason: 'transient',
      slug: accountSlug,
      emailDomain,
    };
  }
}

/** Instance-slug prefix shared by MCP server names, credential dirs, and failure-store slugs. */
const GOOGLE_WORKSPACE_SLUG_PREFIX = 'GoogleWorkspace-';

export type GoogleAccountDiscoveryResult =
  | { ok: true; slugs: string[] }
  | { ok: false };

/**
 * Discover connected Google accounts from per-instance credential dirs.
 *
 * Discriminated result ([RS-F1]/[GPT-F4], 260611_calendar-cache-attention):
 * ENOENT/ENOTDIR on the base dir mean legitimately zero accounts
 * (`ok: true, slugs: []`); every other error code (EMFILE — a live Sentry
 * class — EACCES, EIO, …) returns `ok: false` so each caller must decide what
 * a FAILED discovery means. The orphan-latch sweep skips entirely on
 * `ok: false`: the old blind `catch { return [] }` would have wiped every
 * Google latch on exactly the machines already degraded by fd exhaustion.
 */
export async function discoverGoogleAccounts(): Promise<GoogleAccountDiscoveryResult> {
  const basePath = path.join(getUserDataPath(), 'google-workspace-mcp');
  try {
    const entries = await fs.readdir(basePath, { withFileTypes: true });
    return {
      ok: true,
      slugs: entries
        .filter(e => e.isDirectory() && e.name.startsWith(GOOGLE_WORKSPACE_SLUG_PREFIX))
        .map(e => e.name),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: true, slugs: [] };
    }
    // Privacy note: err carries the base path only — never account slugs.
    logger.warn({ err: error }, 'Google account discovery failed; treating account list as unknown');
    return { ok: false };
  }
}

export type MicrosoftAccountDiscoveryResult =
  | { ok: true; emails: string[] }
  | { ok: false };

/**
 * Discover connected Microsoft accounts from the microsoft-mcp accounts file.
 *
 * Discriminated result (parity with discoverGoogleAccounts): a MISSING file
 * (ENOENT — never connected) means legitimately zero accounts
 * (`ok: true, emails: []`); every OTHER failure (corrupt/unparseable file,
 * EACCES, EMFILE, …) returns `ok: false` so each caller decides what a FAILED
 * discovery means rather than silently collapsing to "no Microsoft accounts"
 * — the same dangerous "failed read becomes no accounts" class
 * discoverGoogleAccounts (above) was hardened against. The Stage-3/F2 fix made
 * the failure observable (log + ENOENT-narrow); this completes the parity by
 * making it caller-distinguishable. (Privacy: err carries the path only, never
 * account emails.)
 */
async function discoverMicrosoftAccounts(): Promise<MicrosoftAccountDiscoveryResult> {
  const accountsPath = path.join(getUserDataPath(), 'microsoft-mcp', 'accounts.json');
  try {
    const data = await fs.readFile(accountsPath, 'utf-8');
    const { accounts } = JSON.parse(data) as { accounts: MicrosoftAccount[] };
    return { ok: true, emails: accounts?.map(a => a.email) || [] };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { ok: true, emails: [] };
    }
    logger.warn({ err: error }, 'Microsoft account discovery failed; treating account list as unknown');
    return { ok: false };
  }
}

export async function listGoogleCalendars(accountSlug: string): Promise<GoogleCalendarListResult> {
  const auth = await getGoogleAccessToken(accountSlug);
  if (!auth.ok) {
    return {
      ok: false,
      reason: auth.reason,
      needsReconnect: auth.reason === 'reauth_required',
    };
  }

  const calendars: AvailableCalendar[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      showHidden: 'false',
      showDeleted: 'false',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/users/me/calendarList?${params}`,
      { headers: { Authorization: `Bearer ${auth.token}` } }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google Calendar list API error: ${response.status} ${error}`);
    }

    const data = await response.json() as GoogleCalendarListResponse;
    if (data.items) {
      for (const calendar of data.items) {
        if (!calendar.id) continue;
        if (calendar.accessRole !== 'reader'
          && calendar.accessRole !== 'writer'
          && calendar.accessRole !== 'owner') {
          continue;
        }

        calendars.push({
          id: calendar.id,
          name: calendar.summary || calendar.id,
          isPrimary: calendar.primary === true,
          provider: 'google',
          accountEmail: auth.email,
        });
      }
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  logger.info({ accountSlug, email: auth.email, count: calendars.length }, 'Listed Google calendars');
  return {
    ok: true,
    calendars,
  };
}

export async function listMicrosoftCalendars(email: string): Promise<AvailableCalendar[]> {
  const calendars: AvailableCalendar[] = [];
  let nextLink: string | undefined =
    'https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,color,isDefaultCalendar,canEdit,owner';

  while (nextLink) {
    const response = await fetchMicrosoftGraph(nextLink, email);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Microsoft Graph calendar list API error: ${response.status} ${error}`);
    }

    const data = await response.json() as MicrosoftCalendarListResponse;
    if (data.value) {
      for (const calendar of data.value) {
        if (!calendar.id) continue;
        calendars.push({
          id: calendar.id,
          name: calendar.name || calendar.id,
          isPrimary: calendar.isDefaultCalendar === true,
          provider: 'microsoft',
          accountEmail: email,
        });
      }
    }

    nextLink = data['@odata.nextLink'];
  }

  logger.info({ email, count: calendars.length }, 'Listed Microsoft calendars');
  return calendars;
}

export async function discoverAllCalendarAccounts(): Promise<DiscoveredCalendarAccount[]> {
  const accounts: DiscoveredCalendarAccount[] = [];

  // Failed discovery (ok: false) degrades to "no Google accounts listed" here —
  // same surface behavior as the pre-discriminated code; only the sweep treats
  // the two cases differently.
  const googleDiscovery = await discoverGoogleAccounts();
  const googleAccountSlugs = googleDiscovery.ok ? googleDiscovery.slugs : [];
  for (const accountSlug of googleAccountSlugs) {
    const account = await readPrimaryGoogleAccount(accountSlug);
    if (!account) continue;
    const refreshState = oauthRefreshFailureStore.getStateForSlug(accountSlug);

    accounts.push({
      calendarSource: `google:${account.email}`,
      provider: 'google',
      email: account.email,
      accountSlug,
      needsReconnect: refreshState?.needsReconnect === true,
    });
  }

  // Failed Microsoft discovery (ok: false) degrades to "no Microsoft accounts
  // listed" here — same surface behavior as the pre-discriminated code (no
  // Microsoft sweep to gate, unlike Google); the discriminated result just
  // makes the failure caller-distinguishable.
  const microsoftDiscovery = await discoverMicrosoftAccounts();
  const microsoftEmails = microsoftDiscovery.ok ? microsoftDiscovery.emails : [];
  for (const email of microsoftEmails) {
    accounts.push({
      calendarSource: `microsoft:${email}`,
      provider: 'microsoft',
      email,
    });
  }

  return accounts;
}

/**
 * Fetch events from Google Calendar API with pagination
 */
async function fetchGoogleCalendarEvents(
  accessToken: string,
  email: string,
  calendarId: string = 'primary'
): Promise<GoogleCalendarEvent[]> {
  const now = new Date();
  const timeMin = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const allEvents: GoogleCalendarEvent[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      maxResults: '250', // Max allowed by Google
      singleEvents: 'true',
      orderBy: 'startTime',
      conferenceDataVersion: '1',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google Calendar API error: ${response.status} ${error}`);
    }

    const data = await response.json();
    if (data.items) allEvents.push(...data.items);
    pageToken = data.nextPageToken;
  } while (pageToken);

  logger.info({ email, calendarId, count: allEvents.length }, 'Fetched Google Calendar events');
  return allEvents;
}

/**
 * Fetch events from Microsoft Graph API with pagination.
 * Uses fetchMicrosoftGraph for automatic token management and 401 retry.
 */
async function fetchMicrosoftCalendarEvents(
  email: string,
  calendarId?: string
): Promise<MicrosoftCalendarEvent[]> {
  const now = new Date();
  const startDateTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const endDateTime = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const allEvents: MicrosoftCalendarEvent[] = [];
  const calendarPath = calendarId
    ? `me/calendars/${calendarId}/calendarView`
    : 'me/calendarView';
  let nextLink: string | undefined = `https://graph.microsoft.com/v1.0/${calendarPath}?startDateTime=${encodeURIComponent(startDateTime)}&endDateTime=${encodeURIComponent(endDateTime)}&$top=100&$orderby=start/dateTime`;

  // Ask Graph to return start/end datetimes in UTC explicitly. Without this,
  // calendarView returns times in the user's mailbox timezone but formats them
  // as naive ISO strings (no 'Z' or offset suffix), which downstream `new Date()`
  // parsers interpret as local time. See normalizeMsDateTime below.
  // https://learn.microsoft.com/en-us/graph/api/user-list-calendarview
  const msGraphInit: RequestInit = {
    headers: { 'Prefer': 'outlook.timezone="UTC"' },
  };

  while (nextLink) {
    const response = await fetchMicrosoftGraph(nextLink, email, msGraphInit);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Microsoft Graph API error: ${response.status} ${error}`);
    }

    const data = await response.json();
    if (data.value) allEvents.push(...data.value);
    nextLink = data['@odata.nextLink'];
  }

  logger.info({ email, calendarId, count: allEvents.length }, 'Fetched Microsoft Calendar events');
  return allEvents;
}

// URL extraction patterns
const MEETING_URL_PATTERNS = [
  /https:\/\/[\w.-]*zoom\.us\/[^\s<>"')}\]]+/gi,
  /https:\/\/meet\.google\.com\/[a-z-]+/gi,
  /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"')}\]]+/gi,
  /https:\/\/teams\.live\.com\/meet\/[^\s<>"')}\]]+/gi,
  /https:\/\/[\w.-]*\.webex\.com\/[^\s<>"')}\]]+/gi,
  /https:\/\/[\w.-]*\.chime\.aws\/[^\s<>"')}\]]+/gi,
  /https:\/\/app\.gather\.town\/[^\s<>"')}\]]+/gi,
];

function cleanMeetingUrl(url: string): string {
  return url.trim().replace(/[.,;)>\]]+$/, '');
}

function extractMeetingUrlFromText(texts: (string | undefined)[]): string | undefined {
  const combined = texts.filter(Boolean).join(' ');
  for (const pattern of MEETING_URL_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(combined);
    if (match) return cleanMeetingUrl(match[0]);
  }
  return undefined;
}

function extractMeetingUrlFromGoogle(event: GoogleCalendarEvent): string | undefined {
  // 1. Check conferenceData for video entry
  const videoEntry = event.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video');
  if (videoEntry?.uri) return videoEntry.uri;

  // 2. Check hangoutLink
  if (event.hangoutLink) return event.hangoutLink;

  // 3. Scan location and description
  return extractMeetingUrlFromText([event.location, event.description]);
}

function extractMeetingUrlFromMicrosoft(event: MicrosoftCalendarEvent): string | undefined {
  // 1. Check onlineMeeting.joinUrl
  if (event.onlineMeeting?.joinUrl) return event.onlineMeeting.joinUrl;

  // 2. Scan location and body
  return extractMeetingUrlFromText([event.location?.displayName, event.bodyPreview]);
}

function isAcceptedResponse(response: string | undefined): boolean {
  if (!response) return false;
  const normalized = response.toLowerCase();
  return normalized === 'accepted' || normalized === 'organizer';
}

/**
 * Per-sync counters tracking why events were excluded from the meeting cache.
 * Surfaced via structured logs at sync completion so silent drops become
 * observable. See REBEL-5CG / FOX-3250 — pre-cache drops are invisible
 * everywhere (no bot, no history, no missed), so aggregate observability is
 * the only signal we have without per-event traces.
 */
export interface SyncDropReasonCounters {
  dropped_cancelled: number;
  dropped_not_self_attendee: number;
  dropped_not_accepted: number;
  dropped_not_creator: number;
  dropped_unknown: number;
}

function createDropReasonCounters(): SyncDropReasonCounters {
  return {
    dropped_cancelled: 0,
    dropped_not_self_attendee: 0,
    dropped_not_accepted: 0,
    dropped_not_creator: 0,
    dropped_unknown: 0,
  };
}

function totalDrops(counters: SyncDropReasonCounters): number {
  return counters.dropped_cancelled
    + counters.dropped_not_self_attendee
    + counters.dropped_not_accepted
    + counters.dropped_not_creator
    + counters.dropped_unknown;
}

function googleEventToMeeting(
  event: GoogleCalendarEvent,
  email: string,
  calendarId?: string,
  dropReasons?: SyncDropReasonCounters,
): CachedMeeting | null {
  if (event.status === 'cancelled') {
    if (dropReasons) dropReasons.dropped_cancelled++;
    return null;
  }

  const emailLower = email.toLowerCase();

  // The user organised/created this meeting — Google sometimes omits the
  // organizer from the attendees array, especially when the event was created
  // via an external tool/integration or imported from another calendar
  // (REBEL-5CG / FOX-3250). Check organizer/creator first, independent of
  // attendees presence. Only exclude if the user explicitly declined.
  const isOrganizerOrCreator =
    event.creator?.self === true
    || event.organizer?.self === true
    || event.creator?.email?.toLowerCase() === emailLower
    || event.organizer?.email?.toLowerCase() === emailLower;

  if (isOrganizerOrCreator) {
    const selfAttendee = event.attendees?.find(a => a.self)
      ?? event.attendees?.find(a => a.email?.toLowerCase() === emailLower);
    if (selfAttendee?.responseStatus?.toLowerCase() === 'declined') {
      if (dropReasons) dropReasons.dropped_not_accepted++;
      return null;
    }
    // Include — the user organises this.
  } else if (event.attendees && event.attendees.length > 0) {
    const selfAttendee = event.attendees.find(a => a.self)
      ?? event.attendees.find(a => a.email?.toLowerCase() === emailLower);
    if (!selfAttendee) {
      if (dropReasons) dropReasons.dropped_not_self_attendee++;
      return null;
    }
    if (!isAcceptedResponse(selfAttendee.responseStatus)) {
      if (dropReasons) dropReasons.dropped_not_accepted++;
      return null;
    }
  } else {
    // No attendees and no creator/organizer match. If creator/organizer fields
    // are set (someone else owns it — shared/subscribed calendar event),
    // exclude. If neither is set, treat as a personal block (all-day reminders,
    // simple blocks) and include.
    const hasCreatorOrOrganizer = event.creator || event.organizer;
    if (hasCreatorOrOrganizer) {
      if (dropReasons) dropReasons.dropped_not_creator++;
      return null;
    }
  }

  const participants = event.attendees
    ?.filter(a => !a.self && (a.displayName || a.email))
    .map(a => {
      if (a.displayName) return a.displayName;
      if (!a.email) {
        throw new Error('Google attendee missing email despite attendee filter');
      }
      return a.email.split('@')[0];
    })
    .slice(0, 10) || [];

  const participantEmails = event.attendees
    ?.filter(a => !a.self && a.email && isAcceptedResponse(a.responseStatus))
    .map(a => {
      if (!a.email) {
        throw new Error('Google attendee missing email despite attendee filter');
      }
      return a.email.toLowerCase();
    })
    .slice(0, 10) || [];

  return {
    id: `google:${event.id}`,
    calendarEventId: event.id,
    calendarSource: `google:${email}`,
    ...(calendarId ? { calendarId } : {}),
    title: event.summary || '(No title)',
    startTime: event.start?.dateTime || event.start?.date || '',
    endTime: event.end?.dateTime || event.end?.date || '',
    meetingUrl: extractMeetingUrlFromGoogle(event),
    participants,
    participantEmails,
    colorId: event.colorId,
  };
}

/**
 * Normalize a Microsoft Graph `dateTime` value into an unambiguous ISO 8601 instant.
 *
 * Microsoft Graph's calendarView returns naive strings like
 * `"2026-04-21T19:00:00.0000000"` (no `Z`, no offset) alongside a `timeZone`
 * field. Downstream consumers use `new Date(...)` which interprets offset-less
 * strings as local time, shifting times by the user's UTC offset.
 *
 * When the accompanying `timeZone` is `UTC` (which is what we request via the
 * `Prefer: outlook.timezone="UTC"` header), we append `Z` so the instant is
 * preserved. If the string already carries an offset or `Z` suffix, it is
 * returned unchanged. For any other timezone (unexpected given our header),
 * we log a warning and pass through the original string — preserving existing
 * behavior rather than silently guessing.
 */
function normalizeMsDateTime(dt: string | undefined, tz: string | undefined): string {
  if (!dt) return '';
  // Already has offset or Z suffix — leave as-is
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(dt)) return dt;
  // Naive string. We request UTC via `Prefer: outlook.timezone="UTC"`, so both
  // an explicit UTC `timeZone` and a missing `timeZone` should be treated as UTC.
  const normalizedTz = (tz ?? 'UTC').toUpperCase();
  if (normalizedTz === 'UTC') return dt + 'Z';
  // Non-UTC timezone (unexpected given our Prefer header). Log so it's observable,
  // then pass through. Do NOT guess: a wrong guess corrupts timestamps.
  logger.warn(
    { dateTime: dt, timeZone: tz },
    'Microsoft event datetime has non-UTC timezone; passing through unchanged',
  );
  return dt;
}

function microsoftEventToMeeting(
  event: MicrosoftCalendarEvent,
  email: string,
  calendarId?: string,
  dropReasons?: SyncDropReasonCounters,
): CachedMeeting | null {
  if (event.isCancelled) {
    if (dropReasons) dropReasons.dropped_cancelled++;
    return null;
  }

  const emailLower = email.toLowerCase();
  const isOrganizer = event.organizer?.emailAddress?.address?.toLowerCase() === emailLower;

  // Symmetric with Google (REBEL-5CG / FOX-3250): check organizer first
  // regardless of responseStatus/attendees presence. Graph normally returns
  // responseStatus.response='organizer' for the organiser, but some calendar
  // sources (delegated mailboxes, imported events, group calendars) can drop
  // it. Trust the organiser field as the source of truth.
  if (isOrganizer) {
    if (event.responseStatus?.response?.toLowerCase() === 'declined') {
      if (dropReasons) dropReasons.dropped_not_accepted++;
      return null;
    }
    // Include — the user organises this.
  } else if (event.responseStatus?.response) {
    if (!isAcceptedResponse(event.responseStatus.response)) {
      if (dropReasons) dropReasons.dropped_not_accepted++;
      return null;
    }
  } else if (event.attendees && event.attendees.length > 0) {
    const selfAttendee = event.attendees.find(
      a => a.emailAddress?.address?.toLowerCase() === emailLower
    );
    if (!selfAttendee) {
      if (dropReasons) dropReasons.dropped_not_self_attendee++;
      return null;
    }
    if (!isAcceptedResponse(selfAttendee.status?.response)) {
      if (dropReasons) dropReasons.dropped_not_accepted++;
      return null;
    }
  } else {
    // No organizer match, no responseStatus, no attendees — shared/subscribed
    // calendar event with no relationship to the user. Exclude.
    if (dropReasons) dropReasons.dropped_not_creator++;
    return null;
  }

  const participants = event.attendees
    ?.filter(a => {
      const addr = a.emailAddress?.address?.toLowerCase();
      return addr !== email.toLowerCase() && (a.emailAddress?.name || addr);
    })
    .map(a => {
      const name = a.emailAddress?.name;
      if (name) return name;
      const address = a.emailAddress?.address;
      if (!address) {
        throw new Error('Microsoft attendee missing address despite attendee filter');
      }
      return address.split('@')[0];
    })
    .slice(0, 10) || [];

  const participantEmails = event.attendees
    ?.filter(a => a.emailAddress?.address
      && a.emailAddress.address.toLowerCase() !== email.toLowerCase()
      && isAcceptedResponse(a.status?.response))
    .map(a => {
      const address = a.emailAddress?.address;
      if (!address) {
        throw new Error('Microsoft attendee missing address despite attendee filter');
      }
      return address.toLowerCase();
    })
    .slice(0, 10) || [];

  // Microsoft uses categories for colors - store first category as colorId
  const colorId = event.categories?.[0];

  return {
    id: `microsoft:${event.id}`,
    calendarEventId: event.id,
    calendarSource: `microsoft:${email}`,
    ...(calendarId ? { calendarId } : {}),
    title: event.subject || '(No title)',
    startTime: normalizeMsDateTime(event.start?.dateTime, event.start?.timeZone),
    endTime: normalizeMsDateTime(event.end?.dateTime, event.end?.timeZone),
    meetingUrl: extractMeetingUrlFromMicrosoft(event),
    participants,
    participantEmails,
    colorId,
  };
}

function deduplicateMeetings(meetings: CachedMeeting[]): CachedMeeting[] {
  const seen = new Map<string, CachedMeeting>();
  
  for (const meeting of meetings) {
    const key = `${meeting.title}|${meeting.startTime}`;
    const existing = seen.get(key);
    
    if (!existing) {
      seen.set(key, meeting);
    } else if (!existing.meetingUrl && meeting.meetingUrl) {
      // Prefer the one with a meeting URL
      seen.set(key, meeting);
    }
  }
  
  return Array.from(seen.values());
}

function getSelectedCalendarIds(
  selectedCalendars: Record<string, string[]> | undefined,
  calendarSource: string
): string[] {
  const configuredCalendarIds = selectedCalendars?.[calendarSource]
    ?.filter(calendarId => calendarId.trim().length > 0);

  return configuredCalendarIds && configuredCalendarIds.length > 0
    ? configuredCalendarIds
    : [];
}

/**
 * Reauth-skip notice for `DirectSyncResult.errors`/reauthSkips ONLY — this
 * string embeds the account slug and must stay unpersisted and unlogged
 * (counts only). The transient class is now a typed `auth_transient`
 * SyncIssue at the persisted chokepoint (Stage 2, 260611_calendar-followups).
 */
function buildGoogleReauthSkipNotice(accountSlug: string, emailDomain?: string): string {
  const accountDescriptor = emailDomain ? `Google account ${emailDomain}` : 'Google account';
  return `${accountSlug}: ${accountDescriptor} needs to reconnect`;
}

export interface DirectSyncResult {
  meetings: CachedMeeting[];
  syncedAt: string;
  googleAccounts: number;
  microsoftAccounts: number;
  /**
   * Operational issue strings for this run: the persisted cache warnings PLUS
   * needs-reconnect skip notices ([GPT-F1] split — reauth skips are visible
   * here but never persisted). Strings may embed account slugs: log COUNTS
   * only, never the strings themselves (scoped-logger warn/error lines
   * forward to Sentry as breadcrumbs).
   */
  errors: string[];
  /**
   * Accounts skipped because their refresh token is latched needs-reconnect.
   * Operational telemetry only — deliberately NOT persisted as cache
   * syncWarnings: `oauthRefreshHealth` is the single needs-reconnect channel
   * (Stage 4, 260611_calendar-cache-attention).
   */
  reauthRequiredAccounts: number;
}

/**
 * Read the Google Workspace server names present in the MCP config — the
 * orphan sweep's keep-set ([RS-F3], 260611_calendar-cache-attention).
 *
 * Orphanhood is defined against MCP CONFIG entries (the universe the
 * connectors panel can act on), NOT discovered credential dirs: a ghost dir
 * surviving a failed `rm -rf` after disconnect would otherwise re-latch a
 * config-less account forever that no panel row can clear.
 *
 * Deliberately NOT `describeMcpConfiguration()` ([Confirm-F1] — heavy:
 * resolver/router/metadata paths); this mirrors `extractServerRecord()`'s
 * config-extraction rules directly so non-`mcpServers` config shapes are
 * honored. Fail-closed: any doubt about the keep-set (no config path
 * configured, unreadable/unparseable file) returns `ok: false` and the sweep
 * is skipped for this cycle. A MISSING config file is legitimately zero
 * entries (config writes are atomic — the file is never absent mid-write).
 */
async function readGoogleWorkspaceConfigServerNames(): Promise<
  { ok: true; keepSlugs: string[] } | { ok: false }
> {
  try {
    const configPath = resolveMcpConfigPath(getSettings());
    if (!configPath) {
      return { ok: false };
    }

    let raw: string;
    try {
      raw = await fs.readFile(configPath, 'utf-8');
    } catch (error) {
      if (isMissingFileError(error)) {
        return { ok: true, keepSlugs: [] };
      }
      return { ok: false };
    }

    const record = extractServerRecord(JSON.parse(raw), configPath, new Map());
    return {
      ok: true,
      keepSlugs: Object.keys(record).filter((name) => name.startsWith(GOOGLE_WORKSPACE_SLUG_PREFIX)),
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Orphan-latch sweep (Stage 2, 260611_calendar-cache-attention): remove
 * persisted needs-reconnect/backoff entries whose account has no MCP config
 * entry. Backstop for the disconnect/connect chokepoint clears — heals
 * pre-fix damage (disconnected account, surviving latch) and any future
 * missed-clear regression. Rides every sync cycle: idempotent and cheap.
 *
 * MUST only be called when account discovery succeeded ([RS-F1]) — on failed
 * discovery the machine state is unknown and sweeping is unsafe.
 */
/**
 * Tripwire noise damping (Stage 4 routed suggestion): a persistent ghost dir
 * re-latches and gets re-swept every 15-min cycle forever — without damping
 * the [DA-F1] warn would fire identically each cycle. In-memory, per-session:
 * warn when the removed count CHANGES, stay quiet while it repeats, re-arm
 * after a clean (zero-removal) cycle so a fresh episode warns again.
 */
let lastSweepWarnRemovedCount: number | null = null;

async function sweepOrphanedGoogleLatches(): Promise<void> {
  const keepSet = await readGoogleWorkspaceConfigServerNames();
  if (!keepSet.ok) {
    logger.debug('Skipping orphan latch sweep: MCP config keep-set unavailable');
    return;
  }

  // All async reads are complete; the store call is one synchronous
  // read-modify-write — no awaits between its read and write [RS-F2].
  const removedCount = oauthRefreshFailureStore.removeOrphanedSlugs(
    GOOGLE_WORKSPACE_SLUG_PREFIX,
    keepSet.keepSlugs,
  );

  if (removedCount > 0) {
    if (removedCount !== lastSweepWarnRemovedCount) {
      lastSweepWarnRemovedCount = removedCount;
      // Tripwire [DA-F1]: the removal chokepoint should have cleared these at
      // disconnect time — a recurring non-zero count here means that wiring
      // regressed. Counts + provider only; NEVER slugs (scoped-logger warns
      // forward to Sentry as breadcrumbs — see the comment near the top of
      // getGoogleAccessToken's catch).
      logger.warn(
        { removedCount, provider: 'GoogleWorkspace' },
        'Swept orphaned OAuth refresh latches with no MCP config entry (removal chokepoint should have cleared these)',
      );
    } else {
      logger.debug(
        { removedCount, provider: 'GoogleWorkspace' },
        'Orphan latch sweep removed entries again (identical count — tripwire warn damped this cycle)',
      );
    }
  } else {
    lastSweepWarnRemovedCount = null;
  }
}

/**
 * Perform direct calendar sync - fetches from Google and Microsoft APIs directly
 */
export async function performDirectCalendarSync(): Promise<DirectSyncResult> {
  // Marked at attempt START (Stage 3 fresh-profile gate, B1): a sync that
  // throws before the cache write must still read as attempted, so the
  // health check's populatedAt-null warn stays a true positive.
  markCalendarSyncAttempted();
  const startTime = Date.now();
  const meetings: CachedMeeting[] = [];
  // Persisted-vs-operational split ([GPT-F1], Stage 4):
  // - cacheIssues → setCachedMeetings → meeting-cache syncIssues (+ derived
  //   display-safe syncWarnings strings) → calendarCacheHealth. Self-healing
  //   classes only: transient auth backoff + thrown per-account/per-calendar
  //   sync errors. Typed construction via makeSyncIssue — raw emails,
  //   calendar ids, and slugs are dropped/scrubbed at construction (Stage 2,
  //   260611_calendar-followups).
  // - reauthSkips → operational telemetry ONLY (DirectSyncResult + log
  //   counts). The latched needs-reconnect condition is owned end-to-end by
  //   oauthRefreshFailureStore → oauthRefreshHealth → connectors panel; a
  //   second persisted channel here re-toasted at every launch and blamed
  //   the (healthy) calendar cache.
  const cacheIssues: SyncIssue[] = [];
  const reauthSkips: string[] = [];
  const dropReasons = createDropReasonCounters();
  const settings = getSettings();
  const selectedCalendars = settings.calendar?.selectedCalendars;

  // Discover accounts
  const googleDiscovery = await discoverGoogleAccounts();
  const googleAccountSlugs = googleDiscovery.ok ? googleDiscovery.slugs : [];
  const microsoftDiscovery = await discoverMicrosoftAccounts();
  const microsoftEmails = microsoftDiscovery.ok ? microsoftDiscovery.emails : [];

  logger.info({
    googleAccounts: googleAccountSlugs.length,
    microsoftAccounts: microsoftEmails.length,
    googleDiscoveryOk: googleDiscovery.ok,
    microsoftDiscoveryOk: microsoftDiscovery.ok,
  }, 'Starting direct calendar sync');

  // Orphan-latch sweep — only when discovery succeeded [RS-F1]: a transient
  // FS failure (EMFILE etc.) must never look like "all accounts gone".
  if (googleDiscovery.ok) {
    await sweepOrphanedGoogleLatches();
  }

  // Fetch from Google accounts
  for (const slug of googleAccountSlugs) {
    try {
      const auth = await getGoogleAccessToken(slug);
      if (!auth.ok) {
        if (auth.reason === 'no_account') {
          continue;
        }
        if (auth.reason === 'reauth_required') {
          reauthSkips.push(buildGoogleReauthSkipNotice(slug, auth.emailDomain));
        } else {
          cacheIssues.push(makeSyncIssue({
            kind: 'auth_transient',
            provider: 'google',
            connector: 'GoogleWorkspace',
            accountRef: auth.emailDomain,
          }));
        }
        continue;
      }

      const calendarSource = `google:${auth.email}`;
      const configuredCalendarIds = getSelectedCalendarIds(selectedCalendars, calendarSource);
      const calendarIds = configuredCalendarIds.length > 0 ? configuredCalendarIds : ['primary'];

      // Fetch color palette on first successful auth (non-blocking)
      fetchGoogleColorPalette(auth.token).catch(() => {});

      for (const calendarId of calendarIds) {
        try {
          const events = await fetchGoogleCalendarEvents(auth.token, auth.email, calendarId);
          for (const event of events) {
            const meeting = googleEventToMeeting(event, auth.email, calendarId, dropReasons);
            if (meeting) meetings.push(meeting);
          }
        } catch (error) {
          const issue = makeSyncIssue({
            kind: 'calendar_fetch_failed' as const,
            provider: 'google' as const,
            connector: 'GoogleWorkspace' as const,
            detail: error instanceof Error ? error.message : String(error),
            cause: classifySyncErrorCause(error),
          });
          // Providers + SCRUBBED detail only — raw err.message and the
          // account email/calendar id can embed addresses, and scoped-logger
          // warn/error lines forward to Sentry as breadcrumbs (see the
          // precedent comment in getGoogleAccessToken's catch).
          logger.warn({ provider: 'google', connector: issue.connector, detail: issue.detail }, 'Google calendar fetch failed during direct sync');
          cacheIssues.push(issue);
        }
      }
    } catch (error) {
      const issue = makeSyncIssue({
        kind: 'account_sync_failed' as const,
        provider: 'google' as const,
        connector: 'GoogleWorkspace' as const,
        detail: error instanceof Error ? error.message : String(error),
        cause: classifySyncErrorCause(error),
      });
      logger.error({ provider: 'google', connector: issue.connector, detail: issue.detail }, 'Google account sync failed during direct sync');
      cacheIssues.push(issue);
    }
  }

  // Fetch from Microsoft accounts
  for (const email of microsoftEmails) {
    try {
      const calendarSource = `microsoft:${email}`;
      const configuredCalendarIds = getSelectedCalendarIds(selectedCalendars, calendarSource);
      const calendarIds = configuredCalendarIds.length > 0
        ? configuredCalendarIds
        : [undefined];

      for (const calendarId of calendarIds) {
        try {
          const events = await fetchMicrosoftCalendarEvents(email, calendarId);
          for (const event of events) {
            const meeting = microsoftEventToMeeting(event, email, calendarId, dropReasons);
            if (meeting) meetings.push(meeting);
          }
        } catch (error) {
          const issue = makeSyncIssue({
            kind: 'calendar_fetch_failed' as const,
            provider: 'microsoft' as const,
            connector: 'Microsoft365Calendar' as const,
            detail: error instanceof Error ? error.message : String(error),
            cause: classifySyncErrorCause(error),
          });
          // Providers + scrubbed detail only — never emails/calendar ids
          // (Sentry breadcrumb channel; see getGoogleAccessToken's catch).
          logger.warn({ provider: 'microsoft', connector: issue.connector, detail: issue.detail }, 'Microsoft calendar fetch failed during direct sync');
          cacheIssues.push(issue);
        }
      }
    } catch (error) {
      const issue = makeSyncIssue({
        kind: 'account_sync_failed' as const,
        provider: 'microsoft' as const,
        connector: 'Microsoft365Calendar' as const,
        detail: error instanceof Error ? error.message : String(error),
        cause: classifySyncErrorCause(error),
      });
      logger.error({ provider: 'microsoft', connector: issue.connector, detail: issue.detail }, 'Microsoft account sync failed during direct sync');
      cacheIssues.push(issue);
    }
  }

  // Deduplicate, hydrate prepPath from on-disk prep docs, then reapply skip state
  // so explicit skip sentinels win over any disk-scanned prep path.
  const dedupedMeetings = deduplicateMeetings(meetings);
  const syncSettings = getSettings();
  const calSettings = syncSettings.calendar;
  const hydratedMeetings = await attachPrepPathsFromDisk(dedupedMeetings, syncSettings.coreDirectory);
  const finalMeetings = (calSettings?.skippedMeetingIds?.length || calSettings?.prepSkippedTitles?.length)
    ? reapplySkipState(hydratedMeetings, calSettings.skippedMeetingIds ?? [], calSettings.prepSkippedTitles ?? [])
    : hydratedMeetings;
  // Only the self-healing warning classes persist; a successful run still
  // overwrites syncIssues/syncWarnings with [] (setCachedMeetings maps
  // undefined → [] for both representations).
  setCachedMeetings(finalMeetings, cacheIssues.length > 0 ? cacheIssues : undefined, 'direct-sync');

  // Operational superset: persisted issues (as display-safe strings) +
  // reauth skips. Counts only in logs — the reauth strings embed slugs.
  const operationalIssues = [...cacheIssues.map(renderSyncIssue), ...reauthSkips];

  const duration = Date.now() - startTime;
  const totalDropped = totalDrops(dropReasons);
  logger.info({
    totalMeetings: dedupedMeetings.length,
    googleAccounts: googleAccountSlugs.length,
    microsoftAccounts: microsoftEmails.length,
    errors: operationalIssues.length,
    persistedWarnings: cacheIssues.length,
    reauthSkippedAccounts: reauthSkips.length,
    durationMs: duration,
    totalDropped,
    ...dropReasons,
  }, 'Direct calendar sync complete');

  // Surface drops at warn level for observability. Pre-cache drops are
  // otherwise invisible (no bot, no history, no missed) — see REBEL-5CG /
  // FOX-3250 postmortem. This makes Sentry breadcrumbs / log search useful
  // when users report "meeting missing from Rebel".
  if (totalDropped > 0) {
    logger.warn({
      totalDropped,
      totalMeetings: dedupedMeetings.length,
      ...dropReasons,
    }, 'Direct calendar sync excluded events from meeting cache');
  }

  return {
    meetings: dedupedMeetings,
    syncedAt: new Date().toISOString(),
    googleAccounts: googleAccountSlugs.length,
    microsoftAccounts: microsoftEmails.length,
    errors: operationalIssues,
    reauthRequiredAccounts: reauthSkips.length,
  };
}

// Export for testing
export const _testing = {
  extractMeetingUrlFromGoogle,
  extractMeetingUrlFromMicrosoft,
  extractMeetingUrlFromText,
  cleanMeetingUrl,
  googleEventToMeeting,
  microsoftEventToMeeting,
  deduplicateMeetings,
  normalizeMsDateTime,
  createDropReasonCounters,
  totalDrops,
};
