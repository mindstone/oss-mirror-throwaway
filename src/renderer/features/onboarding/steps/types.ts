import type React from 'react';

import type {
  AppSettings,
  ModelSettings,
} from '@shared/types';
import type {
  OnboardingFlowState,
  OnboardingFlowActions,
  ToolAuthState,
} from '../hooks/useOnboardingFlow';
export type BaseStepProps = {
  state: OnboardingFlowState;
  actions: OnboardingFlowActions;
  draftSettings: AppSettings;
  isDevMode: boolean;
};

export type GoogleDriveStepProps = BaseStepProps;

export type ApiStepProps = BaseStepProps & {
  updateDraft: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  updateClaude: <K extends keyof ModelSettings>(key: K, value: ModelSettings[K]) => void;
  isValidatingClaude: boolean;
  claudeValidationMessage: string | null;
  claudeValidationOk: boolean | null;
  validateClaudeKey: (apiKey: string | null | undefined) => Promise<boolean>;
};

export type ToolAuthStepProps = BaseStepProps & {
  renderToolStatus: (toolState: ToolAuthState) => React.ReactNode;
};

export type VoiceSetupStepProps = BaseStepProps & {
  updateDraft: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  updateVoice: <K extends keyof AppSettings['voice']>(key: K, value: AppSettings['voice'][K]) => void;
  isValidatingOpenAI: boolean;
  openAiValidationMessage: string | null;
  openAiValidationOk: boolean | null;
  openAiValidationReason: string | null;
  validateOpenAiKey: (apiKey: string | null | undefined) => Promise<boolean>;
  clearOpenAiValidation: () => void;
  isValidatingElevenLabs: boolean;
  elevenLabsValidationMessage: string | null;
  elevenLabsValidationOk: boolean | null;
  validateElevenLabsKey: (apiKey: string | null | undefined) => Promise<boolean>;
  clearElevenLabsValidation: () => void;
  openPrefsAndPoll: (type: 'microphone' | 'files') => Promise<void>;
};

export type TwinkleParticle = {
  key: number;
  left: number;
  top: number;
  delay: number;
  type: number; // 0=normal, 1=blue, 2=purple, 3=large glow
};

export type ShootingStar = {
  key: string;
  startLeft: number;
  startTop: number;
  delay: number;
};

export type WelcomeStepProps = {
  goNext: () => Promise<void>;
  startMigrationImport: () => void;
  twinkleParticles: Array<TwinkleParticle>;
  shootingStars: Array<ShootingStar>;
  eulaAccepted: boolean;
  setEulaAccepted: (accepted: boolean) => void;
};
