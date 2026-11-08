// VEAcom's own toolbar drawings (the Python version's app/ui/icons.py, as VEAcom Next carries them in
// assets/glyphs.json): the fusion rings with the PET's orange, the mirror, the window presets, the CD, and the mouse
// buttons with their function's badge. Drawn in the button's text colour, so they follow the theme and its states.
import data from '../assets/glyphs.json';
import type { Tool, WheelAction } from '../model';

const STROKE = data.colours.stroke;
const ACCENT = data.colours.accent;
const BUTTON_COLOURS: Record<string, string> = data.colours.buttons;
const PLANE_RED = '#ff5c5c', PLANE_BLUE = '#54a8ff', PET_HOT = '#ff8c1a';
const glyphs = data.glyphs as Record<string, string>;

/** The glyph's inner SVG with its colour slots filled; the foreground is the button's own colour. */
function glyphBody(name: string, accent = ACCENT, width = STROKE): string {
  return (glyphs[name] ?? glyphs.none).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')
    .replaceAll('{fg}', 'currentColor').replaceAll('{accent}', accent).replaceAll('{w}', String(width))
    .replaceAll('{red}', PLANE_RED).replaceAll('{blue}', PLANE_BLUE).replaceAll('{hot}', PET_HOT);
}

export function Glyph({ name, size = 20 }: { name: string; size?: number }) {
  return <svg className="glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={STROKE}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: glyphBody(name) }} />;
}

/** A tool's glyph name in the drawings. */
export const TOOL_GLYPHS: Record<Tool, string> = {
  scroll: 'scroll', window: 'window', pan: 'pan', zoom: 'zoom', rotate: 'rotate', none: 'none', length: 'line', angle: 'angle', cobb: 'cobb',
  rectangle: 'rect', ellipse: 'ellipse', polygon: 'polygon', polyline: 'polyline', probe: 'probe', arrow: 'arrow', text: 'text', crosshair: 'crosshair',
  sphere: 'sphere',
};
export const WHEEL_GLYPHS: Record<WheelAction, string> = { scroll: 'scroll', zoom: 'zoom', rotate: 'rotate', none: 'none' };

export type MouseButtonName = 'left' | 'middle' | 'right' | 'wheel';

/** The top of a mouse with `button` filled in its own colour and the function's badge in the corner (VEAcom 1.x). */
export function MouseGlyph({ button, glyph, size = 20 }: { button: MouseButtonName; glyph: string; size?: number }) {
  const own = BUTTON_COLOURS[button] ?? ACCENT;
  const clip = `mouse-glyph-${button}`;
  const dome = 'M1 14V8A7 7 0 0 1 15 8V14Z';
  const onWheel = button === 'wheel' || button === 'middle';
  const badge = 24 * 0.47, badgeSize = 24 * 0.53;
  // The bar's own colour (a CSS variable, so set as a style: SVG attributes take no var()).
  const bar = { fill: 'var(--bg-chrome)' };
  return <svg className="glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <defs><clipPath id={clip}><rect x={button === 'right' ? 8 : 0} y="0" width="8" height="14" /></clipPath></defs>
    <g transform="translate(0 0.3) scale(1.15)">
      {(button === 'left' || button === 'right') && <path d={dome} fill={own} clipPath={`url(#${clip})`} />}
      <path d={dome} fill="none" stroke="currentColor" strokeWidth="1.2" />
      <line x1="8" y1="1" x2="8" y2="14" stroke="currentColor" strokeWidth="1.2" />
      <rect x="5.5" y="2.6" width="5" height="8" rx="2.5" fill={onWheel ? own : undefined} style={onWheel ? undefined : bar} stroke="currentColor" strokeWidth="1" />
      {button === 'wheel' && [4.8, 6.6, 8.4].map(y => <rect key={y} x="6" y={y - 0.45} width="4" height="0.9" style={bar} />)}
    </g>
    <rect x={badge - 0.8} y={badge - 0.8} width={badgeSize + 1.6} height={badgeSize + 1.6} rx="3" style={bar} />
    <g transform={`translate(${badge} ${badge}) scale(${badgeSize / 24})`} fill="none" stroke={own} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: glyphBody(glyph, own, 2.1).replaceAll('currentColor', own) }} />
  </svg>;
}

/** The thick-slab button's picture: a slab of stacked slices. */
export function SlabGlyph({ size = 20, on = false }: { size?: number; on?: boolean }) {
  return <svg className="glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" aria-hidden="true">
    <path d="M4 5h16M4 19h16" opacity={0.55} />
    <rect x="4" y="8.5" width="16" height="7" rx="1.2" fill={on ? ACCENT : 'currentColor'} fillOpacity={on ? 0.45 : 0.18} stroke={on ? ACCENT : 'currentColor'} />
  </svg>;
}
