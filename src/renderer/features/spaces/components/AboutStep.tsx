/**
 * AboutStep Component
 *
 * Step 2 of the Add Space Wizard. User reviews and edits space metadata
 * including name, description, category, sharing level, and storage provider.
 */

import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import {
  HelpCircle,
  Sparkles,
  FileText,
  Loader2,
  HardDrive,
  Cloud,
  Info,
  AlertCircle,
} from 'lucide-react';
import {
  Button,
  Textarea,
  Label,
  Input,
  Badge,
  Tooltip,
  RichSelect,
} from '@renderer/components/ui';
import type {
  SpaceStorageProvider,
  SpaceSharingLevel,
  InferredCategory,
  DescriptionSource,
} from '@shared/ipc/schemas/library';
import styles from './AddSpaceWizard.module.css';

/**
 * Category dropdown options
 */
const CATEGORY_OPTIONS: Array<{
  value: InferredCategory;
  label: string;
  description: string;
}> = [
  { value: 'unknown', label: 'Not specified', description: "No category — Rebel won’t make assumptions." },
  { value: 'personal', label: 'Personal', description: 'For your own use. Typically not shared.' },
  { value: 'work', label: 'Work', description: 'For a team or organization. Often shared.' },
];

/**
 * Sharing level dropdown options
 * Note: 'team' is deprecated in favor of 'restricted' - accepting both for backward compatibility
 */
const SHARING_OPTIONS: Array<{ value: SpaceSharingLevel; label: string; description: string }> = [
  {
    value: 'private',
    label: 'Private — Just you',
    description: 'Only you can access. Rebel can save memories here automatically.',
  },
  {
    value: 'restricted',
    label: 'Restricted — Small group',
    description: 'Shared with a few people. Rebel will check before saving memories.',
  },
  {
    value: 'company-wide',
    label: 'Company-wide — Whole organization',
    description: 'Visible to everyone in your organization. Rebel will check before saving memories.',
  },
  {
    value: 'public',
    label: 'Public — Anyone',
    description: 'Visible to anyone with access. Rebel will be cautious and check before saving.',
  },
];

export interface AboutStepProps {
  /** Space name (pre-filled from folder name) */
  name: string;
  /** Selected folder path */
  path?: string | null;
  /** Space description (generated or user-edited) */
  description: string;
  /** Source of the description */
  descriptionSource: DescriptionSource | 'user';
  /** Whether description is being generated */
  descriptionLoading: boolean;
  /** Detected storage provider */
  storageProvider: SpaceStorageProvider;
  /** Sharing level */
  sharing: SpaceSharingLevel;
  /** Inferred category (personal/work/unknown) */
  category: InferredCategory;
  /** Organisation grouping label */
  organisation: string;
  /** Handler for name changes (only used in create mode before confirmation) */
  onNameChange: (name: string) => void;
  /** Handler for description changes */
  onDescriptionChange: (description: string) => void;
  /** Handler to regenerate AI description */
  onRegenerateDescription: () => Promise<void>;
  /** Handler for sharing level changes */
  onSharingChange: (sharing: SpaceSharingLevel) => void;
  /** Handler for category changes */
  onCategoryChange: (category: InferredCategory) => void;
  /** Handler for organisation changes */
  onOrganisationChange: (organisation: string) => void;
  /** Whether we're editing an existing space */
  isEditMode?: boolean;
  /**
   * Whether we're adding an existing space with pre-populated frontmatter.
   * When true and sharedMetadataUnlocked is false: description, category, and sharing
   * are read-only (from shared README.md). Memory safety is derived from sharing level.
   */
  isAddExistingMode?: boolean;
  /** Whether user has unlocked editing of shared metadata in add-existing mode */
  sharedMetadataUnlocked?: boolean;
  /** Callback to unlock shared metadata editing */
  onUnlockSharedMetadata?: () => void;
  /** Absolute path to the space folder (for reveal in folder) */
  absolutePath?: string;
  /** Associated email accounts (e.g., 'you@example.com', 'company.com' for domain wildcard) */
  emails?: string[];
  /** Handler for email changes */
  onEmailsChange?: (emails: string[]) => void;
  /** Handler for email validation errors state change */
  onEmailErrorsChange?: (hasErrors: boolean) => void;
  /** Handler to change folder (only in create mode) */
  onChangeFolder?: () => void;
}

/**
 * Get display label for storage provider
 */
function getStorageProviderLabel(provider: SpaceStorageProvider): string {
  switch (provider) {
    case 'google_drive':
      return 'Google Drive';
    case 'onedrive':
      return 'OneDrive';
    case 'dropbox':
      return 'Dropbox';
    case 'box':
      return 'Box';
    case 'icloud':
      return 'iCloud Drive';
    case 'local':
      return 'Local';
    case 'other':
      return 'Other';
    default:
      return 'Unknown';
  }
}

/**
 * Get description source hint text
 */
function getDescriptionSourceHint(source: DescriptionSource | 'user'): string | null {
  switch (source) {
    case 'haiku':
      return 'Generated by AI';
    case 'readme':
      return 'From README.md';
    case 'fallback':
      return 'Add a description so Rebel knows how to use this space';
    case 'user':
      return null; // User-edited, no hint needed
    default:
      return null;
  }
}

/**
 * Get display label for category
 */
function getCategoryLabel(category: InferredCategory): string {
  const option = CATEGORY_OPTIONS.find((opt) => opt.value === category);
  return option?.label ?? 'Unknown';
}

/**
 * Get display label for sharing level
 */
function getSharingLabel(sharing: SpaceSharingLevel): string {
  const option = SHARING_OPTIONS.find((opt) => opt.value === sharing);
  return option?.label ?? 'Unknown';
}

// Simple email regex - validates basic structure: [external-email]
// Permissive but excludes obvious issues like consecutive dots
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Bare domain regex - validates domain.tld format (no @ symbol)
// Allows: alphanumeric, hyphens, dots for subdomains
// Rejects: slashes, colons, hashes, and other special characters
const BARE_DOMAIN_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

// Additional check: no consecutive dots in domain
const hasConsecutiveDots = (str: string): boolean => str.includes('..');

/**
 * Normalize a single email entry:
 * - Trim whitespace
 * - Replace smart quotes with regular quotes
 * - Strip surrounding quotes (but preserve internal structure)
 * - Convert legacy formats to bare domain:
 *   - *@domain.com → domain.com
 *   - @domain.com → domain.com
 */
function normalizeEmailEntry(entry: string): string {
  let normalized = entry.trim();
  // Replace smart quotes with regular quotes
  normalized = normalized.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  // Strip surrounding quotes (single or double)
  if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1).trim();
  }
  // Convert legacy *@domain.com to bare domain.com
  if (normalized.startsWith('*@')) {
    normalized = normalized.slice(2); // Remove the *@
  }
  // Convert legacy @domain.com to bare domain.com (only if no local part)
  // Check: starts with @ and has no other @ (it's a wildcard, not an email)
  else if (normalized.startsWith('@') && normalized.indexOf('@', 1) === -1) {
    normalized = normalized.slice(1); // Remove the leading @
  }
  return normalized;
}

/**
 * Validate a single email or domain wildcard entry.
 * - Domain wildcards (domain.com - no @): validate domain structure
 * - Regular emails ([external-email] - contains @): validate email structure
 * - Reject legacy formats (* or @ prefix) with helpful error messages
 */
function validateEmailEntry(entry: string): { valid: boolean; error?: string } {
  const normalized = normalizeEmailEntry(entry);
  if (!normalized) return { valid: true }; // Empty entries are filtered out
  
  // Check for consecutive dots (invalid in all cases)
  if (hasConsecutiveDots(normalized)) {
    return { valid: false, error: `Invalid format (consecutive dots): ${normalized}` };
  }
  
  // Reject legacy *@domain.com format with helpful message
  // (After normalization, this would already be converted, but check original entry)
  const trimmedEntry = entry.trim();
  if (trimmedEntry.startsWith('*@') || trimmedEntry.startsWith('"*@') || trimmedEntry.startsWith("'*@")) {
    return { valid: false, error: `Wildcards are now written as domain.com (no *). Example: example.com` };
  }
  
  // Reject legacy @domain.com format (after stripping quotes)
  // Only if it's a wildcard pattern (single @ at the start, no email-like structure)
  let unquoted = trimmedEntry;
  if ((unquoted.startsWith('"') && unquoted.endsWith('"')) || (unquoted.startsWith("'") && unquoted.endsWith("'"))) {
    unquoted = unquoted.slice(1, -1);
  }
  if (unquoted.startsWith('@') && unquoted.indexOf('@', 1) === -1) {
    return { valid: false, error: `Wildcards are now written as domain.com (no @). Example: example.com` };
  }
  
  // Reject any entry still starting with * after normalization
  if (normalized.startsWith('*')) {
    return { valid: false, error: `* isn't valid here. Use domain.com for a wildcard, or [external-email] for a specific email.` };
  }
  
  // If normalized contains @, it's an email - validate as email
  if (normalized.includes('@')) {
    if (EMAIL_REGEX.test(normalized)) {
      return { valid: true };
    }
    return { valid: false, error: `Invalid email format: ${normalized}. Example: you@example.com` };
  }
  
  // No @ means it's a domain wildcard - validate as bare domain
  if (BARE_DOMAIN_REGEX.test(normalized)) {
    return { valid: true };
  }
  return { valid: false, error: `Invalid domain: ${normalized}. Use a bare domain like example.com` };
}

/**
 * Parse textarea input into email entries and validate them.
 * Returns normalized entries and any validation errors.
 */
function parseAndValidateEmails(rawText: string): {
  entries: string[];
  errors: string[];
} {
  const lines = rawText.split('\n');
  const entries: string[] = [];
  const errors: string[] = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue; // Skip empty lines
    
    // Validate original entry (to detect legacy formats like *@ and @)
    const validation = validateEmailEntry(trimmed);
    if (validation.valid) {
      // Store normalized version (legacy formats get converted)
      const normalized = normalizeEmailEntry(trimmed);
      // Skip entries that normalize to empty (e.g., "" or '')
      if (normalized) {
        entries.push(normalized);
      }
    } else if (validation.error) {
      errors.push(validation.error);
    }
  }
  
  return { entries, errors };
}

/**
 * AboutStep - Space configuration form
 *
 * Shows space details and editable settings. Name is always read-only
 * (reflects folder name on disk). In create mode, allows changing folder.
 *
 * @example
 * <AboutStep
 *   name="Projects"
 *   path="/Users/me/Drive/Projects"
 *   description="Shared project files and documentation"
 *   descriptionSource="haiku"
 *   descriptionLoading={false}
 *   storageProvider="google_drive"
 *   sharing="team"
 *   category="work"
 *   onNameChange={(name) => setState({ name })}
 *   onDescriptionChange={(desc) => setState({ description: desc })}
 *   onRegenerateDescription={regenerateDescription}
 *   onSharingChange={(sharing) => setState({ sharing })}
 *   onCategoryChange={(category) => setState({ category })}
 * />
 */
export const AboutStep = ({
  name,
  path,
  description,
  descriptionSource,
  descriptionLoading,
  storageProvider,
  sharing,
  category,
  organisation,
  onNameChange: _onNameChange, // Unused - name is always read-only now
  onDescriptionChange,
  onRegenerateDescription: _onRegenerateDescription, // Kept for API compatibility
  onSharingChange,
  onCategoryChange,
  onOrganisationChange,
  isEditMode = false,
  isAddExistingMode = false,
  sharedMetadataUnlocked = false,
  onUnlockSharedMetadata,
  absolutePath,
  emails = [],
  onEmailsChange,
  onEmailErrorsChange,
  onChangeFolder,
}: AboutStepProps) => {
  // In add-existing mode, fields are read-only unless user has unlocked editing
  const isSharedFieldsLocked = isAddExistingMode && !sharedMetadataUnlocked;
  
  // Local state for email textarea (raw text while editing)
  const [emailsRaw, setEmailsRaw] = useState(() => emails.join('\n'));
  const [emailErrors, setEmailErrors] = useState<string[]>([]);
  // Track the last emails prop to detect external changes
  const lastEmailsPropRef = useRef(emails);
  
  // Sync emailsRaw when emails prop changes externally (e.g., initial load, mode change)
  // Only sync when prop actually changed (avoid cursor jump during editing)
  useEffect(() => {
    const propChanged = JSON.stringify(lastEmailsPropRef.current) !== JSON.stringify(emails);
    if (propChanged) {
      lastEmailsPropRef.current = emails;
      // Sync on external change and validate (in case of corrupt frontmatter)
      const rawText = emails.join('\n');
      setEmailsRaw(rawText);
      const { errors } = parseAndValidateEmails(rawText);
      setEmailErrors(errors);
      onEmailErrorsChange?.(errors.length > 0);
    }
  }, [emails, onEmailErrorsChange]);
  
  // Handle email input changes with immediate validation and propagation (no debounce)
  const handleEmailsRawChange = useCallback((value: string) => {
    setEmailsRaw(value);
    
    // Validate and propagate immediately
    const { entries, errors } = parseAndValidateEmails(value);
    setEmailErrors(errors);
    onEmailErrorsChange?.(errors.length > 0);
    
    // Always update parent with valid entries (even if some entries have errors)
    // This ensures state is always in sync
    // Update ref to prevent useEffect from resyncing (would cause cursor jump)
    lastEmailsPropRef.current = entries;
    onEmailsChange?.(entries);
  }, [onEmailsChange, onEmailErrorsChange]);
  
  // Normalize on blur (clean up the raw text to show normalized entries)
  const handleEmailsBlur = useCallback(() => {
    const { entries, errors } = parseAndValidateEmails(emailsRaw);
    setEmailErrors(errors);
    onEmailErrorsChange?.(errors.length > 0);
    
    // Update raw text to normalized version (one entry per line)
    // This shows the user the cleaned-up format (e.g., *@domain.com → domain.com)
    if (errors.length === 0) {
      setEmailsRaw(entries.join('\n'));
    }
    // Update ref to prevent useEffect from resyncing
    lastEmailsPropRef.current = entries;
    onEmailsChange?.(entries);
  }, [emailsRaw, onEmailsChange, onEmailErrorsChange]);
  

  const descriptionHint = useMemo(
    () => getDescriptionSourceHint(descriptionSource),
    [descriptionSource]
  );

  const storageProviderLabel = useMemo(
    () => getStorageProviderLabel(storageProvider),
    [storageProvider]
  );

  const isCloudStorage = storageProvider !== 'local' && storageProvider !== 'other';

  const handleRevealInFolder = useCallback(async () => {
    if (!absolutePath) return;
    try {
      await window.appApi.revealPath(absolutePath);
    } catch (err) {
      console.error('Failed to reveal path:', err);
    }
  }, [absolutePath]);

  return (
    <div className={styles.stepContent}>
      {/* Info banner for add-existing mode */}
      {isAddExistingMode && (
        <div className={isSharedFieldsLocked ? styles.addExistingBanner : styles.infoNote}>
          <Info size={16} className={styles.infoNoteIcon} />
          <div className={styles.infoNoteContent}>
            {isSharedFieldsLocked ? (
              <>
                <span className={styles.infoNoteText}>
                  Prefilled shared space settings from team configuration.
                  Associated Accounts are local to you and can still be edited.
                </span>
                {onUnlockSharedMetadata && (
                  <button
                    type="button"
                    className={styles.editMetadataLink}
                    onClick={onUnlockSharedMetadata}
                  >
                    Edit shared settings
                  </button>
                )}
              </>
            ) : (
              <span className={styles.infoNoteText}>
                Editing enabled. If this space is shared, others will see your changes.
              </span>
            )}
          </div>
        </div>
      )}

      {/* Folder header - shows name + storage badge */}
      <div className={styles.folderHeader}>
        <div className={styles.folderInfo}>
          <div className={styles.folderNameRow}>
            <span className={styles.folderName}>{name}</span>
            <Badge variant="secondary" className={styles.storageProviderBadge}>
              {isCloudStorage ? <Cloud size={14} /> : <HardDrive size={14} />}
              {storageProviderLabel}
            </Badge>
          </div>
          {(absolutePath || path) && (
            <div className={styles.folderPath}>{absolutePath || path}</div>
          )}
        </div>
        <div className={styles.folderActions}>
          {onChangeFolder && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onChangeFolder}
              className={styles.changeFolderButton}
            >
              Change
            </Button>
          )}
          {isEditMode && absolutePath && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleRevealInFolder()}
              className={styles.revealButton}
            >
              Reveal
            </Button>
          )}
        </div>
      </div>

      {/* Description field */}
      <div className={styles.formField}>
        <div className={styles.descriptionLabelRow}>
          <div className={styles.labelWithTooltip}>
            <Label htmlFor="space-description">Description</Label>
            <Tooltip content="Rebel uses this to decide where to save memories and find relevant files. Be specific about what this space contains.">
              <HelpCircle size={14} className={styles.helpIconInline} />
            </Tooltip>
          </div>
          {/* Source hint aligned with label row */}
          {!isSharedFieldsLocked && !descriptionLoading && descriptionHint && descriptionSource !== 'fallback' && (
            <span className={styles.sourceHintInline}>
              {descriptionSource === 'haiku' && <Sparkles size={12} />}
              {descriptionSource === 'readme' && <FileText size={12} />}
              {descriptionHint}
            </span>
          )}
        </div>

        {isSharedFieldsLocked ? (
          /* Read-only description when shared metadata is locked */
          <div className={styles.readOnlyDescription}>
            {description || <span className={styles.emptyPlaceholder}>No description</span>}
          </div>
        ) : descriptionLoading ? (
          <div className={styles.descriptionLoading}>
            <Loader2 size={16} className={styles.spinnerIcon} />
            <span>Generating description...</span>
          </div>
        ) : (
          <>
            {/* Attention banner for empty folders (fallback description) */}
            {descriptionSource === 'fallback' && (
              <div className={styles.descriptionWarning}>
                <AlertCircle size={16} className={styles.descriptionWarningIcon} />
                <span>
                  This folder is empty. Add a detailed description so Rebel knows what you'll use this space for.
                </span>
              </div>
            )}
            <Textarea
              id="space-description"
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              placeholder="What will you use this space for? e.g., Client projects for Acme Corp, personal finance tracking..."
              rows={3}
              className={styles.descriptionTextarea}
            />
          </>
        )}
      </div>

      {/* Divider */}
      <div className={styles.sectionDivider} />

      {/* Organisation field */}
      <div className={styles.formField}>
        <Label htmlFor="space-organisation">Organisation</Label>
        {isSharedFieldsLocked ? (
          <div className={styles.readOnlyField}>
            {organisation.trim() || <span className={styles.emptyPlaceholder}>Not set</span>}
          </div>
        ) : (
          <>
            <Input
              id="space-organisation"
              value={organisation}
              onChange={(event) => onOrganisationChange(event.target.value)}
              placeholder="e.g., Mindstone"
            />
            <p className={styles.fieldHelpText}>
              Group this space with related work, like a company or client. It applies to this space only, not a shared account, and you can clear it by leaving it blank.
            </p>
          </>
        )}
      </div>

      {/* Divider */}
      <div className={styles.sectionDivider} />

      {/* Category and Sharing in two-column layout */}
      <div className={styles.twoColumnRow}>
        {/* Category selector */}
        <div className={styles.formField}>
          <Label htmlFor="space-category">Category</Label>
          {isSharedFieldsLocked ? (
            /* Read-only category when shared metadata is locked */
            <div className={styles.readOnlyField}>{getCategoryLabel(category)}</div>
          ) : (
            <RichSelect
              value={category}
              onChange={(value) => onCategoryChange(value as InferredCategory)}
              options={CATEGORY_OPTIONS}
            />
          )}
        </div>

        {/* Sharing selector */}
        <div className={styles.formField}>
          <Label htmlFor="space-sharing">Sharing</Label>
          {isSharedFieldsLocked ? (
            /* Read-only sharing when shared metadata is locked */
            <div className={styles.readOnlyField}>{getSharingLabel(sharing)}</div>
          ) : (
            <RichSelect
              value={sharing}
              onChange={(value) => onSharingChange(value as SpaceSharingLevel)}
              options={SHARING_OPTIONS}
            />
          )}
        </div>
      </div>

      {/* Divider */}
      <div className={styles.sectionDivider} />

      {/* Associated accounts (emails) field */}
      <div className={styles.formField}>
        <div className={styles.labelWithTooltip}>
          <Label htmlFor="space-emails">Associated Accounts</Label>
          <Tooltip 
            content={
              <div>
                <p>Associate email accounts with this Space so Rebel knows which connected services are relevant.</p>
                <p style={{ marginTop: '0.5rem' }}>Use <code>domain.com</code> (without @) to match all emails at a domain.</p>
                <p style={{ marginTop: '0.5rem', opacity: 0.8 }}>Example: <code>you@example.com</code> or <code>example.com</code></p>
              </div>
            }
          >
            <HelpCircle size={14} className={styles.helpIconInline} />
          </Tooltip>
        </div>
        <Textarea
          id="space-emails"
          value={emailsRaw}
          onChange={(e) => handleEmailsRawChange(e.target.value)}
          onBlur={handleEmailsBlur}
          placeholder="One email or domain per line (e.g., [external-email] or company.com)"
          rows={2}
          className={emailErrors.length > 0 ? styles.inputError : undefined}
        />
        {emailErrors.length > 0 && (
          <div className={styles.validationErrors}>
            {emailErrors.map((error, i) => (
              <span key={i} className={styles.errorText}>
                {error}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
