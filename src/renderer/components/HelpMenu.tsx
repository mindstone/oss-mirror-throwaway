import { useState, useCallback, useEffect, useRef } from "react";
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  useHover,
  FloatingPortal,
} from "@floating-ui/react";
import {
  CircleHelp,
  Users,
  Wrench,
  CheckCircle2,
  Keyboard,
  RefreshCw,
  PlayCircle,
  Bug,
  FileDown,
} from "lucide-react";
import { IconButton } from "@renderer/components/ui/IconButton";
import { useTutorialsModalStore } from "@renderer/features/tutorials";
import { tracking } from "@renderer/src/tracking";
import styles from "./HelpMenu.module.css";

export type HealthStatus = "healthy" | "warn" | "critical" | "unknown";

export interface HelpMenuProps {
  onShowShortcuts?: () => void;
  /** @deprecated Use onSendFeedback instead */
  onReportBug?: () => void;
  onSendFeedback?: () => void;
  onCheckForUpdates?: () => void;
  onDownloadDiagnostics?: () => void;
  healthStatus?: HealthStatus;
  healthIssueCount?: number;
  onTroubleshoot?: () => void;
}

export const HelpMenu = ({
  onShowShortcuts,
  onReportBug,
  onSendFeedback,
  onCheckForUpdates,
  onDownloadDiagnostics,
  healthStatus = "unknown",
  healthIssueCount = 0,
  onTroubleshoot,
}: HelpMenuProps) => {
  // Support both old and new prop names for backwards compatibility
  const handleFeedback = onSendFeedback ?? onReportBug;
  const [isOpen, setIsOpen] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const wasOpenRef = useRef(false);

  // Track when help menu opens
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      tracking.navigation.helpMenuOpened();
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  const hasIssues = healthStatus === "warn" || healthStatus === "critical";
  const glowStatus = hasIssues ? healthStatus : undefined;
  const indicatorLabel = hasIssues
    ? `${healthIssueCount} thing${healthIssueCount === 1 ? "" : "s"} need${healthIssueCount === 1 ? "s" : ""} attention`
    : "Help and resources";

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: "bottom-end",
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const {
    refs: tooltipRefs,
    floatingStyles: tooltipStyles,
    context: tooltipContext,
  } = useFloating({
    open: showTooltip && !isOpen,
    onOpenChange: setShowTooltip,
    placement: "bottom",
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "menu" });
  const tooltipHover = useHover(tooltipContext, {
    delay: { open: 400, close: 0 },
  });
  const tooltipDismiss = useDismiss(tooltipContext);
  const tooltipRole = useRole(tooltipContext, { role: "tooltip" });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  const {
    getReferenceProps: getTooltipReferenceProps,
    getFloatingProps: getTooltipFloatingProps,
  } = useInteractions([tooltipHover, tooltipDismiss, tooltipRole]);

  // Tutorials modal - direct store access (no props needed)
  const openTutorials = useTutorialsModalStore((s) => s.open);

  const handleOpenCommunity = useCallback(() => {
    tracking.navigation.helpMenuItemClicked('community');
    void window.appApi.openUrl("https://rebels.mindstone.com");
    setIsOpen(false);
  }, []);

  const handleOpenTutorials = useCallback(() => {
    tracking.navigation.helpMenuItemClicked('tutorials');
    tracking.tutorials.modalOpened('help_menu');
    openTutorials();
    setIsOpen(false);
  }, [openTutorials]);


  const handleTroubleshoot = useCallback(() => {
    tracking.navigation.helpMenuItemClicked('troubleshoot');
    onTroubleshoot?.();
    setIsOpen(false);
  }, [onTroubleshoot]);

  const handleShowShortcuts = useCallback(() => {
    tracking.navigation.helpMenuItemClicked('shortcuts');
    onShowShortcuts?.();
    setIsOpen(false);
  }, [onShowShortcuts]);

  const handleSendFeedback = useCallback(() => {
    tracking.navigation.helpMenuItemClicked('feedback');
    handleFeedback?.();
    setIsOpen(false);
  }, [handleFeedback]);

  const handleCheckForUpdates = useCallback(() => {
    tracking.navigation.helpMenuItemClicked('check_updates');
    onCheckForUpdates?.();
    setIsOpen(false);
  }, [onCheckForUpdates]);

  const handleDownloadDiagnostics = useCallback(() => {
    onDownloadDiagnostics?.();
    setIsOpen(false);
  }, [onDownloadDiagnostics]);

  const mergeRefs =
    (...refs: ((node: HTMLButtonElement | null) => void)[]) =>
    (node: HTMLButtonElement | null) => {
      refs.forEach((ref) => ref(node));
    };

  return (
    <>
      <IconButton
        size="sm"
        ref={mergeRefs(refs.setReference, tooltipRefs.setReference)}
        className={styles.trigger}
        active={isOpen}
        data-open={isOpen}
        data-health={glowStatus}
        aria-label={indicatorLabel}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        {...getReferenceProps(getTooltipReferenceProps())}
      >
        <CircleHelp size={16} strokeWidth={1.5} />
      </IconButton>
      {showTooltip && !isOpen && (
        <FloatingPortal>
          <div
            ref={tooltipRefs.setFloating}
            style={tooltipStyles}
            className={styles.tooltip}
            {...getTooltipFloatingProps()}
          >
            {indicatorLabel}
          </div>
        </FloatingPortal>
      )}
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
            {/* Health status / troubleshoot item */}
            {hasIssues && onTroubleshoot ? (
              <button
                type="button"
                className={styles.menuItemTroubleshoot}
                role="menuitem"
                onClick={handleTroubleshoot}
              >
                <span className={styles.menuItemIcon}>
                  <Wrench size={16} />
                </span>
                What&apos;s going on?
                <span className={styles.issueCount}>{healthIssueCount}</span>
              </button>
            ) : healthStatus === "healthy" ? (
              <div
                className={styles.menuItemHealthy}
                role="menuitem"
                aria-disabled="true"
              >
                <span className={styles.menuItemIcon}>
                  <CheckCircle2 size={16} />
                </span>
                All systems go
              </div>
            ) : null}

            {(hasIssues || healthStatus === "healthy") && (
              <div className={styles.divider} />
            )}

            {/* Menu items ordered by usage frequency (based on analytics) */}
            {onCheckForUpdates && (
              <button
                type="button"
                className={styles.menuItem}
                role="menuitem"
                onClick={handleCheckForUpdates}
              >
                <span className={styles.menuItemIcon}>
                  <RefreshCw size={16} />
                </span>
                Check for updates
              </button>
            )}

            {onDownloadDiagnostics && (
              <button
                type="button"
                className={styles.menuItem}
                role="menuitem"
                onClick={handleDownloadDiagnostics}
              >
                <span className={styles.menuItemIcon}>
                  <FileDown size={16} />
                </span>
                Download diagnostics
              </button>
            )}
            {handleFeedback && (
              <button
                type="button"
                className={styles.menuItem}
                role="menuitem"
                onClick={handleSendFeedback}
              >
                <span className={styles.menuItemIcon}>
                  <Bug size={16} />
                </span>
                Feedback & bugs
              </button>
            )}
            <button
              type="button"
              className={styles.menuItem}
              role="menuitem"
              onClick={handleOpenCommunity}
            >
              <span className={styles.menuItemIcon}>
                <Users size={16} />
              </span>
              Ask the Community
            </button>
            <button
              type="button"
              className={styles.menuItem}
              role="menuitem"
              onClick={handleOpenTutorials}
            >
              <span className={styles.menuItemIcon}>
                <PlayCircle size={16} />
              </span>
              Watch tutorials
            </button>
            {onShowShortcuts && (
              <button
                type="button"
                className={styles.menuItem}
                role="menuitem"
                onClick={handleShowShortcuts}
              >
                <span className={styles.menuItemIcon}>
                  <Keyboard size={16} />
                </span>
                Keyboard shortcuts
              </button>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

HelpMenu.displayName = "HelpMenu";
