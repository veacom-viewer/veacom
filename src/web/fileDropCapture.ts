import { allowExternalDrop, externalDropEffect } from '../ui/fileDrop';

export interface CapturedDrop { files: File[]; entries: FileSystemEntry[] }

/** Directory entries must be taken during the drop. Keep each early selection until the reader installs its handler. */
export function watchFileDrops(target: Document) {
  let pending: CapturedDrop[] | undefined = [];
  let latest: CapturedDrop | null = null;
  target.addEventListener('dragenter', allowExternalDrop, true);
  target.addEventListener('dragover', allowExternalDrop, true);
  target.addEventListener('drop', event => {
    const transfer = event.dataTransfer, effect = externalDropEffect(transfer);
    if (!transfer || !effect) return;
    if (pending) event.preventDefault();
    if (effect !== 'copy' || !transfer.files.length) return;
    const drop = {
      files: Array.from(transfer.files),
      entries: Array.from(transfer.items, item => item.webkitGetAsEntry()).filter((entry): entry is FileSystemEntry => Boolean(entry)),
    };
    if (pending) pending.push(drop);
    else latest = drop;
  }, true);
  return {
    takePending() {
      const early = pending ?? [];
      pending = undefined;
      target.removeEventListener('dragenter', allowExternalDrop, true);
      target.removeEventListener('dragover', allowExternalDrop, true);
      return early;
    },
    takeLatest() { const drop = latest; latest = null; return drop; },
  };
}

declare global { interface Window { veacomFileDrops?: ReturnType<typeof watchFileDrops>; } }
