// The import window's icons: shapes from Lucide (ISC licence, public/icons/lucide-LICENSE.txt), as in
// src/components/icons.tsx, but drawn without React so that the window loads no package code (main.ts).

type Shape = [tag: 'path' | 'circle' | 'rect', attributes: Record<string, string>];
const path = (d: string): Shape => ['path', { d }];
const circle = (cx: string, cy: string, r: string): Shape => ['circle', { cx, cy, r }];
const rect = (x: string, y: string, width: string, height: string): Shape => ['rect', { x, y, width, height, rx: '1' }];

const ICONS = {
  arrowUp: [path('m5 12 7-7 7 7'), path('M12 19V5')],
  disc: [circle('12', '12', '10'), path('M6 12c0-1.7.7-3.2 1.8-4.2'), circle('12', '12', '2'), path('M18 12c0 1.7-.7 3.2-1.8 4.2')],
  archive: [path('M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5'),
    path('M14 2v5a1 1 0 0 0 1 1h5'), path('M8 12v-1'), path('M8 18v-2'), path('M8 7V6'), circle('8', '20', '2')],
  folder: [path('M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z')],
  folderOpen: [path('m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2')],
  hardDrive: [path('M10 16h.01'), path('M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'),
    path('M21.946 12.013H2.054'), path('M6 16h.01')],
  network: [rect('16', '16', '6', '6'), rect('2', '16', '6', '6'), rect('9', '2', '6', '6'), path('M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3'), path('M12 12V8')],
  pin: [path('M12 17v5'), path('M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z')],
  pinOff: [path('M12 17v5'), path('M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89'), path('m2 2 20 20'), path('M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11')],
  usb: [circle('10', '7', '1'), circle('4', '20', '1'), path('M4.7 19.3 19 5'), path('m21 3-3 1 2 2Z'), path('M9.26 7.68 5 12l2 5'), path('m10 14 5 2 3.5-3.5'), path('m18 12 1-1 1 1-1 1Z')],
  x: [path('M18 6 6 18'), path('m6 6 12 12')],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;
const SVG = 'http://www.w3.org/2000/svg';

export function icon(name: IconName, size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  const attributes = { width: String(size), height: String(size), viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
  for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
  for (const [tag, shape] of ICONS[name]) {
    const element = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(shape)) element.setAttribute(key, value);
    svg.append(element);
  }
  return svg;
}
