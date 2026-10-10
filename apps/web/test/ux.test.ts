import { beforeEach, describe, expect, it } from 'vitest';
import {
  alignPositions,
  boundsOf,
  distributePositions,
  idsInRect,
  rectFrom,
  snapValue,
  zoomAt,
} from '../src/ux/geometry';
import {
  attrsOf,
  defaultSerial,
  exportUiDoc,
  importUiDoc,
  onUiDocChange,
  resetUiDoc,
  useDoc,
} from '../src/ux/uiDoc';

describe('Geometrie', () => {
  it('Snap rastet auf 10 px, ohne Snap auf ganze Pixel', () => {
    expect(snapValue(14, true)).toBe(10);
    expect(snapValue(16, true)).toBe(20);
    expect(snapValue(14.6, false)).toBe(15);
  });
  it('Rubberband wählt Geräte im Rechteck (beliebige Ziehrichtung)', () => {
    const pts = { a: { x: 10, y: 10 }, b: { x: 100, y: 100 }, c: { x: 300, y: 10 } };
    const r = rectFrom({ x: 120, y: 120 }, { x: 0, y: 0 });
    expect(idsInRect(pts, r).sort()).toEqual(['a', 'b']);
  });
  it('Ausrichten', () => {
    const pts = { a: { x: 10, y: 50 }, b: { x: 100, y: 20 }, c: { x: 40, y: 90 } };
    expect(alignPositions(pts, 'left')).toEqual({ b: { x: 10, y: 20 }, c: { x: 10, y: 90 } });
    expect(alignPositions(pts, 'top').a).toEqual({ x: 10, y: 20 });
    expect(alignPositions(pts, 'hcenter').a).toEqual({ x: 55, y: 50 });
    expect(alignPositions({ a: pts.a }, 'left')).toEqual({});
  });
  it('Verteilen lässt äußere Punkte stehen', () => {
    const pts = { a: { x: 0, y: 0 }, b: { x: 10, y: 5 }, c: { x: 100, y: 9 } };
    expect(distributePositions(pts, 'horizontal')).toEqual({ b: { x: 50, y: 5 } });
    expect(distributePositions({ a: pts.a, c: pts.c }, 'horizontal')).toEqual({});
    expect(distributePositions(pts, 'vertical').b).toBeUndefined();
  });
  it('Zoom um Fixpunkt bleibt begrenzt', () => {
    const v = zoomAt({ x: 0, y: 0, scale: 1 }, { x: 100, y: 100 }, 2);
    expect(v).toEqual({ scale: 2, x: -100, y: -100 });
    expect(zoomAt({ x: 0, y: 0, scale: 3 }, { x: 0, y: 0 }, 2).scale).toBe(3);
    expect(zoomAt({ x: 0, y: 0, scale: 0.25 }, { x: 0, y: 0 }, 0.5).scale).toBe(0.25);
  });
  it('Umschließendes Rechteck', () => {
    expect(boundsOf([], 5)).toBeNull();
    expect(
      boundsOf(
        [
          { x: 0, y: 0 },
          { x: 10, y: 20 },
        ],
        5,
      ),
    ).toEqual({ x: -5, y: -5, w: 20, h: 30 });
  });
});

describe('UI-Dokument', () => {
  beforeEach(() => resetUiDoc());
  it('Notizen: anlegen, ändern, löschen, Export/Import', () => {
    const id = useDoc.getState().addNote(10, 20, 'Hallo');
    useDoc.getState().updateNote(id, { text: 'Neu' });
    const saved = exportUiDoc();
    expect(saved.notes).toEqual([{ id, x: 10, y: 20, text: 'Neu' }]);
    useDoc.getState().removeNote(id);
    expect(useDoc.getState().notes).toHaveLength(0);
    importUiDoc(saved);
    expect(useDoc.getState().notes).toHaveLength(1);
    // Id-Zähler läuft nach dem Laden weiter
    expect(useDoc.getState().addNote(0, 0)).not.toBe(id);
  });
  it('Gruppen: ein Gerät nur in einer Gruppe, Aufräumen bei gelöschten Geräten', () => {
    const s = useDoc.getState();
    expect(s.addGroup(['a'])).toBeNull();
    s.addGroup(['a', 'b', 'c'], 'G1');
    useDoc.getState().addGroup(['c', 'd'], 'G2');
    expect(useDoc.getState().groups.map((g) => g.deviceIds)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    useDoc.getState().removeDevices(['b']);
    expect(useDoc.getState().groups.map((g) => g.name)).toEqual(['G2']);
    const gid = useDoc.getState().groups[0]?.id as string;
    useDoc.getState().renameGroup(gid, 'X');
    useDoc.getState().ungroup(gid);
    expect(useDoc.getState().groups).toEqual([]);
  });
  it('Attribute: Standardwerte und Überschreiben', () => {
    const d = attrsOf('r1', 'router', {});
    expect(d.license).toBe('ipbasek9');
    expect(d.serial).toBe(defaultSerial('r1'));
    expect(defaultSerial('r1')).toMatch(/^FOC\d{4}[0-9A-Z]{4}$/);
    useDoc.getState().setAttrs('r1', { serial: 'X1', notes: 'n' });
    expect(attrsOf('r1', 'router', useDoc.getState().attrs)).toEqual({
      serial: 'X1',
      license: 'ipbasek9',
      notes: 'n',
    });
    useDoc.getState().removeDevices(['r1']);
    expect(useDoc.getState().attrs).toEqual({});
  });
  it('Hintergrund und Änderungsabo', () => {
    let calls = 0;
    const off = onUiDocChange(() => calls++);
    useDoc.getState().setBackground({ dataUrl: 'data:image/png;base64,AA', opacity: 0.5 });
    expect(exportUiDoc().background?.opacity).toBe(0.5);
    off();
    useDoc.getState().setBackground(null);
    expect(calls).toBe(1);
  });
});
