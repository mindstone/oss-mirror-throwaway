// Use Sentry's Expo Metro wrapper (`getSentryExpoConfig`) instead of Expo's
// bare `getDefaultConfig`. It internally calls `getDefaultConfig(projectRoot)`
// and then injects the Debug ID serializer plugin so JS bundles carry the
// Debug IDs that Sentry needs to symbolicate production JS stack traces. The
// returned config is otherwise an ordinary Expo Metro config, so the monorepo
// `watchFolders` / resolver tweaks below still apply unchanged.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '..');
const projectNodeModules = path.resolve(projectRoot, 'node_modules');
const monorepoNodeModules = path.resolve(monorepoRoot, 'node_modules');
const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\\/]/g, '[\\\\/]');
const cloudClientNodeModules = escapeForRegex(path.resolve(monorepoRoot, 'cloud-client', 'node_modules'));

const config = getSentryExpoConfig(projectRoot);

// Watch shared source directories for changes
config.watchFolders = [
  path.resolve(monorepoRoot, 'src/shared'),
  path.resolve(monorepoRoot, 'packages/shared'),
  path.resolve(monorepoRoot, 'src/core'),
  path.resolve(monorepoRoot, 'cloud-client'),
];

// Allow Metro to resolve modules from the parent's node_modules
// (for packages like zod, zustand that shared code imports)
config.resolver.nodeModulesPaths = [
  projectNodeModules,
  monorepoNodeModules,
];

// Map @shared and @core aliases for Metro resolution.
// @rebel/cloud-client points at `cloud-client/src` (not the package root) so
// scripts/check-alias-integrity.ts can enforce a single canonical location
// across all configs. Metro still follows the package.json `main` field when
// resolving — pointing at `src` is a strict subset of that behaviour.
config.resolver.extraNodeModules = {
  '@shared': path.resolve(monorepoRoot, 'src/shared'),
  '@rebel/shared': path.resolve(monorepoRoot, 'packages/shared/src'),
  '@core': path.resolve(monorepoRoot, 'src/core'),
  '@rebel/cloud-client': path.resolve(monorepoRoot, 'cloud-client/src'),
  react: path.resolve(projectNodeModules, 'react'),
  'react-native': path.resolve(projectNodeModules, 'react-native'),
  zustand: path.resolve(projectNodeModules, 'zustand'),
};

config.resolver.blockList = [
  new RegExp(`${cloudClientNodeModules}[\\\\/](react|zustand)[\\\\/].*`),
];

// Support npm file: dependencies that are symlinked outside the app root
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
