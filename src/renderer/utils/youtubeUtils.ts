/**
 * Media URL detection utilities for react-player.
 * Pure functions with no React dependencies for easy testing.
 */

// Patterns from react-player/dist/patterns.js
const AUDIO_EXTENSIONS = /\.(m4a|m4b|mp4a|mpga|mp2|mp2a|mp3|m2a|m3a|wav|weba|aac|oga|spx)($|\?)/i;
const VIDEO_EXTENSIONS = /\.(mp4|og[gv]|webm|mov|m4v)(#t=[,\d+]+)?($|\?)/i;
const HLS_EXTENSIONS = /\.(m3u8)($|\?)/i;
const DASH_EXTENSIONS = /\.(mpd)($|\?)/i;

const MATCH_URL_YOUTUBE = /(?:youtu\.be\/|youtube(?:-nocookie|education)?\.com\/(?:embed\/|v\/|watch\/|watch\?v=|watch\?.+&v=|shorts\/|live\/))((\w|-){11})|youtube\.com\/playlist\?list=|youtube\.com\/user\//;
const MATCH_URL_VIMEO = /vimeo\.com\/(?!progressive_redirect).+/;
const MATCH_URL_TWITCH = /(?:www\.|go\.)?twitch\.tv\/([a-zA-Z0-9_]+|(videos?\/|\?video=)\d+)($|\?)/;
const MATCH_URL_TIKTOK = /tiktok\.com\/(?:player\/v1\/|share\/video\/|@[^/]+\/video\/)([0-9]+)/;
const MATCH_URL_SPOTIFY = /open\.spotify\.com\/(\w+)\/(\w+)/i;
const MATCH_URL_SOUNDCLOUD = /soundcloud\.com\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9-_]+)/;

/**
 * Detects if a URL is a valid YouTube URL.
 */
export function isYouTubeUrl(urlString: string): boolean {
  return MATCH_URL_YOUTUBE.test(urlString);
}

/**
 * Detects if a URL is a valid Vimeo URL.
 */
export function isVimeoUrl(urlString: string): boolean {
  return MATCH_URL_VIMEO.test(urlString) && !VIDEO_EXTENSIONS.test(urlString);
}

/**
 * Detects if a URL is a valid Twitch URL.
 */
export function isTwitchUrl(urlString: string): boolean {
  return MATCH_URL_TWITCH.test(urlString);
}

/**
 * Detects if a URL is a valid TikTok URL.
 */
export function isTikTokUrl(urlString: string): boolean {
  return MATCH_URL_TIKTOK.test(urlString);
}

/**
 * Detects if a URL is a valid Spotify URL.
 */
export function isSpotifyUrl(urlString: string): boolean {
  return MATCH_URL_SPOTIFY.test(urlString);
}

/**
 * Detects if a URL is a valid SoundCloud URL.
 */
export function isSoundCloudUrl(urlString: string): boolean {
  return MATCH_URL_SOUNDCLOUD.test(urlString);
}

/**
 * Detects if a URL is a direct video file.
 */
export function isVideoFileUrl(urlString: string): boolean {
  return VIDEO_EXTENSIONS.test(urlString);
}

/**
 * Detects if a URL is a direct audio file.
 */
export function isAudioFileUrl(urlString: string): boolean {
  return AUDIO_EXTENSIONS.test(urlString);
}

/**
 * Detects if a URL is an HLS stream.
 */
export function isHlsUrl(urlString: string): boolean {
  return HLS_EXTENSIONS.test(urlString);
}

/**
 * Detects if a URL is a DASH stream.
 */
export function isDashUrl(urlString: string): boolean {
  return DASH_EXTENSIONS.test(urlString);
}

/**
 * Detects if a URL can be played by react-player as an embeddable media.
 * Returns true for YouTube, Vimeo, Twitch, TikTok, Spotify, SoundCloud,
 * and direct video/audio files.
 */
export function isEmbeddableMediaUrl(urlString: string): boolean {
  return (
    isYouTubeUrl(urlString) ||
    isVimeoUrl(urlString) ||
    isTwitchUrl(urlString) ||
    isTikTokUrl(urlString) ||
    isSpotifyUrl(urlString) ||
    isSoundCloudUrl(urlString) ||
    isVideoFileUrl(urlString) ||
    isAudioFileUrl(urlString) ||
    isHlsUrl(urlString) ||
    isDashUrl(urlString)
  );
}

/**
 * Extracts the 11-character YouTube video ID from a URL.
 * Returns null for non-YouTube URLs, playlist-only URLs, or user channel URLs.
 */
export function extractYouTubeId(url: string): string | null {
  const match = url.match(MATCH_URL_YOUTUBE);
  const id = match?.[1];
  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return null;
  return id;
}

/**
 * Returns the type of media for a URL (for display/styling purposes).
 */
export function getMediaType(urlString: string): 'youtube' | 'vimeo' | 'twitch' | 'tiktok' | 'spotify' | 'soundcloud' | 'video' | 'audio' | 'stream' | null {
  if (isYouTubeUrl(urlString)) return 'youtube';
  if (isVimeoUrl(urlString)) return 'vimeo';
  if (isTwitchUrl(urlString)) return 'twitch';
  if (isTikTokUrl(urlString)) return 'tiktok';
  if (isSpotifyUrl(urlString)) return 'spotify';
  if (isSoundCloudUrl(urlString)) return 'soundcloud';
  if (isVideoFileUrl(urlString)) return 'video';
  if (isAudioFileUrl(urlString)) return 'audio';
  if (isHlsUrl(urlString) || isDashUrl(urlString)) return 'stream';
  return null;
}
