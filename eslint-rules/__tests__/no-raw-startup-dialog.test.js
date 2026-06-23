import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rule = require('../no-raw-startup-dialog.js');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

ruleTester.run('no-raw-startup-dialog', rule, {
  valid: [
    {
      name: 'routes through the wrapper',
      code: `await showStartupMessageBox({ message: 'hi', buttons: ['OK'] });`,
    },
    {
      name: 'routes the startup-failure error box through the wrapper',
      code: `showStartupErrorBox('Rebel startup failed', 'details');`,
    },
    {
      name: 'unrelated dialog method (e.g. showOpenDialog) is not flagged',
      code: `await dialog.showOpenDialog({ properties: ['openDirectory'] });`,
    },
    {
      name: 'a same-named method on a different object is not flagged',
      code: `await notDialog.showMessageBox({ message: 'hi' });`,
    },
    {
      name: 'showErrorBox on a different object is not flagged',
      code: `notDialog.showErrorBox('Title', 'content');`,
    },
  ],
  invalid: [
    {
      name: 'raw dialog.showMessageBox is flagged',
      code: `await dialog.showMessageBox({ message: 'hi', buttons: ['OK'], cancelId: 0 });`,
      errors: [{ messageId: 'noRawStartupDialog', data: { method: 'showMessageBox', wrapper: 'showStartupMessageBox' } }],
    },
    {
      name: 'raw dialog.showMessageBoxSync is flagged',
      code: `const r = dialog.showMessageBoxSync({ message: 'hi', buttons: ['OK'] });`,
      errors: [{ messageId: 'noRawStartupDialog' }],
    },
    {
      name: 'raw dialog.showErrorBox is flagged (the chronic-hang residual this rule now closes)',
      code: `dialog.showErrorBox('Rebel startup failed', 'details');`,
      errors: [{ messageId: 'noRawStartupDialog', data: { method: 'showErrorBox', wrapper: 'showStartupErrorBox' } }],
    },
    {
      name: 'parented (2-arg) form is still flagged in the startup surface (no windows at startup)',
      code: `await dialog.showMessageBox(someWindow, { message: 'hi', buttons: ['OK'] });`,
      errors: [{ messageId: 'noRawStartupDialog' }],
    },
  ],
});
