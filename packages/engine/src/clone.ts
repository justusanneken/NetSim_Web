/**
 * Kopieren/Einfügen von Geräten (Strg+C / Strg+V): Konfiguration wird mitkopiert, Namen und MAC-Adressen sind
 * neu, doppelte IPv4-Adressen werden durch die nächste freie Adresse im selben Subnetz ersetzt (IOS lehnt
 * doppelte Adressen im selben Netz ab bzw. meldet `Duplicate address`), Kabel zwischen kopierten Geräten bleiben.
 */
import { formatIpv4, macFromCounter, parseIpv4 } from '@netsim/protocols';
import { CATALOG } from './catalog';
import type { Engine } from './engine';
import type { Device, Link, Point, Port, Result } from './types';

type Plain = Record<string, unknown>;

/** Alle belegten IPv4-Adressen im Netz (Host-IP und Schnittstellen). */
function usedIps(eng: Engine, skip?: Set<string>): Set<string> {
  const used = new Set<string>();
  for (const d of Object.values(eng.state.devices)) {
    if (skip?.has(d.id)) continue;
    const c = d.config as unknown as Plain;
    if (typeof c.ip === 'string') used.add(c.ip);
    const ifs = c.ifaces as Record<string, { ip?: string }> | undefined;
    if (ifs) for (const i of Object.values(ifs)) if (i.ip) used.add(i.ip);
  }
  return used;
}

/** Nächste freie Adresse im Subnetz von `ip`/`mask` (aufwärts, mit Umlauf); `undefined`, wenn das Subnetz voll ist. */
export function nextFreeIp(ip: string, mask: string, used: Set<string>): string | undefined {
  const a = parseIpv4(ip);
  const m = parseIpv4(mask);
  if (a === undefined || m === undefined) return undefined;
  const net = (a & m) >>> 0;
  const bcast = (net | ~m) >>> 0;
  const size = bcast - net - 1;
  if (size <= 0 || size > 65534) return undefined;
  for (let i = 1; i <= size; i++) {
    let cand = a + i;
    if (cand >= bcast) cand = net + (cand - bcast);
    if (cand <= net) continue;
    const s = formatIpv4(cand >>> 0);
    if (!used.has(s)) return s;
  }
  return undefined;
}

export interface PasteResult {
  ids: string[];
  /** Zuordnung alt → neu. */
  map: Record<string, string>;
  /** IPv4-Adressen, die wegen eines Konflikts geändert wurden. */
  readdressed: { device: string; from: string; to: string }[];
}

/**
 * Dupliziert die Geräte `ids` samt Konfiguration und den Kabeln zwischen ihnen; die Kopien werden um
 * `offset` verschoben. Geräte, die nicht existieren, werden übergangen.
 */
export function cloneDevices(eng: Engine, ids: string[], offset: Point): Result<PasteResult> {
  const src = ids.map((i) => eng.state.devices[i]).filter((d): d is Device => d !== undefined);
  if (src.length === 0) return { ok: false, error: 'paste.empty' };
  const s = eng.state;
  const map: Record<string, string> = {};
  const readdressed: PasteResult['readdressed'] = [];
  const used = usedIps(eng);
  for (const d of src) {
    const spec = CATALOG[d.type];
    if (!spec) continue;
    const id = `d${s.nextId++}`;
    const n = s.nameCounters[spec.namePrefix] ?? 0;
    s.nameCounters[spec.namePrefix] = n + 1;
    let name = `${spec.namePrefix}${n}`;
    while (Object.values(s.devices).some((x) => x.name === name)) {
      s.nameCounters[spec.namePrefix] = (s.nameCounters[spec.namePrefix] ?? 0) + 1;
      name = `${spec.namePrefix}${s.nameCounters[spec.namePrefix] ?? 0}`;
    }
    const ports: Port[] = d.ports.map((p) => {
      const q = structuredClone(p);
      q.mac = macFromCounter(++s.macCounter);
      delete q.linkId;
      delete q.errdisabled;
      q.operUp = false;
      return q;
    });
    const cfg = structuredClone(d.config) as unknown as Plain;
    const dup: Device = {
      id,
      type: d.type,
      model: d.model,
      name,
      pos: { x: d.pos.x + offset.x, y: d.pos.y + offset.y },
      ports,
      modules: structuredClone(d.modules),
      powered: d.powered,
      config: cfg as unknown as Device['config'],
      physical: {},
    };
    s.devices[id] = dup;
    map[d.id] = id;
    const sys = cfg.sys as { hostname?: string; startupConfig?: string } | undefined;
    if (sys) {
      const old = sys.hostname;
      sys.hostname = name;
      if (sys.startupConfig && old)
        sys.startupConfig = sys.startupConfig.replace(`hostname ${old}\n`, `hostname ${name}\n`);
    }
    eng.resetDeviceRuntime(dup);
    // doppelte Adressen vermeiden
    const fix = (holder: { ip?: string; mask?: string }): void => {
      if (!holder.ip) return;
      if (used.has(holder.ip)) {
        const nf = nextFreeIp(holder.ip, holder.mask ?? '255.255.255.0', used);
        if (nf) {
          readdressed.push({ device: name, from: holder.ip, to: nf });
          holder.ip = nf;
        } else {
          readdressed.push({ device: name, from: holder.ip, to: '' });
          delete holder.ip;
        }
      }
      if (holder.ip) used.add(holder.ip);
    };
    fix(cfg as { ip?: string; mask?: string });
    const ifs = cfg.ifaces as Record<string, { ip?: string; mask?: string }> | undefined;
    if (ifs) for (const i of Object.values(ifs)) fix(i);
  }
  // Kabel zwischen kopierten Geräten
  for (const l of Object.values(s.links)) {
    const a = map[l.a.deviceId];
    const b = map[l.b.deviceId];
    if (!a || !b || l.cable === 'wireless') continue;
    eng.connect(
      { deviceId: a, portId: l.a.portId },
      { deviceId: b, portId: l.b.portId },
      l.cable as Link['cable'],
      l.lengthM,
    );
  }
  eng.refreshLinks();
  for (const nid of Object.values(map)) {
    const dev = s.devices[nid];
    if (dev) eng.startTimers(dev);
  }
  eng.p5.wirelessSync();
  return { ok: true, value: { ids: Object.values(map), map, readdressed } };
}
