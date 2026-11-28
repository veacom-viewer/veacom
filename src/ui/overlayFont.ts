const FALLBACK_FONT = 'Arial, "Segoe UI", sans-serif';
export function overlayFont() {
  return document.fonts.check('12px Inter') ? `Inter, ${FALLBACK_FONT}` : FALLBACK_FONT;
}
export function subscribeFont(listener: () => void) {
  document.fonts.addEventListener('loadingdone', listener);
  document.fonts.addEventListener('loadingerror', listener);
  return () => {
    document.fonts.removeEventListener('loadingdone', listener);
    document.fonts.removeEventListener('loadingerror', listener);
  };
}

const MAX_WIDTH_CACHE = 512;
let measureContext: CanvasRenderingContext2D | null | undefined, measuredFont = '';
const widthCache = new Map<string, number>();
const fitCache = new Map<string, string>();
let fontListenerAttached = false;

function ensureFontInvalidation() {
  if (fontListenerAttached || typeof document === 'undefined') return;
  const fonts = (document as { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  fontListenerAttached = true;
  fonts.addEventListener('loadingdone', () => {
    widthCache.clear();
    fitCache.clear();
  });
}

export function textWidth(text: string, family: string, weight: 400 | 500) {
  if (measureContext === undefined) measureContext = document.createElement('canvas').getContext('2d');
  if (!measureContext) return text.length * (weight === 500 ? 7 : 6.5);
  ensureFontInvalidation();
  const key = `${weight}\0${family}\0${text}`;
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;
  const font = `${weight} 12px ${family}`;
  if (measuredFont !== font) { measureContext.font = font; measuredFont = font; }
  const measured = measureContext.measureText(text).width;
  if (widthCache.size >= MAX_WIDTH_CACHE) widthCache.clear();
  widthCache.set(key, measured);
  return measured;
}

export function fitWidth(text: string, width: number, family: string) {
  if (textWidth(text, family, 400) <= width) return text;
  const key = `${width}\0${family}\0${text}`;
  const cached = fitCache.get(key);
  if (cached !== undefined) return cached;
  let low = Math.min(3, text.length), high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (textWidth(`${text.slice(0, middle)}…`, family, 400) <= width) low = middle;
    else high = middle - 1;
  }
  const fitted = `${text.slice(0, low).trimEnd()}…`;
  if (fitCache.size >= MAX_WIDTH_CACHE) fitCache.clear();
  fitCache.set(key, fitted);
  return fitted;
}
