import { describe, it, expect } from 'vitest';
import {
  isYouTubeUrl,
  isVimeoUrl,
  isTwitchUrl,
  isTikTokUrl,
  isSpotifyUrl,
  isSoundCloudUrl,
  isVideoFileUrl,
  isAudioFileUrl,
  isEmbeddableMediaUrl,
  getMediaType,
  extractYouTubeId,
} from '../../utils/youtubeUtils';

describe('YouTube URL detection', () => {
  it('detects youtube.com/watch URLs', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isYouTubeUrl('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
  });

  it('detects youtu.be short URLs', () => {
    expect(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
  });

  it('detects youtube.com/shorts URLs', () => {
    expect(isYouTubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(true);
  });

  it('detects youtube.com/embed URLs', () => {
    expect(isYouTubeUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(true);
  });

  it('detects youtube.com/live URLs', () => {
    expect(isYouTubeUrl('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe(true);
  });

  it('rejects non-YouTube URLs', () => {
    expect(isYouTubeUrl('https://vimeo.com/123456')).toBe(false);
    expect(isYouTubeUrl('https://example.com')).toBe(false);
  });
});

describe('Vimeo URL detection', () => {
  it('detects vimeo.com URLs', () => {
    expect(isVimeoUrl('https://vimeo.com/123456789')).toBe(true);
    expect(isVimeoUrl('https://vimeo.com/channels/staffpicks/123456')).toBe(true);
  });

  it('rejects non-Vimeo URLs', () => {
    expect(isVimeoUrl('https://youtube.com/watch?v=abc')).toBe(false);
  });
});

describe('Twitch URL detection', () => {
  it('detects twitch.tv channel URLs', () => {
    expect(isTwitchUrl('https://www.twitch.tv/ninja')).toBe(true);
    expect(isTwitchUrl('https://twitch.tv/shroud')).toBe(true);
  });

  it('detects twitch.tv video URLs', () => {
    expect(isTwitchUrl('https://www.twitch.tv/videos/123456789')).toBe(true);
  });

  it('rejects non-Twitch URLs', () => {
    expect(isTwitchUrl('https://youtube.com/watch?v=abc')).toBe(false);
  });
});

describe('TikTok URL detection', () => {
  it('detects tiktok.com video URLs', () => {
    expect(isTikTokUrl('https://www.tiktok.com/@user/video/1234567890123456789')).toBe(true);
  });

  it('rejects non-TikTok URLs', () => {
    expect(isTikTokUrl('https://youtube.com/watch?v=abc')).toBe(false);
  });
});

describe('Spotify URL detection', () => {
  it('detects open.spotify.com URLs', () => {
    expect(isSpotifyUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')).toBe(true);
    expect(isSpotifyUrl('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3')).toBe(true);
    expect(isSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toBe(true);
  });

  it('rejects non-Spotify URLs', () => {
    expect(isSpotifyUrl('https://youtube.com/watch?v=abc')).toBe(false);
  });
});

describe('SoundCloud URL detection', () => {
  it('detects soundcloud.com URLs', () => {
    expect(isSoundCloudUrl('https://soundcloud.com/artist/track-name')).toBe(true);
  });

  it('rejects non-SoundCloud URLs', () => {
    expect(isSoundCloudUrl('https://youtube.com/watch?v=abc')).toBe(false);
  });
});

describe('Video file URL detection', () => {
  it('detects common video file extensions', () => {
    expect(isVideoFileUrl('https://example.com/video.mp4')).toBe(true);
    expect(isVideoFileUrl('https://example.com/video.webm')).toBe(true);
    expect(isVideoFileUrl('https://example.com/video.mov')).toBe(true);
    expect(isVideoFileUrl('https://example.com/video.m4v')).toBe(true);
  });

  it('handles query strings', () => {
    expect(isVideoFileUrl('https://example.com/video.mp4?token=abc')).toBe(true);
  });

  it('rejects non-video URLs', () => {
    expect(isVideoFileUrl('https://youtube.com/watch?v=abc')).toBe(false);
    expect(isVideoFileUrl('https://example.com/image.png')).toBe(false);
  });
});

describe('Audio file URL detection', () => {
  it('detects common audio file extensions', () => {
    expect(isAudioFileUrl('https://example.com/audio.mp3')).toBe(true);
    expect(isAudioFileUrl('https://example.com/audio.wav')).toBe(true);
    expect(isAudioFileUrl('https://example.com/audio.m4a')).toBe(true);
    expect(isAudioFileUrl('https://example.com/audio.aac')).toBe(true);
  });

  it('rejects non-audio URLs', () => {
    expect(isAudioFileUrl('https://example.com/video.mp4')).toBe(false);
  });
});

describe('isEmbeddableMediaUrl', () => {
  it('returns true for all supported media types', () => {
    expect(isEmbeddableMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isEmbeddableMediaUrl('https://vimeo.com/123456789')).toBe(true);
    expect(isEmbeddableMediaUrl('https://www.twitch.tv/ninja')).toBe(true);
    expect(isEmbeddableMediaUrl('https://open.spotify.com/track/abc')).toBe(true);
    expect(isEmbeddableMediaUrl('https://example.com/video.mp4')).toBe(true);
    expect(isEmbeddableMediaUrl('https://example.com/audio.mp3')).toBe(true);
  });

  it('returns false for non-media URLs', () => {
    expect(isEmbeddableMediaUrl('https://google.com')).toBe(false);
    expect(isEmbeddableMediaUrl('https://example.com/page.html')).toBe(false);
  });
});

describe('extractYouTubeId', () => {
  it('extracts ID from standard watch URL', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts ID from short URL', () => {
    expect(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts ID from shorts URL', () => {
    expect(extractYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts ID from embed URL', () => {
    expect(extractYouTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts ID from live URL', () => {
    expect(extractYouTubeId('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts ID from URL with timestamp', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=60')).toBe('dQw4w9WgXcQ');
  });

  it('extracts ID from short URL with timestamp', () => {
    expect(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ?t=123')).toBe('dQw4w9WgXcQ');
  });

  it('extracts ID from URL with extra params', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxyz')).toBe('dQw4w9WgXcQ');
  });

  it('extracts ID containing hyphens and underscores', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=k5M4iRi-wM8')).toBe('k5M4iRi-wM8');
  });

  it('returns null for playlist-only URL', () => {
    expect(extractYouTubeId('https://youtube.com/playlist?list=PLxyz')).toBeNull();
  });

  it('returns null for user URL', () => {
    expect(extractYouTubeId('https://youtube.com/user/someuser')).toBeNull();
  });

  it('returns null for non-YouTube URL', () => {
    expect(extractYouTubeId('https://vimeo.com/123456')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractYouTubeId('')).toBeNull();
  });
});

describe('getMediaType', () => {
  it('returns correct media type for each platform', () => {
    expect(getMediaType('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube');
    expect(getMediaType('https://vimeo.com/123456789')).toBe('vimeo');
    expect(getMediaType('https://www.twitch.tv/ninja')).toBe('twitch');
    expect(getMediaType('https://open.spotify.com/track/abc')).toBe('spotify');
    expect(getMediaType('https://soundcloud.com/artist/track')).toBe('soundcloud');
    expect(getMediaType('https://example.com/video.mp4')).toBe('video');
    expect(getMediaType('https://example.com/audio.mp3')).toBe('audio');
    expect(getMediaType('https://example.com/stream.m3u8')).toBe('stream');
  });

  it('returns null for non-media URLs', () => {
    expect(getMediaType('https://google.com')).toBe(null);
  });
});
