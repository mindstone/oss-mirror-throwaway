(function () {
  'use strict';

  var ACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
  var FIELD_STRING_LIMIT = 4096;
  var CONTENT_BYTE_LIMIT = 12 * 1024;
  var SUMMARY_LIMIT = 240;
  var REQUEST_TIMEOUT_MS = 30 * 1000;
  var CANCELLED_ACTION_ID_LIMIT = 50;
  var ENVELOPE_TAG = 'rebel-canvas-submit-v1';
  var PROMPT_INJECTION_LITERAL = 'ignore previous instructions';
  var requestId = 1;
  var pendingRequests = new Map();
  var pendingRetry = null;
  var cancelledActionIds = new Set();
  var inFlightElements = new Set();
  var warnedInvalidElements = typeof WeakSet === 'function' ? new WeakSet() : null;

  // Pixel fallbacks in `var(--rc-status-*, Npx)` are deliberate: canvas views
  // (form/confirm/picker) define the tokens, but Stage 4 html-action hosts
  // agent-authored HTML that may not declare canvas tokens. The fallbacks keep
  // status UI legible in that surface without forcing every host to inject the
  // full token set.
  function getStatusEl() {
    var existing = document.querySelector('[data-rebel-canvas-status]');
    if (existing) return existing;
    var el = document.createElement('div');
    el.setAttribute('data-rebel-canvas-status', '');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.marginTop = 'var(--rc-status-gap, 12px)';
    el.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    el.style.fontSize = 'var(--rc-status-fs, 12px)';
    el.style.lineHeight = 'var(--rc-status-lh, 1.4)';
    el.style.padding = 'var(--rc-status-pad, 8px)';
    document.body.appendChild(el);
    return el;
  }

  function renderStatus(message, kind, retryHandler) {
    var el = getStatusEl();
    el.textContent = '';
    el.dataset.rebelCanvasStatusKind = kind || 'info';
    var text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);
    if (typeof retryHandler === 'function') {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Try again';
      button.style.marginLeft = 'var(--rc-status-button-gap, 8px)';
      button.addEventListener('click', retryHandler);
      el.appendChild(button);
    }
  }

  function clearStatus() {
    var el = document.querySelector('[data-rebel-canvas-status]');
    if (el) el.textContent = '';
  }

  function escapeAngleBrackets(value) {
    return String(value == null ? '' : value).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function truncateSummary(value) {
    var text = String(value == null ? '' : value).trim();
    if (text.length <= SUMMARY_LIMIT) return text;
    return text.slice(0, SUMMARY_LIMIT - 1) + '…';
  }

  function containsPromptInjectionLiteral(value) {
    if (typeof value === 'string') {
      return value.toLowerCase().indexOf(PROMPT_INJECTION_LITERAL) !== -1;
    }
    if (Array.isArray(value)) {
      return value.some(containsPromptInjectionLiteral);
    }
    if (value && typeof value === 'object') {
      return Object.keys(value).some(function (key) {
        return containsPromptInjectionLiteral(key) || containsPromptInjectionLiteral(value[key]);
      });
    }
    return false;
  }

  function cloneWithTruncation(value, state) {
    if (typeof value === 'string') {
      if (value.length > FIELD_STRING_LIMIT) {
        state.truncated = true;
        return value.slice(0, FIELD_STRING_LIMIT) + '…[truncated; ' + value.length + ' chars]';
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(function (item) { return cloneWithTruncation(item, state); });
    }
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (key) {
        out[key] = cloneWithTruncation(value[key], state);
      });
      return out;
    }
    return value;
  }

  function buildPayload(actionId, payload) {
    var base = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.assign({ actionId: actionId }, payload)
      : { actionId: actionId, value: payload };
    var state = { truncated: false };
    var cloned = cloneWithTruncation(base, state);
    if (state.truncated && cloned && typeof cloned === 'object' && !Array.isArray(cloned)) {
      cloned._truncated = true;
    }
    return cloned;
  }

  function byteLength(value) {
    if (typeof TextEncoder === 'function') {
      return new TextEncoder().encode(value).length;
    }
    return value.length * 2;
  }

  function buildContent(actionId, summary, payload) {
    if (!ACTION_ID_RE.test(actionId)) {
      throw new Error('Invalid action id. The action was not sent.');
    }
    if (containsPromptInjectionLiteral(summary) || containsPromptInjectionLiteral(payload)) {
      throw new Error('Action could not be sent because the content was rejected by safety checks. Try rephrasing.');
    }
    var safeSummary = escapeAngleBrackets(truncateSummary(summary || ('Submitted ' + actionId)));
    var finalPayload = buildPayload(actionId, payload);
    var json = JSON.stringify(finalPayload).replace(/</g, '\\u003c');
    var content = safeSummary + '\n\n<' + ENVELOPE_TAG + '>\n' + json + '\n</' + ENVELOPE_TAG + '>';
    if (byteLength(content) > CONTENT_BYTE_LIMIT) {
      throw new Error('Form data too large. Reduce length and try again.');
    }
    return { content: content, payload: finalPayload };
  }

  function isTrustedActivation(event) {
    if (!(event instanceof Event)) return false;
    if (!event || event.isTrusted !== true) return false;
    var activation = typeof navigator === 'undefined' ? null : navigator.userActivation;
    if (activation && activation.isActive !== true) return false;
    return true;
  }

  function rememberCancelledActionId(actionId) {
    var id = String(actionId || '');
    if (!id) return;
    if (cancelledActionIds.has(id)) cancelledActionIds.delete(id);
    cancelledActionIds.add(id);
    while (cancelledActionIds.size > CANCELLED_ACTION_ID_LIMIT) {
      cancelledActionIds.delete(cancelledActionIds.keys().next().value);
    }
  }

  function isActionCancelled(actionId) {
    return cancelledActionIds.has(String(actionId || ''));
  }

  function clearCancelledActionId(actionId) {
    cancelledActionIds.delete(String(actionId || ''));
  }

  function postSendMessage(content, actionId) {
    var id = requestId++;
    var message = {
      jsonrpc: '2.0',
      id: id,
      method: 'ui/sendMessage',
      params: {
        role: 'user',
        content: content
      }
    };

    return new Promise(function (resolve, reject) {
      var timeoutId = setTimeout(function () {
        if (!pendingRequests.has(id)) return;
        pendingRequests.delete(id);
        var error = new Error('Request timed out. Try again.');
        error.rebelCanvasTimeout = true;
        reject(error);
      }, REQUEST_TIMEOUT_MS);
      pendingRequests.set(id, { actionId: String(actionId || ''), resolve: resolve, reject: reject, timeoutId: timeoutId });
      window.parent.postMessage(message, '*');
    });
  }

  function setElementBusy(element, busy) {
    if (!element || typeof element !== 'object') return;
    if ('disabled' in element) element.disabled = busy;
    if (element.setAttribute) element.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function isPermissionError(error) {
    var message = String(error && error.message ? error.message : error || '').toLowerCase();
    return message.indexOf('permission') !== -1
      || message.indexOf('grant') !== -1
      || message.indexOf('allow') !== -1
      || message.indexOf('settings') !== -1;
  }

  function normalizeArgs(args) {
    var first = args[0];
    if (first instanceof Event) {
      return {
        event: first,
        actionId: args[1],
        summary: args[2],
        payload: args[3],
        options: args[4] || {}
      };
    }
    var options = args[3] || {};
    return {
      event: options.event || window.event,
      actionId: first,
      summary: args[1],
      payload: args[2],
      options: options
    };
  }

  function publicOptions(options) {
    options = options || {};
    return {
      event: options.event,
      sourceElement: options.sourceElement,
      onRequestStateChange: typeof options.onRequestStateChange === 'function' ? options.onRequestStateChange : undefined,
      silent: options.silent
    };
  }

  function notifyRequestState(options, busy) {
    if (options && typeof options.onRequestStateChange === 'function') {
      options.onRequestStateChange(busy);
    }
  }

  function isRunningInIframe() {
    return window.parent !== window;
  }

  function submitInternal(event, actionId, summary, payload, options) {
    options = options || {};
    if (!isRunningInIframe()) {
      renderStatus('Not running inside a Rebel canvas iframe', 'error');
      return Promise.resolve({ success: false, rejected: 'not_iframe' });
    }
    if (!options.bypassTrust && !isTrustedActivation(event)) {
      console.warn('[RebelCanvas] Ignored action submit without trusted user activation.');
      renderStatus('Action was not sent because it did not come from a real click or submit.', 'error');
      return Promise.resolve({ success: false, rejected: 'untrusted' });
    }

    var sourceElement = options.sourceElement || event && event.currentTarget;
    if (sourceElement && inFlightElements.has(sourceElement)) {
      return Promise.resolve({ success: false, rejected: 'in_flight' });
    }
    var normalizedActionId = String(actionId || '');
    var built;
    try {
      built = buildContent(normalizedActionId, summary, payload);
    } catch (error) {
      var message = error instanceof Error ? error.message : String(error);
      renderStatus(message, 'error');
      return Promise.resolve({ success: false, rejected: 'invalid', message: message });
    }

    if (options.autoRetry) pendingRetry = null;
    pendingRetry = null;
    clearCancelledActionId(normalizedActionId);
    if (sourceElement) inFlightElements.add(sourceElement);
    setElementBusy(sourceElement, true);
    notifyRequestState(options, true);
    renderStatus(options.autoRetry ? 'Permission granted — resending…' : 'Submitting…', 'pending');

    return postSendMessage(built.content, normalizedActionId).then(function (result) {
      pendingRetry = null;
      if (sourceElement) inFlightElements.delete(sourceElement);
      setElementBusy(sourceElement, false);
      notifyRequestState(options, false);
      renderStatus('Submitted.', 'success');
      return Object.assign({ success: true }, result || {}, { submittedPayload: built.payload });
    }).catch(function (error) {
      if (sourceElement) inFlightElements.delete(sourceElement);
      setElementBusy(sourceElement, false);
      notifyRequestState(options, false);
      var message = error && error.message ? error.message : 'Action could not be sent. Try again.';
      if (message === 'cancelled') {
        pendingRetry = null;
        clearStatus();
        return { success: false, rejected: 'cancelled' };
      } else if (isPermissionError(error) && !options.autoRetry) {
        // Stage 2 refinement: keep the original submit() Promise pending while
        // permission is being granted, so declarative views learn whether the
        // host-origin auto-retry ultimately submitted or failed.
        return new Promise(function (resolve) {
          pendingRetry = {
            actionId: String(actionId || ''),
            summary: summary,
            payload: payload,
            sourceElement: sourceElement,
            onRequestStateChange: options.onRequestStateChange,
            resolve: resolve
          };
          renderStatus(message, 'permission_denied', function (retryEvent) {
            runPendingRetry(retryEvent, false);
          });
        });
      } else {
        pendingRetry = null;
        renderStatus(message, 'error', error && error.rebelCanvasTimeout ? undefined : function (retryEvent) {
          return submitInternal(retryEvent, actionId, summary, payload, { sourceElement: sourceElement });
        });
      }
      return { success: false, error: error };
    });
  }

  function runPendingRetry(event, bypassTrust) {
    if (!pendingRetry) return Promise.resolve({ success: false, rejected: 'no_pending_retry' });
    var retry = pendingRetry;
    pendingRetry = null;
    return submitInternal(event, retry.actionId, retry.summary, retry.payload, {
      sourceElement: retry.sourceElement,
      onRequestStateChange: retry.onRequestStateChange,
      bypassTrust: bypassTrust,
      autoRetry: true
    }).then(function (result) {
      if (typeof retry.resolve === 'function') retry.resolve(result);
      return result;
    });
  }

  function clearPendingRetry(actionId) {
    if (!pendingRetry) return false;
    if (actionId && pendingRetry.actionId !== String(actionId)) return false;
    var retry = pendingRetry;
    pendingRetry = null;
    if (typeof retry.resolve === 'function') {
      retry.resolve({ success: false, rejected: 'cleared' });
    }
    clearStatus();
    return true;
  }

  function markCancelled(actionId) {
    var id = String(actionId || '');
    if (!id) return false;
    var cancelled = false;
    rememberCancelledActionId(id);
    pendingRequests.forEach(function (pending, requestIdKey) {
      if (pending.actionId !== id) return;
      pendingRequests.delete(requestIdKey);
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('cancelled'));
      cancelled = true;
    });
    if (pendingRetry && pendingRetry.actionId === id) {
      var retry = pendingRetry;
      pendingRetry = null;
      if (typeof retry.resolve === 'function') {
        retry.resolve({ success: false, rejected: 'cancelled' });
      }
      cancelled = true;
    }
    clearStatus();
    return cancelled;
  }

  function submit() {
    var parsed = normalizeArgs(arguments);
    return submitInternal(parsed.event, parsed.actionId, parsed.summary, parsed.payload, publicOptions(parsed.options));
  }

  function collectFormData(form) {
    var fields = {};
    Array.prototype.forEach.call(form.elements || [], function (field) {
      if (!field.name || field.disabled) return;
      if ((field.type === 'checkbox' || field.type === 'radio') && !field.checked) return;
      if (field.type === 'checkbox') {
        if (Object.prototype.hasOwnProperty.call(fields, field.name)) {
          if (!Array.isArray(fields[field.name])) fields[field.name] = [fields[field.name]];
          fields[field.name].push(field.value || true);
        } else {
          fields[field.name] = field.value || true;
        }
        return;
      }
      fields[field.name] = field.value;
    });
    return { fields: fields };
  }

  function escapeAttributeValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function findElementsByName(name) {
    try {
      return Array.prototype.slice.call(document.querySelectorAll('[name="' + escapeAttributeValue(name) + '"]'));
    } catch (_) {
      return Array.prototype.slice.call(document.querySelectorAll('[name]')).filter(function (element) {
        return element.getAttribute('name') === name;
      });
    }
  }

  function collectIncludedFieldValue(elements) {
    var sawCheckbox = false;
    var checkboxValues = [];
    var sawRadio = false;
    var radioValue;
    var hasRadioValue = false;
    var regularValue;
    var hasRegularValue = false;

    Array.prototype.forEach.call(elements || [], function (field) {
      if (!field.name || field.disabled) return;
      var type = String(field.type || '').toLowerCase();
      if (type === 'checkbox') {
        sawCheckbox = true;
        if (field.checked) checkboxValues.push(field.value || true);
        return;
      }
      if (type === 'radio') {
        sawRadio = true;
        if (field.checked) {
          radioValue = field.value;
          hasRadioValue = true;
        }
        return;
      }
      regularValue = field.value;
      hasRegularValue = true;
    });

    if (hasRegularValue) return { hasValue: true, value: regularValue };
    if (hasRadioValue) return { hasValue: true, value: radioValue };
    if (sawCheckbox) return { hasValue: true, value: checkboxValues };
    if (sawRadio) return { hasValue: false };
    return { hasValue: false };
  }

  function collectButtonIncludeData(button) {
    if (!button.hasAttribute || !button.hasAttribute('data-rebel-include')) return {};
    var fields = {};
    var includeNames = String(button.getAttribute('data-rebel-include') || '')
      .split(',')
      .map(function (name) { return name.trim(); })
      .filter(Boolean);

    includeNames.forEach(function (name) {
      var elements = findElementsByName(name);
      if (!elements.length) return;
      var collected = collectIncludedFieldValue(elements);
      if (collected.hasValue) fields[name] = collected.value;
    });

    return { fields: fields };
  }

  function warnInvalidElement(element, actionId) {
    if (warnedInvalidElements && warnedInvalidElements.has(element)) return;
    if (warnedInvalidElements) warnedInvalidElements.add(element);
    console.warn('[RebelCanvas] Ignored invalid data-rebel-submit action id:', actionId);
  }

  function bindActionElements(rootEl) {
    var root = rootEl || document.body;
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-rebel-submit]'), function (element) {
      var actionId = element.getAttribute('data-rebel-submit') || '';
      if (!ACTION_ID_RE.test(actionId)) {
        warnInvalidElement(element, actionId);
        return;
      }
      if (element.dataset.rebelCanvasBound === 'true') return;
      element.dataset.rebelCanvasBound = 'true';
      var handler = function (event) {
        event.preventDefault();
        var form = element.tagName === 'FORM' ? element : null;
        var payload = form ? collectFormData(form) : collectButtonIncludeData(element);
        var summary = element.getAttribute('data-rebel-summary')
          || (form ? 'Submitted form' : (element.textContent || 'Submitted action'));
        submitInternal(event, actionId, summary, payload, { sourceElement: element });
      };
      element.addEventListener(element.tagName === 'FORM' ? 'submit' : 'click', handler);
    });
  }

  function ready() {
    window.parent.postMessage({ method: 'mcp-app:ready' }, '*');
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (data && data.jsonrpc === '2.0' && pendingRequests.has(data.id)) {
      if (event.source !== window.parent) {
        console.debug('[RebelCanvas] Ignored JSON-RPC response from non-parent window.');
        return;
      }
      if (
        !Object.prototype.hasOwnProperty.call(data, 'result')
        && !Object.prototype.hasOwnProperty.call(data, 'error')
      ) {
        console.debug('[RebelCanvas] Ignored malformed JSON-RPC response.');
        return;
      }
      var pending = pendingRequests.get(data.id);
      if (isActionCancelled(pending.actionId)) {
        pendingRequests.delete(data.id);
        clearTimeout(pending.timeoutId);
        return;
      }
      pendingRequests.delete(data.id);
      clearTimeout(pending.timeoutId);
      if (data.error) {
        pending.reject(new Error(data.error.message || 'Action could not be sent.'));
      } else {
        pending.resolve(data.result || { success: true });
      }
      return;
    }

    if (!data || data.kind !== 'mcp-app:permission-changed') return;
    if (event.source !== window.parent) {
      console.warn('[RebelCanvas] Ignored permission change message from non-parent window.');
      return;
    }
    if (!pendingRetry) return;
    if (isActionCancelled(pendingRetry.actionId)) {
      var retry = pendingRetry;
      pendingRetry = null;
      if (typeof retry.resolve === 'function') {
        retry.resolve({ success: false, rejected: 'cancelled' });
      }
      clearStatus();
      return;
    }
    runPendingRetry(null, true);
  });

  window.__rebelCanvas = Object.assign(window.__rebelCanvas || {}, {
    submit: submit,
    bindActionElements: bindActionElements,
    clearPendingRetry: clearPendingRetry,
    markCancelled: markCancelled,
    ready: ready
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      bindActionElements(document.body);
      ready();
    });
  } else {
    bindActionElements(document.body);
    ready();
  }
})();
