// A desktop check's window must not take the computer's own mouse and keyboard. Shown the usual way, the window
// makes the app the active one, so a key press or scroll from the person at the computer, or from another tool's
// computer use, lands in the app under test: in pull request 52 one opened the import window and another moved the
// slice. The check's own input still arrives, through Playwright (the DevTools protocol), which needs neither the
// focus nor the real mouse.
//
// Not on Windows. When the hosted Windows job last passed (run 42384415403), the other desktop checks ran there without
// any of this, and check-interface with an older form of it that lacked the show() change below, which has not run on
// Windows. The Windows checks run only before a release, on the hosted job (nobody at it) and the VM, where
// tools/windows-vm/ui-windows-checks.cjs needs real input.

const { _electron } = require('playwright');

/** Tests own their windows and profile. macOS otherwise waits for a person to dismiss its restoration dialog after a crash probe. */
function launchDesktop(options) {
  if (process.platform !== 'darwin') return _electron.launch(options);
  return _electron.launch({ ...options, args: [...(options.args ?? []), '-ApplePersistenceIgnoreState', 'YES'] });
}

/**
 * Makes the application window ignore real input for the rest of the check. Call it straight after `firstWindow()`:
 * electron/main.cjs creates the window hidden and shows it on `ready-to-show`, and this makes that `show()` leave the
 * app inactive. Whenever the app becomes the active one all the same, it is hidden at once, and its window keeps drawing.
 * @param desktop Playwright's ElectronApplication
 */
async function ignoreOutsideInput(desktop) {
  // Runs in Electron's main process, so it must not use anything from this file.
  await desktop.evaluate(({ app, BrowserWindow }) => {
    if (process.platform === 'win32') return;
    const focused = Boolean(BrowserWindow.getFocusedWindow());
    for (const window of BrowserWindow.getAllWindows()) {
      // Keep drawing while the window is covered or hidden.
      window.webContents.setBackgroundThrottling(false);
      window.setFocusable(false);
      window.setIgnoreMouseEvents(true);
      // On macOS show() also makes the app the active one, and menu shortcuts such as Cmd+Q would reach it.
      window.show = () => window.showInactive();
      window.showInactive();
    }
    if (process.platform !== 'darwin') return;
    // webContents.focus() makes the app the active one too, while its window is shown: the import window calls it as it
    // opens (electron/import-view.cjs). Hiding the app gives the focus straight back, and focus() leaves a hidden window
    // alone. Showing it again would make the app active, so it stays hidden.
    app.on('did-become-active', () => app.hide());
    if (focused) app.hide();
  });
}

module.exports = { ignoreOutsideInput, launchDesktop };
