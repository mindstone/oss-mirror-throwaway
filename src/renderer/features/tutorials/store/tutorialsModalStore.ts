import { create } from 'zustand';
import type { TutorialVideo } from '@shared/config/tutorialVideos';

interface TutorialsModalState {
  isOpen: boolean;
  initialVideo: TutorialVideo | null;
  open: (video?: TutorialVideo) => void;
  close: () => void;
}

/**
 * Zustand store for tutorials modal state.
 * Enables opening the modal from anywhere (HelpMenu, TheSparkPanel) without prop drilling.
 */
export const useTutorialsModalStore = create<TutorialsModalState>((set) => ({
  isOpen: false,
  initialVideo: null,
  open: (video) => set({ isOpen: true, initialVideo: video ?? null }),
  close: () => set({ isOpen: false, initialVideo: null }),
}));
