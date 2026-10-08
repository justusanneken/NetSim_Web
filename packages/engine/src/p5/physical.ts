import type { PhysicalBuilding, PhysicalCity, PhysicalRoom, PhysicalTree } from '../p5types';
import type { Device, EngineState } from '../types';

/** Zusätzliche „Entfernung“ (Canvas-Pixel) für eine Wand zwischen zwei Räumen desselben Gebäudes. */
export const WALL_PENALTY = 120;

export const physicalOf = (s: EngineState): PhysicalTree => (s.physical ??= { cities: [] });

export interface LocPath {
  city: string;
  building?: string;
  room?: string;
  rack?: string;
}

export function parseLocation(loc: string | undefined): LocPath | undefined {
  if (!loc) return undefined;
  const [city, building, room, rack] = loc.split('/');
  if (!city) return undefined;
  return { city, building, room, rack };
}

export const formatLocation = (p: LocPath): string =>
  [p.city, p.building, p.room, p.rack].filter((x) => x !== undefined && x !== '').join('/');

/**
 * Entfernung zweier Geräte für die Funkreichweite: Canvas-Abstand; liegen beide in der Physical View,
 * zählt: anderer Standort/anderes Gebäude = außer Reichweite, anderer Raum = + Wandabschlag.
 */
export function deviceDistance(a: Device, b: Device): number {
  const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
  const la = parseLocation(a.physical.location);
  const lb = parseLocation(b.physical.location);
  if (!la || !lb) return d;
  if (la.city !== lb.city || la.building !== lb.building) return Infinity;
  if (la.room !== lb.room) return d + WALL_PENALTY;
  return d;
}

// ---------------------------------------------------------------- Baum bearbeiten

const city = (t: PhysicalTree, name: string): PhysicalCity | undefined =>
  t.cities.find((c) => c.name === name);
const building = (c: PhysicalCity, name: string): PhysicalBuilding | undefined =>
  c.buildings.find((b) => b.name === name);
const room = (b: PhysicalBuilding, name: string): PhysicalRoom | undefined =>
  b.rooms.find((r) => r.name === name);

/** Legt fehlende Ebenen an (`Stadt`, `Stadt/Gebäude`, `Stadt/Gebäude/Raum`, `…/Rack`). */
export function ensureLocation(t: PhysicalTree, p: LocPath): void {
  let c = city(t, p.city);
  if (!c) t.cities.push((c = { name: p.city, buildings: [] }));
  if (!p.building) return;
  let b = building(c, p.building);
  if (!b) c.buildings.push((b = { name: p.building, rooms: [] }));
  if (!p.room) return;
  let r = room(b, p.room);
  if (!r) b.rooms.push((r = { name: p.room, racks: [] }));
  if (p.rack && !r.racks.includes(p.rack)) r.racks.push(p.rack);
}

/** Entfernt eine Ebene samt Unterebenen; liefert die gelöschten Pfadpräfixe zurück. */
export function removeLocation(t: PhysicalTree, p: LocPath): void {
  const c = city(t, p.city);
  if (!c) return;
  if (!p.building) {
    t.cities = t.cities.filter((x) => x !== c);
    return;
  }
  const b = building(c, p.building);
  if (!b) return;
  if (!p.room) {
    c.buildings = c.buildings.filter((x) => x !== b);
    return;
  }
  const r = room(b, p.room);
  if (!r) return;
  if (!p.rack) b.rooms = b.rooms.filter((x) => x !== r);
  else r.racks = r.racks.filter((x) => x !== p.rack);
}

/** Liegt der Gerätestandort `loc` innerhalb (oder genau auf) dem Pfad `prefix`? */
export function locationWithin(loc: string | undefined, prefix: LocPath): boolean {
  const l = parseLocation(loc);
  if (!l || l.city !== prefix.city) return false;
  if (prefix.building && l.building !== prefix.building) return false;
  if (prefix.room && l.room !== prefix.room) return false;
  if (prefix.rack && l.rack !== prefix.rack) return false;
  return true;
}
