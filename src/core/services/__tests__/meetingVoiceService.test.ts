import { describe, it, expect, vi, beforeEach } from 'vitest';

 
vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(),
}));

import { getMeetingVoiceInstructions } from '@core/services/meetingVoiceService';
import { getSettings } from '@core/services/settingsStore';

const mockGetSettings = vi.mocked(getSettings);

describe('getMeetingVoiceInstructions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes base participant voice instructions', () => {
    mockGetSettings.mockReturnValue({} as ReturnType<typeof getSettings>);
    const result = getMeetingVoiceInstructions();
    expect(result).toContain('You are speaking directly in the meeting as a participant');
    expect(result).toContain('Use first person');
  });

  it('appends default brand voice when no custom instructions', () => {
    mockGetSettings.mockReturnValue({} as ReturnType<typeof getSettings>);
    const result = getMeetingVoiceInstructions();
    expect(result).toContain('dry wit');
    expect(result).toContain('capable colleague');
  });

  it('appends custom instructions instead of brand voice when set', () => {
    mockGetSettings.mockReturnValue({
      meetingBot: { meetingVoiceInstructions: 'Be formal and use technical language.' },
    } as ReturnType<typeof getSettings>);
    const result = getMeetingVoiceInstructions();
    expect(result).toContain('Be formal and use technical language.');
    expect(result).not.toContain('dry wit');
  });

  it('falls back to brand voice for whitespace-only custom instructions', () => {
    mockGetSettings.mockReturnValue({
      meetingBot: { meetingVoiceInstructions: '   \n  ' },
    } as ReturnType<typeof getSettings>);
    const result = getMeetingVoiceInstructions();
    expect(result).toContain('dry wit');
  });

  it('truncates custom instructions exceeding 500 characters', () => {
    const longInstructions = 'A'.repeat(600);
    mockGetSettings.mockReturnValue({
      meetingBot: { meetingVoiceInstructions: longInstructions },
    } as ReturnType<typeof getSettings>);
    const result = getMeetingVoiceInstructions();
    expect(result).toContain('A'.repeat(500));
    expect(result).not.toContain('A'.repeat(501));
  });

  it('handles undefined meetingBot settings', () => {
    mockGetSettings.mockReturnValue({
      meetingBot: undefined,
    } as ReturnType<typeof getSettings>);
    const result = getMeetingVoiceInstructions();
    expect(result).toContain('capable colleague');
  });
});
