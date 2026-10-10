import { z } from 'zod';
import type { Engine } from '../engine';
import { heapRemove } from '../heap';
import type { Device, Result } from '../types';
import {
  attemptOutcome,
  findDevice,
  PduSpecSchema,
  startAttempt,
  type Attempt,
  type PduOutcome,
  type PduSpec,
  type PduSpecInput,
} from './pdu';

/**
 * Szenarien (Packet-Tracer-Stil): Zu einer Topologie gehoeren mehrere Szenarien (Scenario 0, 1 …), jedes mit
 * eigener PDU-Liste. Das Format steht im `.nsim`-Feld `scenarios` (reines JSON, siehe `ScenarioFileSchema`).
 *
 * PDU-Eintraege halten die Beschreibung (`spec`) und das zuletzt bekannte Ergebnis. Die Laufzeit (Versuche,
 * Timer) ist fluechtig und nicht Teil der Datei.
 */

export const PDU_STATUS = ['unsent', 'pending', 'successful', 'failed'] as const;
export type PduEntryStatus = (typeof PDU_STATUS)[number];

export const PduEntrySchema = z.object({
  id: z.number().int().min(1),
  spec: PduSpecSchema,
  status: z.enum(PDU_STATUS).default('unsent'),
  /** Ursache des letzten Fehlschlags (i18n-Schluessel). */
  note: z.string().max(100).optional(),
  /** Zahl der gestarteten / erfolgreichen Versuche der letzten Ausfuehrung. */
  sent: z.number().int().min(0).default(0),
  okCount: z.number().int().min(0).default(0),
  /** Zeitpunkt (virtuelle Zeit, µs) des letzten Starts. */
  lastT: z.number().optional(),
});
export type PduEntry = z.infer<typeof PduEntrySchema>;

export const ScenarioSchema = z.object({
  id: z.number().int().min(0),
  name: z.string().max(80),
  description: z.string().max(2000).default(''),
  nextPduId: z.number().int().min(1).default(1),
  pdus: z.array(PduEntrySchema).max(500).default([]),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const ScenarioFileSchema = z.object({
  schema: z.literal(1),
  /** Index des aktiven Szenarios in `scenarios`. */
  active: z.number().int().min(0).default(0),
  nextId: z.number().int().min(0).default(1),
  scenarios: z.array(ScenarioSchema).min(1).max(50),
});
export type ScenarioFile = z.infer<typeof ScenarioFileSchema>;

export function newScenarioFile(): ScenarioFile {
  return {
    schema: 1,
    active: 0,
    nextId: 1,
    scenarios: [{ id: 0, name: 'Scenario 0', description: '', nextPduId: 1, pdus: [] }],
  };
}

/** Prueft ein `scenarios`-Feld aus einer Datei; Unbrauchbares ergibt ein leeres Szenario 0. */
export function parseScenarioFile(data: unknown): ScenarioFile {
  const r = ScenarioFileSchema.safeParse(data);
  if (!r.success) return newScenarioFile();
  const f = r.data;
  // PDUs, die beim Speichern noch liefen, gelten als nicht gesendet
  for (const s of f.scenarios)
    for (const p of s.pdus) if (p.status === 'pending') p.status = 'unsent';
  f.active = Math.min(f.active, f.scenarios.length - 1);
  return f;
}

interface Run {
  /** Aktueller Lauf: geplante Zahl der Versuche und bisherige Versuche. */
  total: number;
  attempts: Attempt[];
  specKey: string;
  t0: number;
  /** Beim Planen fehlgeschlagene Versuche (Quelle aus, kein Ziel …). */
  startErrors: string[];
}

/**
 * Fuehrt PDUs eines Szenarios aus. Versuche werden ueber Engine-Timer (`teach:`) zeitgesteuert – damit
 * bleibt die Simulation deterministisch (kein Wanduhr-Einfluss, auch Step Back/Reset sind konsistent).
 */
export class PduRunner {
  private runs = new Map<string, Run>();
  private engine: Engine | undefined;

  constructor(private readonly getEngine: () => Engine) {}

  private bind(): Engine {
    const e = this.getEngine();
    if (this.engine !== e) {
      this.runs.clear();
      this.engine = e;
    }
    e.teachTimer = (dev, name) => this.onTimer(e, dev, name);
    return e;
  }

  static key(scenarioId: number, pduId: number): string {
    return `${scenarioId}.${pduId}`;
  }

  /** Startet (oder wiederholt) die PDU; liefert Fehler nur, wenn gar kein Versuch geplant werden kann. */
  send(key: string, spec: PduSpec): Result<true> {
    const e = this.bind();
    this.cancel(key);
    const src = findDevice(e, spec.src);
    if (!src) return { ok: false, error: 'pdu.err.noSource' };
    const run: Run = {
      total: spec.count,
      attempts: [],
      specKey: JSON.stringify(spec),
      t0: e.state.now,
      startErrors: [],
    };
    this.runs.set(key, run);
    const delayUs = Math.round(spec.delaySec * 1_000_000);
    const stepUs = Math.round(spec.intervalSec * 1_000_000);
    for (let k = 0; k < spec.count; k++) {
      const at = delayUs + k * stepUs;
      if (at === 0) this.fire(e, key, run, spec, 0);
      else e.withCtx(src, (ctx) => ctx.setTimer(`teach:${key}:${k}`, at));
    }
    return { ok: true, value: true };
  }

  /** Geplante Versuche und laufende Zaehler verwerfen. */
  cancel(key: string): void {
    const e = this.engine;
    const run = this.runs.get(key);
    this.runs.delete(key);
    if (!e || !run) return;
    const prefix = `teach:${key}:`;
    heapRemove(e.state.queue, (ev) => ev.kind === 'timer' && ev.payload.name.startsWith(prefix));
  }

  private fire(e: Engine, key: string, run: Run, spec: PduSpec, k: number): void {
    const r = startAttempt(e, spec);
    if (r.ok) run.attempts.push(r.value);
    else run.startErrors.push(r.error);
    void k;
  }

  private onTimer(e: Engine, _dev: Device, name: string): void {
    const m = /^(\d+\.\d+):(\d+)$/.exec(name);
    if (!m) return;
    const key = m[1] as string;
    const run = this.runs.get(key);
    if (!run) return;
    const spec = PduSpecSchema.safeParse(JSON.parse(run.specKey));
    if (!spec.success) return;
    this.fire(e, key, run, spec.data, Number(m[2]));
  }

  /** Aktueller Zustand der Ausfuehrung (nach der letzten Anfrage). */
  status(
    key: string,
  ): { status: PduEntryStatus; note?: string; sent: number; okCount: number } | undefined {
    const e = this.bind();
    const run = this.runs.get(key);
    if (!run) return undefined;
    // nach Step Back/Reset liegt der Lauf in der Zukunft: verwerfen
    if (e.state.now < run.t0) {
      this.runs.delete(key);
      return undefined;
    }
    let okCount = 0;
    let failed = 0;
    let pending = 0;
    let note: string | undefined = run.startErrors[0];
    failed += run.startErrors.length;
    for (const a of run.attempts) {
      const o: PduOutcome = attemptOutcome(e, a);
      if (o.status !== 'pending') a.decided = o;
      if (o.status === 'ok') okCount++;
      else if (o.status === 'failed') {
        failed++;
        note ??= o.note;
      } else pending++;
    }
    const sent = run.attempts.length + run.startErrors.length;
    const open = run.total - sent + pending;
    const status: PduEntryStatus = failed > 0 ? 'failed' : open > 0 ? 'pending' : 'successful';
    return { status, note, sent, okCount };
  }
}

/** Anwendung der Laufzeitergebnisse auf die Datei (fuer Anzeige und Speichern). */
export function refreshScenarioFile(f: ScenarioFile, runner: PduRunner): void {
  for (const s of f.scenarios) {
    for (const p of s.pdus) {
      const st = runner.status(PduRunner.key(s.id, p.id));
      if (!st) {
        if (p.status === 'pending') p.status = 'unsent';
        continue;
      }
      p.status = st.status;
      p.note = st.note;
      p.sent = st.sent;
      p.okCount = st.okCount;
    }
  }
}

export type { PduSpecInput };
