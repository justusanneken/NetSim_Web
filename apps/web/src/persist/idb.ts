import { openDB, type IDBPDatabase } from 'idb';

/** Speicher für Autosave und zuletzt verwendete Dateien (IndexedDB); alle Zugriffe tolerieren Ausfälle. */
export interface StoredFile {
  name: string;
  savedAt: number;
  devices: number;
  bytes: Uint8Array;
}

let dbp: Promise<IDBPDatabase> | undefined;
function db(): Promise<IDBPDatabase> {
  dbp ??= openDB('netsim', 1, {
    upgrade(d) {
      d.createObjectStore('kv');
    },
  });
  return dbp;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    return (await (await db()).get('kv', key)) as T | undefined;
  } catch {
    return undefined;
  }
}
export async function kvSet(key: string, value: unknown): Promise<boolean> {
  try {
    await (await db()).put('kv', value, key);
    return true;
  } catch {
    return false;
  }
}
export async function kvDelete(key: string): Promise<void> {
  try {
    await (await db()).delete('kv', key);
  } catch {
    /* ignorieren */
  }
}

const RECENT_MAX = 6;

export async function recentList(): Promise<StoredFile[]> {
  return (await kvGet<StoredFile[]>('recent')) ?? [];
}

export async function recentAdd(f: StoredFile): Promise<StoredFile[]> {
  const list = [f, ...(await recentList()).filter((r) => r.name !== f.name)].slice(0, RECENT_MAX);
  await kvSet('recent', list);
  return list;
}
