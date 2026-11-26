export const HEAD_GROUP_SIZE: number;
export function catalogPrefixMap(heads: ReadonlyArray<Uint8Array | undefined>): Map<number, Uint8Array> | undefined;
export function releaseCatalogPrefixes(prefixes: Map<number, Uint8Array> | undefined): void;
export function readHeads(files: ReadonlyArray<{ file: Blob }>, waitForFiles?: (offset: number) => Promise<void>): Promise<(Uint8Array | undefined)[]>;
