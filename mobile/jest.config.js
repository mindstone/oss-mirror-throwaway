const jestExpoPreset = require('jest-expo/jest-preset');

module.exports = {
  ...jestExpoPreset,
  // Our setup must run BEFORE jest-expo's setup to pre-install globals
  // that Expo's winter runtime lazily initializes via require() calls
  // which can fail in Jest's module sandbox.
  setupFiles: ['./jest.setup.js', ...(jestExpoPreset.setupFiles || [])],
  testPathIgnorePatterns: ['/node_modules/', '__tests__/helpers\\.ts$', '__tests__/e2e\\.'],
  workerIdleMemoryLimit: '512MB',
  // Sibling workspace source (cloud-client) is resolved via moduleNameMapper
  // but lives outside mobile/. Without this, Babel-injected @babel/runtime
  // imports fail because Node won't look in mobile/node_modules/.
  modulePaths: ['<rootDir>/node_modules'],
  transformIgnorePatterns: [
    // remark-gfm and its transitive ESM dependencies (mdast-util-*, micromark-*,
    // unist-util-*, etc.) ship as native ESM. Jest's default CJS transform chokes
    // on `export` keywords, so we whitelist the whole remark/unified ecosystem
    // here. Pulled in via @rebel/shared/utils/markdownPipeline.
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|@rebel/cloud-client|@rebel/shared|@ronradtke/react-native-markdown-display|expo-haptics|expo-audio|expo-image-picker|expo-document-picker|expo-file-system|remark-gfm|mdast-util-.*|micromark.*|unist-util-.*|unified|bail|trough|vfile|vfile-message|is-plain-obj|decode-named-character-reference|character-entities.*|ccount|escape-string-regexp|longest-streak|markdown-table|zwitch|devlop)',
  ],
  moduleNameMapper: {
    ...jestExpoPreset.moduleNameMapper,
    // Ensure ALL code (including the sibling cloud-client workspace) resolves a single React copy.
    // Otherwise React hooks can throw "Invalid hook call" when React is loaded from both
    // mobile/node_modules and cloud-client/node_modules.
    '^react$': '<rootDir>/node_modules/react',
    '^react/(.*)$': '<rootDir>/node_modules/react/$1',
    '^@rebel/cloud-client$': '<rootDir>/../cloud-client/src/index.ts',
    '^@rebel/shared$': '<rootDir>/../packages/shared/src/index.ts',
    '^@rebel/shared/(.*)$': '<rootDir>/../packages/shared/src/$1',
    '^@shared/(.*)$': '<rootDir>/../src/shared/$1',
    '^@core/(.*)$': '<rootDir>/../src/core/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
