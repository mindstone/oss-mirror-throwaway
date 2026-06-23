// Manual mock for expo-document-picker in Jest.
// The native module is not available in the test environment.

module.exports = {
  getDocumentAsync: jest.fn().mockResolvedValue({ canceled: true, assets: [] }),
};
