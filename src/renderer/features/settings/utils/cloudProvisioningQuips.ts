/**
 * Branded provisioning quips for managed cloud setup.
 * Maps server provisioning phases to Rebel-voice copy.
 * Primary text informs, subtext delights.
 */

export type ProvisioningQuip = {
  text: string;
  subtext: string;
};

/**
 * Phase-to-copy mapping for managed cloud provisioning.
 * Server reports raw phases; we map them to branded copy in Rebel's voice.
 */
export const MANAGED_PROVISION_PHASE_COPY: Record<string, ProvisioningQuip> = {
  creating_app: {
    text: 'Reserving your corner of the cloud',
    subtext: 'Every good address starts with a foundation',
  },
  setting_secrets: {
    text: 'Installing the locks',
    subtext: 'Military-grade, but without the paperwork',
  },
  creating_volume: {
    text: 'Setting up your archive',
    subtext: '50 GB of space. That is a lot of conversations',
  },
  creating_machine: {
    text: 'Waking up the machinery',
    subtext: 'Your personal cloud instance is stretching its legs',
  },
  configuring_network: {
    text: 'Opening the front door',
    subtext: 'Encrypted, naturally',
  },
  waiting: {
    text: 'Waiting for the paint to dry',
    subtext: 'Patience is a virtue. I have several',
  },
  health_check: {
    text: 'Running final inspections',
    subtext: 'The building inspector is also me',
  },
  complete: {
    text: 'Your cloud is ready',
    subtext: 'That was the hard part. You will not have to do it again',
  },
  failed: {
    text: 'Something went sideways',
    subtext: 'We will clean up and you can try again',
  },
};

/**
 * Extended subtext strings that rotate when a phase lingers (>15s).
 * Only the subtext changes — the primary text stays stable so the user
 * knows what's actually happening.
 */
export const EXTENDED_SUBTEXT = [
  'Rome was not built in a day. This will be faster.',
  'Good infrastructure takes a moment. Bad infrastructure takes much longer.',
  'Still here. Still working. Still me.',
  'The cloud is not rushing because I told it not to.',
  'Laying the groundwork with appropriate deliberation.',
  'Quality takes exactly this long. I checked.',
  'The servers are being cooperative, which is more than I can say for most.',
  'Your patience is noted and appreciated. The cloud\'s patience is irrelevant.',
] as const;

/**
 * Phase-to-copy mapping for cloud provider switching.
 * Tone: reassuring first, witty second — the user needs to trust the process.
 */
export const SWITCH_PHASE_COPY: Record<string, ProvisioningQuip> = {
  preflight: {
    text: 'Checking everything is in order',
    subtext: 'Measure twice, provision once',
  },
  provisioning_new: {
    text: 'Setting up your new cloud',
    subtext: 'Your current cloud is still running. Nothing to worry about',
  },
  syncing_down: {
    text: 'Bringing your data home',
    subtext: 'Every conversation, every file',
  },
  migrating_up: {
    text: 'Moving into the new place',
    subtext: 'Almost there',
  },
  cleaning_up: {
    text: 'Tidying up the old one',
    subtext: 'Leaving it better than we found it',
  },
  complete: {
    text: 'You have been switched',
    subtext: 'Same data, new home',
  },
  failed: {
    text: 'Something went wrong',
    subtext: 'Your current cloud is untouched. Try again when ready',
  },
};

const FALLBACK_QUIP: ProvisioningQuip = {
  text: 'Working on it',
  subtext: 'Something is happening and it is probably good',
};

/**
 * Get the provisioning quip for a given server phase.
 * Returns a branded fallback for unknown phases.
 */
export const getProvisioningQuip = (phase: string): ProvisioningQuip => {
  return MANAGED_PROVISION_PHASE_COPY[phase] ?? FALLBACK_QUIP;
};

/**
 * Get the switch quip for a given server phase.
 * Returns a branded fallback for unknown phases.
 */
export const getSwitchQuip = (phase: string): ProvisioningQuip => {
  return SWITCH_PHASE_COPY[phase] ?? FALLBACK_QUIP;
};

/**
 * Get the next extended subtext in rotation.
 * Used when a single phase takes longer than expected (~15s+).
 */
export const getExtendedSubtext = (cycleIndex: number): string => {
  return EXTENDED_SUBTEXT[cycleIndex % EXTENDED_SUBTEXT.length];
};
