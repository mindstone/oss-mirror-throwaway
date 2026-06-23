export const SLACK_BOT_SCOPES = [
  'channels:history',
  'channels:read',
  'chat:write',
  'files:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'reactions:read',
  'reactions:write',
  'users:read',
] as const;

export const SLACK_USER_SCOPES = [
  'search:read',
  'channels:history',
  'channels:read',
  'channels:write',
  'channels:write.invites',
  'files:read',
  'groups:read',
  'groups:history',
  'groups:write',
  'groups:write.invites',
  'im:read',
  'im:history',
  'im:write',
  'mpim:read',
  'mpim:history',
  'mpim:write',
  'users:read',
  'users:read.email',
  'chat:write',
  'reactions:write',
  'reminders:write',
  'bookmarks:write',
] as const;

export const SLACK_BOT_SCOPE_PARAM = SLACK_BOT_SCOPES.join(',');
export const SLACK_USER_SCOPE_PARAM = SLACK_USER_SCOPES.join(',');
