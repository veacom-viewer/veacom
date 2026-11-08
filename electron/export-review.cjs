const { messagePages } = require('./feedback.cjs');

// Only the native window can approve the selected catalog revisions.
async function reviewExportPixels(dialog, parent, series, t, frame) {
  if (!parent || parent.isDestroyed()) return null;
  const label = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu, ' ').slice(0, 80);
  const selected = series.map(item => [item.patientName, item.patientId, item.description, item.studyUid, item.uid].map(label).filter(Boolean).join(' · ') || item.id);
  const pages = messagePages(selected.join('\n'));
  for (const [index, page] of pages.entries()) {
    const last = index === pages.length - 1;
    const { response } = await dialog.showMessageBox(parent, {
      type: 'warning', noLink: true, defaultId: 0, cancelId: 0,
      title: t('export.reviewTitle'), message: t('export.reviewMessage', { count: series.length }),
      detail: [t('export.reviewDetail'), page, frame === undefined ? '' : t('export.reviewSlice', { n: frame + 1 })].filter(Boolean).join('\n\n'),
      buttons: [t('feedback.confirmCancel'), t(last ? 'export.reviewAccept' : 'feedback.confirmNext')],
    });
    if (response !== 1 || parent.isDestroyed()) return null;
  }
  return Object.fromEntries(series.map(item => [item.id, item.catalogRevision]));
}
module.exports = { reviewExportPixels };
