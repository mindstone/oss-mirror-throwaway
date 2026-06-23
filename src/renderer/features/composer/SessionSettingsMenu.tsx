import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useHover,
  useInteractions,
  FloatingPortal,
  safePolygon,
} from '@floating-ui/react';
import {
  SlidersHorizontal,
  Volume2,
  VolumeX,
  EyeOff,
  Eye,
  CheckCircle2,
  Circle,
  Users,
  Cpu,
  ChevronRight,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { IconButton } from '@renderer/components/ui/IconButton';
import { tracking } from '@renderer/src/tracking';
import { COUNCIL_MANAGED_NO_BYOK_TOOLTIP } from '@shared/utils/councilProfiles';
import styles from './SessionSettingsMenu.module.css';

const PRIVATE_MODE_ON_TOAST =
  "Private mode enabled. I'll ask before writing or taking any actions.";

export type SessionSettingsMenuProps = {
  autoSpeak: boolean;
  onToggleAutoSpeak: () => void;
  /**
   * Whether the TTS key is missing for the selected provider.
   * TTS is key-only — Codex/ChatGPT Pro does NOT provide a TTS fallback (unlike STT).
   * See App.tsx `ttsKeyMissing` computation.
   */
  ttsKeyMissing?: boolean;
  ttsUnavailable?: boolean;
  privateMode: boolean;
  onPrivateModeChange?: (enabled: boolean) => void;
  councilMode?: boolean;
  onCouncilModeChange?: (enabled: boolean) => void;
  councilModeAvailable?: boolean;
  councilModeDisabledTooltip?: string;
  isBusy: boolean;
  autoDoneEnabled: boolean;
  onToggleAutoDone?: (
    source?: 'click' | 'keyboard' | 'long_press' | 'menu'
  ) => void;
  canMarkDoneNow: boolean;
  onMarkDoneNow?: () => void;
  showToast?: (options: { title: string }) => void;
  onOpenSettings?: () => void;
  modelInfo?: {
    workingModelName: string;
    thinkingModelName: string;
    thinkingInheritsFromWorking: boolean;
    hasAnyCustom: boolean;
    backgroundModelName: string;
    backgroundIsCustom: boolean;
  };
  onNavigateToModelSettings?: () => void;
};

type ToggleItemConfig = {
  type: 'toggle';
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled: boolean;
  /** Item is actionable but redirects (e.g. to settings) — dimmed but not aria-disabled */
  redirecting?: boolean;
  onToggle: () => void;
};

type ActionItemConfig = {
  type: 'action';
  id: string;
  label: string;
  description?: string;
  onClick: () => void;
};

type InfoItemConfig = {
  type: 'info';
  id: string;
  label: string;
  description?: string;
  onClick: () => void;
  tooltipContent?: ReactNode;
};

type MenuItemConfig = ToggleItemConfig | ActionItemConfig | InfoItemConfig;

const TOGGLE_ICONS: Record<string, { active: LucideIcon; inactive: LucideIcon }> = {
  voice: { active: Volume2, inactive: VolumeX },
  private: { active: EyeOff, inactive: Eye },
  council: { active: Users, inactive: Users },
  done: { active: CheckCircle2, inactive: Circle },
};

function getItemIcon(item: MenuItemConfig): LucideIcon {
  if (item.type === 'toggle') {
    const icons = TOGGLE_ICONS[item.id];
    if (icons) return item.checked ? icons.active : icons.inactive;
  }
  return CheckCircle2;
}

const SessionSettingsMenuComponent = ({
  autoSpeak,
  onToggleAutoSpeak,
  ttsKeyMissing = false,
  ttsUnavailable = false,
  privateMode,
  onPrivateModeChange,
  councilMode = false,
  onCouncilModeChange,
  councilModeAvailable = false,
  councilModeDisabledTooltip,
  isBusy,
  autoDoneEnabled,
  onToggleAutoDone,
  canMarkDoneNow,
  onMarkDoneNow,
  showToast,
  onOpenSettings,
  modelInfo,
  onNavigateToModelSettings,
}: SessionSettingsMenuProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [hasShownPrivateToast, setHasShownPrivateToast] = useState(() =>
    localStorage.getItem('rebel-private-mode-toast-shown') === 'true'
  );

  const speakerBlocked = (ttsKeyMissing || ttsUnavailable) && !autoSpeak;

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'top-end',
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const [isModelTooltipOpen, setIsModelTooltipOpen] = useState(false);
  const [isVoiceTooltipOpen, setIsVoiceTooltipOpen] = useState(false);
  const [isCouncilTooltipOpen, setIsCouncilTooltipOpen] = useState(false);
  const councilModeBlocked = Boolean(councilModeDisabledTooltip);

  const {
    refs: tooltipRefs,
    floatingStyles: tooltipStyles,
    context: tooltipContext,
    isPositioned: isTooltipPositioned,
  } = useFloating({
    open: isModelTooltipOpen && isOpen,
    onOpenChange: setIsModelTooltipOpen,
    placement: 'left-start',
    middleware: [offset(8), flip(), shift()],
    whileElementsMounted: autoUpdate,
  });

  const tooltipHover = useHover(tooltipContext, {
    delay: { open: 200, close: 100 },
    handleClose: safePolygon(),
  });
  const tooltipDismiss = useDismiss(tooltipContext);
  const tooltipRole = useRole(tooltipContext, { role: 'tooltip' });

  const {
    getReferenceProps: getTooltipReferenceProps,
    getFloatingProps: getTooltipFloatingProps,
  } = useInteractions([tooltipHover, tooltipDismiss, tooltipRole]);

  const {
    refs: voiceTooltipRefs,
    floatingStyles: voiceTooltipStyles,
    context: voiceTooltipContext,
    isPositioned: isVoiceTooltipPositioned,
  } = useFloating({
    open: isVoiceTooltipOpen && isOpen && speakerBlocked,
    onOpenChange: setIsVoiceTooltipOpen,
    placement: 'left-start',
    middleware: [offset(8), flip(), shift()],
    whileElementsMounted: autoUpdate,
  });

  const voiceTooltipHover = useHover(voiceTooltipContext, {
    delay: { open: 200, close: 100 },
    handleClose: safePolygon(),
  });
  const voiceTooltipDismiss = useDismiss(voiceTooltipContext);
  const voiceTooltipRole = useRole(voiceTooltipContext, { role: 'tooltip' });

  const {
    getReferenceProps: getVoiceTooltipReferenceProps,
    getFloatingProps: getVoiceTooltipFloatingProps,
  } = useInteractions([voiceTooltipHover, voiceTooltipDismiss, voiceTooltipRole]);

  const {
    refs: councilTooltipRefs,
    floatingStyles: councilTooltipStyles,
    context: councilTooltipContext,
    isPositioned: isCouncilTooltipPositioned,
  } = useFloating({
    open: isCouncilTooltipOpen && isOpen && councilModeBlocked,
    onOpenChange: setIsCouncilTooltipOpen,
    placement: 'left-start',
    middleware: [offset(8), flip(), shift()],
    whileElementsMounted: autoUpdate,
  });

  const councilTooltipHover = useHover(councilTooltipContext, {
    delay: { open: 200, close: 100 },
    handleClose: safePolygon(),
  });
  const councilTooltipDismiss = useDismiss(councilTooltipContext);
  const councilTooltipRole = useRole(councilTooltipContext, { role: 'tooltip' });

  const {
    getReferenceProps: getCouncilTooltipReferenceProps,
    getFloatingProps: getCouncilTooltipFloatingProps,
  } = useInteractions([councilTooltipHover, councilTooltipDismiss, councilTooltipRole]);

  const click = useClick(context);
  const dismiss = useDismiss(context, {
    outsidePress: (event) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return true;
      }

      return !tooltipRefs.floating.current?.contains(target)
        && !voiceTooltipRefs.floating.current?.contains(target)
        && !councilTooltipRefs.floating.current?.contains(target);
    },
  });
  const role = useRole(context, { role: 'menu' });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  useEffect(() => {
    if (!isOpen) {
      setFocusedIndex(-1);
      setIsModelTooltipOpen(false);
      setIsVoiceTooltipOpen(false);
      setIsCouncilTooltipOpen(false);
    }
  }, [isOpen]);

  const handleVoiceRepliesToggle = useCallback(() => {
    if (speakerBlocked) {
      onOpenSettings?.();
      return;
    }
    const newEnabled = !autoSpeak;
    onToggleAutoSpeak();
    tracking.conversation.voiceRepliesToggled(newEnabled);
  }, [autoSpeak, speakerBlocked, onToggleAutoSpeak, onOpenSettings]);

  const handlePrivateModeToggle = useCallback(() => {
    if (isBusy) return;
    const newEnabled = !privateMode;
    onPrivateModeChange?.(newEnabled);
    tracking.settings.privacyModeToggled(newEnabled);

    if (newEnabled && !hasShownPrivateToast && showToast) {
      localStorage.setItem('rebel-private-mode-toast-shown', 'true');
      setHasShownPrivateToast(true);
      showToast({ title: PRIVATE_MODE_ON_TOAST });
    }
  }, [privateMode, isBusy, onPrivateModeChange, hasShownPrivateToast, showToast]);

  const handleCouncilModeToggle = useCallback(() => {
    if (councilModeBlocked) return;
    onCouncilModeChange?.(!councilMode);
  }, [councilMode, councilModeBlocked, onCouncilModeChange]);

  const handleAutoDoneToggle = useCallback(() => {
    onToggleAutoDone?.('menu');
  }, [onToggleAutoDone]);

  const handleMarkDoneNow = useCallback(() => {
    onMarkDoneNow?.();
    setIsOpen(false);
  }, [onMarkDoneNow]);

  const items = useMemo<MenuItemConfig[]>(() => {
    const list: MenuItemConfig[] = [
      {
        type: 'toggle',
        id: 'voice',
        label: speakerBlocked ? 'Voice replies (setup required)' : 'Voice replies',
        description: 'Read responses aloud',
        checked: autoSpeak,
        disabled: false,
        redirecting: speakerBlocked,
        onToggle: handleVoiceRepliesToggle,
      },
    ];
    if (onPrivateModeChange) {
      list.push({
        type: 'toggle',
        id: 'private',
        label: 'Private mode',
        description: 'Ask before writing or taking actions',
        checked: privateMode,
        disabled: isBusy,
        onToggle: handlePrivateModeToggle,
      });
    }
    if ((councilModeAvailable || councilModeBlocked) && onCouncilModeChange) {
      list.push({
        type: 'toggle',
        id: 'council',
        label: 'Council mode',
        description: 'Consult multiple AI models in parallel',
        checked: councilMode,
        disabled: councilModeBlocked,
        onToggle: handleCouncilModeToggle,
      });
    }
    if (onToggleAutoDone) {
      list.push({
        type: 'toggle',
        id: 'done',
        label: 'Auto-done',
        description: 'Mark as done when conversation ends',
        checked: autoDoneEnabled,
        disabled: false,
        onToggle: handleAutoDoneToggle,
      });
    }
    if (canMarkDoneNow) {
      list.push({
        type: 'action',
        id: 'done-now',
        label: 'Mark as done',
        description: 'Mark this conversation as done',
        onClick: handleMarkDoneNow,
      });
    }
    // Model info at the top — unshift so it appears before toggles
    if (modelInfo && onNavigateToModelSettings) {
      list.unshift({
        type: 'info',
        id: 'model-info',
        label: 'AI model',
        description: 'Which AI is powering this conversation',
        onClick: onNavigateToModelSettings,
      });
    }
    return list;
  }, [
    autoSpeak, speakerBlocked, handleVoiceRepliesToggle,
    onPrivateModeChange, privateMode, isBusy, handlePrivateModeToggle,
    councilModeAvailable, councilModeBlocked, onCouncilModeChange, councilMode, handleCouncilModeToggle,
    onToggleAutoDone, autoDoneEnabled, handleAutoDoneToggle,
    canMarkDoneNow, handleMarkDoneNow,
    modelInfo, onNavigateToModelSettings,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) return;
      // Ignore keystrokes with modifier keys (Cmd/Ctrl) — these are global
      // shortcuts (e.g. Cmd+Enter for done) and should not interact with menu items
      if (e.metaKey || e.ctrlKey) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setFocusedIndex((prev) =>
            prev < items.length - 1 ? prev + 1 : 0
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setFocusedIndex((prev) =>
            prev > 0 ? prev - 1 : items.length - 1
          );
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < items.length) {
            const item = items[focusedIndex];
            if (item.type === 'toggle' && !item.disabled) item.onToggle();
            else if (item.type === 'action') item.onClick();
            else if (item.type === 'info') { setIsOpen(false); item.onClick(); }
          }
          break;
        case 'Escape':
          e.preventDefault();
          setIsOpen(false);
          break;
      }
    },
    [isOpen, focusedIndex, items]
  );

  return (
    <>
      <IconButton
        ref={refs.setReference}
        size="md"
        active={isOpen}
        className={cn(styles.trigger, isOpen && styles.triggerOpen)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="Session settings"
        data-testid="session-settings-menu-trigger"
        {...getReferenceProps({ onKeyDown: handleKeyDown })}
      >
        <SlidersHorizontal size={16} aria-hidden />
      </IconButton>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={styles.menu}
            role="menu"
            data-positioned={isPositioned}
            {...getFloatingProps()}
          >
            {items.map((item, index) => {
              const Icon = getItemIcon(item);
              const isFocused = index === focusedIndex;
              const prevItem = index > 0 ? items[index - 1] : null;
              const showSeparator =
                (item.id === 'done-now' && index > 0) ||
                (prevItem?.type === 'info' && item.type !== 'info');

              return (
                <Fragment key={item.id}>
                  {showSeparator && (
                    <div className={styles.separator} role="separator" />
                  )}
                  {item.type === 'toggle' ? (
                    <button
                      type="button"
                      ref={
                        item.id === 'voice' && speakerBlocked
                          ? voiceTooltipRefs.setReference
                          : item.id === 'council' && councilModeBlocked
                            ? councilTooltipRefs.setReference
                            : undefined
                      }
                      className={cn(
                        styles.toggleItem,
                        isFocused && styles.itemFocused,
                        (item.disabled || item.redirecting) && styles.itemDisabled
                      )}
                      role="menuitemcheckbox"
                      aria-checked={item.checked}
                      aria-disabled={item.disabled || undefined}
                      tabIndex={-1}
                      onClick={item.onToggle}
                      {...(item.id === 'voice' && speakerBlocked
                        ? getVoiceTooltipReferenceProps({ onMouseEnter: () => setFocusedIndex(index) })
                        : item.id === 'council' && councilModeBlocked
                          ? getCouncilTooltipReferenceProps({ onMouseEnter: () => setFocusedIndex(index) })
                        : { onMouseEnter: () => setFocusedIndex(index) }
                      )}
                    >
                      <Icon
                        size={16}
                        aria-hidden
                        className={styles.itemIcon}
                      />
                      <span className={styles.itemLabel}>
                        <span className={styles.itemTitle}>{item.label}</span>
                        {item.description && (
                          <span className={styles.itemDescription}>{item.description}</span>
                        )}
                      </span>
                      <span
                        className={cn(
                          styles.toggleSwitch,
                          item.checked && styles.toggleSwitchActive
                        )}
                        aria-hidden
                      />
                    </button>
                  ) : item.type === 'info' ? (
                    <button
                      type="button"
                      ref={tooltipRefs.setReference}
                      className={cn(
                        styles.infoItem,
                        isFocused && styles.itemFocused,
                      )}
                      role="menuitem"
                      aria-label={`AI model: ${modelInfo?.workingModelName ?? ''}${modelInfo?.thinkingInheritsFromWorking ? '' : `, Thinking: ${modelInfo?.thinkingModelName ?? ''}`}`}
                      aria-haspopup="true"
                      data-testid="session-settings-model-info"
                      tabIndex={-1}
                      onClick={() => { setIsOpen(false); item.onClick(); }}
                      {...getTooltipReferenceProps({ onMouseEnter: () => setFocusedIndex(index) })}
                    >
                      <Cpu
                        size={16}
                        aria-hidden
                        className={styles.itemIcon}
                      />
                      <span className={styles.itemLabel}>
                        <span className={styles.itemTitle}>{item.label}</span>
                        {item.description && (
                          <span className={styles.itemDescription}>{item.description}</span>
                        )}
                      </span>
                      <ChevronRight
                        size={14}
                        aria-hidden
                        className={styles.infoChevron}
                      />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={cn(
                        styles.actionItem,
                        isFocused && styles.itemFocused
                      )}
                      role="menuitem"
                      tabIndex={-1}
                      onClick={item.onClick}
                      onMouseEnter={() => setFocusedIndex(index)}
                    >
                      <Icon
                        size={16}
                        aria-hidden
                        className={styles.itemIcon}
                      />
                      <span className={styles.itemLabel}>
                        <span className={styles.itemTitle}>{item.label}</span>
                        {item.description && (
                          <span className={styles.itemDescription}>{item.description}</span>
                        )}
                      </span>
                    </button>
                  )}
                </Fragment>
              );
            })}
          </div>
        </FloatingPortal>
      )}

      {isModelTooltipOpen && isOpen && modelInfo && (
        <FloatingPortal>
          <div
            ref={tooltipRefs.setFloating}
            style={tooltipStyles}
            className={styles.modelTooltip}
            role="tooltip"
            data-positioned={isTooltipPositioned}
            {...getTooltipFloatingProps({
              onPointerDown: (e) => e.stopPropagation(),
            })}
          >
            <div className={styles.modelTooltipRow}>
              <span className={styles.modelTooltipLabel}>Working</span>
              <span className={styles.modelTooltipName}>{modelInfo.workingModelName}</span>
            </div>
            <div className={styles.modelTooltipRow}>
              <span className={styles.modelTooltipLabel}>Thinking</span>
              <span className={styles.modelTooltipName}>
                {modelInfo.thinkingInheritsFromWorking ? '(same)' : modelInfo.thinkingModelName}
              </span>
            </div>
            <div className={styles.modelTooltipRow}>
              <span className={styles.modelTooltipLabel}>Background</span>
              <span className={styles.modelTooltipName}>{modelInfo.backgroundModelName}</span>
            </div>
            <button
              type="button"
              className={styles.modelTooltipConfigure}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setIsOpen(false);
                onNavigateToModelSettings?.();
              }}
            >
              <Settings2 size={12} aria-hidden />
              Configure in settings
            </button>
          </div>
        </FloatingPortal>
      )}

      {isVoiceTooltipOpen && isOpen && speakerBlocked && (
        <FloatingPortal>
          <div
            ref={voiceTooltipRefs.setFloating}
            style={voiceTooltipStyles}
            className={styles.voiceTooltip}
            role="tooltip"
            data-positioned={isVoiceTooltipPositioned}
            {...getVoiceTooltipFloatingProps()}
          >
            <p className={styles.voiceTooltipText}>
              An API key is needed to enable voice replies.
            </p>
            <button
              type="button"
              className={styles.voiceTooltipButton}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setIsOpen(false);
                onOpenSettings?.();
              }}
            >
              <Settings2 size={12} aria-hidden />
              Set up in settings
            </button>
          </div>
        </FloatingPortal>
      )}
      {isCouncilTooltipOpen && isOpen && councilModeBlocked && (
        <FloatingPortal>
          <div
            ref={councilTooltipRefs.setFloating}
            style={councilTooltipStyles}
            className={styles.voiceTooltip}
            role="tooltip"
            data-positioned={isCouncilTooltipPositioned}
            {...getCouncilTooltipFloatingProps()}
          >
            <p className={styles.voiceTooltipText}>
              {councilModeDisabledTooltip ?? COUNCIL_MANAGED_NO_BYOK_TOOLTIP}
            </p>
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

export const SessionSettingsMenu = memo(SessionSettingsMenuComponent);
SessionSettingsMenu.displayName = 'SessionSettingsMenu';
