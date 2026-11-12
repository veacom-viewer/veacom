// How many series one DICOM export holds, to a folder, a USB stick or a disc. The main process refuses a larger request
// (electron/main.cjs; a disc's series pass the same check after electron/media.cjs) and the export window does not
// offer one (src/components/ExportDialog.tsx).
export const MAX_EXPORT_SERIES = 512;
