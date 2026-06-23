#!/usr/bin/env node
// MUST be the first non-comment statement — see docs/plans/260428_graceful_fs_emfile_fix.md
// Uses globalThis.process so files that later `const process = require('node:process')` don't trigger TDZ.
if (globalThis.process.env.REBEL_DISABLE_GRACEFUL_FS !== '1') {
  try { require('graceful-fs').gracefulify(require('node:fs')); } catch (e) {
    globalThis.__REBEL_BOOTSTRAP_LEAF_ERROR__ = { kind: 'graceful_fs_leaf_install_failed', error: { name: e?.name, message: e?.message, stack: e?.stack }, at: Date.now() };
    if (globalThis.process.env.REBEL_DEBUG_BOOTSTRAP === '1') console.warn('[installGracefulFs] failed:', e);
  }
}
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

// ---------------------------------------------------------------------------
// Data store -- FIFO eviction, persisted to disk with atomic writes
// ---------------------------------------------------------------------------
const MAX_ENTRIES = 200;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_STORE_BYTES = 2 * 1024 * 1024; // 2 MB cap on the JSON file
const STORE_PATH = process.env.REBEL_CANVAS_STORE_PATH || '';
const dataStore = new Map();

const loadStore = () => {
  if (!STORE_PATH) return;
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    const now = Date.now();
    for (const [k, v] of entries) {
      if (v && typeof v === 'object' && (now - (v._ts || 0)) < MAX_AGE_MS) {
        dataStore.set(k, v);
      }
    }
  } catch (_) { /* first run or corrupt file -- start fresh */ }
};

const atomicWriteSync = (filePath, data) => {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, data, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (_) {
    // Windows: rename fails if target exists; remove first then retry
    try { fs.unlinkSync(filePath); } catch (__) { /* may not exist */ }
    fs.renameSync(tmp, filePath);
  }
};

let saveTimer = null;
const persistStore = () => {
  if (!STORE_PATH) return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushStore();
  }, 500);
};

const flushStore = () => {
  if (!STORE_PATH) return;
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Prune expired entries before writing
    const now = Date.now();
    for (const [k, v] of dataStore) {
      if (v && (now - (v._ts || 0)) >= MAX_AGE_MS) dataStore.delete(k);
    }
    let json = JSON.stringify([...dataStore]);
    // Evict oldest entries until under size budget
    const prevSize = dataStore.size;
    while (json.length > MAX_STORE_BYTES && dataStore.size > 0) {
      dataStore.delete(dataStore.keys().next().value);
      json = JSON.stringify([...dataStore]);
    }
    if (dataStore.size < prevSize) {
      console.error('[RebelCanvas] Evicted ' + (prevSize - dataStore.size) + ' entries to meet size cap');
    }
    atomicWriteSync(STORE_PATH, json);
  } catch (e) {
    console.error('[RebelCanvas] Failed to persist store:', e && e.message ? e.message : e);
  }
};

let flushed = false;
const flushOnce = () => { if (!flushed) { flushed = true; if (saveTimer) clearTimeout(saveTimer); flushStore(); } };
process.on('exit', flushOnce);
process.on('SIGTERM', () => { flushOnce(); process.exit(0); });

loadStore();

const storeData = (data) => {
  const id = crypto.randomUUID();
  if (dataStore.size >= MAX_ENTRIES) {
    const oldestKey = dataStore.keys().next().value;
    dataStore.delete(oldestKey);
  }
  dataStore.set(id, { ...data, _ts: Date.now() });
  persistStore();
  return id;
};

// ---------------------------------------------------------------------------
// Template cache -- load HTML files once, reuse
// ---------------------------------------------------------------------------
const templateCache = new Map();
let actionSubstrateScriptCache = null;

const ACTION_CAPABLE_TEMPLATES = new Set(['form', 'confirm', 'picker', 'html-action']);
const HTML_ACTION_SUBMIT_PATTERN = /data-rebel-submit\s*=/i;
const stripHtmlComments = (s) => String(s || '').replace(/<!--[\s\S]*?-->/g, '');
const detectsHtmlAction = (html) => HTML_ACTION_SUBMIT_PATTERN.test(stripHtmlComments(html));

const loadTemplate = (name) => {
  if (!templateCache.has(name)) {
    templateCache.set(
      name,
      fs.readFileSync(path.join(__dirname, 'views', `${name}.html`), 'utf8')
    );
  }
  return templateCache.get(name);
};

const loadActionSubstrateScript = () => {
  if (actionSubstrateScriptCache === null) {
    actionSubstrateScriptCache = fs.readFileSync(path.join(__dirname, 'views', '_actionSubstrate.js'), 'utf8');
  }
  return actionSubstrateScriptCache;
};

const injectActionSubstrate = (html, options = {}) => {
  if (typeof html !== 'string') return html;
  // Idempotence guard: the substrate registers window.__rebelCanvas. If an
  // agent-authored page already contains it, avoid double-injecting listeners.
  if (!options.force && html.indexOf('window.__rebelCanvas') !== -1) return html;
  const script = `<script>${loadActionSubstrateScript().replace(/<\/script/gi, '<\\/script')}</script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${script}</body>`);
  }
  if (/<\/html>/i.test(html)) {
    return html.replace(/<\/html>/i, `${script}</html>`);
  }
  return `${html}${script}`;
};

// ---------------------------------------------------------------------------
// Tool names -- follow rebel-diagnostics TOOL_NAMES pattern
// ---------------------------------------------------------------------------
const TOOL_NAMES = {
  chart: 'rebel_canvas_chart',
  table: 'rebel_canvas_table',
  options: 'rebel_canvas_options',
  form: 'rebel_canvas_form',
  confirm: 'rebel_canvas_confirm',
  picker: 'rebel_canvas_picker',
  html: 'rebel_canvas_html'
};

// Keep in sync with resources/mcp/rebel-canvas/views/_actionSubstrate.js.
const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const PROMPT_INJECTION_LITERAL = 'ignore previous instructions';
const VIEW_SUMMARY_HTML_CHARS = /[<>]/g;

const containsPromptInjectionLiteral = (value) => (
  typeof value === 'string'
  && value.toLowerCase().includes(PROMPT_INJECTION_LITERAL)
);

const sanitizeViewSummaryText = (value, fallback) => {
  const sanitized = String(value == null ? '' : value).replace(VIEW_SUMMARY_HTML_CHARS, '').trim();
  return sanitized || fallback;
};

const safeActionIdSchema = z.string()
  .min(1)
  .max(80)
  .regex(ACTION_ID_PATTERN, 'Use letters or numbers first, then letters, numbers, ".", "_", ":", or "-".')
  .refine((value) => !containsPromptInjectionLiteral(value), {
    message: 'Prompt-like action ids are not allowed'
  });

const fieldIdSchema = z.string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/, 'Use a short field id without spaces');

const textPatternSchema = z.string().min(1).max(500);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const isoTimeSchema = z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/, 'Use HH:mm or HH:mm:ss');
const isoDatetimeSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/,
  'Use an ISO 8601 datetime'
);
const formOptionSchema = z.object({
  label: z.string().min(1).max(160),
  value: z.string().min(1).max(200),
  description: z.string().max(500).optional()
}).strict();

const formFieldBase = {
  id: fieldIdSchema.describe('Stable field id used as the submitted payload key'),
  label: z.string().min(1).max(160).describe('Human-readable field label'),
  description: z.string().max(500).optional().describe('Optional helper text'),
  required: z.boolean().optional().describe('Whether the user must fill this field before submitting')
};

const makeFormFieldSchema = (shape) => z.object({ ...formFieldBase, ...shape }).strict();

const formTextFieldSchema = makeFormFieldSchema({
  type: z.literal('text'),
  default: z.string().optional(),
  pattern: textPatternSchema.optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(1).optional(),
  placeholder: z.string().max(200).optional()
});

const formLongtextFieldSchema = makeFormFieldSchema({
  type: z.literal('longtext'),
  default: z.string().optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(1).optional(),
  placeholder: z.string().max(200).optional(),
  rows: z.number().int().min(2).max(20).optional()
});

const formEmailFieldSchema = makeFormFieldSchema({
  type: z.literal('email'),
  default: z.string().optional(),
  pattern: textPatternSchema.optional(),
  placeholder: z.string().max(200).optional()
});

const formUrlFieldSchema = makeFormFieldSchema({
  type: z.literal('url'),
  default: z.string().optional(),
  pattern: textPatternSchema.optional(),
  placeholder: z.string().max(200).optional()
});

const formNumberFieldSchema = makeFormFieldSchema({
  type: z.literal('number'),
  default: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  placeholder: z.string().max(200).optional()
});

const formDateFieldSchema = makeFormFieldSchema({
  type: z.literal('date'),
  default: isoDateSchema.optional(),
  min: isoDateSchema.optional(),
  max: isoDateSchema.optional()
});

const formTimeFieldSchema = makeFormFieldSchema({
  type: z.literal('time'),
  default: isoTimeSchema.optional(),
  min: isoTimeSchema.optional(),
  max: isoTimeSchema.optional()
});

const formDatetimeFieldSchema = makeFormFieldSchema({
  type: z.literal('datetime'),
  default: isoDatetimeSchema.optional(),
  min: isoDatetimeSchema.optional(),
  max: isoDatetimeSchema.optional()
});

const formSelectFieldSchema = makeFormFieldSchema({
  type: z.literal('select'),
  default: z.string().optional(),
  options: z.array(formOptionSchema).min(1)
});

const formMultiselectFieldSchema = makeFormFieldSchema({
  type: z.literal('multiselect'),
  default: z.array(z.string()).optional(),
  options: z.array(formOptionSchema).min(1),
  minCount: z.number().int().min(0).optional(),
  maxCount: z.number().int().min(1).optional()
});

const formSliderFieldSchema = makeFormFieldSchema({
  type: z.literal('slider'),
  default: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  unit: z.string().max(40).optional(),
  valueLabel: z.string().max(120).optional()
});

const formRatingFieldSchema = makeFormFieldSchema({
  type: z.literal('rating'),
  default: z.number().int().min(1).max(10).optional(),
  max: z.number().int().min(1).max(10).optional()
});

const formCheckboxFieldSchema = makeFormFieldSchema({
  type: z.literal('checkbox'),
  default: z.boolean().optional()
});

const formRadioFieldSchema = makeFormFieldSchema({
  type: z.literal('radio'),
  default: z.string().optional(),
  options: z.array(formOptionSchema).min(1)
});

const FORM_FIELD_TYPES = [
  'text',
  'longtext',
  'email',
  'url',
  'number',
  'date',
  'time',
  'datetime',
  'select',
  'multiselect',
  'slider',
  'rating',
  'checkbox',
  'radio',
];

const formFieldSchema = z.discriminatedUnion('type', [
  formTextFieldSchema,
  formLongtextFieldSchema,
  formEmailFieldSchema,
  formUrlFieldSchema,
  formNumberFieldSchema,
  formDateFieldSchema,
  formTimeFieldSchema,
  formDatetimeFieldSchema,
  formSelectFieldSchema,
  formMultiselectFieldSchema,
  formSliderFieldSchema,
  formRatingFieldSchema,
  formCheckboxFieldSchema,
  formRadioFieldSchema,
]);

const formInputSchema = z.object({
  title: z.string().min(1).max(160).describe('Form title'),
  actionId: safeActionIdSchema.describe('Stable action id returned in the submitted payload'),
  description: z.string().max(1000).optional().describe('Optional short intro above the fields'),
  submitLabel: z.string().min(1).max(80).optional().describe('Submit button label'),
  cancelLabel: z.string().min(1).max(80).optional().describe('Cancel button label'),
  fields: z.array(formFieldSchema).min(1).max(30).describe('Fields to render')
}).strict().superRefine((definition, ctx) => {
  const ids = new Set();
  definition.fields.forEach((field, index) => {
    if (ids.has(field.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields', index, 'id'],
        message: 'Field ids must be unique'
      });
    }
    ids.add(field.id);

    if ((field.type === 'number' || field.type === 'slider') && field.min != null && field.max != null && field.min > field.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields', index, 'min'],
        message: 'min must be less than or equal to max'
      });
    }

    if ((field.type === 'date' || field.type === 'time' || field.type === 'datetime') && field.min != null && field.max != null) {
      let outOfOrder = false;
      if (field.type === 'datetime') {
        const minMs = Date.parse(field.min);
        const maxMs = Date.parse(field.max);
        if (Number.isFinite(minMs) && Number.isFinite(maxMs) && minMs > maxMs) {
          outOfOrder = true;
        } else if ((!Number.isFinite(minMs) || !Number.isFinite(maxMs)) && field.min > field.max) {
          outOfOrder = true;
        }
      } else if (field.min > field.max) {
        outOfOrder = true;
      }
      if (outOfOrder) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', index, 'min'],
          message: 'min must be less than or equal to max'
        });
      }
    }

    if (field.type === 'slider' && field.default != null) {
      const min = field.min != null ? field.min : 0;
      const max = field.max != null ? field.max : 100;
      if (field.default < min || field.default > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', index, 'default'],
          message: 'default must be between min and max'
        });
      }
    }

    if (field.type === 'rating' && field.default != null) {
      const max = field.max != null ? field.max : 5;
      if (field.default < 1 || field.default > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', index, 'default'],
          message: 'default must be between 1 and max'
        });
      }
    }

    if (field.type === 'multiselect') {
      if (field.minCount != null && field.maxCount != null && field.minCount > field.maxCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', index, 'minCount'],
          message: 'minCount must be less than or equal to maxCount'
        });
      }
      const optionValues = new Set(field.options.map((option) => option.value));
      if (Array.isArray(field.default)) {
        const invalidDefault = field.default.find((value) => !optionValues.has(value));
        if (invalidDefault) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['fields', index, 'default'],
            message: 'default values must be present in options'
          });
        }
      }
    }

    if ((field.type === 'select' || field.type === 'radio') && field.default != null) {
      const optionValues = new Set(field.options.map((option) => option.value));
      if (!optionValues.has(field.default)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', index, 'default'],
          message: 'default must be present in options'
        });
      }
    }
  });
});

const confirmButtonSetSchema = z.enum(['yes-no', 'yes-no-cancel', 'approve-reject', 'continue-cancel', 'custom']);
const confirmCustomButtonSchema = z.object({
  actionId: safeActionIdSchema.describe('Stable choice id returned in the submitted payload'),
  label: z.string().min(1).max(80).describe('Button label'),
  intent: z.enum(['primary', 'secondary', 'destructive', 'cancel']).describe('Button visual/behavioral intent')
}).strict();

const confirmInputSchema = z.object({
  title: z.string().min(1).max(160).describe('Decision title'),
  body: z.string().max(2000).optional().describe('Optional plaintext body; markdown is rendered literally'),
  actionId: safeActionIdSchema.describe('Stable action id returned in the submitted payload'),
  buttonSet: confirmButtonSetSchema.default('yes-no').describe('Preset button set to render'),
  customButtons: z.array(confirmCustomButtonSchema).min(1).max(8).optional().describe('Buttons to render when buttonSet is custom')
}).strict().superRefine((definition, ctx) => {
  if (definition.buttonSet === 'custom' && !definition.customButtons) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['customButtons'],
      message: 'customButtons is required when buttonSet is custom'
    });
  }
});

const pickerOptionSchema = z.object({
  value: safeActionIdSchema.describe('Stable option value returned in the submitted payload'),
  label: z.string().min(1).max(160).describe('Option label'),
  description: z.string().max(500).optional().describe('Optional helper text')
}).strict();

const pickerInputSchema = z.object({
  question: z.string().min(1).max(200).describe('Question for the user'),
  options: z.array(pickerOptionSchema).min(2).max(50).describe('Options to choose from'),
  mode: z.enum(['single', 'multi']).default('single').describe('Single-choice or multi-choice mode'),
  minCount: z.number().int().min(1).optional().describe('Minimum selections in multi mode'),
  maxCount: z.number().int().min(1).optional().describe('Maximum selections in multi mode'),
  default: z.union([safeActionIdSchema, z.array(safeActionIdSchema)]).optional().describe('Preselected option value(s)'),
  actionId: safeActionIdSchema.describe('Stable action id returned in the submitted payload')
}).strict().superRefine((definition, ctx) => {
  if (definition.mode !== 'multi' && (definition.minCount != null || definition.maxCount != null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: definition.minCount != null ? ['minCount'] : ['maxCount'],
      message: 'minCount and maxCount are only valid in multi mode'
    });
  }

  if (definition.mode === 'multi' && definition.minCount != null && definition.maxCount != null && definition.minCount > definition.maxCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['minCount'],
      message: 'minCount must be less than or equal to maxCount'
    });
  }

  const values = new Set();
  definition.options.forEach((option, index) => {
    if (values.has(option.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options', index, 'value'],
        message: 'Option values must be unique'
      });
    }
    values.add(option.value);
  });

  if (definition.mode === 'single') {
    if (Array.isArray(definition.default)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default'],
        message: 'default must be a single option value in single mode'
      });
    } else if (definition.default != null && !values.has(definition.default)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default'],
        message: 'default must be present in options'
      });
    }
  } else if (definition.mode === 'multi') {
    if (typeof definition.default === 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default'],
        message: 'default must be an array of option values in multi mode'
      });
    } else if (Array.isArray(definition.default)) {
      const invalidDefault = definition.default.find((value) => !values.has(value));
      if (invalidDefault) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['default'],
          message: 'default values must be present in options'
        });
      }
      if (definition.minCount != null && definition.default.length < definition.minCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['default'],
          message: 'default must satisfy minCount'
        });
      }
      if (definition.maxCount != null && definition.default.length > definition.maxCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['default'],
          message: 'default must satisfy maxCount'
        });
      }
    }
  }
});

const CONFIRM_BUTTON_PRESETS = {
  'yes-no': [
    { actionId: 'yes', label: 'Yes', intent: 'primary' },
    { actionId: 'no', label: 'No', intent: 'secondary' }
  ],
  'yes-no-cancel': [
    { actionId: 'yes', label: 'Yes', intent: 'primary' },
    { actionId: 'no', label: 'No', intent: 'secondary' },
    { actionId: 'cancel', label: 'Cancel', intent: 'cancel' }
  ],
  'approve-reject': [
    { actionId: 'approve', label: 'Approve', intent: 'primary' },
    { actionId: 'reject', label: 'Reject', intent: 'destructive' }
  ],
  'continue-cancel': [
    { actionId: 'continue', label: 'Continue', intent: 'primary' },
    { actionId: 'cancel', label: 'Cancel', intent: 'cancel' }
  ]
};

const describeDefaultValue = (field) => {
  if (!Object.prototype.hasOwnProperty.call(field, 'default')) return '';
  const value = Array.isArray(field.default) ? field.default.join(', ') : String(field.default);
  return value ? ` — default: ${value}` : '';
};

const describeOptions = (field) => {
  if (!Array.isArray(field.options) || field.options.length === 0) return '';
  return ` options: ${field.options.map((option) => `${option.label}=${option.value}`).join(', ')}`;
};

const describeFieldConstraints = (field) => {
  const bits = [];
  if (field.required) bits.push('required');
  if (field.type === 'select' || field.type === 'radio' || field.type === 'multiselect') {
    bits.push(describeOptions(field));
    if (field.type === 'multiselect') {
      if (field.minCount != null) bits.push(`min selections: ${field.minCount}`);
      if (field.maxCount != null) bits.push(`max selections: ${field.maxCount}`);
    }
  }
  if (field.type === 'slider' || field.type === 'rating') {
    if (field.min != null) bits.push(`min: ${field.min}`);
    if (field.max != null) bits.push(`max: ${field.max}`);
    if (field.step != null) bits.push(`step: ${field.step}`);
    if (field.default != null) bits.push(`default: ${field.default}`);
  }
  if (field.type === 'date' || field.type === 'time' || field.type === 'datetime') {
    if (field.min != null) bits.push(`min: ${field.min}`);
    if (field.max != null) bits.push(`max: ${field.max}`);
    if (field.default != null) bits.push(`default: ${field.default}`);
  }
  if (field.type !== 'slider' && field.type !== 'rating' && field.type !== 'date' && field.type !== 'time' && field.type !== 'datetime') {
    const defaultDescription = describeDefaultValue(field).replace(/^ — /, '');
    if (defaultDescription) bits.push(defaultDescription);
  }
  return bits.filter(Boolean).join('; ');
};

const buildFormFallbackMarkdown = (definition) => {
  const lines = [
    `# ${definition.title}`,
    '',
    ...(definition.description ? [definition.description, ''] : []),
    ...definition.fields.map((field) => {
      const constraints = describeFieldConstraints(field);
      return `- ${field.label} (${field.type}, id: ${field.id}${constraints ? `; ${constraints}` : ''})`;
    })
  ];
  return lines.join('\n').trim();
};

const resolveConfirmButtons = (definition) => {
  if (definition.buttonSet === 'custom') return definition.customButtons || [];
  return CONFIRM_BUTTON_PRESETS[definition.buttonSet || 'yes-no'];
};

const buildConfirmFallbackMarkdown = (definition) => {
  const lines = [
    `# ${definition.title}`,
    '',
    ...(definition.body ? [definition.body, ''] : []),
    ...resolveConfirmButtons(definition).map((button) => `- ${button.label} (${button.intent || 'secondary'})`)
  ];
  return lines.join('\n').trim();
};

const describePickerInstruction = (definition) => {
  if (definition.mode !== 'multi') return 'Pick one of:';
  if (definition.minCount != null && definition.maxCount != null) {
    return definition.minCount === definition.maxCount
      ? `Choose ${definition.minCount} of:`
      : `Choose ${definition.minCount}-${definition.maxCount} of:`;
  }
  if (definition.minCount != null) return `Choose at least ${definition.minCount} of:`;
  if (definition.maxCount != null) return `Choose up to ${definition.maxCount} of:`;
  return 'Choose one or more of:';
};

const buildPickerFallbackMarkdown = (definition) => {
  const lines = [
    `# ${definition.question}`,
    '',
    describePickerInstruction(definition),
    '',
    ...definition.options.map((option) => `- ${option.label}`)
  ];
  return lines.join('\n').trim();
};

// ---------------------------------------------------------------------------
// Server instance
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: 'rebel-canvas',
  version: '0.1.0'
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.registerTool(TOOL_NAMES.chart, {
  title: 'Display chart',
  description:
    'Display data as an interactive chart. Supports bar, line, pie, and area chart types. ' +
    'Use for sales figures, trends over time, category breakdowns, survey results, budget ' +
    'allocations -- any data that benefits from visual representation.',
  inputSchema: z.object({
    type: z.enum(['bar', 'line', 'pie', 'area']).describe('Chart type'),
    title: z.string().describe('Chart title'),
    data: z
      .array(
        z.object({
          label: z.string().describe('Data point label'),
          value: z.number().describe('Data point value')
        })
      )
      .describe('Array of {label, value} pairs for the chart'),
    color: z.string().regex(/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]{1,60}\)|hsla?\([^)]{1,60}\)|[a-z]{3,20})$/).optional().describe('Optional accent color (hex, rgb, hsl, or named CSS color)')
  }),
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const id = storeData(input);
  const resourceUri = `ui://RebelCanvas/chart?id=${id}`;

  return {
    content: [
      {
        type: 'text',
        text: `Chart: ${input.title} (${input.data.length} data points, ${input.type})\n\n[View: ${resourceUri}]`
      }
    ],
    _meta: {
      ui: { resourceUri }
    }
  };
});

server.registerTool(TOOL_NAMES.table, {
  title: 'Display table',
  description:
    'Display structured data as a sortable table. Use for comparison data, lists with ' +
    'multiple attributes, search results, financial records, or any tabular information ' +
    "that's easier to scan visually than as prose.",
  inputSchema: z.object({
    title: z.string().optional().describe('Optional table title'),
    columns: z.array(z.string()).describe('Column header names'),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Array of row objects keyed by column name')
  }),
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const id = storeData(input);
  const resourceUri = `ui://RebelCanvas/table?id=${id}`;

  return {
    content: [
      {
        type: 'text',
        text: `Table: ${input.title || 'Data'} (${input.rows.length} rows, ${input.columns.length} columns)\n\n[View: ${resourceUri}]`
      }
    ],
    _meta: {
      ui: { resourceUri }
    }
  };
});

server.registerTool(TOOL_NAMES.options, {
  title: 'Present options',
  description:
    'Present a set of choices or options for the user to review. Use when offering ' +
    'alternatives, presenting recommendations with trade-offs, showing poll results, or ' +
    'laying out decision options. Each option can have a title, description, and optional ' +
    'pros/cons.',
  inputSchema: z.object({
    question: z.string().describe('The question or decision being presented'),
    options: z.array(
      z.object({
        title: z.string().describe('Option title'),
        description: z.string().optional().describe('Option description'),
        pros: z.array(z.string()).optional().describe('List of advantages'),
        cons: z.array(z.string()).optional().describe('List of disadvantages')
      })
    ).describe('Array of options to present')
  }),
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const id = storeData(input);
  const resourceUri = `ui://RebelCanvas/options?id=${id}`;

  return {
    content: [
      {
        type: 'text',
        text: `Options: ${input.question} (${input.options.length} choices)\n\n[View: ${resourceUri}]`
      }
    ],
    _meta: {
      ui: { resourceUri }
    }
  };
});

server.registerTool(TOOL_NAMES.form, {
  title: 'Show form',
  description:
    'Render an editable form for the user to fill out and submit back to the agent. ' +
    'Use when you need structured input from the user, such as contact details, ' +
    'preferences, approvals with notes, scheduling constraints, survey answers, or a draft ' +
    'that should be returned as fields instead of free text.',
  inputSchema: formInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const id = storeData({ definition: input, _type: 'form' });
  const resourceUri = `ui://RebelCanvas/form?id=${id}`;
  const fieldCount = input.fields.length;
  const viewSummary = `${input.title} · ${fieldCount} field${fieldCount === 1 ? '' : 's'}`;
  const fallbackMarkdown = buildFormFallbackMarkdown(input);

  return {
    content: [
      {
        type: 'text',
        text: `Form: ${input.title} (${fieldCount} field${fieldCount === 1 ? '' : 's'})\n\n[View: ${resourceUri}]`
      }
    ],
    _meta: {
      ui: {
        resourceUri,
        presentation: 'primary',
        viewSummary,
        viewRoleLabel: 'Form',
        structuredFallback: {
          kind: 'plain',
          payload: {
            markdown: fallbackMarkdown
          }
        }
      }
    }
  };
});

server.registerTool(TOOL_NAMES.confirm, {
  title: 'Ask for confirmation',
  description:
    'Render a compact confirmation view for a quick yes/no/cancel-style decision. ' +
    'Use when you need a simple user choice with plaintext context and clear buttons.',
  inputSchema: confirmInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const id = storeData({ definition: input, _type: 'confirm' });
  const resourceUri = `ui://RebelCanvas/confirm?id=${id}`;
  const fallbackMarkdown = buildConfirmFallbackMarkdown(input);
  const viewSummary = sanitizeViewSummaryText(input.title, 'Confirm');

  return {
    content: [
      {
        type: 'text',
        text: `Confirm: ${input.title}\n\n[View: ${resourceUri}]`
      }
    ],
    _meta: {
      ui: {
        resourceUri,
        presentation: 'primary',
        viewSummary,
        viewRoleLabel: 'Confirm',
        structuredFallback: {
          kind: 'plain',
          payload: {
            markdown: fallbackMarkdown
          }
        }
      }
    }
  };
});

server.registerTool(TOOL_NAMES.picker, {
  title: 'Ask user to pick',
  description:
    'Render a picker for choosing one or more explicit options. Use when the user ' +
    'should select from two or more concrete choices instead of replying free-form.',
  inputSchema: pickerInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const id = storeData({ definition: input, _type: 'picker' });
  const resourceUri = `ui://RebelCanvas/picker?id=${id}`;
  const optionCount = input.options.length;
  const safeQuestion = sanitizeViewSummaryText(input.question, 'Pick');
  const viewSummary = `${safeQuestion} · ${optionCount} option${optionCount === 1 ? '' : 's'}`;
  const fallbackMarkdown = buildPickerFallbackMarkdown(input);

  return {
    content: [
      {
        type: 'text',
        text: `Pick: ${input.question} (${optionCount} option${optionCount === 1 ? '' : 's'})\n\n[View: ${resourceUri}]`
      }
    ],
    _meta: {
      ui: {
        resourceUri,
        presentation: 'primary',
        viewSummary,
        viewRoleLabel: 'Pick',
        structuredFallback: {
          kind: 'plain',
          payload: {
            markdown: fallbackMarkdown
          }
        }
      }
    }
  };
});

server.registerTool(TOOL_NAMES.html, {
  title: 'Display HTML preview',
  description:
    'Display custom HTML content inline in the conversation. Three modes: ' +
    '(1) Pass raw HTML as a string. ' +
    '(2) Pass a file path to a single HTML file. ' +
    '(3) Pass a folder path containing an index.html and supporting files (JS, CSS, images). ' +
    'Folder mode serves all files via a custom protocol so relative imports work naturally. ' +
    'Use for app prototypes, interactive demos, data dashboards, or any rich HTML content. ' +
    '\n\nSandbox: Previews run in a sandboxed iframe. ' +
    'External scripts/styles are ONLY allowed from https://cdnjs.cloudflare.com and Google Fonts. ' +
    'Other CDNs (jsdelivr, unpkg, etc.) are blocked. ' +
    'For simple charts, prefer the dedicated rebel_canvas_chart tool. ' +
    '\n\nBlessed CDN libraries (use these exact URLs):' +
    '\n• Chart.js 4.4.1 — charts and dashboards: <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>' +
    '\n• Mermaid 11.4.0 — flowcharts, org charts, Gantt, sequence diagrams, timelines: <script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.4.0/mermaid.min.js"></script> (use <pre class="mermaid"> markup and call mermaid.run())' +
    '\n• D3.js 7.9.0 — for advanced custom visualizations (treemaps, networks, hierarchies): <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>' +
    '\n• Leaflet 1.9.4 — interactive maps: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"/> <script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script> (use tile layer: https://tile.openstreetmap.org/{z}/{x}/{y}.png)' +
    '\n\nAction-submit opt-in: a <button data-rebel-submit="<actionId>"> or <form data-rebel-submit="<actionId>"> inside the HTML auto-wires to the canvas submit substrate. ' +
    'Click → user message + structured payload back to the agent. ' +
    'data-rebel-summary="…" overrides the auto-generated summary; data-rebel-include="name1,name2" (button only) pulls additional named inputs from elsewhere in the document. ' +
    'actionId must match [A-Za-z0-9][A-Za-z0-9._:-]{0,79}. ' +
    'Inline-HTML and filePath modes only; folder mode does not support this in v1.' +
    '\n\nNote: folder mode (folderPath) does not support external CDN scripts — use inline JS or local files only.',
  inputSchema: z.object({
    html: z.string().optional().describe('Raw HTML string to render'),
    filePath: z.string().optional().describe('Absolute path to a single HTML file'),
    folderPath: z.string().optional().describe('Absolute path to a folder containing index.html')
  }).refine(
    data => [data.html, data.filePath, data.folderPath].filter(Boolean).length === 1,
    { message: 'Exactly one of html, filePath, or folderPath must be provided' }
  ),
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  // CSP config: allowlist cdnjs.cloudflare.com for script/style loading
  // tile.openstreetmap.org serves PNG tiles only; added to resourceDomains because
  // buildCSPString doesn't support img-only domains
  const htmlCsp = {
    resourceDomains: ['https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://tile.openstreetmap.org'],
    connectDomains: [],
  };

  if (input.html) {
    const htmlText = input.html;
    const isAction = detectsHtmlAction(htmlText);
    const id = storeData({ html: htmlText, _type: isAction ? 'html-action' : 'html' });
    const resourceUri = `ui://RebelCanvas/html?id=${id}`;
    return {
      content: [{ type: 'text', text: `HTML preview (inline)` }],
      _meta: { ui: { resourceUri, csp: htmlCsp } }
    };
  }

  if (input.filePath) {
    let content;
    try {
      content = fs.readFileSync(input.filePath, 'utf8');
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Error: Could not read file at ${input.filePath}: ${e.message}` }],
        isError: true
      };
    }
    const isAction = detectsHtmlAction(content);
    const id = storeData({ html: content, _type: isAction ? 'html-action' : 'html', originalFilePath: input.filePath });
    const resourceUri = `ui://RebelCanvas/html?id=${id}`;
    return {
      content: [{ type: 'text', text: `HTML preview (file: ${path.basename(input.filePath)})` }],
      _meta: {
        ui: {
          resourceUri,
          csp: htmlCsp,
          originalFilePath: input.filePath
        }
      }
    };
  }

  if (input.folderPath) {
    const indexPath = path.join(input.folderPath, 'index.html');
    if (!fs.existsSync(indexPath)) {
      return {
        content: [{ type: 'text', text: `Error: No index.html found in ${input.folderPath}` }],
        isError: true
      };
    }
    const id = storeData({ folderPath: input.folderPath, _type: 'preview' });
    // Flush immediately so the protocol handler can resolve the preview ID
    flushStore();
    const resourceUri = `ui://RebelCanvas/html?id=${id}`;
    const protocolUrl = `rebel-preview:///${id}/index.html`;
    return {
      content: [{ type: 'text', text: `HTML preview (folder: ${path.basename(input.folderPath)})` }],
      _meta: {
        ui: {
          resourceUri,
          csp: htmlCsp,
          protocolUrl,
          originalFilePath: indexPath
        }
      }
    };
  }
});

// ---------------------------------------------------------------------------
// Resource handlers -- serve HTML views with baked-in data
// ---------------------------------------------------------------------------

const buildResourceResponse = (uri, templateName, data) => {
  const template = loadTemplate(templateName);
  const { _ts, ...viewData } = data;
  const safeJson = JSON.stringify(viewData).replace(/</g, '\\u003c');
  const html = template.replace('/*__DATA__*/ null', safeJson);
  const text = ACTION_CAPABLE_TEMPLATES.has(templateName)
    ? injectActionSubstrate(html, { force: true })
    : html;

  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'text/html;profile=mcp-app',
        text
      }
    ]
  };
};

const buildExpiredResponse = (uri) => {
  const html = loadTemplate('expired');
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'text/html;profile=mcp-app',
        text: html
      }
    ]
  };
};

server.registerResource('Chart View', new ResourceTemplate('ui://RebelCanvas/chart{?id}', {}), {
  mimeType: 'text/html;profile=mcp-app',
  description: 'Interactive chart visualization'
}, async (uri) => {
  const id = uri.searchParams.get('id');
  const data = id ? dataStore.get(id) : undefined;
  if (!data) return buildExpiredResponse(uri);
  return buildResourceResponse(uri, 'chart', data);
});

server.registerResource('Table View', new ResourceTemplate('ui://RebelCanvas/table{?id}', {}), {
  mimeType: 'text/html;profile=mcp-app',
  description: 'Sortable data table'
}, async (uri) => {
  const id = uri.searchParams.get('id');
  const data = id ? dataStore.get(id) : undefined;
  if (!data) return buildExpiredResponse(uri);
  return buildResourceResponse(uri, 'table', data);
});

server.registerResource('Options View', new ResourceTemplate('ui://RebelCanvas/options{?id}', {}), {
  mimeType: 'text/html;profile=mcp-app',
  description: 'Decision options cards'
}, async (uri) => {
  const id = uri.searchParams.get('id');
  const data = id ? dataStore.get(id) : undefined;
  if (!data) return buildExpiredResponse(uri);
  return buildResourceResponse(uri, 'options', data);
});

server.registerResource('Form View', new ResourceTemplate('ui://RebelCanvas/form{?id}', {}), {
  mimeType: 'text/html;profile=mcp-app',
  description: 'Interactive form'
}, async (uri) => {
  const id = uri.searchParams.get('id');
  const data = id ? dataStore.get(id) : undefined;
  if (!data) return buildExpiredResponse(uri);
  return buildResourceResponse(uri, 'form', data);
});

server.registerResource('Confirm View', new ResourceTemplate('ui://RebelCanvas/confirm{?id}', {}), {
  mimeType: 'text/html;profile=mcp-app',
  description: 'Interactive confirmation'
}, async (uri) => {
  const id = uri.searchParams.get('id');
  const data = id ? dataStore.get(id) : undefined;
  if (!data) return buildExpiredResponse(uri);
  return buildResourceResponse(uri, 'confirm', data);
});

server.registerResource('Pick View', new ResourceTemplate('ui://RebelCanvas/picker{?id}', {}), {
  mimeType: 'text/html;profile=mcp-app',
  description: 'Interactive picker'
}, async (uri) => {
  const id = uri.searchParams.get('id');
  const data = id ? dataStore.get(id) : undefined;
  if (!data) return buildExpiredResponse(uri);
  return buildResourceResponse(uri, 'picker', data);
});

server.registerResource('HTML View', new ResourceTemplate('ui://RebelCanvas/html{?id}', {}), {
  mimeType: 'text/html;profile=mcp-app',
  description: 'Custom HTML preview'
}, async (uri) => {
  const id = uri.searchParams.get('id');
  const data = id ? dataStore.get(id) : undefined;
  if (!data) return buildExpiredResponse(uri);

  // html-action shares the html resource URI; the data-store entry's `_type`
  // decides whether to inject the action substrate.
  if ((data._type === 'html' || data._type === 'html-action') && typeof data.html === 'string') {
    const isAction = data._type === 'html-action';
    const text = isAction ? injectActionSubstrate(data.html) : data.html;
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'text/html;profile=mcp-app',
        text
      }]
    };
  }

  // For preview/_type entries (folder mode), return a simple loading page
  // The actual content is served via rebel-preview:// protocol
  if (data._type === 'preview') {
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'text/html;profile=mcp-app',
        text: '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Loading preview...</title></head><body><p>Loading preview via protocol...</p></body></html>'
      }]
    };
  }

  return buildExpiredResponse(uri);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (require.main === module) {
  const transport = new StdioServerTransport();
  server.connect(transport).catch((error) => {
    console.error('[RebelCanvas] Failed to start', error);
    process.exit(1);
  });

  console.error('[RebelCanvas] Server started');
}

module.exports = {
  ACTION_CAPABLE_TEMPLATES,
  ACTION_ID_PATTERN,
  FORM_FIELD_TYPES,
  HTML_ACTION_SUBMIT_PATTERN,
  buildExpiredResponse,
  buildResourceResponse,
  confirmInputSchema,
  dataStore,
  detectsHtmlAction,
  formInputSchema,
  injectActionSubstrate,
  loadActionSubstrateScript,
  loadTemplate,
  pickerInputSchema,
  server,
};
