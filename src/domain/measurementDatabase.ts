import type { RecoveryRecord } from './measurementRecovery';

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
export async function writeMeasurements(scope: string, put: RecoveryRecord[], remove: string[]): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    const store = tx.objectStore(STORE);
    try {
      for (const record of put) store.put(record);
      for (const id of remove) store.delete([scope, id]);
    } catch (error) { tx.abort(); reject(error); }
  });
}
