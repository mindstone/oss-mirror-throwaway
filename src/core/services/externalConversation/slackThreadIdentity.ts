export type SlackThreadIdentityInput = {
  team?: { id?: string } | string;
  channel?: string | { id?: string };
  thread_ts?: string;
  ts?: string;
};

export type SlackThreadIdentity = {
  teamId: string;
  channelId: string;
  threadTs: string;
};

function nonEmptyString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function extractTeamId(team: SlackThreadIdentityInput['team']): string | null {
  return nonEmptyString(typeof team === 'string' ? team : team?.id);
}

function extractChannelId(channel: SlackThreadIdentityInput['channel']): string | null {
  return nonEmptyString(typeof channel === 'string' ? channel : channel?.id);
}

export function extractSlackThreadIdentity(event: SlackThreadIdentityInput): SlackThreadIdentity | null {
  const teamId = extractTeamId(event.team);
  const channelId = extractChannelId(event.channel);
  const threadTs = nonEmptyString(event.thread_ts ?? event.ts);

  if (!teamId || !channelId || !threadTs) {
    return null;
  }

  return { teamId, channelId, threadTs };
}
