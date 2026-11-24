/** Opens or restores three-plane MPR on the current toolbar and on the split toolbar in older builds. */
async function toggleMpr(page) {
  const button = page.getByTestId('tool-mpr');
  const opensMenu = await button.getAttribute('aria-haspopup') === 'menu';
  await button.click();
  if (opensMenu) await page.locator('[role="menu"] [data-action="toolbar-restore-previous"]').click();
}

module.exports = { toggleMpr };
