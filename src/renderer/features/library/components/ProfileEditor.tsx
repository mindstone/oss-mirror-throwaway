import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageCircle, FileText, Lock, ArrowLeft,
  Briefcase, Target, MessageSquare, Clock, type LucideIcon,
} from 'lucide-react';
import { Badge, Button, Tooltip } from '@renderer/components/ui';
import { tracking } from '@renderer/src/tracking';
import { useProfileData } from '../hooks/useProfileData';
import { extractContentForSection } from '../utils/profileSections';
import { ProfileSection } from './ProfileSection';
import styles from './ProfileEditor.module.css';

const PROFILE_SECTION_CONFIG: ReadonlyArray<{
  id: string;
  heading: string;
  subtitle: string;
  prompt: string;
  placeholder: string;
  icon: LucideIcon;
}> = [
  {
    id: 'role',
    heading: 'Role & Context',
    subtitle: 'Helps Rebel tailor responses to your industry, role, and team',
    prompt: 'What do you do? What company or team are you part of?',
    placeholder:
      "e.g., I'm a Product Manager at Acme Corp, leading the Growth team...",
    icon: Briefcase,
  },
  {
    id: 'goals',
    heading: 'Goals & Priorities',
    subtitle: 'So Rebel aligns suggestions with what you\'re actually working toward',
    prompt: 'What are you working toward right now?',
    placeholder:
      'e.g., Ship v2 by end of Q2, improve onboarding conversion by 15%...',
    icon: Target,
  },
  {
    id: 'communication',
    heading: 'Communication Preferences',
    subtitle: 'Rebel adjusts its tone, format, and detail level based on this',
    prompt: 'How should Rebel communicate with you?',
    placeholder:
      'e.g., Be direct and concise. Skip the preamble. Use bullet points when possible...',
    icon: MessageSquare,
  },
  {
    id: 'working-style',
    heading: 'Working Style',
    subtitle: 'Helps Rebel respect your schedule and work patterns',
    prompt: 'How do you prefer to work?',
    placeholder:
      'e.g., Mornings are for deep focus. I prefer async communication over meetings...',
    icon: Clock,
  },
];

const FILLED_THRESHOLD = 10;

type ProfileEditorProps = {
  filePath: string | null;
  onAsk: () => void;
  onOpenFolder: () => void;
  onBack: () => void;
  onOpenReadme?: () => void;
  askDisabled?: boolean;
};

export function ProfileEditor({
  filePath,
  onAsk,
  onOpenFolder,
  onBack,
  onOpenReadme,
  askDisabled,
}: ProfileEditorProps) {
  const { profile, isLoading, updateSectionAt, addSection, completionPercent } =
    useProfileData(filePath);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  const toggleSection = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const displaySections = useMemo(() => {
    return PROFILE_SECTION_CONFIG.map((config) => {
      const idx =
        profile?.sections.findIndex((s) => s.id === config.id) ?? -1;
      const section = idx >= 0 && profile ? profile.sections[idx] : undefined;

      let value = section?.body ?? '';

      if (!value.trim() && profile) {
        value = extractContentForSection(profile, config.id);
      }

      return {
        key: `known-${config.id}`,
        heading: section?.heading ?? config.heading,
        subtitle: config.subtitle,
        prompt: config.prompt,
        placeholder: config.placeholder,
        value,
        profileIndex: idx >= 0 ? idx : null,
        configId: config.id,
        icon: config.icon,
        isFilled: value.trim().length > FILLED_THRESHOLD,
      };
    });
  }, [profile]);

  const editedSectionsRef = useRef<Set<string>>(new Set());
  const prevCompletionRef = useRef<number>(0);

  const handleSectionChange = useCallback(
    (configId: string, profileIndex: number | null, value: string) => {
      if (profileIndex !== null) {
        updateSectionAt(profileIndex, value);
      } else {
        const config = PROFILE_SECTION_CONFIG.find((c) => c.id === configId);
        if (config) addSection(configId, config.heading, value);
      }

      const isFirstEdit = !editedSectionsRef.current.has(configId);
      editedSectionsRef.current.add(configId);
      tracking.library.profileSectionEdited(configId, value.length, isFirstEdit, completionPercent);
    },
    [updateSectionAt, addSection, completionPercent],
  );

  const filledCount = displaySections.filter((s) => s.isFilled).length;

  const isEmpty =
    !profile || (!profile.preamble && profile.sections.length === 0);

  const handleAsk = useCallback(() => {
    if (askDisabled) return;
    tracking.library.profileCtaClicked('interview', completionPercent);
    tracking.library.profileInterviewStarted();
    onAsk();
  }, [askDisabled, onAsk, completionPercent]);

  useEffect(() => {
    if (prevCompletionRef.current !== completionPercent && prevCompletionRef.current > 0) {
      tracking.library.profileCompletionChanged(prevCompletionRef.current, completionPercent, 'section_edit');
    }
    prevCompletionRef.current = completionPercent;
  }, [completionPercent]);

  const expandedKeysRef = useRef(expandedKeys);
  expandedKeysRef.current = expandedKeys;
  useEffect(() => {
    const start = Date.now();
    const expandedRef = expandedKeysRef;
    const editedRef = editedSectionsRef;
    return () => {
      const durationMs = Date.now() - start;
      if (durationMs > 1000) {
        tracking.library.profileTimeSpent(
          durationMs,
          expandedRef.current.size,
          editedRef.current.size,
        );
      }
    };
  }, []);

  if (isLoading) {
    return (
      <div className={styles.scrollWrapper} data-testid="chief-of-staff-overview">
        <div className={styles.container}>
          <div className={styles.loadingState}>Loading profile…</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.scrollWrapper} data-testid="chief-of-staff-overview">
      <div className={styles.container}>
        {/* Header */}
        <header className={styles.pageHeader}>
          {onBack && (
            <button type="button" className={styles.backButton} onClick={onBack} aria-label="Back">
              <ArrowLeft size={16} />
              <span>Back</span>
            </button>
          )}
          <div className={styles.titleRow}>
            <h2 className={styles.pageTitle}>
              {isEmpty ? 'Help Rebel understand you' : 'Your Profile'}
            </h2>
            <Badge variant="secondary" className={styles.privacyBadge}>
              <Lock size={10} aria-hidden />
              Private
            </Badge>
          </div>
          <p className={styles.pageDescription}>
            {isEmpty
              ? "The more Rebel knows about you, the better it can help. Start with the basics — you can always add more later."
              : 'Rebel reads this at the start of every conversation so you never have to repeat yourself.'}
          </p>
        </header>

        {/* Completion indicator */}
        {!isEmpty && (
          <div className={styles.completionRow}>
            <div className={styles.completionRing}>
              <svg viewBox="0 0 36 36" className={styles.completionSvg}>
                <circle
                  cx="18" cy="18" r="15.5"
                  fill="none"
                  stroke="var(--color-border)"
                  strokeWidth="3"
                />
                <circle
                  cx="18" cy="18" r="15.5"
                  fill="none"
                  stroke="var(--color-primary)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={`${completionPercent * 0.975} 100`}
                  transform="rotate(-90 18 18)"
                />
              </svg>
            </div>
            <span className={styles.completionText}>
              {completionPercent}%
            </span>
            <span className={styles.completionHint}>
              {completionPercent < 60
                ? 'Fill in more so Rebel can personalise every response'
                : completionPercent < 100
                  ? 'Almost there — a fuller profile means better answers'
                  : 'Rebel knows you well'}
            </span>
          </div>
        )}

        {/* Interview CTA */}
        <div className={styles.interviewBlock}>
          <Tooltip
            content={
              askDisabled
                ? 'Start a conversation first'
                : 'Have Rebel interview you about your preferences'
            }
            placement="bottom"
          >
            <span>
              <Button size="sm" onClick={handleAsk} disabled={askDisabled}>
                <MessageCircle size={14} />
                Let Rebel interview you
              </Button>
            </span>
          </Tooltip>
          <p className={styles.interviewExplainer}>
            Have a quick chat and Rebel fills in the sections below for you.
          </p>
        </div>

        {/* Section heading */}
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>What Rebel learns from you</h3>
          <span className={styles.sectionCount}>
            {filledCount} of {PROFILE_SECTION_CONFIG.length} complete
          </span>
        </div>

        {/* Only the 4 human-facing sections */}
        <div className={styles.sections}>
          {displaySections.map((section) => (
            <ProfileSection
              key={section.key}
              heading={section.heading}
              subtitle={section.subtitle}
              prompt={section.prompt}
              placeholder={section.placeholder}
              value={section.value}
              icon={section.icon}
              isFilled={section.isFilled}
              onChange={(val) =>
                handleSectionChange(section.configId, section.profileIndex, val)
              }
              onInterview={!askDisabled ? handleAsk : undefined}
              isExpanded={expandedKeys.has(section.key)}
              onToggle={() => toggleSection(section.key)}
            />
          ))}
        </div>

        {/* Footer links */}
        {(onOpenReadme !== undefined || onOpenFolder !== undefined) && (
          <div className={styles.footerLinks}>
            {onOpenReadme && (
              <Button variant="ghost" size="sm" className={styles.footerLink} onClick={onOpenReadme}>
                <FileText size={13} />
                View profile file
              </Button>
            )}
            {onOpenFolder && (
              <Button variant="ghost" size="sm" className={styles.footerLink} onClick={onOpenFolder}>
                View files
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
