/** Opens the system print dialog for the page: through the desktop app (Electron's own print) where VEAcom runs in it,
 * else the browser's. False when the reader cancels it in the desktop app; a browser does not say. */
export function printPage(): Promise<boolean> {
  if (window.veacom?.printPage) return window.veacom.printPage();
  window.print();
  return Promise.resolve(true);
}
