// Manual mock for expo-file-system/legacy in Jest.
// Provides uploadAsync and FileSystemUploadType for native file upload tests.

const FileSystemUploadType = {
  BINARY_CONTENT: 0,
  MULTIPART: 1,
};

module.exports = {
  uploadAsync: jest.fn().mockResolvedValue({ status: 200, headers: {}, body: '{}' }),
  FileSystemUploadType,
  // Re-export standard helpers from the base mock for compatibility
  ...require('./index'),
};
