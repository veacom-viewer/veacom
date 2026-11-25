import { supersededScales, type RecoveryWrite } from './measurementRecovery';

const STORE = 'measurements';
let opening: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (opening) return opening;
  const connection = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('veacom-reading', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: ['scope', 'id'] });
      store.createIndex('scope', 'scope');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const close = () => { db.close(); if (opening === connection) opening = undefined; };
      db.onversionchange = close;
      db.onclose = close;
      resolve(db);
    };
  });
  opening = connection;
  void connection.catch(() => { if (opening === connection) opening = undefined; });
  return connection;
}

export async function readMeasurements(scope: string): Promise<unknown[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE);
    const request = tx.objectStore(STORE).index('scope').getAll(scope);
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error);
  });
}

/** Only edit the affected IDs. Other windows can add a measurement to the same study without replacing this one. */
export async function writeMeasurements(scope: string, changes: RecoveryWrite[]): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    const store = tx.objectStore(STORE);
    const write = (superseded: RecoveryWrite[]) => {
      try {
        for (const edit of [...superseded, ...changes]) {
          if (edit.put) store.put(edit.put);
          else store.delete([scope, edit.id]);
        }
      } catch (error) { tx.abort(); reject(error); }
    };
    const updated = new Map<string, number | null>();
    for (const { scale } of changes) if (scale) for (const hash of scale.sources) updated.set(hash, scale.factor);
    if (!updated.size) { write([]); return; }
    // Resolve overlapping grids inside the same transaction, including changes already committed by another window.
    const read = store.index('scope').getAll(scope);
    read.onsuccess = () => write(supersededScales(read.result, updated));
  });
}
