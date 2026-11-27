export const HEAD_BYTES: number;
export const HEAD_GROUP_SIZE: number;
export const MAX_PREFETCH_BYTES: number;
export function readHeads(files: ReadonlyArray<{ file: Blob }>, waitForFiles?: (offset: number) => Promise<void>,
  onHead?: (index: number, head: Uint8Array | undefined) => void): Promise<(Uint8Array | undefined)[]>;
