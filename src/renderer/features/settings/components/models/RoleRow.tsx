import { useEffect, useState } from 'react';
import { BillingBadge, Button, Notice, Tooltip } from '@renderer/components/ui';
import type { RoleAssignment } from '@core/rebelCore/roleAssignment';
import type { ActiveProvider, AppSettings, ModelProfile } from '@shared/types';
import type { ModelChoice, RoleId } from '@shared/types/modelChoice';
import { roleSupports } from '@shared/types/modelChoice';
import {
  selectHasAnyActiveTurn,
  useSessionStore,
} from '@renderer/features/agent-session/store/sessionStore';
import type { TestResult, TestStateEntry } from './useProfileTester';
import { SettingRow } from '../SettingRow';
import styles from '../SettingsSurface.module.css';
import rowStyles from './RoleRow.module.css';
import { choiceToPickerValue, ModelChoicePicker } from './ModelChoicePicker';

const FALLBACK_TOOLTIP =
  'Used when the primary model is unavailable or returns an error.';
const TURN_IN_FLIGHT_TOOLTIP = 'Edits apply to your next turn.';

type InlineTestStateEntry = TestStateEntry & {
  modelKey?: string;
};

type SecondaryFallbackPickerConfig = {
  role?: RoleId;
  value: ModelChoice;
  htmlFor: string;
  catalogModels: ReadonlyArray<{ value: string; label: string; group?: string }>;
  additionalModelGroups?: ReadonlyArray<{ label: string; options: ReadonlyArray<{ value: string; label: string }> }>;
  profiles?: readonly ModelProfile[];
  offLabel?: string;
};

export interface RoleRowProps {
  role: RoleId;
  label: string;
  tooltip: string;
  htmlFor: string;
  assignment: RoleAssignment;
  onChangePrimary: (next: ModelChoice) => void;
  onChangeFallback: (next: ModelChoice | null) => void;
  catalogModels: ReadonlyArray<{ value: string; label: string; group?: string }>;
  additionalModelGroups?: ReadonlyArray<{ label: string; options: ReadonlyArray<{ value: string; label: string }> }>;
  fallbackCatalogModels: ReadonlyArray<{ value: string; label: string; group?: string }>;
  additionalFallbackGroups?: ReadonlyArray<{ label: string; options: ReadonlyArray<{ value: string; label: string }> }>;
  profiles: readonly ModelProfile[];
  settings: AppSettings;
  codexConnected: boolean;
  activeProvider: ActiveProvider | string | undefined;
  /**
   * Click handler for the inline status CTA ("Pick a model" / "Finish setup").
   * Receives the assignment so the parent can deep-link to the right wizard.
   */
  onStatusCtaClick?: (assignment: RoleAssignment) => void;
  /** Inline uncatalogued-model probe handler. Receives the currently resolved primary choice. */
  onInlineTest?: (choice: ModelChoice, assignment: RoleAssignment) => void | Promise<TestResult>;
  /** Latest state for the inline uncatalogued-model probe. */
  inlineTestState?: InlineTestStateEntry;
  /** Optional inline secondary fallback picker rendered below the primary picker. */
  secondaryFallback?: {
    label: string;
    picker: SecondaryFallbackPickerConfig;
    onChange: (next: ModelChoice) => void;
    warning?: string | null;
    warningCta?: string | null;
    onWarningCtaClick?: () => void;
  };
  /** Optional test/story override. Production defaults to the live agent-session in-flight selector. */
  turnInFlight?: boolean;
}

function displayLine(display: RoleAssignment['display']): string {
  return [display.modelLabel, display.providerLabel].filter(Boolean).join(' · ');
}

export function RoleRow({
  role,
  label,
  tooltip,
  htmlFor,
  assignment,
  onChangePrimary,
  onChangeFallback,
  catalogModels,
  additionalModelGroups,
  fallbackCatalogModels,
  additionalFallbackGroups,
  profiles,
  settings,
  codexConnected,
  activeProvider,
  onStatusCtaClick,
  onInlineTest,
  inlineTestState,
  secondaryFallback,
  turnInFlight,
}: RoleRowProps) {
  const liveTurnInFlight = useSessionStore(selectHasAnyActiveTurn);
  const effectiveTurnInFlight = turnInFlight ?? liveTurnInFlight;
  const [showFallback, setShowFallback] = useState(Boolean(assignment.fallback));
  const supportsFallback = role !== 'recovery';
  const showInlineTest = assignment.isUncatalogued === true && assignment.primary.kind === 'model' && !!onInlineTest;
  const currentModelKey = assignment.primary.kind === 'model' ? choiceToPickerValue(assignment.primary) : null;
  const inlineTestBelongsToCurrentChoice =
    currentModelKey !== null && inlineTestState?.modelKey === currentModelKey;
  const inlineTestFailed = inlineTestBelongsToCurrentChoice && inlineTestState?.result?.success === false;
  const inlineTestError = inlineTestFailed ? inlineTestState?.result?.error : null;

  useEffect(() => {
    setShowFallback(Boolean(assignment.fallback));
  }, [assignment.fallback]);

  const selectedText = displayLine(assignment.display);
  const fallbackValue = assignment.fallback ?? { kind: 'off' as const };
  const secondaryFallbackControl = secondaryFallback ? (
    <div
      className={rowStyles.secondaryFallback}
      data-testid={`settings-role-row-${role}-secondary-fallback`}
      title={effectiveTurnInFlight ? TURN_IN_FLIGHT_TOOLTIP : undefined}
      tabIndex={effectiveTurnInFlight ? 0 : undefined}
    >
      <label
        htmlFor={secondaryFallback.picker.htmlFor}
        className={rowStyles.secondaryFallbackLabel}
      >
        {secondaryFallback.label}
      </label>
      <ModelChoicePicker
        role={secondaryFallback.picker.role ?? role}
        value={secondaryFallback.picker.value}
        onChange={secondaryFallback.onChange}
        profiles={secondaryFallback.picker.profiles ?? profiles}
        catalogModels={secondaryFallback.picker.catalogModels}
        additionalModelGroups={secondaryFallback.picker.additionalModelGroups}
        settings={settings}
        codexConnected={codexConnected}
        activeProvider={activeProvider}
        htmlFor={secondaryFallback.picker.htmlFor}
        includeOffOption
        offLabel={secondaryFallback.picker.offLabel}
        disabled={effectiveTurnInFlight}
      />
      {secondaryFallback.warning && (
        <div
          style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}
          data-testid={`settings-role-row-${role}-secondary-fallback-warning`}
        >
          <span className={styles.modelConfigHint}>{secondaryFallback.warning}</span>
          {secondaryFallback.warningCta && secondaryFallback.onWarningCtaClick && (
            <Button
              type="button"
              variant="default"
              size="xs"
              onClick={secondaryFallback.onWarningCtaClick}
              data-testid={`settings-role-row-${role}-secondary-fallback-cta`}
            >
              {secondaryFallback.warningCta}
            </Button>
          )}
        </div>
      )}
    </div>
  ) : null;

  return (
    <SettingRow
      label={label}
      tooltip={tooltip}
      htmlFor={htmlFor}
      data-testid={`settings-role-row-${role}`}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
            Selected: <span style={{ color: 'var(--color-text)' }}>{selectedText}</span>
          </span>
          {assignment.display.billingSource && <BillingBadge source={assignment.display.billingSource} />}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
          <ModelChoicePicker
            role={role}
            value={assignment.primary}
            onChange={onChangePrimary}
            profiles={profiles}
            catalogModels={catalogModels}
            additionalModelGroups={additionalModelGroups}
            settings={settings}
            codexConnected={codexConnected}
            activeProvider={activeProvider}
            htmlFor={htmlFor}
            includeSpecialValues
          />
          {showInlineTest && (
            <Button
              type="button"
              variant={inlineTestFailed ? 'destructive' : 'ghost'}
              size="xs"
              onClick={() => onInlineTest(assignment.primary, assignment)}
              disabled={inlineTestBelongsToCurrentChoice && inlineTestState?.testing === true}
              style={{ flexShrink: 0 }}
              data-testid={`settings-role-row-${role}-inline-test`}
            >
              Test
            </Button>
          )}
        </div>

        {inlineTestError && (
          <Notice
            tone="error"
            density="compact"
            placement="inline"
            data-testid={`settings-role-row-${role}-inline-test-error`}
          >
            {inlineTestError}
          </Notice>
        )}

        {secondaryFallbackControl && (
          effectiveTurnInFlight
            ? <Tooltip content={TURN_IN_FLIGHT_TOOLTIP}>{secondaryFallbackControl}</Tooltip>
            : secondaryFallbackControl
        )}

        {assignment.warning && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span className={styles.modelConfigHint}>{assignment.warning}</span>
            {assignment.warningCta && onStatusCtaClick && (
              <Button
                type="button"
                variant="default"
                size="xs"
                onClick={() => onStatusCtaClick(assignment)}
                data-testid={`settings-role-row-${role}-status-cta`}
              >
                {assignment.warningCta}
              </Button>
            )}
          </div>
        )}

        {supportsFallback && !showFallback && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setShowFallback(true)}
            style={{ alignSelf: 'flex-start' }}
            aria-label="Add availability fallback"
            data-testid={`settings-role-row-${role}-add-fallback`}
          >
            + Add availability fallback
          </Button>
        )}

        {supportsFallback && showFallback && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' }}>
            <Tooltip content={FALLBACK_TOOLTIP}>
              <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', width: 'fit-content', cursor: 'help' }}>
                Availability fallback
              </span>
            </Tooltip>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
              <ModelChoicePicker
                role={role}
                value={fallbackValue}
                onChange={(next) => onChangeFallback(next.kind === 'off' ? null : next)}
                profiles={profiles}
                catalogModels={fallbackCatalogModels}
                additionalModelGroups={additionalFallbackGroups}
                settings={settings}
                codexConnected={codexConnected}
                activeProvider={activeProvider}
                htmlFor={`${htmlFor}-fallback`}
                includeOffOption
              />
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  onChangeFallback(null);
                  setShowFallback(false);
                }}
                style={{ whiteSpace: 'nowrap' }}
                data-testid={`settings-role-row-${role}-remove-fallback`}
              >
                × Remove
              </Button>
            </div>
            {assignment.fallbackDisplay && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                  Availability fallback: <span style={{ color: 'var(--color-text)' }}>{displayLine(assignment.fallbackDisplay)}</span>
                </span>
                {assignment.fallbackDisplay.billingSource && (
                  <BillingBadge source={assignment.fallbackDisplay.billingSource} />
                )}
              </div>
            )}
          </div>
        )}

        {role === 'recovery' && (roleSupports(role, 'auto') || roleSupports(role, 'off')) && (
          <span className={styles.modelConfigHint}>
            Recovery is already the fallback, so there is no second fallback here.
          </span>
        )}
      </div>
    </SettingRow>
  );
}
