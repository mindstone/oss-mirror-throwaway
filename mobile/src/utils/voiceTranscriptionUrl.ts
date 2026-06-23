export function buildVoiceTranscriptionUrl(
  cloudUrl: string,
  params: {
    sessionId?: string | null;
    durationMs?: number | null;
  },
): string {
  const searchParams = new URLSearchParams();
  if (params.sessionId) {
    searchParams.set('sessionId', params.sessionId);
  }
  if (
    typeof params.durationMs === 'number'
    && Number.isFinite(params.durationMs)
    && params.durationMs > 0
  ) {
    searchParams.set('durationMs', String(Math.round(params.durationMs)));
  }

  const queryString = searchParams.toString();
  const baseUrl = cloudUrl.replace(/\/+$/, '');
  return `${baseUrl}/api/voice/transcribe${queryString ? `?${queryString}` : ''}`;
}
