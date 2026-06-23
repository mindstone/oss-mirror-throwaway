import { Bot, Check, Copy, ExternalLink, Loader2 } from 'lucide-react';

import { Button, InlineToggle, Input, Notice, Select, Tooltip } from '@renderer/components/ui';
import type { ConnectorCatalogEntry } from '@shared/types';

import styles from './SettingsSurface.module.css';

type SetupField = NonNullable<ConnectorCatalogEntry['setupFields']>[number];

export type SetupFieldsFormMode = 'create' | 'update';

export interface ProviderKeyPreFill {
  fieldId: string;
  providerLabel: string;
}

interface SetupFieldsFormProps {
  mode: SetupFieldsFormMode;
  catalogEntry: ConnectorCatalogEntry;
  connectionName: string;
  fieldValues: Record<string, string>;
  onChange: (fieldId: string, value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  isSaving: boolean;
  error: string | null;
  providerKeyPreFill?: ProviderKeyPreFill | null;
  callbackUrlCopied: boolean;
  onCopyCallbackUrl: () => void | Promise<void>;
  onOpenSetupUrl: () => void;
  submitWithRebel: boolean;
  showBundledEmailField: boolean;
  showManualEmailField: boolean;
  showManualWorkspaceField: boolean;
  skipDefaultUrlField: boolean;
  panelTitle?: string;
}

function fieldValue(fieldValues: Record<string, string>, field: SetupField): string {
  return fieldValues[field.id] ?? field.default ?? '';
}

function isRequiredInMode(field: SetupField, mode: SetupFieldsFormMode): boolean {
  if (mode === 'update' && field.type === 'password') {
    return false;
  }
  return field.required !== false;
}

function setupFieldsHaveBlankRequiredValue(
  fields: SetupField[] | undefined,
  fieldValues: Record<string, string>,
  mode: SetupFieldsFormMode,
): boolean {
  if (!fields) {
    return !fieldValues.url?.trim();
  }
  return fields.some((field) => isRequiredInMode(field, mode) && !fieldValues[field.id]?.trim());
}

function submitLabel(mode: SetupFieldsFormMode, submitWithRebel: boolean): string {
  if (mode === 'update') {
    return 'Save';
  }
  return submitWithRebel ? 'Set up with Rebel' : 'Connect';
}

export function SetupFieldsForm({
  mode,
  catalogEntry,
  connectionName,
  fieldValues,
  onChange,
  onSubmit,
  onCancel,
  isSaving,
  error,
  providerKeyPreFill,
  callbackUrlCopied,
  onCopyCallbackUrl,
  onOpenSetupUrl,
  submitWithRebel,
  showBundledEmailField,
  showManualEmailField,
  showManualWorkspaceField,
  skipDefaultUrlField,
  panelTitle,
}: SetupFieldsFormProps) {
  const hasBlankRequiredSetupField =
    !skipDefaultUrlField &&
    setupFieldsHaveBlankRequiredValue(catalogEntry.setupFields, fieldValues, mode);
  const hasBlankBundledEmail =
    showBundledEmailField && !fieldValues.email?.trim();
  const hasBlankManualEmail =
    showManualEmailField && !fieldValues.email?.trim();
  const hasBlankManualWorkspace =
    showManualWorkspaceField && !fieldValues.workspace?.trim();
  const isSubmitDisabled =
    isSaving ||
    hasBlankRequiredSetupField ||
    hasBlankBundledEmail ||
    hasBlankManualEmail ||
    hasBlankManualWorkspace;
  const shouldShowSetupUrlButton = Boolean(
    catalogEntry.setupUrl &&
      (
        catalogEntry.setupUrlBehavior === 'button' ||
        (!catalogEntry.setupUrlBehavior && catalogEntry.bundledConfig?.authType === 'api-key')
      ),
  );

  return (
    <>
      <div className={styles.setupView}>
        {panelTitle && (
          <p className={styles.setupInstructionsTitle}>{panelTitle}</p>
        )}

        {catalogEntry.setupNotice && (
          <Notice tone="info" placement="inline" density="compact">
            {catalogEntry.setupNotice}
          </Notice>
        )}

        {catalogEntry.callbackUrl && (
          <div className={styles.setupInstructions}>
            <div className={styles.advancedConfigLabelRow}>
              <label className={styles.advancedConfigLabel}>Callback URL</label>
              <Tooltip content={callbackUrlCopied ? 'Copied!' : 'Copy callback URL'}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void onCopyCallbackUrl()}
                  aria-label={callbackUrlCopied ? 'Copied!' : 'Copy callback URL'}
                >
                  {callbackUrlCopied ? <Check size={14} /> : <Copy size={14} />}
                  {callbackUrlCopied ? 'Copied!' : 'Copy'}
                </Button>
              </Tooltip>
            </div>
            <code style={{
              display: 'block',
              fontSize: '0.8125rem',
              padding: '0.5rem 0.75rem',
              borderRadius: 6,
              background: 'var(--color-muted)',
              border: '1px solid var(--color-border-soft)',
              wordBreak: 'break-all',
              color: 'var(--color-foreground)',
              userSelect: 'all',
            }}>
              {catalogEntry.callbackUrl}
            </code>
          </div>
        )}

        {catalogEntry.setupInstructions && (
          <div className={styles.setupInstructions}>
            <p className={styles.setupInstructionsTitle}>Follow these steps:</p>
            <ol className={styles.setupStepsList}>
              {catalogEntry.setupInstructions.split('\n').map((step, index) => {
                const cleanStep = step.replace(/^\d+\.\s*/, '').trim();
                return cleanStep ? <li key={index}>{cleanStep}</li> : null;
              })}
            </ol>
          </div>
        )}

        {catalogEntry.setupFields ? (
          catalogEntry.setupFields.map((field) => {
            if (field.type === 'boolean') {
              const stored = fieldValues[field.id] ?? field.default ?? 'false';
              const checked = stored === 'true';
              return (
                <div key={field.id} className={styles.setupUrlInput}>
                  <InlineToggle
                    toggleId={`setup-${field.id}-expanded`}
                    checked={checked}
                    disabled={isSaving}
                    label={field.label}
                    onCheckedChange={(next) => onChange(field.id, next ? 'true' : 'false')}
                  />
                  {field.helpText && (
                    <span className={styles.setupHint}>{field.helpText}</span>
                  )}
                </div>
              );
            }
            return (
              <div key={field.id} className={styles.setupUrlInput}>
                <label htmlFor={`setup-${field.id}-expanded`}>{field.label}</label>
                {field.type === 'select' && field.options ? (
                  <Select
                    id={`setup-${field.id}-expanded`}
                    value={fieldValue(fieldValues, field)}
                    onChange={(event) => onChange(field.id, event.target.value)}
                    disabled={isSaving}
                    selectSize="sm"
                  >
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id={`setup-${field.id}-expanded`}
                    type={field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'}
                    placeholder={field.placeholder || (field.type === 'url' ? 'https://...' : '')}
                    value={fieldValues[field.id] || ''}
                    onChange={(event) => onChange(field.id, event.target.value)}
                    className={styles.advancedConfigNameInput}
                    disabled={isSaving}
                    inputSize="md"
                  />
                )}
                {field.helpText && (
                  <span className={styles.setupHint}>{field.helpText}</span>
                )}
                {providerKeyPreFill?.fieldId === field.id && fieldValues[field.id]?.trim() && (
                  <span className={styles.setupHint}>
                    Pre-filled from your saved {providerKeyPreFill.providerLabel} key
                  </span>
                )}
              </div>
            );
          })
        ) : !skipDefaultUrlField ? (
          <div className={styles.setupUrlInput}>
            <label htmlFor="setup-url-expanded">MCP Server URL</label>
            <Input
              id="setup-url-expanded"
              type="url"
              placeholder="https://..."
              value={fieldValues.url || ''}
              onChange={(event) => onChange('url', event.target.value)}
              className={styles.advancedConfigNameInput}
              disabled={isSaving}
              inputSize="md"
            />
          </div>
        ) : null}

        {showBundledEmailField && (
          <div className={styles.setupUrlInput}>
            <label htmlFor="setup-email-expanded">Account Email</label>
            <Input
              id="setup-email-expanded"
              type="email"
              placeholder="you@example.com"
              value={fieldValues.email || ''}
              onChange={(event) => onChange('email', event.target.value)}
              className={styles.advancedConfigNameInput}
              disabled={isSaving}
              readOnly={mode === 'update'}
              inputSize="md"
            />
            <span className={styles.setupHint}>
              Helps identify which account this connector uses
            </span>
          </div>
        )}

        {showManualEmailField && (
          <div className={styles.setupUrlInput}>
            <label htmlFor="setup-email-manual-expanded">Account Email</label>
            <Input
              id="setup-email-manual-expanded"
              type="email"
              placeholder="you@example.com"
              value={fieldValues.email || ''}
              onChange={(event) => onChange('email', event.target.value)}
              className={styles.advancedConfigNameInput}
              disabled={isSaving}
              readOnly={mode === 'update'}
              inputSize="md"
            />
            <span className={styles.setupHint}>
              Helps identify which account this connector uses
            </span>
          </div>
        )}

        {showManualWorkspaceField && (
          <div className={styles.setupUrlInput}>
            <label htmlFor="setup-workspace-manual-expanded">Workspace Name</label>
            <Input
              id="setup-workspace-manual-expanded"
              type="text"
              placeholder="My Workspace"
              value={fieldValues.workspace || ''}
              onChange={(event) => onChange('workspace', event.target.value)}
              className={styles.advancedConfigNameInput}
              disabled={isSaving}
              inputSize="md"
            />
            <span className={styles.setupHint}>
              Helps identify which workspace this connector uses
            </span>
          </div>
        )}
      </div>

      {error && (
        <span className={styles.setupError} style={{ padding: '0 2px' }}>{error}</span>
      )}
      <div className={styles.expandedConnectionFooterActions}>
        <div className={styles.expandedConnectionFooterPrimary}>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={isSaving}
          >
            Cancel
          </Button>
          {shouldShowSetupUrlButton && (
            <Button
              variant="outline"
              size="sm"
              onClick={onOpenSetupUrl}
              className={styles.setupLinkButton}
            >
              <ExternalLink size={14} />
              {catalogEntry.setupUrlButtonLabel || `Open ${connectionName}`}
            </Button>
          )}
        </div>
        <div className={styles.expandedConnectionFooterSecondary}>
          <Button
            variant="default"
            size="sm"
            data-testid="connector-setup-save-button"
            onClick={onSubmit}
            disabled={isSubmitDisabled}
          >
            {isSaving ? (
              <>
                <Loader2 size={14} className={styles.spinnerIcon} />
                {mode === 'update' ? 'Saving...' : 'Setting up...'}
              </>
            ) : mode === 'create' && submitWithRebel ? (
              <>
                <Bot size={14} />
                {submitLabel(mode, submitWithRebel)}
              </>
            ) : (
              submitLabel(mode, submitWithRebel)
            )}
          </Button>
        </div>
      </div>
    </>
  );
}
