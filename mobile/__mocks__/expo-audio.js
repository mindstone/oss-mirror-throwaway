// Manual mock for expo-audio in Jest.
// The native module is not available in the test environment.

// Track the last audio mode params passed to setAudioModeAsync.
// Tests can retrieve them via __getLastAudioMode() to verify preset correctness.
let __lastAudioMode = null;

const RecordingPresets = {
  HIGH_QUALITY: {
    extension: '.m4a',
    sampleRate: 44100,
    numberOfChannels: 2,
    bitRate: 128000,
    android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
    ios: { outputFormat: 'aac ', audioQuality: 127 },
    web: { mimeType: 'audio/webm', bitsPerSecond: 128000 },
  },
  LOW_QUALITY: {
    extension: '.m4a',
    sampleRate: 44100,
    numberOfChannels: 2,
    bitRate: 64000,
  },
};

const mockRecorder = {
  id: 1,
  currentTime: 0,
  isRecording: false,
  uri: null,
  record: jest.fn(),
  stop: jest.fn().mockResolvedValue(undefined),
  pause: jest.fn(),
  getAvailableInputs: jest.fn().mockReturnValue([]),
  getCurrentInput: jest.fn().mockResolvedValue({ name: 'mic', type: 'builtin', uid: 'mic-1' }),
  setInput: jest.fn(),
  getStatus: jest.fn().mockReturnValue({ canRecord: true, isRecording: false, durationMillis: 0, mediaServicesDidReset: false, url: null }),
  prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
  startRecordingAtTime: jest.fn(),
  recordForDuration: jest.fn(),
  addListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  removeAllListeners: jest.fn(),
};

module.exports = {
  useAudioRecorder: jest.fn().mockReturnValue(mockRecorder),
  useAudioRecorderState: jest.fn().mockReturnValue({ canRecord: true, isRecording: false, durationMillis: 0, mediaServicesDidReset: false, url: null }),
  useAudioPlayer: jest.fn().mockReturnValue({}),
  useAudioPlayerStatus: jest.fn().mockReturnValue({}),
  useAudioSampleListener: jest.fn(),
  requestRecordingPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, status: 'granted' }),
  getRecordingPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, status: 'granted' }),
  setIsAudioActiveAsync: jest.fn().mockResolvedValue(undefined),
  setAudioModeAsync: jest.fn().mockImplementation((params) => {
    __lastAudioMode = params;
    return Promise.resolve(undefined);
  }),
  __getLastAudioMode: () => __lastAudioMode,
  __resetLastAudioMode: () => { __lastAudioMode = null; },
  createAudioPlayer: jest.fn().mockReturnValue({}),
  RecordingPresets,
  IOSOutputFormat: {},
  AudioQuality: { MIN: 0, LOW: 32, MEDIUM: 64, HIGH: 96, MAX: 127 },
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
};
