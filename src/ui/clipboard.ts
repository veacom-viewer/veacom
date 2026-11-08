/** Puts `text` on the clipboard: through the desktop app where VEAcom runs in it, else through the browser. */
export function copyText(text: string): Promise<void> {
  return window.veacom?.copyText ? window.veacom.copyText(text) : navigator.clipboard.writeText(text);
}
