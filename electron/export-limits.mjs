// How many series one DICOM export holds, to a folder or a USB stick. The main process refuses a larger request
// (electron/main.cjs) and the export window does not offer one (src/components/ExportDialog.tsx). Writing a disc has
// a limit of its own (electron/media.cjs).
export const MAX_EXPORT_SERIES = 512;
