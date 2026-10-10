/**
 * `.nsim`-Dateiformat (Spec 6): JSON `{ schema, meta, topology, deviceStates, scenarios, physical, assets }`,
 * zlib-komprimiert. Der Import validiert strikt (Zod + Struktur-/Integritätsprüfung) – ungeprüftes JSON erreicht
 * die Engine nie. Fehler werden als `Result` mit i18n-Schlüssel gemeldet, nichts wirft nach außen.
 *
 * Gespeichert wird der Entwurfszustand (Topologie + vollständige Gerätekonfiguration inkl. Notizen,
 * Physical View, IoT-Skripten). Laufzeitzustand (Ereigniswarteschlange, Uhr, ARP-/MAC-Tabellen, Log) wird
 * beim Öffnen wie nach einem Neustart der Geräte neu aufgebaut (`Engine.loadState` → `resetRuntime`).
 */
import { Unzlib, zlibSync } from 'fflate';
import { z } from 'zod';
import { CATALOG } from './catalog';
import { validateCable } from './cabling';
import { DEFAULT_CONFIG, Engine } from './engine';
import { buildDevices, buildLinks } from './view';
import type { Device, DeviceType, EngineConfig, EngineState, Link, Port, Result } from './types';
import type { PhysicalTree } from './p5types';

export const NSIM_SCHEMA = 1;
/** Obergrenzen gegen Zip-Bomben und Speicherangriffe. */
export const NSIM_MAX_COMPRESSED = 16 * 1024 * 1024;
export const NSIM_MAX_JSON = 64 * 1024 * 1024;
const MAX_DEVICES = 1000;
const MAX_LINKS = 5000;
const MAX_PORTS = 512;
const MAX_DEPTH = 40;
const MAX_NODES = 4_000_000;

export interface NsimMeta {
  app: string;
  name: string;
  description?: string;
  savedAt?: string;
  seed: number;
  nextId: number;
  macCounter: number;
  nameCounters: Record<string, number>;
  engine: Partial<EngineConfig>;
}

export interface NsimDevice {
  id: string;
  type: DeviceType;
  model: string;
  name: string;
  pos: { x: number; y: number };
  powered: boolean;
  modules: { id: string; name: string; module?: string }[];
  physical: { rackPos?: number; location?: string };
  ports: NsimPort[];
}
export interface NsimPort {
  id: string;
  name: string;
  kind: Port['kind'];
  mac: string;
  adminUp: boolean;
  speed: Port['speed'];
  duplex: Port['duplex'];
  mtu: number;
  vlanMode?: Port['vlanMode'];
  errdisabled?: string;
}
export interface NsimLink {
  id: string;
  cable: Link['cable'];
  a: { deviceId: string; portId: string };
  b: { deviceId: string; portId: string };
  lengthM?: number;
}

export interface NsimDoc {
  schema: number;
  meta: NsimMeta;
  topology: { devices: NsimDevice[]; links: NsimLink[] };
  /** Gerätekonfiguration je Geräte-Id (vollständiger Konfigurationsbaum). */
  deviceStates: Record<string, unknown>;
  /** Platzhalter, gehört der Szenario-/Aufgaben-Komponente; wird unverändert durchgereicht. */
  scenarios?: unknown;
  /** Weitere Komponenten der Oberfläche (Notizen, Gruppen, Hintergrund …), Name → JSON; wird unverändert durchgereicht. */
  extras?: Record<string, unknown>;
  physical: PhysicalTree;
  /** Eingebettete Dateien (z. B. Hintergrundbild als Data-URI); Schlüssel → String. */
  assets: Record<string, string>;
}

// ------------------------------------------------------------------ Zod-Schemas

const ID = z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/);
const noCtl = (s: string): boolean =>
  ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const label = (max: number) => z.string().min(1).max(max).refine(noCtl);
const coord = z.number().finite().min(-1e6).max(1e6);
const MAC = z.string().regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i);
const nat = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const PortSchema = z.object({
  id: ID,
  name: label(64),
  kind: z.enum([
    'fe',
    'ge',
    'tengig',
    'serial',
    'console',
    'aux',
    'usb',
    'wifi',
    'fiber-sfp',
    'dsl',
    'coax',
  ]),
  mac: MAC,
  adminUp: z.boolean(),
  speed: z.union([
    z.literal('auto'),
    z.literal(10),
    z.literal(100),
    z.literal(1000),
    z.literal(10000),
  ]),
  duplex: z.enum(['auto', 'half', 'full']),
  mtu: z.number().int().min(64).max(65535),
  vlanMode: z.enum(['access', 'trunk', 'routed']).optional(),
  errdisabled: z.string().max(64).optional(),
});

const DeviceSchema = z.object({
  id: ID,
  type: z.string().refine((t) => Object.prototype.hasOwnProperty.call(CATALOG, t)),
  model: label(64),
  name: label(64),
  pos: z.object({ x: coord, y: coord }),
  powered: z.boolean(),
  modules: z
    .array(
      z.object({
        id: ID,
        name: label(64),
        module: z.string().max(64).optional(),
      }),
    )
    .max(64),
  physical: z.object({
    rackPos: z.number().int().min(0).max(1000).optional(),
    location: z.string().max(256).optional(),
  }),
  ports: z.array(PortSchema).max(MAX_PORTS),
});

const PortRefSchema = z.object({ deviceId: ID, portId: ID });
const LinkSchema = z.object({
  id: ID,
  cable: z.enum([
    'straight',
    'crossover',
    'rollover',
    'serial-dce',
    'serial-dte',
    'fiber',
    'coax',
    'phone',
    'usb',
  ]),
  a: PortRefSchema,
  b: PortRefSchema,
  lengthM: z.number().finite().min(0).max(1e6).optional(),
});

const PhysicalSchema = z.object({
  cities: z
    .array(
      z.object({
        name: label(64),
        buildings: z
          .array(
            z.object({
              name: label(64),
              rooms: z
                .array(z.object({ name: label(64), racks: z.array(label(64)).max(256) }))
                .max(256),
            }),
          )
          .max(256),
      }),
    )
    .max(256),
});

const MetaSchema = z.object({
  app: z.string().max(64),
  name: z.string().max(200),
  description: z.string().max(5000).optional(),
  savedAt: z.string().max(40).optional(),
  seed: z.number().int().min(-2147483648).max(2147483647),
  nextId: nat,
  macCounter: nat,
  nameCounters: z.record(z.string().max(32), nat),
  engine: z
    .object({
      propagationUs: z.number().finite().min(0).max(1e9).optional(),
      processingUs: z.number().finite().min(0).max(1e9).optional(),
      maxCopperLengthM: z.number().finite().min(1).max(1e6).optional(),
      maxLogEntries: z.number().int().min(100).max(1_000_000).optional(),
    })
    .partial(),
});

const DocSchema = z.object({
  schema: z.literal(NSIM_SCHEMA),
  meta: MetaSchema,
  topology: z.object({
    devices: z.array(DeviceSchema).max(MAX_DEVICES),
    links: z.array(LinkSchema).max(MAX_LINKS),
  }),
  deviceStates: z.record(ID, z.unknown()),
  scenarios: z.unknown().optional(),
  extras: z.record(z.string().max(64), z.unknown()).optional(),
  physical: PhysicalSchema,
  assets: z.record(z.string().max(120), z.string().max(8 * 1024 * 1024)),
});

// ------------------------------------------------------------------ Hilfen

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** Prüft reines JSON: keine gefährlichen Schlüssel, begrenzte Tiefe/Knotenzahl. */
function checkPlain(v: unknown): string | undefined {
  let nodes = 0;
  const walk = (x: unknown, depth: number, path: string): string | undefined => {
    if (++nodes > MAX_NODES) return 'too many nodes';
    if (x === null || typeof x === 'string' || typeof x === 'boolean') return undefined;
    if (typeof x === 'number') return Number.isFinite(x) ? undefined : `${path}: non-finite number`;
    if (typeof x !== 'object') return `${path}: unsupported value`;
    if (depth > MAX_DEPTH) return `${path}: nesting too deep`;
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) {
        const r = walk(x[i], depth + 1, `${path}[${i}]`);
        if (r) return r;
      }
      return undefined;
    }
    for (const k of Object.keys(x)) {
      if (FORBIDDEN.has(k)) return `${path}.${k}: forbidden key`;
      const r = walk((x as Record<string, unknown>)[k], depth + 1, `${path}.${k}`);
      if (r) return r;
    }
    return undefined;
  };
  return walk(v, 0, '$');
}

type Plain = Record<string, unknown>;
const isObj = (x: unknown): x is Plain => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Grundtyp-Konflikt zwischen Standardwert und importiertem Wert (Union-Felder wie `'all' | number[]` sind erlaubt). */
function mismatch(d: unknown, v: unknown): boolean {
  if (Array.isArray(d)) return !Array.isArray(v);
  if (typeof d === 'string') return typeof v !== 'string' && !Array.isArray(v);
  if (typeof d === 'object') return !isObj(v);
  return typeof d !== typeof v;
}

/**
 * Gleicht eine importierte Konfiguration mit der Standardkonfiguration des Gerätetyps ab: fehlende Felder
 * werden ergänzt (Vorwärtskompatibilität), Felder mit falschem Grundtyp lehnen den Import ab.
 */
function conform(defaults: unknown, value: unknown, path: string): string | undefined {
  if (!isObj(defaults) || !isObj(value)) return undefined;
  for (const k of Object.keys(defaults)) {
    const d = defaults[k];
    if (!(k in value)) {
      value[k] = structuredClone(d);
      continue;
    }
    const v = value[k];
    if (d === undefined || d === null || v === undefined) continue;
    if (mismatch(d, v)) return `${path}.${k}: wrong type`;
    if (isObj(d) && Object.keys(d).length > 0) {
      const r = conform(d, v, `${path}.${k}`);
      if (r) return r;
    }
  }
  return undefined;
}

export type NsimResult<T> = Result<T>;
const fail = (
  error: string,
  params?: Record<string, string | number>,
): { ok: false; error: string; params?: Record<string, string | number> } =>
  params ? { ok: false, error, params } : { ok: false, error };

// ------------------------------------------------------------------ Export

function buildDoc(
  engine: Engine,
  opts: {
    name?: string;
    description?: string;
    savedAt?: string;
    scenarios?: unknown;
    extras?: Record<string, unknown>;
    assets?: Record<string, string>;
  } = {},
): NsimDoc {
  const s = engine.state;
  const devices: NsimDevice[] = [];
  const deviceStates: Record<string, unknown> = {};
  for (const d of Object.values(s.devices)) {
    devices.push({
      id: d.id,
      type: d.type,
      model: d.model,
      name: d.name,
      pos: { x: d.pos.x, y: d.pos.y },
      powered: d.powered,
      modules: d.modules.map((m) => ({ ...m })),
      physical: { ...d.physical },
      ports: d.ports.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        mac: p.mac,
        adminUp: p.adminUp,
        speed: p.speed,
        duplex: p.duplex,
        mtu: p.mtu,
        ...(p.vlanMode ? { vlanMode: p.vlanMode } : {}),
        ...(p.errdisabled ? { errdisabled: p.errdisabled } : {}),
      })),
    });
    deviceStates[d.id] = d.config;
  }
  const links: NsimLink[] = Object.values(s.links)
    .filter((l) => l.cable !== 'wireless')
    .map((l) => ({
      id: l.id,
      cable: l.cable,
      a: { ...l.a },
      b: { ...l.b },
      ...(l.lengthM !== undefined ? { lengthM: l.lengthM } : {}),
    }));
  const doc: NsimDoc = {
    schema: NSIM_SCHEMA,
    meta: {
      app: 'NetSim Web',
      name: opts.name ?? '',
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.savedAt ? { savedAt: opts.savedAt } : {}),
      seed: s.seed,
      nextId: s.nextId,
      macCounter: s.macCounter,
      nameCounters: { ...s.nameCounters },
      engine: { ...s.config },
    },
    topology: { devices, links },
    deviceStates,
    physical: s.physical ?? { cities: [] },
    assets: opts.assets ?? {},
  };
  if (opts.scenarios !== undefined) doc.scenarios = opts.scenarios;
  if (opts.extras !== undefined) doc.extras = opts.extras;
  return doc;
}

type ExportOpts = Parameters<typeof buildDoc>[1];

/** Dokument mit JSON-Semantik (tiefe Kopie, `undefined`-Felder entfallen wie in der Datei). */
export function exportNsim(engine: Engine, opts: ExportOpts = {}): NsimDoc {
  return JSON.parse(JSON.stringify(buildDoc(engine, opts))) as NsimDoc;
}

/** Entwurfszustand als JSON-Text (für Undo/Redo-Schnappschüsse und Autosave; vermeidet die zweite Kopie). */
export function designJson(engine: Engine, opts: ExportOpts = {}): string {
  return JSON.stringify(buildDoc(engine, opts));
}

export function encodeNsim(doc: NsimDoc): Uint8Array {
  return zlibSync(new TextEncoder().encode(JSON.stringify(doc)), { level: 6 });
}

// ------------------------------------------------------------------ Migration

export type Migration = (doc: Plain) => Plain;
/** Migrationskette: `MIGRATIONS[n]` überführt Schema n in Schema n+1. Für Schema 1 ist noch keine nötig. */
export const MIGRATIONS: Record<number, Migration> = {};

export function migrate(
  raw: unknown,
  migrations: Record<number, Migration> = MIGRATIONS,
  current = NSIM_SCHEMA,
): Result<Plain> {
  if (!isObj(raw)) return fail('nsim.notObject');
  const v = raw.schema;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return fail('nsim.noSchema');
  if (v > current) return fail('nsim.newer', { schema: v, supported: current });
  let doc: Plain = raw;
  for (let n = v; n < current; n++) {
    const step = migrations[n];
    if (!step) return fail('nsim.noMigration', { schema: n });
    try {
      doc = step(doc);
    } catch {
      return fail('nsim.migrationFailed', { schema: n });
    }
    doc.schema = n + 1;
  }
  return { ok: true, value: doc };
}

// ------------------------------------------------------------------ Import

/** Dekomprimiert mit hartem Größenlimit (schrittweise in kleinen Blöcken, gegen Zip-Bomben). */
export function inflateLimited(bytes: Uint8Array, maxOut = NSIM_MAX_JSON): Result<Uint8Array> {
  if (bytes.length > NSIM_MAX_COMPRESSED) return fail('nsim.tooLarge');
  if (bytes.length < 6 || (bytes[0] ?? 0) % 16 !== 8) return fail('nsim.notNsim');
  const chunks: Uint8Array[] = [];
  let total = 0;
  let bad = false;
  let tooBig = false;
  let done = false;
  const u = new Unzlib((chunk, final) => {
    total += chunk.length;
    if (total > maxOut) {
      tooBig = true;
      return;
    }
    chunks.push(chunk);
    if (final) done = true;
  });
  const STEP = 8192;
  try {
    for (let i = 0; i < bytes.length && !bad && !tooBig; i += STEP) {
      u.push(bytes.subarray(i, i + STEP), i + STEP >= bytes.length);
    }
  } catch {
    bad = true;
  }
  if (tooBig) return fail('nsim.tooLarge');
  if (bad || !done) return fail('nsim.notNsim');
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return { ok: true, value: out };
}

export function parseNsimJson(text: string): Result<NsimDoc> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('nsim.badJson');
  }
  const bad = checkPlain(raw);
  if (bad) return fail('nsim.invalid', { detail: bad });
  const mig = migrate(raw);
  if (!mig.ok) return mig;
  const parsed = DocSchema.safeParse(mig.value);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return fail('nsim.invalid', {
      detail: `${(i?.path ?? []).join('.')}: ${i?.message ?? ''}`.slice(0, 200),
    });
  }
  const doc = parsed.data as unknown as NsimDoc;
  const integrity = checkIntegrity(doc);
  if (integrity) return fail('nsim.invalid', { detail: integrity });
  return { ok: true, value: doc };
}

export function decodeNsim(bytes: Uint8Array): Result<NsimDoc> {
  const inf = inflateLimited(bytes);
  if (!inf.ok) return inf;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(inf.value);
  } catch {
    return fail('nsim.badJson');
  }
  return parseNsimJson(text);
}

/** Referenzen, Eindeutigkeit und Konfigurationsform prüfen. */
function checkIntegrity(doc: NsimDoc): string | undefined {
  const devs = new Map<string, NsimDevice>();
  const macs = new Set<string>();
  for (const d of doc.topology.devices) {
    if (devs.has(d.id)) return `duplicate device id ${d.id}`;
    devs.set(d.id, d);
    const pids = new Set<string>();
    for (const p of d.ports) {
      if (pids.has(p.id)) return `${d.id}: duplicate port ${p.id}`;
      pids.add(p.id);
      const m = p.mac.toLowerCase();
      if (macs.has(m)) return `duplicate MAC ${m}`;
      macs.add(m);
    }
    const spec = CATALOG[d.type];
    if (!spec) return `${d.id}: unknown type`;
    const cfg = doc.deviceStates[d.id];
    if (!isObj(cfg) || typeof cfg.kind !== 'string') return `deviceStates.${d.id}: missing`;
  }
  for (const id of Object.keys(doc.deviceStates))
    if (!devs.has(id)) return `deviceStates.${id}: no such device`;
  const used = new Set<string>();
  const lids = new Set<string>();
  for (const l of doc.topology.links) {
    if (lids.has(l.id)) return `duplicate link id ${l.id}`;
    lids.add(l.id);
    for (const ref of [l.a, l.b]) {
      const d = devs.get(ref.deviceId);
      if (!d?.ports.some((p) => p.id === ref.portId)) return `link ${l.id}: unknown port`;
      const key = `${ref.deviceId}/${ref.portId}`;
      if (used.has(key)) return `port ${key} used twice`;
      used.add(key);
    }
    if (l.a.deviceId === l.b.deviceId) return `link ${l.id}: loops to same device`;
  }
  return undefined;
}

/** Baut aus einem validierten Dokument einen frischen Engine-Zustand (ohne Laufzeit). */
export function buildState(doc: NsimDoc): Result<EngineState> {
  const devices: Record<string, Device> = {};
  let maxId = 0;
  const bump = (id: string): void => {
    const m = /(\d+)$/.exec(id);
    if (m) maxId = Math.max(maxId, Number(m[1]));
  };
  for (const nd of doc.topology.devices) {
    bump(nd.id);
    const spec = CATALOG[nd.type];
    if (!spec) return fail('nsim.invalid', { detail: `unknown type ${nd.type}` });
    const ports: Port[] = nd.ports.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      mac: p.mac.toLowerCase(),
      adminUp: p.adminUp,
      operUp: false,
      speed: p.speed,
      duplex: p.duplex,
      counters: {
        inPkts: 0,
        outPkts: 0,
        inBytes: 0,
        outBytes: 0,
        inErrors: 0,
        outErrors: 0,
        collisions: 0,
      },
      operSpeed: 0,
      operDuplex: 'full',
      txBusyUntil: 0,
      mtu: p.mtu,
      ...(p.vlanMode ? { vlanMode: p.vlanMode } : {}),
      ...(p.errdisabled ? { errdisabled: p.errdisabled } : {}),
    }));
    const cfg = structuredClone(doc.deviceStates[nd.id]) as Plain;
    const defaults = spec.makeConfig(nd.name, ports) as unknown as Plain;
    if (cfg.kind !== defaults.kind)
      return fail('nsim.invalid', { detail: `deviceStates.${nd.id}: kind mismatch` });
    const bad = conform(defaults, cfg, `deviceStates.${nd.id}`);
    if (bad) return fail('nsim.invalid', { detail: bad });
    devices[nd.id] = {
      id: nd.id,
      type: nd.type,
      model: nd.model,
      name: nd.name,
      pos: { ...nd.pos },
      ports,
      modules: nd.modules.map((m) => ({ ...m })),
      powered: nd.powered,
      config: cfg as unknown as Device['config'],
      physical: { ...nd.physical },
    };
  }
  const config: EngineConfig = { ...DEFAULT_CONFIG, ...doc.meta.engine };
  const links: Record<string, Link> = {};
  for (const nl of doc.topology.links) {
    bump(nl.id);
    const da = devices[nl.a.deviceId] as Device;
    const db = devices[nl.b.deviceId] as Device;
    const pa = da.ports.find((p) => p.id === nl.a.portId) as Port;
    const pb = db.ports.find((p) => p.id === nl.b.portId) as Port;
    const check = validateCable(nl.cable, da, pa, db, pb, nl.lengthM, config);
    if (!check.allowed)
      return fail('nsim.invalid', { detail: `link ${nl.id}: ${check.rejectKey ?? 'cable'}` });
    links[nl.id] = {
      id: nl.id,
      cable: nl.cable,
      a: { ...nl.a },
      b: { ...nl.b },
      operUp: false,
      ...(nl.lengthM !== undefined ? { lengthM: nl.lengthM } : {}),
      cableOk: check.operUp,
      ...(check.problemKey ? { cableProblem: check.problemKey } : {}),
      busyFrom: 0,
      busyUntil: 0,
      lastActivityT: -1,
    };
    pa.linkId = nl.id;
    pb.linkId = nl.id;
  }
  const seed = doc.meta.seed;
  const state: EngineState = {
    version: 1,
    seed,
    rng: seed | 0,
    now: 0,
    seq: 0,
    nextTxId: 1,
    nextId: Math.max(doc.meta.nextId, maxId + 1),
    macCounter: doc.meta.macCounter,
    nameCounters: { ...doc.meta.nameCounters },
    config,
    devices,
    links,
    queue: [],
    transmissions: [],
  };
  if (doc.physical.cities.length > 0) state.physical = structuredClone(doc.physical);
  return { ok: true, value: state };
}

// ------------------------------------------------------------------ Probelauf

/**
 * Zusätzliche Prüfung im Probelauf (z. B. running-config und `show`-Befehle rendern). Das CLI-Paket
 * registriert sie beim Laden; die Engine selbst kennt die CLI nicht.
 */
export type ImportVerifier = (e: Engine) => void;
let verifier: ImportVerifier | undefined;
export function setImportVerifier(v: ImportVerifier | undefined): void {
  verifier = v;
}

/** Virtuelle Zeit des Probelaufs: erste Hellos/Advertisements, DHCP-/STP-Start. */
const TRIAL_US = 3_000_000;

/**
 * Probelauf auf einer Kopie: Laden, Ansicht bauen, kurz simulieren, Verifier. Die Zod-/Typprüfung deckt
 * nur Felder der Standardkonfiguration ab; optionale Teilbäume und Einträge von Tabellen (ACLs, QoS,
 * CDP/LLDP, Snooping …) mit falschen Typen würden sonst erst in Engine, Ansicht oder CLI werfen.
 */
function trialRun(state: EngineState): string | undefined {
  try {
    const e = new Engine({ seed: state.seed, config: state.config });
    e.loadState(structuredClone(state));
    buildDevices(e);
    buildLinks(e);
    e.runUntil(e.state.now + TRIAL_US);
    buildDevices(e);
    verifier?.(e);
    return undefined;
  } catch (err) {
    return `trial: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
  }
}

/**
 * Lädt ein validiertes Dokument in die Engine (Zustand ersetzen, Laufzeit neu aufbauen). Nicht
 * vertrauenswürdige Dokumente laufen vorher probeweise auf einer Kopie; wirft dabei etwas, bleibt die
 * Engine unverändert und das Ergebnis ist `nsim.invalid`. `trusted` (eigene Undo-Schnappschüsse) spart das.
 */
export function importNsim(
  engine: Engine,
  doc: NsimDoc,
  opts: { trusted?: boolean } = {},
): Result<true> {
  const st = buildState(doc);
  if (!st.ok) return st;
  if (!opts.trusted) {
    const bad = trialRun(st.value);
    if (bad) return fail('nsim.invalid', { detail: bad });
  }
  engine.loadState(st.value);
  return { ok: true, value: true };
}

/**
 * Bereinigt einen fremden Engine-Zustand (z. B. Start-/Antwortnetz einer `.nsact`-Aufgabe) über denselben
 * Weg wie `.nsim`: Entwurf exportieren, Zod/Integrität/Typabgleich, Probelauf. Ergebnis ist ein frischer
 * Zustand ohne Laufzeitdaten.
 */
export function sanitizeState(raw: EngineState): Result<EngineState> {
  let json: string;
  try {
    json = designJson({ state: raw } as unknown as Engine);
  } catch {
    return fail('nsim.invalid', { detail: 'state' });
  }
  const doc = parseNsimJson(json);
  if (!doc.ok) return doc;
  const st = buildState(doc.value);
  if (!st.ok) return st;
  const bad = trialRun(st.value);
  return bad ? fail('nsim.invalid', { detail: bad }) : st;
}

/** Bequemer Pfad: Bytes → Engine. */
export function openNsim(engine: Engine, bytes: Uint8Array): Result<NsimDoc> {
  const doc = decodeNsim(bytes);
  if (!doc.ok) return doc;
  const r = importNsim(engine, doc.value);
  return r.ok ? doc : r;
}
