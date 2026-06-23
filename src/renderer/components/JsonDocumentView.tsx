import { memo, useState, useCallback, Children } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * Converts a JSON key like "success_signal" or "dependsOn" into a readable heading.
 * snake_case → Title Case, camelCase → Title Case, kebab-case → Title Case.
 */
const humanizeKey = (key: string): string => {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase
    .replace(/[_-]+/g, ' ') // snake_case / kebab-case
    .replace(/\b\w/g, (c) => c.toUpperCase()) // capitalize words
    .trim();
};

type JsonNodeProps = {
  value: unknown;
  depth: number;
};

const JsonNode = ({ value, depth }: JsonNodeProps) => {
  if (value === null || value === undefined) {
    return <span className="json-doc__null">None</span>;
  }

  if (typeof value === 'boolean') {
    return <span className="json-doc__boolean">{value ? 'Yes' : 'No'}</span>;
  }

  if (typeof value === 'number') {
    return <span className="json-doc__number">{value}</span>;
  }

  if (typeof value === 'string') {
    if (value.length > 200) {
      return <p className="json-doc__text">{value}</p>;
    }
    return <span className="json-doc__text">{value}</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="json-doc__empty">None</span>;
    }

    const allPrimitive = value.every(
      (item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
    );

    if (allPrimitive) {
      return (
        <ul className="json-doc__list">
          {value.map((item, i) => (
            <li key={i} className="json-doc__list-item">
              <JsonNode value={item} depth={depth + 1} />
            </li>
          ))}
        </ul>
      );
    }

    return (
      <ol className="json-doc__list json-doc__list--numbered">
        {value.map((item, i) => (
          <li key={i} className="json-doc__list-item">
            <JsonNode value={item} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return <span className="json-doc__empty">Empty</span>;
    }

    return (
      <div className="json-doc__section">
        {entries.map(([key, val]) => (
          <JsonField key={key} fieldKey={key} value={val} depth={depth} />
        ))}
      </div>
    );
  }

  return <span>{String(value)}</span>;
};

type JsonFieldProps = {
  fieldKey: string;
  value: unknown;
  depth: number;
};

function JsonField({ fieldKey, value, depth }: JsonFieldProps) {
  const label = humanizeKey(fieldKey);
  const isComplex = typeof value === 'object' && value !== null;
  const isLongArray = Array.isArray(value) && value.length > 3;

  if (isComplex && depth > 0 && isLongArray) {
    return <CollapsibleField label={label} value={value} depth={depth} />;
  }

  const isSimple =
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null;

  if (isSimple) {
    return (
      <div className="json-doc__field json-doc__field--inline">
        <span className="json-doc__label">{label}:</span>{' '}
        <JsonNode value={value} depth={depth + 1} />
      </div>
    );
  }

  return (
    <div className="json-doc__field">
      <div className="json-doc__label">{label}</div>
      <JsonNode value={value} depth={depth + 1} />
    </div>
  );
}

type CollapsibleFieldProps = {
  label: string;
  value: unknown;
  depth: number;
};

function CollapsibleField({ label, value, depth }: CollapsibleFieldProps) {
  const [isOpen, setIsOpen] = useState(true);
  const count = Array.isArray(value) ? value.length : Object.keys(value as Record<string, unknown>).length;

  const handleToggle = useCallback((event: React.SyntheticEvent<HTMLDetailsElement>) => {
    setIsOpen(event.currentTarget.open);
  }, []);

  return (
    <details className="json-doc__field json-doc__collapsible" open={isOpen} onToggle={handleToggle}>
      <summary className="json-doc__collapsible-summary">
        <ChevronRight size={14} className="json-doc__chevron" aria-hidden />
        <span className="json-doc__label">{label}</span>
        <span className="json-doc__count">{count}</span>
      </summary>
      {isOpen && (
        <div className="json-doc__collapsible-body">
          <JsonNode value={value} depth={depth + 1} />
        </div>
      )}
    </details>
  );
}

type JsonDocumentViewProps = {
  content: string;
};

const JsonDocumentViewComponent = ({ content }: JsonDocumentViewProps) => {
  const [showRaw, setShowRaw] = useState(false);

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return null;

  return (
    <div className="json-doc">
      <div className="json-doc__content">
        {showRaw ? (
          <pre className="json-doc__raw">
            <code>{JSON.stringify(parsed, null, 2)}</code>
          </pre>
        ) : (
          <JsonNode value={parsed} depth={0} />
        )}
      </div>
      <button
        type="button"
        className="json-doc__toggle"
        onClick={() => setShowRaw(!showRaw)}
      >
        {showRaw ? 'Show formatted' : 'Show raw'}
      </button>
    </div>
  );
};

JsonDocumentViewComponent.displayName = 'JsonDocumentView';

export const JsonDocumentView = memo(JsonDocumentViewComponent);

/**
 * Checks if a className indicates a JSON code block.
 */
export const isJsonLanguage = (className: string | undefined): boolean => {
  if (!className) return false;
  const tokens = className.split(/\s+/);
  return tokens.includes('language-json');
};

/**
 * Extracts text content from a React code element's children.
 */
export const extractCodeText = (children: React.ReactNode): string => {
  if (typeof children === 'string') return children;
  return Children.toArray(children)
    .map((c) => (typeof c === 'string' ? c : ''))
    .join('');
};

/**
 * Checks if a string is a valid JSON object (not array/primitive)
 * with enough keys to be worth rendering as a document.
 */
export const isRenderableJsonObject = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length >= 2;
  } catch {
    return false;
  }
};
