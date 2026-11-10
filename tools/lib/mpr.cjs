// The three-plane MPR as a reader opens and leaves it from the toolbar: the MPR button opens the planes' menu, whose
// first entry is the three-plane screen (or, in that screen, the way back to the layout before it).

/** Presses MPR and then the menu's first entry. */
async function toggleMpr(page) {
  await page.getByTestId('tool-mpr').click();
  await page.locator('[role="menu"] [data-action="toolbar-restore-previous"]').click();
}

module.exports = { toggleMpr };
