/**
 * Per-tool approval details for the Rebel browser extension (Stage 6b).
 *
 * Renders a compact block above the default approval actions when the
 * pending approval is a browser `fill_form` or `click` call. Shows:
 *
 *   - for `fill_form`: one row per field with selector, visible label, and
 *     a masked preview of sensitive values. Sensitive fields are flagged as
 *     "denied by default" so the user understands why they need to approve.
 *
 *   - for `click`: highlights the destructive label (if any) so the user
 *     notices the high-risk action before clicking Allow.
 *
 * Re-uses the shared heuristics from `@core/safety/browserToolSafety` so the
 * UI and the server-side safety evaluator agree on what counts as sensitive.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 6b)
 */
import { memo } from 'react';
import {
  BROWSER_FILL_FORM_TOOL,
  BROWSER_CLICK_TOOL,
  isDestructiveClickLabel,
  sanitizeFillFormFields,
  type BrowserFillField,
} from '@rebel/shared';
import './BrowserToolApprovalDetails.css';

export interface BrowserToolApprovalDetailsProps {
  toolName: string;
  toolInput: Record<string, unknown>;
}

export const BrowserToolApprovalDetails = memo(function BrowserToolApprovalDetails({
  toolName,
  toolInput,
}: BrowserToolApprovalDetailsProps) {
  if (toolName === BROWSER_FILL_FORM_TOOL) {
    return <FillFormDetails toolInput={toolInput} />;
  }
  if (toolName === BROWSER_CLICK_TOOL) {
    return <ClickDetails toolInput={toolInput} />;
  }
  return null;
});

function FillFormDetails({ toolInput }: { toolInput: Record<string, unknown> }) {
  const rawFields = (toolInput?.fields as BrowserFillField[] | undefined) ?? [];
  const fields = sanitizeFillFormFields(rawFields);
  if (fields.length === 0) return null;

  return (
    <div
      className="browser-tool-approval__details"
      data-testid="browser-tool-approval-fill-form"
    >
      <div className="browser-tool-approval__heading">Fields to fill</div>
      <ul className="browser-tool-approval__fields">
        {fields.map((f) => (
          <li
            key={f.selector}
            className={`browser-tool-approval__field${f.sensitive ? ' browser-tool-approval__field--sensitive' : ''}`}
          >
            <span className="browser-tool-approval__field-label">
              {f.elementLabel || f.selector}
            </span>
            <span className="browser-tool-approval__field-value">
              {f.valuePreview || <em>(empty)</em>}
            </span>
            {f.sensitive && (
              <span className="browser-tool-approval__field-badge">
                Sensitive — denied by default
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClickDetails({ toolInput }: { toolInput: Record<string, unknown> }) {
  const elementLabel =
    typeof toolInput?.elementLabel === 'string'
      ? (toolInput.elementLabel as string)
      : '';
  const selector =
    typeof toolInput?.selector === 'string' ? (toolInput.selector as string) : '';
  const destructive = isDestructiveClickLabel(elementLabel);

  return (
    <div
      className="browser-tool-approval__details"
      data-testid="browser-tool-approval-click"
    >
      <div className="browser-tool-approval__heading">Click target</div>
      <dl className="browser-tool-approval__click">
        <dt>Label</dt>
        <dd
          className={destructive ? 'browser-tool-approval__label--destructive' : ''}
        >
          {elementLabel || <em>(no label provided)</em>}
          {destructive && (
            <span className="browser-tool-approval__field-badge">
              Destructive — needs your approval
            </span>
          )}
        </dd>
        <dt>Selector</dt>
        <dd className="browser-tool-approval__selector">{selector}</dd>
      </dl>
    </div>
  );
}
