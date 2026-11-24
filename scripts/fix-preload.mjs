// tsc compiles src/main/preload-nav.cts to dist/main/preload-nav.cjs, so the preload keeps its
// CommonJS extension and needs no scoped package.json. Writing one anyway is actively harmful:
// `{"type":"commonjs"}` in dist/main makes Electron load main.js as CommonJS, which breaks the
// ESM main process with "Cannot use import statement outside a module".
//
// The scoped file is no longer generated. Delete a leftover copy from older builds so a stale
// artifact cannot resurrect the bug.
//
// SANDBOX LAW: a sandboxed preload may only require('electron'); a relative require fails at load
// time with "module not found" inside the sandbox (verified on this stack). Every shared preload
// module is therefore INLINED into the preloads that import it after tsc: the emitted
// `require('./module.cjs')` is replaced by a literal namespace object built from the module body,
// wrapped in an IIFE so its top-level consts cannot collide with the host preload's scope.
//
// Each module lists the exports the host preloads may reference. A module that gains an export must
// be added to MODULES here, or the inlined copy silently lacks it.
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `name` — dist/main/<name>.cjs; `global` — the IIFE global it is inlined under; `exports` — the
 * named exports the preloads are allowed to destructure.
 */
const MODULES = [
  { name: 'preload-gesture', global: 'NTF_GESTURES', exports: ['installGestures'] },
  { name: 'preload-video-swipe', global: 'NTF_VIDEO_SWIPE', exports: ['installVideoSwipe'] },
];

const preloads = [
  join('dist', 'main', 'preload-nav.cjs'),
  join('dist', 'main', 'preload-dock.cjs'),
  join('dist', 'main', 'preload-service.cjs'),
];

const scoped = join('dist', 'main', 'package.json');
if (existsSync(scoped)) {
  rmSync(scoped);
  console.log('removed stale dist/main/package.json (keeps main process ESM)');
}

/** Read a compiled module once, so the body can be pasted into every preload that imports it. */
function loadModule(mod) {
  const file = join('dist', 'main', `${mod.name}.cjs`);
  if (!existsSync(file)) {
    console.error(`fix-preload: missing ${file} — the build did not emit the ${mod.name} module`);
    process.exit(1);
  }
  const body = readFileSync(file, 'utf8');
  const literal = `const ${mod.var} = { ${mod.exports
    .map((name) => `${name}: ${mod.global}.${name}`)
    .join(', ')} };`;
  return { body, literal };
}

for (const mod of MODULES) {
  mod.var = `${mod.name.replace(/[^a-z0-9]/g, '_')}_cjs_1`;
  mod.loaded = loadModule(mod);
}

for (const preload of preloads) {
  if (!existsSync(preload)) {
    console.error(`fix-preload: missing ${preload} — the build did not emit the preload bundle`);
    process.exit(1);
  }
  let code = readFileSync(preload, 'utf8');
  if (!code.includes('require(')) {
    console.error(`fix-preload: ${preload} is not CommonJS — sandboxed preloads must not use import`);
    process.exit(1);
  }
  const injected = [];
  for (const mod of MODULES) {
    const pattern = new RegExp(
      `const\\s+${mod.var}\\s*=\\s*require\\(['"]\\./${mod.name}\\.cjs['"]\\);?`,
    );
    const assignment = code.match(pattern);
    if (!assignment) continue;
    code = code.replace(assignment[0], mod.loaded.literal);
    // The body starts with "use strict"; drop it so the paste is a plain function body, and return
    // the exports object so the literal above can read from it.
    injected.push(
      `const ${mod.global} = (function (exports) {\n${mod.loaded.body.replace(
        /^"use strict";\s*/m,
        '',
      )}\nreturn exports;\n})({});`,
    );
  }
  if (injected.length === 0) {
    console.error(`fix-preload: no shared preload module is imported by ${preload}`);
    process.exit(1);
  }
  writeFileSync(preload, `${injected.join('\n')}\n${code}`);
}
console.log('preloads inlined with shared modules (sandbox-safe)');