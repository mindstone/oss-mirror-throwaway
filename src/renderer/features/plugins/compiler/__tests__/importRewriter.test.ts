import { describe, expect, it } from 'vitest';
import { ALLOWED_PLUGIN_REQUIRE_MODULES, rewritePluginRequires, autoImportBarePluginHooks } from '../importRewriter';

describe('rewritePluginRequires', () => {
  it('rewrites all allowed modules to __REBEL_MODULES__ lookups', () => {
    const input = ALLOWED_PLUGIN_REQUIRE_MODULES.map(
      (moduleName, index) => `var m${index} = require("${moduleName}");`,
    ).join('\n');

    const output = rewritePluginRequires(input);

    for (const moduleName of ALLOWED_PLUGIN_REQUIRE_MODULES) {
      expect(output).toContain(`__REBEL_MODULES__["${moduleName}"]`);
      expect(output).not.toContain(`require("${moduleName}")`);
    }
  });

  it('does not include globalThis prefix in rewritten output', () => {
    const input = "var pluginApi = require('@rebel/plugin-api');";

    const output = rewritePluginRequires(input);

    expect(output).toContain('__REBEL_MODULES__["@rebel/plugin-api"]');
    expect(output).not.toContain('globalThis.__REBEL_MODULES__');
    expect(output).not.toContain("require('@rebel/plugin-api')");
  });

  it('rewrites single-quoted require calls', () => {
    const input = "var pluginApi = require('@rebel/plugin-api');";

    const output = rewritePluginRequires(input);

    expect(output).toContain('__REBEL_MODULES__["@rebel/plugin-api"]');
    expect(output).not.toContain("require('@rebel/plugin-api')");
  });

  it('rewrites multiline require calls', () => {
    const input = `var pluginUi = require(\n  "@rebel/plugin-ui"\n);`;

    const output = rewritePluginRequires(input);

    expect(output).toContain('__REBEL_MODULES__["@rebel/plugin-ui"]');
    expect(output).not.toContain('require(');
  });

  it('does not rewrite disallowed require calls', () => {
    const input = 'var fs = require("fs");';

    const output = rewritePluginRequires(input);

    expect(output).toBe(input);
  });
});

describe('autoImportBarePluginHooks', () => {
  it('rewrites bare useMemorySearch call when no plugin-api import exists', () => {
    const code = '"use strict";function Foo() { var x = useMemorySearch("q"); }';
    const result = autoImportBarePluginHooks(code);

    expect(result).toContain('var __autoPluginApi');
    expect(result).toContain('__autoPluginApi.useMemorySearch(');
    expect(result).not.toMatch(/(?<!\.)useMemorySearch\(/);
  });

  it('skips when plugin-api import already present', () => {
    const code = 'var _api = __REBEL_MODULES__["@rebel/plugin-api"]; _api.useMemorySearch("q");';
    const result = autoImportBarePluginHooks(code);

    expect(result).toBe(code);
    expect(result).not.toContain('__autoPluginApi');
  });

  it('rewrites multiple bare hooks', () => {
    const code = '"use strict";function Foo() { useRebel(); useMemorySearch("q"); }';
    const result = autoImportBarePluginHooks(code);

    expect(result).toContain('__autoPluginApi.useRebel(');
    expect(result).toContain('__autoPluginApi.useMemorySearch(');
  });

  it('does not rewrite property accesses (._api.hookName)', () => {
    const code = 'var _api = something; _api.useMemorySearch("q");';
    const result = autoImportBarePluginHooks(code);

    // .useMemorySearch should not be touched
    expect(result).toContain('_api.useMemorySearch(');
    // No __autoPluginApi needed since there are no bare references
    expect(result).not.toContain('__autoPluginApi');
  });

  it('preserves "use strict" directive', () => {
    const code = '"use strict";function Foo() { useMemorySearch("q"); }';
    const result = autoImportBarePluginHooks(code);

    expect(result).toMatch(/^"use strict";/);
    expect(result).toContain('var __autoPluginApi');
  });

  it('handles code without "use strict"', () => {
    const code = 'function Foo() { useMemorySearch("q"); }';
    const result = autoImportBarePluginHooks(code);

    expect(result).toMatch(/^var __autoPluginApi/);
    expect(result).toContain('__autoPluginApi.useMemorySearch(');
  });

  it('returns code unchanged if no bare hooks found', () => {
    const code = '"use strict";function Foo() { return 42; }';
    const result = autoImportBarePluginHooks(code);

    expect(result).toBe(code);
  });
});
