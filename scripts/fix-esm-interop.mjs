#!/usr/bin/env node
/**
 * Post-build script to fix ESM default export interop issues.
 * 
 * Problem: electron-store is an ESM-only package ("type": "module").
 * When the bundled CJS output uses require('electron-store'), Node.js
 * returns { default: Store } instead of Store directly.
 * 
 * Solution: Transform the require to extract the default export.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainOutputPath = path.join(__dirname, '..', 'out', 'main', 'index.js');

// ESM packages that need default export extraction
const ESM_PACKAGES = ['electron-store'];

function fixEsmInterop() {
  if (!fs.existsSync(mainOutputPath)) {
    console.log('[fix-esm-interop] No build output found, skipping');
    return;
  }

  let code = fs.readFileSync(mainOutputPath, 'utf-8');
  let changed = false;

  for (const pkg of ESM_PACKAGES) {
    // Match: const VarName = require("package-name");
    const pattern = new RegExp(
      `const (\\w+) = require\\("${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\);`,
      'g'
    );

    const replacement = `const _esm_${pkg.replace(/-/g, '_')} = require("${pkg}"); const $1 = _esm_${pkg.replace(/-/g, '_')}.default ?? _esm_${pkg.replace(/-/g, '_')};`;

    if (pattern.test(code)) {
      code = code.replace(pattern, replacement);
      changed = true;
      console.log(`[fix-esm-interop] Fixed ESM interop for: ${pkg}`);
    }
  }

  if (changed) {
    fs.writeFileSync(mainOutputPath, code);
    console.log('[fix-esm-interop] Build output updated successfully');
  } else {
    console.log('[fix-esm-interop] No ESM packages needed fixing');
  }
}

fixEsmInterop();
