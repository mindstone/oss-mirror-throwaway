export const RECALL_DESKTOP_SDK_PACKAGE_NAME = '@recallai/desktop-sdk';
export const RECALL_DESKTOP_SDK_VERSION = '2.0.9';

/** Pinned `name@version` spec shared by the copy-command and the one-click installer. */
export const RECALL_DESKTOP_SDK_PACKAGE_SPEC =
  `${RECALL_DESKTOP_SDK_PACKAGE_NAME}@${RECALL_DESKTOP_SDK_VERSION}`;

/**
 * npm CLI args for the on-demand install. **Lifecycle scripts stay ENABLED**
 * (no `--ignore-scripts`): the SDK's `install` script (`setup.js`) is what
 * downloads the platform-native recorder binaries. `--no-save` leaves the
 * consumer's package.json untouched — that's what keeps the recorder opt-in and
 * the public-mirror dependency strip intact. Single source of truth for both
 * the displayed copy-command and the spawned argv, so they can never drift.
 */
export const RECALL_DESKTOP_SDK_INSTALL_ARGS: readonly string[] = [
  'install',
  '--no-save',
  RECALL_DESKTOP_SDK_PACKAGE_SPEC,
];

export const RECALL_DESKTOP_SDK_INSTALL_COMMAND =
  ['npm', ...RECALL_DESKTOP_SDK_INSTALL_ARGS].join(' ');
