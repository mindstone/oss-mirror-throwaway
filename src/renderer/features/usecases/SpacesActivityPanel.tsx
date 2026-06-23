/**
 * SpacesActivityPanel - Activity across all spaces
 *
 * Shows what's been happening in your spaces this week.
 * Includes AI-synthesized summary tailored to what the user cares about.
 */

import { useState, useMemo, useCallback } from 'react';
import { Bot, Sparkles, ChevronRight, FolderOpen, Pencil, RefreshCw, Heart } from 'lucide-react';
import { useSpaceActivity, useSpacesSynthesis, useCompanyValuesStatus } from './hooks';
import { useSkillContributors } from './hooks/useSkillContributors';
import { useSettings } from '@renderer/features/settings';
import { Button, Input, Tooltip } from '@renderer/components/ui';
import { MessageMarkdown } from '@renderer/components/MessageMarkdown';
import { formatRelativeTime as _formatRelativeTime } from '@rebel/shared';
import type { SpaceActivity, MemoryPreview, SkillPreview } from '@shared/ipc/channels/dashboard';
import styles from './SpacesActivityPanel.module.css';

const formatRelativeTime = (timestamp: number): string =>
  _formatRelativeTime(timestamp, { includeMinutes: false });

/** Get a witty header based on activity level */
const _getHeaderCopy = (totalSpaces: number, totalActivity: number): { title: string; subtitle: string } => {
  if (totalSpaces === 0) {
    return {
      title: 'All quiet',
      subtitle: 'Your spaces are resting this week',
    };
  }
  
  if (totalActivity <= 3) {
    return {
      title: `${totalSpaces} ${totalSpaces === 1 ? 'space' : 'spaces'} stirred`,
      subtitle: 'Light activity. Nothing urgent.',
    };
  }
  
  if (totalActivity <= 10) {
    return {
      title: 'Your spaces have been busy',
      subtitle: `${totalActivity} updates across ${totalSpaces} ${totalSpaces === 1 ? 'space' : 'spaces'}`,
    };
  }
  
  return {
    title: 'A productive week',
    subtitle: `${totalActivity} updates. Someone has been thinking.`,
  };
};

/** Truncate text with ellipsis */
const truncate = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
};

interface ActivityItemProps {
  icon: React.ReactNode;
  text: string;
  timestamp: number;
  onClick?: () => void;
  /** True for actions performed by Rebel (e.g., memory saves) */
  isRebelAction?: boolean;
}

const ActivityItem = ({ icon, text, timestamp, onClick, isRebelAction }: ActivityItemProps) => (
  <button 
    type="button" 
    className={`${styles.activityItem} ${isRebelAction ? styles.rebelAction : ''}`}
    onClick={onClick} 
    disabled={!onClick}
  >
    <span className={styles.activityIcon}>{icon}</span>
    <span className={styles.activityText}>{truncate(text, 80)}</span>
    <span className={styles.activityTime}>{formatRelativeTime(timestamp)}</span>
    <ChevronRight size={12} className={styles.activityArrow} />
  </button>
);

interface SpaceCardProps {
  space: SpaceActivity;
  onOpenFile: (relativePath: string) => void;
}

const SpaceCard = ({ space, onOpenFile }: SpaceCardProps) => {
  // Combine and sort all activity items by timestamp
  const allItems = useMemo(() => {
    const items: Array<{ type: 'memory' | 'skill'; data: MemoryPreview | SkillPreview }> = [];
    
    for (const m of space.recentMemories) {
      items.push({ type: 'memory', data: m });
    }
    for (const s of space.recentSkills) {
      items.push({ type: 'skill', data: s });
    }
    
    // Sort by timestamp descending
    items.sort((a, b) => b.data.timestamp - a.data.timestamp);
    
    return items;
  }, [space.recentMemories, space.recentSkills]);

  const hasMore = space.memoryCount + space.skillCount > allItems.length;

  return (
    <div className={styles.spaceCard}>
      <div className={styles.spaceHeader}>
        <span className={styles.spaceName}>{space.displayName}</span>
        {space.lastActivityAt && (
          <span className={styles.spaceTime}>{formatRelativeTime(space.lastActivityAt)}</span>
        )}
      </div>

      <div className={styles.activityList}>
        {allItems.map((item, idx) => {
          if (item.type === 'memory') {
            const m = item.data as MemoryPreview;
            return (
              <ActivityItem
                key={`m-${idx}`}
                icon={<Bot size={13} />}
                text={m.summary}
                timestamp={m.timestamp}
                onClick={m.filePath ? () => { if (m.filePath) onOpenFile(m.filePath); } : undefined}
                isRebelAction
              />
            );
          } else {
            const s = item.data as SkillPreview;
            return (
              <ActivityItem
                key={`s-${idx}`}
                icon={<Sparkles size={13} />}
                text={s.name}
                timestamp={s.timestamp}
                onClick={() => onOpenFile(s.filePath)}
              />
            );
          }
        })}
      </div>

      {hasMore && (
        <div className={styles.moreIndicator}>
          +{space.memoryCount + space.skillCount - allItems.length} more
        </div>
      )}
    </div>
  );
};

/** Thank You Board - Shows skill contributors with their contributions */
interface ThankYouBoardProps {
  contributors: { name: string; created: string[]; improved: string[] }[];
}

/** Format skill list: up to 3 names, then +N */
const formatSkillList = (skills: string[]): string => {
  if (skills.length === 0) return '';
  const shown = skills.slice(0, 3).join(', ');
  return skills.length > 3 ? `${shown} +${skills.length - 3}` : shown;
};

const ThankYouBoard = ({ contributors }: ThankYouBoardProps) => {
  if (contributors.length === 0) return null;

  // Show at most 5 contributors
  const displayContributors = contributors.slice(0, 5);

  return (
    <div className={styles.thankYouBoard}>
      <div className={styles.thankYouHeader}>
        <Heart size={14} className={styles.thankYouIcon} />
        <span className={styles.thankYouTitle}>Skill contributors</span>
      </div>
      <div className={styles.thankYouList}>
        {displayContributors.map((c) => (
          <div key={c.name} className={styles.thankYouContributor}>
            <span className={styles.thankYouName}>{c.name}</span>
            {c.created.length > 0 && (
              <span className={styles.thankYouSkills}>
                <span className={styles.thankYouVerb}>created</span> {formatSkillList(c.created)}
              </span>
            )}
            {c.improved.length > 0 && (
              <span className={styles.thankYouSkills}>
                <span className={styles.thankYouVerb}>improved</span> {formatSkillList(c.improved)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

/** First-time onboarding: Ask what the user cares about */
interface FocusOnboardingProps {
  onSubmit: (focus: string) => void;
}

const FocusOnboarding = ({ onSubmit }: FocusOnboardingProps) => {
  const [value, setValue] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim()) {
      onSubmit(value.trim());
    }
  };

  return (
    <div className={styles.onboarding}>
      <p className={styles.onboardingIntro}>
        I've been quietly learning from your conversations, saving memories, building skills.
        But I can only help you see patterns if I know what you're looking for.
      </p>
      <form onSubmit={handleSubmit} className={styles.onboardingForm}>
        <label htmlFor="focus-input" className={styles.onboardingLabel}>
          What should I pay attention to?
        </label>
        <p className={styles.onboardingHint}>
          This shapes how I interpret your week—the summary below will reflect what matters to you.
        </p>
        <Input
          id="focus-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Team dynamics, client work, how my thinking evolves..."
          className={styles.onboardingInput}
        />
        <Button type="submit" disabled={!value.trim()} className={styles.onboardingButton}>
          Watch for this
        </Button>
      </form>
    </div>
  );
};

/** Synthesis display with expandable detail */
interface SynthesisCardProps {
  hook: string;
  detail: string;
  focus: string;
  isGenerating: boolean;
  thinkingMessage: string;
  onEditFocus: () => void;
  onRefresh: () => void;
}

const SynthesisCard = ({
  hook,
  detail,
  focus,
  isGenerating,
  thinkingMessage,
  onEditFocus,
  onRefresh,
}: SynthesisCardProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className={styles.synthesisCard}>
      <div className={styles.synthesisHeader}>
        <div className={styles.synthesisHeaderLeft}>
          <span className={styles.synthesisLabel}>Paying attention to: {focus}</span>
          <span className={styles.synthesisSubtitle}>Based on memories and skills across your spaces from the past week</span>
        </div>
        <div className={styles.synthesisActions}>
          <Tooltip content="Change what I watch for">
            <button type="button" className={styles.synthesisAction} onClick={onEditFocus}>
              <Pencil size={14} />
            </button>
          </Tooltip>
          <Tooltip content="Think again">
            <button type="button" className={styles.synthesisAction} onClick={onRefresh}>
              <RefreshCw size={14} />
            </button>
          </Tooltip>
        </div>
      </div>
      
      {isGenerating ? (
        <p className={styles.thinkingMessage}>{thinkingMessage}</p>
      ) : (
        <>
          <div className={styles.synthesisHook}>
            <MessageMarkdown content={hook} />
          </div>
          
          {detail && (
            <>
              <button 
                type="button" 
                className={styles.expandToggle}
                onClick={() => setIsExpanded(!isExpanded)}
              >
                {isExpanded ? 'Just the headlines' : 'The full picture'} 
                <ChevronRight 
                  size={14} 
                  className={`${styles.expandIcon} ${isExpanded ? styles.expandIconRotated : ''}`} 
                />
              </button>
              
              {isExpanded && (
                <div className={styles.synthesisDetail}>
                  <MessageMarkdown content={detail} />
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
};

interface SpacesActivityPanelProps {
  onOpenFile: (relativePath: string) => void;
  onSelectUseCase?: (prompt: string) => void;
}

export function SpacesActivityPanel({ onOpenFile, onSelectUseCase }: SpacesActivityPanelProps) {
  const { settings, refreshSettings } = useSettings();
  const focus = settings?.spacesActivityFocus;
  
  const [isEditingFocus, setIsEditingFocus] = useState(false);
  const [editFocusValue, setEditFocusValue] = useState(focus ?? '');
  const [isEverythingExpanded, setIsEverythingExpanded] = useState(false);
  
  const { data, isLoading: isLoadingActivity } = useSpaceActivity(7);
  const { 
    synthesis, 
    isGenerating, 
    thinkingMessage, 
    refresh: refreshSynthesis 
  } = useSpacesSynthesis(focus);
  const { contributors } = useSkillContributors();
  const { spacesNeedingValues } = useCompanyValuesStatus();

  // Handle setting focus for the first time
  const handleSetFocus = useCallback(async (newFocus: string) => {
    try {
      // IMPORTANT: settings:update expects a full AppSettings object.
      // Fetch + merge to avoid clobbering other fields (API keys, onboarding, coreDirectory, etc.).
      const current = await window.settingsApi.get();
      await window.settingsApi.update({
        ...current,
        spacesActivityFocus: newFocus,
      });
      await refreshSettings?.();
    } catch (err) {
      console.error('Failed to save focus:', err);
    }
  }, [refreshSettings]);

  // Handle editing focus
  const handleSaveFocus = useCallback(async () => {
    if (editFocusValue.trim()) {
      await handleSetFocus(editFocusValue.trim());
      setIsEditingFocus(false);
    }
  }, [editFocusValue, handleSetFocus]);

  const handleCancelEdit = useCallback(() => {
    setEditFocusValue(focus ?? '');
    setIsEditingFocus(false);
  }, [focus]);

  // Show onboarding if focus not set
  if (!focus) {
    return (
      <div className={styles.container}>
        <FocusOnboarding onSubmit={handleSetFocus} />
      </div>
    );
  }

  // Show focus editing
  if (isEditingFocus) {
    return (
      <div className={styles.container}>
        <div className={styles.editFocus}>
          <label htmlFor="edit-focus" className={styles.editFocusLabel}>
            Paying attention to:
          </label>
          <Input
            id="edit-focus"
            value={editFocusValue}
            onChange={(e) => setEditFocusValue(e.target.value)}
            className={styles.editFocusInput}
            autoFocus
          />
          <div className={styles.editFocusActions}>
            <Button onClick={handleSaveFocus} disabled={!editFocusValue.trim()}>
              Update
            </Button>
            <Button variant="ghost" onClick={handleCancelEdit}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Loading state
  if (isLoadingActivity) {
    return (
      <div className={styles.container}>
        <div className={styles.loadingState}>
          <span className={styles.loadingDot} />
          <span className={styles.loadingDot} />
          <span className={styles.loadingDot} />
        </div>
      </div>
    );
  }

  // Empty state
  if (!data || data.spaces.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            <FolderOpen size={28} />
          </div>
          <p className={styles.emptyTitle}>Nothing to report yet</p>
          <p className={styles.emptyDescription}>
            As we work together, I'll save memories and build skills in your spaces.
            When that starts happening, you'll see it here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* Synthesis section */}
      {synthesis && (
        <SynthesisCard
          hook={synthesis.hook}
          detail={synthesis.detail}
          focus={synthesis.focus}
          isGenerating={isGenerating}
          thinkingMessage={thinkingMessage}
          onEditFocus={() => {
            setEditFocusValue(focus);
            setIsEditingFocus(true);
          }}
          onRefresh={refreshSynthesis}
        />
      )}

      {/* Generating state when no synthesis yet */}
      {!synthesis && isGenerating && (
        <div className={styles.synthesisThinking}>
          <p className={styles.thinkingMessage}>{thinkingMessage}</p>
        </div>
      )}

      {/* Values inline prompt - subtle, woven into synthesis area */}
      {onSelectUseCase && spacesNeedingValues.length > 0 && (
        <div className={styles.valuesInlinePrompt}>
          {spacesNeedingValues.map((space, index) => (
            <span key={space.spacePath}>
              {index > 0 && ' '}
              <span className={styles.valuesSpaceRef}>{space.spaceName}</span>
              {' hasn\'t told me what matters to it yet. '}
              <button
                type="button"
                className={styles.valuesInlineLink}
                onClick={() => onSelectUseCase(`Help me use the skill at @\`rebel-system/skills/thinking/set-company-values/SKILL.md\` for my ${space.spaceName} space`)}
              >
                Set values →
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Thank You Board - skill contributors */}
      <ThankYouBoard contributors={contributors} />

      {/* Activity list - expandable */}
      <div className={styles.activitySection}>
        <button
          type="button"
          className={styles.everythingToggle}
          onClick={() => setIsEverythingExpanded(!isEverythingExpanded)}
        >
          <ChevronRight 
            size={14} 
            className={`${styles.everythingIcon} ${isEverythingExpanded ? styles.everythingIconExpanded : ''}`} 
          />
          <span>Everything</span>
          <span className={styles.everythingCount}>{data.spaces.length} spaces</span>
        </button>
        {isEverythingExpanded && (
          <div className={styles.spaceList}>
            {data.spaces.map((space) => (
              <SpaceCard key={space.spacePath} space={space} onOpenFile={onOpenFile} />
            ))}
          </div>
        )}
      </div>

      {isEverythingExpanded && (
        <footer className={styles.footer}>
          <p className={styles.footerText}>Activity from the last 7 days</p>
        </footer>
      )}
    </div>
  );
}
