// Windows checks of the frameless window with real OS mouse input, on the packaged app.
// Playwright clicks bypass the window's hit test, so they cannot tell whether a click lands on a control or on
// the toolbar strip that drags the window. Here the mouse goes through Windows (user32 SetCursorPos/mouse_event),
// exactly as a user's would. Screenshots are taken from the screen, so they include the caption buttons that
// Electron draws over the page. Run in the logged-in desktop session (run-gui.ps1), never from SSH session 0.
// Usage: node tools/windows-vm/ui-windows-checks.cjs <packaged-exe> <study> <output-dir>
const { _electron: electron } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const [executable, study, output] = process.argv.slice(2).map(value => path.resolve(value));
const POWERSHELL = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const USER32 = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.UIntPtr e); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);'; [W.U]::SetProcessDPIAware() | Out-Null; $W = [W.U]::GetSystemMetrics(0); $H = [W.U]::GetSystemMetrics(1);`;
const ps = script => execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60_000 });
const wait = ms => `Start-Sleep -Milliseconds ${ms};`;
const DOWN = '[W.U]::mouse_event(2,0,0,0,[UIntPtr]::Zero);', UP = '[W.U]::mouse_event(4,0,0,0,[UIntPtr]::Zero);';
// Cursor moves are sent as absolute mouse input (not just SetCursorPos), so a window move loop sees them.
const to = (x, y) => `[W.U]::SetCursorPos(${Math.round(x)},${Math.round(y)}) | Out-Null; [W.U]::mouse_event(0x8001,[uint32](${Math.round(x)}*65535/($W-1)),[uint32](${Math.round(y)}*65535/($H-1)),0,[UIntPtr]::Zero);`;
const click = (x, y) => ps(`${USER32} ${to(x, y)} ${wait(150)} ${DOWN} ${wait(60)} ${UP} ${wait(250)}`);
const drag = (x, y, dx, dy) => {
  let moves = '';
  for (let step = 1; step <= 12; step++) moves += `${to(x + dx * step / 12, y + dy * step / 12)} ${wait(30)}`;
  return ps(`${USER32} ${to(x, y)} ${wait(150)} ${DOWN} ${wait(150)} ${moves} ${wait(150)} ${UP} ${wait(400)}`);
};
const grab = (file, r) => ps(`Add-Type -AssemblyName System.Drawing; ${USER32} $b = New-Object Drawing.Bitmap ${r.width},${r.height}; $g = [Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${r.x},${r.y},0,0,$b.Size); $b.Save('${file.replace(/'/g, "''")}', [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose()`);

(async () => {
  await fs.mkdir(output, { recursive: true });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-ui-windows-'));
  const result = { executable, study, checks: [], errors: [] };
  const check = (name, detail) => { result.checks.push({ name, detail }); console.log(`PASS ${name}`); };
  const desktop = await electron.launch({ executablePath: executable, args: ['--study', study], env: { ...process.env, VEACOM_USER_DATA: userData }, timeout: 90_000 });
  try {
    const page = await desktop.firstWindow();
    page.on('pageerror', error => result.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') result.errors.push(message.text()); });
    await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded, undefined, { timeout: 90_000 });
    const settle = async () => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await page.waitForTimeout(250); };
    const place = async (width, height, zoom = 1) => {
      await desktop.evaluate(({ BrowserWindow }, [w, h, z]) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window.isMaximized()) window.unmaximize();
        window.webContents.setZoomFactor(z); window.setContentSize(w, h); window.setPosition(16, 16);
        window.show(); window.focus(); window.moveTop();
      }, [width, height, zoom]);
      await page.waitForFunction(([w, z]) => Math.abs(innerWidth - w / z) < 2, [width, zoom]);
      await settle();
    };
    const geometry = () => desktop.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0], bounds = window.getBounds();
      return { bounds, content: window.getContentBounds(), scale: screen.getDisplayMatching(bounds).scaleFactor, zoom: window.webContents.getZoomFactor(), maximized: window.isMaximized() };
    });
    // Page CSS pixels → physical screen pixels (the PowerShell process is DPI-aware).
    const toScreen = (g, x, y) => [(g.content.x + x * g.zoom) * g.scale, (g.content.y + y * g.zoom) * g.scale];
    const shoot = async name => {
      await settle();
      const g = await geometry(), b = g.bounds;
      try { grab(path.join(output, `${name}-screen.png`), { x: Math.round(b.x * g.scale), y: Math.round(b.y * g.scale), width: Math.round(b.width * g.scale), height: Math.round(b.height * g.scale) }); }
      catch (error) { (result.screenErrors ??= []).push(`${name}: ${String(error.message).slice(0, 300)}`); }
      await page.screenshot({ path: path.join(output, `${name}-page.png`) });
    };
    const centre = async locator => { const box = await locator.boundingBox(); return [box.x + box.width / 2, box.y + box.height / 2]; };

    // The VM's screen is 1280 × 800 (taskbar included), so the largest size stays a little smaller to keep the
    // whole window, its caption buttons and every click on screen.
    await place(1200, 720);
    await page.evaluate(() => window.__VEACOM_TEST__.setView({ slice: 50, windowWidth: 400, windowCenter: 40 }));
    result.display = await geometry();

    // The caption buttons take the strip's right end; no toolbar control sits under them.
    const chrome = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:env(titlebar-area-x,-1px);top:env(titlebar-area-y,-1px);width:env(titlebar-area-width,-1px);height:env(titlebar-area-height,-1px)';
      document.body.append(probe); const area = probe.getBoundingClientRect(); probe.remove();
      const bar = document.querySelector('.toolbar'), controls = [...bar.querySelectorAll('button, select, input')].filter(element => element.getClientRects().length);
      return { area: [area.left, area.top, area.width, area.height], toolbarHeight: bar.getBoundingClientRect().height, region: getComputedStyle(bar).getPropertyValue('-webkit-app-region'),
        lastControlRight: Math.max(...controls.map(element => element.getBoundingClientRect().right)), innerWidth };
    });
    assert.ok(chrome.area[2] > 0 && chrome.area[2] < chrome.innerWidth, `Window Controls Overlay area not reported: ${JSON.stringify(chrome)}`);
    assert.ok(chrome.toolbarHeight >= chrome.area[3] - 0.5, `Caption buttons are taller than the toolbar: ${JSON.stringify(chrome)}`);
    assert.ok(chrome.lastControlRight <= chrome.area[0] + chrome.area[2], `A toolbar control sits under the caption buttons: ${JSON.stringify(chrome)}`);
    assert.equal(chrome.region, 'drag');
    check('Caption buttons sit in the toolbar strip, clear of every toolbar control', chrome);
    await shoot('01-viewer-1200x720');

    // Dragging an empty part of the toolbar moves the window, as a title bar does.
    const empty = await page.evaluate(limit => {
      const bar = document.querySelector('.toolbar').getBoundingClientRect(), y = Math.round(bar.top + bar.height / 2);
      const free = x => [-8, 0, 8].every(dx => { const element = document.elementFromPoint(x + dx, y); return element && element.closest('.toolbar') && !element.closest('button, select, input, [role="menu"], .popover-menu'); });
      for (let x = Math.round(limit) - 24; x > bar.left + 24; x -= 4) if (free(x)) return [x, y];
      return null;
    }, chrome.area[0] + chrome.area[2]);
    assert.ok(empty, 'No empty toolbar spot to drag the window by.');
    let g = await geometry();
    const before = g.bounds;
    drag(...toScreen(g, ...empty), 40 * g.scale, 24 * g.scale);
    g = await geometry();
    const moved = [g.bounds.x - before.x, g.bounds.y - before.y];
    assert.ok(Math.abs(moved[0] - 40) <= 3 && Math.abs(moved[1] - 24) <= 3 && !g.maximized, `The window did not follow a drag of the toolbar strip: ${JSON.stringify({ before, after: g.bounds, empty })}`);
    check('Dragging an empty toolbar spot moves the window', { from: empty, moved });
    await place(1200, 720);

    // Real clicks reach controls at the strip's right end and in dialogs, without moving the window.
    const helpClicks = [];
    const helpRoundTrip = async (label, size, zoom) => {
      await place(...size, zoom);
      let g = await geometry();
      const button = page.getByTestId('tool-help'), viaToolbar = await button.isVisible();
      if (viaToolbar) click(...toScreen(g, ...await centre(button))); else await page.keyboard.press('F1');
      await page.locator('dialog.shortcuts-dialog').waitFor({ timeout: 5000 });
      await shoot(`02-help-${label}`);
      g = await geometry();
      const placement = await page.evaluate(() => ({ top: document.querySelector('dialog.shortcuts-dialog').getBoundingClientRect().top, strip: document.querySelector('.toolbar').getBoundingClientRect().bottom }));
      const close = await centre(page.getByTestId('help-close'));
      const start = g.bounds;
      click(...toScreen(g, ...close));
      await page.locator('dialog.shortcuts-dialog').waitFor({ state: 'detached', timeout: 5000 });
      const end = (await geometry()).bounds;
      assert.deepEqual(end, start, `The window moved when the Help close button was clicked (${label}).`);
      assert.ok(placement.top >= placement.strip, `Help reaches into the drag strip (${label}): ${JSON.stringify(placement)}`);
      helpClicks.push({ label, opened: viaToolbar ? 'real click on the toolbar button' : 'F1 (button in the More menu)', placement, close });
    };
    await helpRoundTrip('1200x720', [1200, 720], 1);
    await helpRoundTrip('900x640', [900, 640], 1);
    await helpRoundTrip('zoom150', [1200, 720], 1.5);
    check('Real clicks open Help from the toolbar and close it from its close button, without moving the window', helpClicks);

    await place(900, 640);
    await shoot('03-viewer-900x640');
    await place(1200, 720, 1.5);
    await shoot('04-viewer-zoom150');
    await place(1200, 720);
    assert.deepEqual(result.errors, []);
    check('No renderer errors');
    result.passed = true;
  } catch (error) {
    result.passed = false; result.error = String(error?.stack || error);
    console.error(error); process.exitCode = 1;
  } finally {
    await desktop.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true }).catch(() => {});
    await fs.writeFile(path.join(output, 'ui-windows-checks.json'), JSON.stringify(result, null, 2));
  }
})();
