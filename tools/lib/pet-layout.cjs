async function selectPetLayout(page, action = 'layout-pet-reading') {
  await page.getByTestId('tool-layout').click();
  await page.locator(`[data-action="${action}"]`).click();
}

async function choosePetLayout(page, action) {
  await selectPetLayout(page, action);
  await page.waitForFunction(() => {
    const state = window.__VEACOM_TEST__.state();
    return state.panes.length === 4 && state.fullVolumeLoaded && state.pendingLoads === 0
      && [...document.querySelectorAll('[data-testid="viewport-cell"]')].every(cell => cell.dataset.volumeComplete === 'true');
  });
}
module.exports = { choosePetLayout, selectPetLayout };
