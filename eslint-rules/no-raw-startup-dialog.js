'use strict';

/**
 * no-raw-startup-dialog
 *
 * Forbids raw `dialog.showMessageBox` / `dialog.showMessageBoxSync` /
 * `dialog.showErrorBox` in the startup-dialog surface — they must go through
 * `showStartupMessageBox` / `showStartupErrorBox` (src/main/startup/startupDialog.ts).
 *
 * WHY (the `startup_modal_blocks_automated_boot` class — two prior incidents):
 * a PARENT-LESS native message box during startup becomes an app-modal
 * `[NSAlert runModal]` on the shared Electron/Chromium main thread; with no user
 * to dismiss it (automation/headless) it wedges window creation AND the
 * browser-CDP pump → Playwright's `electron.launch` never attaches → the
 * chronic-E2E publish gate hangs (~6h blocked beta). The wrapper suppresses the
 * modal in automated/headless contexts; calling `dialog.showMessageBox` directly
 * silently re-opens the class. This rule turns "forgot the wrapper" — the exact
 * failure that produced both prior incidents — into a failing lint (the genuine
 * by-construction kill; the wrapper alone is only a convention).
 *
 * SCOPE: applied (via eslint.config.mjs `files`) to the startup-dialog surface
 * (the install-hygiene services + `src/main/startup/**`), with the wrapper module
 * itself exempted. It is NOT applied repo-wide, so legitimately window-PARENTED
 * dialogs and post-startup dialogs elsewhere are unaffected.
 */
// Forbidden native dialog methods → the wrapper each must route through. All three are
// parent-less app-modal `[NSAlert runModal]` calls that wedge an automated/headless boot.
const FORBIDDEN_DIALOG_METHODS = {
  showMessageBox: 'showStartupMessageBox',
  showMessageBoxSync: 'showStartupMessageBox',
  showErrorBox: 'showStartupErrorBox',
};

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid raw dialog.showMessageBox / showMessageBoxSync / showErrorBox in the startup surface; route through showStartupMessageBox / showStartupErrorBox.',
    },
    schema: [],
    messages: {
      noRawStartupDialog:
        'Do not call dialog.{{method}} directly in the startup surface — route it through {{wrapper}} (src/main/startup/startupDialog.ts), which no-ops in automated/headless contexts. A parent-less startup modal wedges the automated/E2E boot (the chronic-E2E launch-hang class).',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (!callee || callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.object.type !== 'Identifier' || callee.object.name !== 'dialog') return;
        if (callee.property.type !== 'Identifier') return;
        const method = callee.property.name;
        const wrapper = FORBIDDEN_DIALOG_METHODS[method];
        if (!wrapper) return;
        context.report({ node, messageId: 'noRawStartupDialog', data: { method, wrapper } });
      },
    };
  },
};

module.exports = rule;
