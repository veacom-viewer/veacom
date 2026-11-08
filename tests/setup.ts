// Loaded before every test file (package.json "test": node --import ./tests/setup.ts --test). Node runs the
// TypeScript itself by stripping its types, so src/ may use only erasable syntax (tsconfig "erasableSyntaxOnly").
// src/ is written for the bundler's resolution ("moduleResolution": "Bundler"): these hooks give TypeScript files the
// same in Node, extensionless and folder imports and JSON without an import attribute. Other files resolve as usual.
import { registerHooks } from 'node:module';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const isFile = (url: URL) => statSync(fileURLToPath(url), { throwIfNoEntry: false })?.isFile() ?? false;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL?.startsWith('file:') ? new URL(context.parentURL) : undefined;
    if (!parent || !/\.tsx?$/.test(parent.pathname) || !/^\.\.?\//.test(specifier)) return nextResolve(specifier, context);
    // A query string survives, so a test can import a fresh copy of a module (`../src/api.ts?fresh=2`).
    const url = new URL(specifier, parent), file = new URL(url.pathname, url);
    if (!isFile(file)) {
      const found = ['.ts', '/index.ts'].map(suffix => new URL(file.href + suffix)).find(isFile);
      if (found) specifier = found.href + url.search + url.hash;
    }
    const resolved = nextResolve(specifier, context);
    if (!new URL(resolved.url).pathname.endsWith('.json')) return resolved;
    return { ...resolved, importAttributes: { ...context.importAttributes, type: 'json' } };
  },
});

// The suite predates the Turkish interface and checks English messages; tests that check Turkish
// switch the language themselves (tests/i18n.test.ts). The main-process modules read VEACOM_LOCALE.
// Imported only now: a static import would load before the hooks above exist.
process.env.VEACOM_LOCALE = 'en';
const { setLocale } = await import('../src/i18n');
setLocale('en');
