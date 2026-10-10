import { z } from 'zod';
import { EngineService5 } from '../service5';
import type { EngineState, Result } from '../types';
import {
  decodeActivity,
  encodeActivity,
  parseActivity,
  ActivitySchema,
  type Activity,
} from './activity';
import { buildChallenge, type ChallengeQuestion, type DeviceClass } from './challenge';
import { CheckSchema, evaluateChecks, type Check, type EvalSummary } from './checks';
import { engineFromState, loadStateInto } from './clone';
import { deriveChecks } from './derive';
import { PduSpecSchema, type PduSpecInput } from './pdu';
import {
  newScenarioFile,
  parseScenarioFile,
  PduRunner,
  refreshScenarioFile,
  type ScenarioFile,
} from './scenario';

/** Aufgabe ohne die (grossen) Netzzustaende – das bekommt die Oberflaeche. */
export type ActivityPublic = Omit<Activity, 'start' | 'answer'> & { hasAnswer: boolean };

const DraftSchema = ActivitySchema.omit({
  start: true,
  answer: true,
  schema: true,
  kind: true,
}).extend({
  includeAnswer: z.boolean().default(false),
});
export type ActivityDraft = z.input<typeof DraftSchema>;

/**
 * Lehr-Werkzeuge im Nachrichtenprotokoll UI <-> Worker: Szenarien/PDU-Liste, Aufgaben (Laden, Pruefen) und
 * Autorenfunktionen. Alle Parameter und Rueckgaben sind strukturell klonbar.
 */
export class TeachService extends EngineService5 {
  protected scen: ScenarioFile = newScenarioFile();
  private readonly runner = new PduRunner(() => this.engine);
  private activity: Activity | undefined;
  private authorStart: EngineState | undefined;
  private authorAnswer: EngineState | undefined;

  // ------------------------------------------------------------ Szenarien und PDU-Liste

  /** Szenarien samt aktuellem Ergebnis aller PDUs (das ist zugleich der Inhalt des `.nsim`-Felds `scenarios`). */
  getScenarios(): ScenarioFile {
    refreshScenarioFile(this.scen, this.runner);
    return structuredClone(this.scen);
  }

  /** Szenarien aus einer Datei uebernehmen (ungueltige Daten ergeben ein leeres Szenario 0). */
  setScenarios(data: unknown): void {
    this.scen = data === undefined ? newScenarioFile() : parseScenarioFile(data);
    this.touch();
  }

  scenarioAdd(): number {
    const id = this.scen.nextId++;
    this.scen.scenarios.push({
      id,
      name: `Scenario ${id}`,
      description: '',
      nextPduId: 1,
      pdus: [],
    });
    this.scen.active = this.scen.scenarios.length - 1;
    this.touch();
    return this.scen.active;
  }

  scenarioSelect(index: number): Result<true> {
    if (!Number.isInteger(index) || index < 0 || index >= this.scen.scenarios.length)
      return { ok: false, error: 'scenario.err.range' };
    this.scen.active = index;
    this.touch();
    return { ok: true, value: true };
  }

  scenarioUpdate(index: number, patch: { name?: string; description?: string }): Result<true> {
    const s = this.scen.scenarios[index];
    if (!s) return { ok: false, error: 'scenario.err.range' };
    if (patch.name !== undefined) s.name = patch.name.slice(0, 80) || s.name;
    if (patch.description !== undefined) s.description = patch.description.slice(0, 2000);
    this.touch();
    return { ok: true, value: true };
  }

  scenarioDelete(index: number): Result<true> {
    if (this.scen.scenarios.length <= 1) return { ok: false, error: 'scenario.err.last' };
    const s = this.scen.scenarios[index];
    if (!s) return { ok: false, error: 'scenario.err.range' };
    for (const p of s.pdus) this.runner.cancel(PduRunner.key(s.id, p.id));
    this.scen.scenarios.splice(index, 1);
    this.scen.active = Math.min(this.scen.active, this.scen.scenarios.length - 1);
    this.touch();
    return { ok: true, value: true };
  }

  /** PDU zur Liste des aktiven Szenarios hinzufuegen und (standardmaessig) sofort senden. */
  pduAdd(input: PduSpecInput, send = true): Result<number> {
    const spec = PduSpecSchema.safeParse(input);
    if (!spec.success) return { ok: false, error: 'pdu.err.invalid' };
    const s = this.scen.scenarios[this.scen.active];
    if (!s) return { ok: false, error: 'scenario.err.range' };
    if (s.pdus.length >= 500) return { ok: false, error: 'pdu.err.full' };
    const id = s.nextPduId++;
    s.pdus.push({ id, spec: spec.data, status: 'unsent', sent: 0, okCount: 0 });
    if (send) {
      const r = this.runner.send(PduRunner.key(s.id, id), spec.data);
      const e = s.pdus[s.pdus.length - 1];
      if (e) e.lastT = this.engine.state.now;
      if (!r.ok) {
        if (e) {
          e.status = 'failed';
          e.note = r.error;
        }
      }
    }
    this.touch();
    return { ok: true, value: id };
  }

  /** PDU erneut senden (Rerun). */
  pduRerun(id: number): Result<true> {
    const s = this.scen.scenarios[this.scen.active];
    const p = s?.pdus.find((x) => x.id === id);
    if (!s || !p) return { ok: false, error: 'pdu.err.notFound' };
    const r = this.runner.send(PduRunner.key(s.id, id), p.spec);
    p.lastT = this.engine.state.now;
    p.sent = 0;
    p.okCount = 0;
    if (!r.ok) {
      p.status = 'failed';
      p.note = r.error;
    } else {
      p.status = 'pending';
      p.note = undefined;
    }
    this.touch();
    return { ok: true, value: true };
  }

  pduDelete(id: number): Result<true> {
    const s = this.scen.scenarios[this.scen.active];
    if (!s) return { ok: false, error: 'scenario.err.range' };
    const i = s.pdus.findIndex((x) => x.id === id);
    if (i < 0) return { ok: false, error: 'pdu.err.notFound' };
    this.runner.cancel(PduRunner.key(s.id, id));
    s.pdus.splice(i, 1);
    this.touch();
    return { ok: true, value: true };
  }

  pduClear(): void {
    const s = this.scen.scenarios[this.scen.active];
    if (!s) return;
    for (const p of s.pdus) this.runner.cancel(PduRunner.key(s.id, p.id));
    s.pdus = [];
    this.touch();
  }

  override clear(): void {
    super.clear();
    this.scen = newScenarioFile();
    this.activity = undefined;
  }

  // ------------------------------------------------------------ Aufgaben (Teilnehmer)

  private publicOf(a: Activity): ActivityPublic {
    const { start: _s, answer, ...rest } = a;
    void _s;
    return { ...rest, hasAnswer: answer !== undefined };
  }

  /** Aufgabe aus `.nsact`-Bytes oder bereits dekodiertem JSON laden; das Startnetz ersetzt das aktuelle Netz. */
  activityLoad(data: Uint8Array | unknown): Result<ActivityPublic> {
    const r = data instanceof Uint8Array ? decodeActivity(data) : parseActivity(data);
    if (!r.ok) return r;
    this.clear();
    loadStateInto(this.engine, r.value.start);
    this.activity = r.value;
    this.touch();
    return { ok: true, value: this.publicOf(r.value) };
  }

  activityInfo(): ActivityPublic | undefined {
    return this.activity ? this.publicOf(this.activity) : undefined;
  }

  activityClose(): void {
    this.activity = undefined;
    this.touch();
  }

  /** Prueft das aktuelle Netz gegen die Aufgabe. */
  activityCheck(): Result<EvalSummary> {
    if (!this.activity) return { ok: false, error: 'activity.err.none' };
    return { ok: true, value: evaluateChecks(this.engine, this.activity.checks) };
  }

  /** Antwortnetz in das Arbeitsnetz laden (Loesung ansehen), sofern die Aufgabe eines enthaelt. */
  activityShowAnswer(): Result<true> {
    const a = this.activity?.answer;
    if (!a) return { ok: false, error: 'activity.err.noAnswer' };
    loadStateInto(this.engine, a);
    this.touch();
    return { ok: true, value: true };
  }

  /** Setzt das Startnetz der Aufgabe zurueck. */
  activityRestart(): Result<true> {
    if (!this.activity) return { ok: false, error: 'activity.err.none' };
    loadStateInto(this.engine, this.activity.start);
    this.touch();
    return { ok: true, value: true };
  }

  // ------------------------------------------------------------ Challenge Me

  /** Fragen zu einem Log-Eintrag (Quiz im PDU-Inspektor); leer, wenn der Eintrag nicht mehr vorhanden ist. */
  challenge(logId: number): ChallengeQuestion[] {
    const entry = this.engine.logSlice(logId, 1)[0];
    if (entry?.id !== logId) return [];
    const dev = this.engine.getDevice(entry.atDeviceId);
    const k = dev?.config.kind;
    const deviceKind: DeviceClass =
      k === 'host' || k === 'router' || k === 'switch' || k === 'hub' ? k : 'other';
    return buildChallenge({
      entry,
      deviceKind,
      ports: dev?.ports.map((p) => p.name) ?? [],
      later: this.engine.logSlice(logId + 1, 40),
    });
  }

  // ------------------------------------------------------------ Autor

  /** Pruefungen auf dem aktuellen Netz auswerten (Vorschau beim Erstellen). */
  evaluate(checks: unknown[]): Result<EvalSummary> {
    const parsed = z.array(CheckSchema).max(200).safeParse(checks);
    if (!parsed.success) return { ok: false, error: 'activity.err.invalid' };
    return { ok: true, value: evaluateChecks(this.engine, parsed.data) };
  }

  /** Aktuelles Netz als Start- bzw. Antwortnetz der Aufgabe festhalten. */
  authorCapture(which: 'start' | 'answer'): void {
    const s = structuredClone(this.engine.state);
    if (which === 'start') this.authorStart = s;
    else this.authorAnswer = s;
  }

  authorStatus(): { start: boolean; answer: boolean } {
    return { start: this.authorStart !== undefined, answer: this.authorAnswer !== undefined };
  }

  authorDiscard(which: 'start' | 'answer'): void {
    if (which === 'start') this.authorStart = undefined;
    else this.authorAnswer = undefined;
  }

  /** Leitet Pruefungen aus Start- und Antwortnetz ab. */
  authorDerive(): Result<Check[]> {
    if (!this.authorStart || !this.authorAnswer)
      return { ok: false, error: 'activity.err.needBoth' };
    return {
      ok: true,
      value: deriveChecks(engineFromState(this.authorStart), engineFromState(this.authorAnswer)),
    };
  }

  /** Baut `.nsact`-Bytes aus Entwurf + festgehaltenen Netzen (Startnetz: festgehaltenes, sonst aktuelles). */
  authorExport(draft: ActivityDraft | unknown): Result<Uint8Array> {
    const d = DraftSchema.safeParse(draft);
    if (!d.success) {
      const issue = d.error.issues[0];
      return {
        ok: false,
        error: 'activity.err.invalid',
        params: { path: issue?.path.join('.') ?? '', message: issue?.message ?? '' },
      };
    }
    const { includeAnswer, ...rest } = d.data;
    const raw = {
      schema: 1,
      kind: 'netsim-activity',
      ...rest,
      start: this.authorStart ?? structuredClone(this.engine.state),
      ...(includeAnswer && this.authorAnswer ? { answer: this.authorAnswer } : {}),
    };
    const p = parseActivity(raw);
    if (!p.ok) return p;
    return { ok: true, value: encodeActivity(p.value) };
  }
}
