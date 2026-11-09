// The browser build's only Trusted Types policy. The site's Content-Security-Policy requires Trusted Types, so no
// text can become HTML or a script without passing through here. Two things are let through:
// - the toolbar's own icon drawings (Glyph.tsx inserts them as SVG markup): only their shapes, with drawing
//   attributes whose values are numbers, words or colours; anything else (a script, an event handler, a link) is refused;
// - the site's own scripts as Workers (the engine, ROI statistics): same-origin URLs only.

const SHAPES = new Set(['circle', 'ellipse', 'path', 'rect', 'g']);
const ATTRIBUTES = new Set(['cx', 'cy', 'd', 'fill', 'fill-opacity', 'height', 'r', 'rx', 'ry', 'stroke', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'stroke-width', 'width', 'x', 'y', 'transform', 'opacity']);
const VALUE = /^[#\w .,()-]*$/;
const TOKEN = /\s*(?:<([a-z]+)((?:\s+[a-z-]+="[^"]*")*)\s*(\/?)>|<\/([a-z]+)>)/gy;
const ATTRIBUTE = /\s+([a-z-]+)="([^"]*)"/g;

/** The markup itself when it is only icon shapes; otherwise an error. */
export function iconMarkup(markup: string): string {
  TOKEN.lastIndex = 0;
  let end = 0;
  for (let match = TOKEN.exec(markup); match; match = TOKEN.exec(markup)) {
    // A tag is either opening or closing: the other one's name group is undefined.
    const [, , attributes = ''] = match, tag = match.at(1) ?? match.at(4);
    if (!tag || !SHAPES.has(tag)) throw new TypeError('Only icon shapes may be inserted as markup.');
    for (const [, name, value] of attributes.matchAll(ATTRIBUTE)) {
      if (!ATTRIBUTES.has(name) || !VALUE.test(value) || /url\s*\(/i.test(value)) throw new TypeError('Only icon shapes may be inserted as markup.');
    }
    end = TOKEN.lastIndex;
  }
  if (markup.slice(end).trim()) throw new TypeError('Only icon shapes may be inserted as markup.');
  return markup;
}

/** A URL on this site, for starting the site's own Workers. */
export function ownScript(url: string): string {
  if (new URL(url, location.href).origin !== location.origin) throw new TypeError('Only this site\'s scripts may be started.');
  return url;
}

export function installTrustedTypes(): void {
  const factory = (window as { trustedTypes?: { createPolicy(name: string, rules: object): unknown } }).trustedTypes;
  factory?.createPolicy('default', {
    createHTML: iconMarkup,
    createScriptURL: ownScript,
    createScript: () => { throw new TypeError('Scripts cannot be created from text.'); },
  });
}
