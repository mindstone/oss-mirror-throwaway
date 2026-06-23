// Manual mock for expo-file-system in Jest.
// The native module is not available in the test environment.

module.exports = {
  readAsStringAsync: jest.fn().mockResolvedValue(''),
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false, isDirectory: false }),
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  copyAsync: jest.fn().mockResolvedValue(undefined),
  moveAsync: jest.fn().mockResolvedValue(undefined),
  readDirectoryAsync: jest.fn().mockResolvedValue([]),
  downloadAsync: jest.fn().mockResolvedValue({ uri: '', status: 200, headers: {} }),
  documentDirectory: '/mock/documents/',
  cacheDirectory: '/mock/cache/',
  bundleDirectory: '/mock/bundle/',
  EncodingType: {
    UTF8: 'utf8',
    Base64: 'base64',
  },
};
