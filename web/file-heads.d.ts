export const HEAD_GROUP_SIZE: number;
export function readHeads(files: ReadonlyArray<{ file: Blob }>, waitForFiles?: (offset: number) => Promise<void>): Promise<(Uint8Array | undefined)[]>;
