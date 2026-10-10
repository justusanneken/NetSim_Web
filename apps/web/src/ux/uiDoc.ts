import { create } from 'zustand';

/**
 * Dokumentzustand der Oberfläche, der zur Topologie gehört, aber nicht in der Engine lebt:
 * Notizen, Gruppen (Cluster), Hintergrundbild und Geräte-Attribute. Wird von der Persistenz
 * (`.nsim`) über `exportUiDoc` / `importUiDoc` gespeichert und über `snapshotUiDoc` / `restoreUiDoc`
 * in den Undo-Stapel eingebunden. Geräte-Positionen liegen weiterhin in der Engine (`DeviceView.pos`).
 */
export interface Note {
  id: string;
  x: number;
  y: number;
  text: string;
}
export interface Group {
  id: string;
  name: string;
  deviceIds: string[];
}
export interface Background {
  dataUrl: string;
  /** 0 … 1 */
  opacity: number;
}
export interface DeviceAttrs {
  serial: string;
  license: string;
  notes: string;
}
export interface UiDocData {
  version: 1;
  notes: Note[];
  groups: Group[];
  background: Background | null;
  attrs: Record<string, Partial<DeviceAttrs>>;
}

interface DocState extends UiDocData {
  nextId: number;
  addNote(x: number, y: number, text?: string): string;
  updateNote(id: string, patch: Partial<Omit<Note, 'id'>>): void;
  removeNote(id: string): void;
  addGroup(deviceIds: string[], name?: string): string | null;
  renameGroup(id: string, name: string): void;
  ungroup(id: string): void;
  /** Entfernt gelöschte Geräte aus Gruppen und Attributen. */
  removeDevices(ids: string[]): void;
  setBackground(b: Background | null): void;
  setAttrs(deviceId: string, patch: Partial<DeviceAttrs>): void;
}

const EMPTY: UiDocData = { version: 1, notes: [], groups: [], background: null, attrs: {} };

export const useDoc = create<DocState>((set, get) => ({
  ...EMPTY,
  nextId: 1,
  addNote(x, y, text = '') {
    const id = `n${get().nextId}`;
    set((s) => ({ nextId: s.nextId + 1, notes: [...s.notes, { id, x, y, text }] }));
    return id;
  },
  updateNote(id, patch) {
    set((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
  },
  removeNote(id) {
    set((s) => ({ notes: s.notes.filter((n) => n.id !== id) }));
  },
  addGroup(deviceIds, name) {
    const ids = [...new Set(deviceIds)];
    if (ids.length < 2) return null;
    const id = `g${get().nextId}`;
    set((s) => ({
      nextId: s.nextId + 1,
      // ein Gerät gehört höchstens zu einer Gruppe
      groups: [
        ...s.groups
          .map((g) => ({ ...g, deviceIds: g.deviceIds.filter((d) => !ids.includes(d)) }))
          .filter((g) => g.deviceIds.length >= 2),
        { id, name: name ?? `Cluster ${s.nextId}`, deviceIds: ids },
      ],
    }));
    return id;
  },
  renameGroup(id, name) {
    set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)) }));
  },
  ungroup(id) {
    set((s) => ({ groups: s.groups.filter((g) => g.id !== id) }));
  },
  removeDevices(ids) {
    const gone = new Set(ids);
    const s = get();
    const groups = s.groups
      .map((g) => ({ ...g, deviceIds: g.deviceIds.filter((d) => !gone.has(d)) }))
      .filter((g) => g.deviceIds.length >= 2);
    const changed =
      groups.length !== s.groups.length ||
      groups.some((g, i) => g.deviceIds.length !== (s.groups[i] as Group).deviceIds.length);
    const attrs = Object.fromEntries(Object.entries(s.attrs).filter(([id]) => !gone.has(id)));
    const attrsChanged = Object.keys(attrs).length !== Object.keys(s.attrs).length;
    if (changed || attrsChanged) set({ groups, attrs });
  },
  setBackground(background) {
    set({ background });
  },
  setAttrs(deviceId, patch) {
    set((s) => ({ attrs: { ...s.attrs, [deviceId]: { ...s.attrs[deviceId], ...patch } } }));
  },
}));

/** Serialisierbarer Zustand für die `.nsim`-Datei. */
export function exportUiDoc(): UiDocData {
  const s = useDoc.getState();
  return structuredClone({
    version: 1 as const,
    notes: s.notes,
    groups: s.groups,
    background: s.background,
    attrs: s.attrs,
  });
}

/** Lädt einen gespeicherten Zustand (unbekannte/fehlende Felder werden ignoriert bzw. ergänzt). */
export function importUiDoc(data: Partial<UiDocData> | null | undefined): void {
  const d = data ?? {};
  const notes = Array.isArray(d.notes) ? d.notes : [];
  const groups = Array.isArray(d.groups) ? d.groups : [];
  const ids = [...notes, ...groups].map((x) => Number(/\d+$/.exec(x.id)?.[0] ?? 0));
  useDoc.setState({
    notes: structuredClone(notes),
    groups: structuredClone(groups),
    background: d.background ? structuredClone(d.background) : null,
    attrs: d.attrs ? structuredClone(d.attrs) : {},
    nextId: Math.max(0, ...ids) + 1,
  });
}

/** Zustand für Undo/Redo (identisch zu `exportUiDoc`); `restoreUiDoc` ist das Gegenstück. */
export const snapshotUiDoc = exportUiDoc;
export const restoreUiDoc = importUiDoc;

/** Setzt auf einen leeren Zustand zurück („Neu“). */
export function resetUiDoc(): void {
  importUiDoc(EMPTY);
}

/**
 * Abonniert Änderungen des Dokumentzustands (für Autosave/Undo der Persistenz).
 * Liefert die Abmeldefunktion.
 */
export function onUiDocChange(cb: (doc: UiDocData) => void): () => void {
  return useDoc.subscribe((s, prev) => {
    if (
      s.notes !== prev.notes ||
      s.groups !== prev.groups ||
      s.background !== prev.background ||
      s.attrs !== prev.attrs
    )
      cb(exportUiDoc());
  });
}

/** Standard-Seriennummer (deterministisch aus der Geräte-Id), wie bei Cisco `FOC` + Datum + Zähler. */
export function defaultSerial(deviceId: string): string {
  let h = 2166136261;
  for (const c of deviceId) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const week = String(1000 + (h % 600)).slice(0, 4);
  return `FOC${week}${(h >>> 8).toString(36).toUpperCase().padStart(4, '0').slice(0, 4)}`;
}

/** Standard-Lizenz je Gerätetyp (IOS-Technologiepaket). */
export function defaultLicense(type: string): string {
  if (type === 'router') return 'ipbasek9';
  if (type === 'switch-l2' || type === 'switch-l3') return 'lanbasek9';
  if (type === 'firewall') return 'base';
  return '–';
}

export function attrsOf(
  deviceId: string,
  type: string,
  attrs: Record<string, Partial<DeviceAttrs>>,
): DeviceAttrs {
  const a = attrs[deviceId] ?? {};
  return {
    serial: a.serial ?? defaultSerial(deviceId),
    license: a.license ?? defaultLicense(type),
    notes: a.notes ?? '',
  };
}
