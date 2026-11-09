/** Puts `text` on the clipboard: through the desktop app where VEAcom runs in it, else through the browser. */
export function copyText(text: string): Promise<void> {
  return window.veacom?.copyText ? window.veacom.copyText(text) : navigator.clipboard.writeText(text);
}

/** Puts the picture drawn on `canvas` on the clipboard as an image. The desktop app takes the pixels themselves, so
 * its main process decodes nothing; a browser takes a PNG. */
export async function copyCanvas(canvas: HTMLCanvasElement): Promise<void> {
  if (window.veacom?.copyImage) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The picture cannot be read.');
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    await window.veacom.copyImage({ width: canvas.width, height: canvas.height, pixels: data.buffer });
    return;
  }
  const png = await new Promise<Blob | null>(resolve => { canvas.toBlob(resolve, 'image/png'); });
  if (!png) throw new Error('The picture cannot be encoded.');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
