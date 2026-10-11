import { api, proxy } from '../engine/client';
import { useStore } from '../store';
import { kvDelete, kvGet, kvSet, recentAdd, recentList } from './idb';
import { usePersist } from './state';
import { selectOnly, selection } from '../ux/actions';
import { exportUiDoc, importUiDoc, onUiDocChange, resetUiDoc } from '../ux/uiDoc';

/** Obergrenze für zu öffnende Dateien (entspricht dem Limit der Engine). */
const MAX_FILE = 16 * 1024 * 1024;

// ------------------------------------------------------------------ Erweiterungen (Notizen, Gruppen, …)

export interface DocExtra {
  export(): unknown;
  import(data: unknown): void;
  reset(): void;
}
const extras = new Map<string, DocExtra>();
/** Weitere Oberflächen-Komponenten registrieren sich hier; ihre Daten landen unter `extras.<name>` in der `.nsim`-Datei. */
export function registerDocExtra(name: string, ext: DocExtra): void {
  extras.set(name, ext);
}
// Notizen, Gruppen, Hintergrund und Geräte-Attribute der Oberfläche
registerDocExtra('ux', {
  export: exportUiDoc,
  import: (d) => importUiDoc(d as Parameters<typeof importUiDoc>[0]),
  reset: resetUiDoc,
});

/** Unterdrückt die Rückmeldung an den Worker, solange der Zustand von dort eingespielt wird. */
let applying = false;

function collectExtras(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, e] of extras) out[k] = e.export();
  return out;
}
function applyExtras(data: Record<string, unknown>): void {
  applying = true;
  try {
    applyExtrasInner(data);
  } finally {
    applying = false;
  }
}
function applyExtrasInner(data: Record<string, unknown>): void {
  for (const [k, e] of extras) {
    try {
      if (k in data) e.import(data[k]);
      else e.reset();
    } catch {
      e.reset();
    }
  }
}
export function resetDocExtras(): void {
  applying = true;
  try {
    for (const e of extras.values()) e.reset();
  } finally {
    applying = false;
  }
}

// ------------------------------------------------------------------ Auswahl

let selectionProvider = (): string[] => selection();
/** Mehrfachauswahl-Komponenten können hier die Liste der ausgewählten Geräte liefern. */
export function setSelectionProvider(fn: () => string[]): void {
  selectionProvider = fn;
}

// ------------------------------------------------------------------ Hilfen

const toast = (
  key: string,
  params?: Record<string, string | number>,
  kind: 'ok' | 'error' = 'ok',
) => useStore.getState().showToast(key, params, kind);

function safeName(n: string): string {
  return (
    n
      .replace(/[^\p{L}\p{N}._ -]/gu, '_')
      .trim()
      .slice(0, 60) || 'netsim'
  );
}

function downloadBytes(filename: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: 'application/octet-stream' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function deviceCount(): Promise<number> {
  return useStore.getState().view?.devices.length ?? 0;
}

// ------------------------------------------------------------------ Datei

export async function fileNew(): Promise<void> {
  await useStore.getState().newTopology();
}

/** Speichern; ohne bisherigen Namen (oder mit `as`) wird zuerst nach dem Dateinamen gefragt. */
export async function fileSave(as = false): Promise<void> {
  const name = usePersist.getState().fileName;
  if (as || !name) {
    usePersist.setState({ saveAsOpen: true });
    return;
  }
  await writeFile(name);
}

export async function writeFile(rawName: string): Promise<void> {
  const name = safeName(rawName);
  await api.setFileName(name);
  const bytes = await api.saveNsim(collectExtras());
  downloadBytes(`${name}.nsim`, bytes);
  usePersist.setState({ fileName: name, saveAsOpen: false });
  const recents = await recentAdd({
    name,
    savedAt: Date.now(),
    devices: await deviceCount(),
    bytes,
  });
  usePersist.setState({ recents });
  toast('persist.saved', { name: `${name}.nsim` });
}

export function fileOpen(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.nsim,application/octet-stream';
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void openFile(f);
  };
  input.click();
}

export async function openFile(f: File): Promise<void> {
  if (f.size > MAX_FILE) {
    toast('nsim.tooLarge', undefined, 'error');
    return;
  }
  const bytes = new Uint8Array(await f.arrayBuffer());
  await openBytes(bytes, f.name.replace(/\.nsim$/i, ''));
}

export async function openBytes(bytes: Uint8Array, fallbackName = ''): Promise<boolean> {
  const r = await api.openNsim(bytes);
  if (!r.ok) {
    toast(r.error, r.params, 'error');
    return false;
  }
  const name = safeName(r.value.name || fallbackName);
  await api.setFileName(name);
  applyExtras(r.value.extras);
  const s = useStore.getState();
  s.selectDevice(null);
  s.selectLog(null);
  usePersist.setState({ fileName: name });
  const recents = await recentAdd({ name, savedAt: Date.now(), devices: r.value.devices, bytes });
  usePersist.setState({ recents });
  toast('persist.opened', { name });
  return true;
}

// ------------------------------------------------------------------ Vorlagen

export async function loadTemplate(id: string): Promise<void> {
  const r = await api.loadTemplate(id);
  if (!r.ok) {
    toast(r.error, r.params, 'error');
    return;
  }
  resetDocExtras();
  const s = useStore.getState();
  s.selectDevice(null);
  s.selectLog(null);
  usePersist.setState({ templatesOpen: false, fileName: '' });
  toast('persist.templateLoaded');
}

// ------------------------------------------------------------------ Undo/Redo, Kopieren/Einfügen

export async function undo(): Promise<void> {
  if (usePersist.getState().undo === 0) return;
  const r = await api.undo();
  if (r.ok) applyExtras(r.extras);
  useStore.getState().selectLog(null);
}
export async function redo(): Promise<void> {
  if (usePersist.getState().redo === 0) return;
  const r = await api.redo();
  if (r.ok) applyExtras(r.extras);
  useStore.getState().selectLog(null);
}

export function copySelection(): void {
  const ids = selectionProvider();
  if (ids.length === 0) return;
  usePersist.setState({ clipboard: ids, pasteCount: 0 });
  toast('persist.copied', { n: ids.length });
}

export async function pasteClipboard(): Promise<void> {
  const { clipboard, pasteCount } = usePersist.getState();
  if (clipboard.length === 0) return;
  const n = pasteCount + 1;
  usePersist.setState({ pasteCount: n });
  const r = await api.pasteDevices(clipboard, 40 * n, 40 * n);
  if (!r.ok) {
    toast(r.error, r.params, 'error');
    return;
  }
  const first = r.value.ids[0];
  if (first) selectOnly(first);
  if (r.value.readdressed.length > 0)
    toast('persist.pastedReaddressed', { n: r.value.readdressed.length });
  else toast('persist.pasted', { n: r.value.ids.length });
}

// ------------------------------------------------------------------ Autosave und Wiederherstellung

const CLEAN_KEY = 'netsim.clean';
const setClean = (v: '0' | '1'): void => {
  try {
    localStorage.setItem(CLEAN_KEY, v);
  } catch {
    /* ignorieren */
  }
};

let lastRevision = -1;

export async function autosaveNow(): Promise<boolean> {
  if (usePersist.getState().restore) return false;
  if ((await api.revision()) === lastRevision) return false;
  // Revision, Anzahl und Bytes aus einem Worker-Aufruf: die Ansicht im Hauptthread kann hinterherhinken
  // (sonst z. B. „1 Gerät“ in der Wiederherstellungs-Abfrage bei 2 gesicherten Geräten)
  const snap = await api.saveNsimAutosave(collectExtras());
  if (snap.devices === 0) return false;
  const ok = await kvSet('autosave', {
    name: usePersist.getState().fileName,
    savedAt: Date.now(),
    devices: snap.devices,
    bytes: snap.bytes,
  });
  if (ok) lastRevision = snap.revision;
  return ok;
}

interface AutosaveRec {
  name: string;
  savedAt: number;
  devices: number;
  bytes: Uint8Array;
}

export async function restoreAutosave(): Promise<void> {
  const rec = await kvGet<AutosaveRec>('autosave');
  usePersist.setState({ restore: null });
  if (rec) await openBytes(rec.bytes, rec.name);
}

export async function discardAutosave(): Promise<void> {
  usePersist.setState({ restore: null });
  await kvDelete('autosave');
}

/** Beim Start: Absturzerkennung, Undo-Zähler, zuletzt verwendete Dateien und der 30-s-Autosave-Takt. */
export function initPersistence(): void {
  let unclean = false;
  try {
    unclean = localStorage.getItem(CLEAN_KEY) === '0';
  } catch {
    /* ignorieren */
  }
  setClean('0');
  window.addEventListener('pagehide', () => setClean('1'));
  void api.subscribeUndo(
    proxy((i: { undo: number; redo: number }) =>
      usePersist.setState({ undo: i.undo, redo: i.redo }),
    ),
  );
  void recentList().then((recents) => usePersist.setState({ recents }));
  if (unclean) {
    void kvGet<AutosaveRec>('autosave').then((rec) => {
      if (rec)
        usePersist.setState({
          restore: { savedAt: rec.savedAt, name: rec.name, devices: rec.devices },
        });
    });
  }
  let ms = 30_000;
  try {
    const v = Number(localStorage.getItem('netsim.autosaveMs'));
    if (v >= 100) ms = v;
  } catch {
    /* ignorieren */
  }
  setInterval(() => void autosaveNow(), ms);
  // Änderungen der Oberfläche (Notizen …) an den Worker melden: Teil von Undo und Autosave
  let timer: ReturnType<typeof setTimeout> | undefined;
  onUiDocChange(() => {
    if (applying) return;
    clearTimeout(timer);
    timer = setTimeout(() => void api.setExtras(collectExtras()), 600);
  });
}
