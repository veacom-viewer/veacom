/** The reader accepts files from the OS and prevents links from navigating away from open studies. */
export function externalDropEffect(transfer: DataTransfer | null): 'copy' | 'none' | undefined {
  const types = transfer?.types;
  if (types?.includes('Files') && !types.includes('application/x-veacom-series')) return 'copy';
  if (types?.includes('text/uri-list')) return 'none';
}

export function allowExternalDrop(event: DragEvent): void {
  const effect = externalDropEffect(event.dataTransfer);
  if (!event.dataTransfer || !effect) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = effect;
}
