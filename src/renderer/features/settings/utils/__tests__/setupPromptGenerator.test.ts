// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { generateSetupPrompt } from '../setupPromptGenerator';

describe('generateSetupPrompt for bundled-app-bridge', () => {
  const params = {
    serverName: 'Rebel Browser',
    isNewConnection: true,
    catalogEntry: {
      id: 'bundled-app-bridge',
      name: 'Rebel Browser',
      description: 'Browser extension',
      provider: 'rebel-oss',
    } as any,
  };

  it('routes setup through the deterministic prepare-install tool', async () => {
    const prompt = await generateSetupPrompt(params);

    expect(prompt).toContain('rebel_bridge_prepare_install');
    expect(prompt).toContain('browser_id');
    expect(prompt).toContain('rebel_browser_status');
    expect(prompt).not.toContain('rebel-browser-install/SKILL.md');
  });

  it('verifies with browser status after the user says the extension is loaded', async () => {
    const prompt = await generateSetupPrompt(params);

    expect(prompt).toContain('When I say the extension is loaded, done, installed, or the Rebel icon appears');
    expect(prompt).toContain('call `rebel_browser_status({})` exactly once');
    expect(prompt).toContain('Do not call `rebel_bridge_prepare_install` again');
  });

  it('does not contain any STEP N markers (anti-regression: protocol must not leak back)', async () => {
    const prompt = await generateSetupPrompt(params);

    // Structural assertion — no magic-number length guards. If the install protocol
    // ever gets re-inlined, it would contain STEP 0 / STEP 1 / STEP 2 / etc.
    expect(prompt).not.toMatch(/STEP \d/);
  });

  it('does not contain internal tool names or implementation identifiers', async () => {
    const prompt = await generateSetupPrompt(params);

    // Lower-level install tools and internal ids should not be the primary setup path.
    expect(prompt).not.toMatch(
      /pairSessionId|timeoutMs|rebel_bridge_(start_pairing|wait_pair_event|diagnose|extract_extension|reveal_extension_folder|open_extensions_page|list_browsers|check_pair_status|reset_install|end_pair_session)/
    );
  });

  it('does not re-inline anti-regression surfaces that were previously removed', async () => {
    const prompt = await generateSetupPrompt(params);

    // These were explicit anti-regressions in the prior inline prompt. Keep them
    // out of this short prompt too — their removal lives in the skill.
    expect(prompt).not.toMatch(/\bfingerprint\b/i);
    expect(prompt).not.toContain('rebel_bridge_list_pending_approvals');
    expect(prompt).not.toContain('rebel_bridge_approve_pending');
    expect(prompt).not.toMatch(/\bpair code\b/i);
  });
});
