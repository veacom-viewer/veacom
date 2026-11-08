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

let measureContext: CanvasRenderingContext2D | null | undefined, measuredFont = '';
export function textWidth(text: string, family: string, weight: 400 | 500) {
  if (measureContext === undefined) measureContext = document.createElement('canvas').getContext('2d');
  if (!measureContext) return text.length * (weight === 500 ? 7 : 6.5);
  const font = `${weight} 12px ${family}`;
  if (measuredFont !== font) { measureContext.font = font; measuredFont = font; }
  return measureContext.measureText(text).width;
}

export function fitWidth(text: string, width: number, family: string) {
  if (textWidth(text, family, 400) <= width) return text;
  let low = Math.min(3, text.length), high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (textWidth(`${text.slice(0, middle)}…`, family, 400) <= width) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low).trimEnd()}…`;
}
