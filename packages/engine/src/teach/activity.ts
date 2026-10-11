import { Unzlib, strFromU8, strToU8, zlibSync } from 'fflate';
import { z } from 'zod';
import type { EngineState, Result } from '../types';
import { CheckSchema, LTextSchema } from './checks';
import { sanitizeState } from '../nsim';

/**
 * Aufgabenformat `.nsact`: JSON `{ schema: 1, kind: 'netsim-activity', ... }`, zlib-komprimiert, mit Zod
 * validiert. Netze (`start`, `answer`) sind Engine-Zustaende (reines JSON). Nie ungeprueftes JSON in die Engine.
 */

export const ACTIVITY_SCHEMA = 1;
export const MAX_ACTIVITY_BYTES = 16 * 1024 * 1024;
export const MAX_ACTIVITY_JSON = 48 * 1024 * 1024;

const looseNum = z.number().finite();

const PortSchema = z.looseObject({
  id: z.string().max(64),
  name: z.string().max(64),
  kind: z.string().max(32),
  mac: z.string().max(17),
  adminUp: z.boolean(),
  operUp: z.boolean(),
});

const DeviceSchema = z.looseObject({
  id: z.string().max(64),
  type: z.string().max(40),
  model: z.string().max(80),
  name: z.string().max(64),
  pos: z.object({ x: looseNum, y: looseNum }),
  ports: z.array(PortSchema).max(512),
  powered: z.boolean(),
  config: z.looseObject({
    kind: z.enum(['host', 'router', 'switch', 'hub', 'bridge', 'none']),
  }),
});

const LinkSchema = z.looseObject({
  id: z.string().max(64),
  a: z.object({ deviceId: z.string().max(64), portId: z.string().max(64) }),
  b: z.object({ deviceId: z.string().max(64), portId: z.string().max(64) }),
});

/** Strukturpruefung eines Engine-Zustands (tiefe Inhalte der Gerate sind Engine-intern). */
export const EngineStateSchema = z.looseObject({
  version: z.literal(1),
  seed: looseNum,
  rng: looseNum,
  now: looseNum,
  seq: looseNum,
  nextTxId: looseNum,
  nextId: looseNum,
  macCounter: looseNum,
  nameCounters: z.record(z.string(), looseNum),
  config: z.looseObject({
    propagationUs: looseNum,
    processingUs: looseNum,
    maxCopperLengthM: looseNum,
  }),
  devices: z.record(z.string().max(64), DeviceSchema),
  links: z.record(z.string().max(64), LinkSchema),
  queue: z.array(z.unknown()).max(200_000),
  transmissions: z.array(z.unknown()).max(50_000),
});

export const StepSchema = z.object({
  title: LTextSchema.optional(),
  text: LTextSchema,
});

export const ActivitySchema = z.object({
  schema: z.literal(ACTIVITY_SCHEMA),
  kind: z.literal('netsim-activity'),
  meta: z.object({
    id: z.string().min(1).max(64),
    title: LTextSchema,
    description: LTextSchema.optional(),
    author: z.string().max(100).optional(),
    created: z.string().max(40).optional(),
    difficulty: z.number().int().min(1).max(3).optional(),
  }),
  /** Schrittanleitung (Reihenfolge = Anzeige). */
  steps: z.array(StepSchema).max(50).default([]),
  /** Zeitlimit in Sekunden (0 = keins). */
  timeLimitSec: z.number().int().min(0).max(86_400).default(0),
  /** Prozent, ab denen die Aufgabe als bestanden gilt. */
  passPercent: z.number().int().min(1).max(100).default(100),
  /** Live-Fortschritt (Auswertung nach jeder Aenderung des Netzes). */
  liveProgress: z.boolean().default(false),
  locks: z
    .object({
      hideCli: z.boolean().default(false),
      hideGui: z.boolean().default(false),
      noAddDevices: z.boolean().default(false),
    })
    .default({ hideCli: false, hideGui: false, noAddDevices: false }),
  start: EngineStateSchema,
  answer: EngineStateSchema.optional(),
  checks: z.array(CheckSchema).min(1).max(200),
});
export type Activity = Omit<z.infer<typeof ActivitySchema>, 'start' | 'answer'> & {
  start: EngineState;
  answer?: EngineState;
};

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Verweigert gefaehrliche Schluessel und uebertriebene Verschachtelung (Schutz vor Prototype Pollution). */
export function assertSafeJson(v: unknown, depth = 0): string | undefined {
  if (depth > 40) return 'depth';
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = assertSafeJson(x, depth + 1);
      if (r) return r;
    }
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (FORBIDDEN_KEYS.has(k)) return `key:${k}`;
      const r = assertSafeJson((v as Record<string, unknown>)[k], depth + 1);
      if (r) return r;
    }
  }
  return undefined;
}

/** Validiert beliebige Daten als Aufgabe. `trusted`: selbst erzeugte Netze (Beispielaufgaben) ohne Probelauf. */
export function parseActivity(data: unknown, opts: { trusted?: boolean } = {}): Result<Activity> {
  const unsafe = assertSafeJson(data);
  if (unsafe) return { ok: false, error: 'activity.err.unsafe', params: { detail: unsafe } };
  const r = ActivitySchema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    return {
      ok: false,
      error: 'activity.err.invalid',
      params: { path: issue?.path.join('.') ?? '', message: issue?.message ?? '' },
    };
  }
  const checks = r.data.checks;
  const ids = new Set(checks.map((c) => c.id));
  if (ids.size !== checks.length) return { ok: false, error: 'activity.err.duplicateId' };
  const value = r.data as unknown as Activity;
  // Netze wie `.nsim` prüfen (Typabgleich, Integrität, Probelauf): das Zod-Schema oben prüft nur die Hülle
  for (const k of opts.trusted ? [] : (['start', 'answer'] as const)) {
    const st = value[k];
    if (st === undefined) continue;
    const clean = sanitizeState(st);
    if (!clean.ok)
      return {
        ok: false,
        error: 'activity.err.invalid',
        params: { path: k, message: String(clean.params?.detail ?? clean.error) },
      };
    value[k] = clean.value;
  }
  return { ok: true, value };
}

/** `.nsact`-Bytes: zlib-komprimiertes JSON. */
export function encodeActivity(a: Activity): Uint8Array {
  return zlibSync(strToU8(JSON.stringify(a)), { level: 6 });
}

/** Dekomprimiert mit Groessenlimit (Schutz vor Dekompressionsbomben). */
function inflateLimited(bytes: Uint8Array, limit: number): Uint8Array | undefined {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let tooBig = false;
  let error = false;
  const z = new Unzlib((chunk) => {
    size += chunk.length;
    if (size > limit) tooBig = true;
    else chunks.push(chunk);
  });
  try {
    z.push(bytes, true);
  } catch {
    error = true;
  }
  if (tooBig || error) return undefined;
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function decodeActivity(bytes: Uint8Array): Result<Activity> {
  if (bytes.length > MAX_ACTIVITY_BYTES) return { ok: false, error: 'activity.err.tooLarge' };
  const raw = inflateLimited(bytes, MAX_ACTIVITY_JSON);
  if (!raw) return { ok: false, error: 'activity.err.corrupt' };
  let data: unknown;
  try {
    data = JSON.parse(strFromU8(raw));
  } catch {
    return { ok: false, error: 'activity.err.corrupt' };
  }
  return parseActivity(data);
}
