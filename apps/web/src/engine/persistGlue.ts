import {
  cloneDevices,
  decodeNsim,
  designJson,
  encodeNsim,
  exportNsim,
  importNsim,
  parseNsimJson,
  type EngineService5,
  type NsimDoc,
  type PasteResult,
  type Point,
  type Result,
} from '@netsim/engine';
import { TEMPLATES, buildTemplate, renderRunningConfig, type Template } from '@netsim/cli';
import { UndoManager, type UndoInfo } from './undo';

/** Methoden des Dienstes, die den Entwurf nicht ändern (kein Undo-Schritt, kein Umhüllen). */
const NO_WRAP = new Set([
  'constructor',
  'tick',
  'consumeDirty',
  'getView',
  'getLog',
  'touch',
  'setMode',
  'setSpeed',
  'play',
  'pause',
  'step',
  'stepBack',
  'reset',
  'ping',
  'trace',
  'httpGet',
  'mailSend',
  'mailFetch',
  'snmpQuery',
  'runIotScript',
  'subscribe',
  'termOpen',
  'termPoll',
  'termData',
  'done',
  'pump',
  'mailStatus',
  'shellFor',
]);
const NO_WRAP_PREFIX = [
  'get',
  'is',
  'saveNsim',
  'openNsim',
  'loadTemplate',
  'paste',
  'undo',
  'redo',
  'list',
  // Lehr-Werkzeuge (teach): Szenarien/PDU-Liste, Aufgaben, Autor, Challenge – kein Entwurf, kein Undo-Schritt
  'setScenarios',
  'scenario',
  'pdu',
  'author',
  'challenge',
  'example',
  'evaluate',
  'activityLoad',
  'activityInfo',
  'activityCheck',
  'activityClose',
];

export interface TemplateInfo {
  id: string;
  level: Template['level'];
  title: Template['title'];
  summary: Template['summary'];
  goals: Template['goals'];
  devices: number;
}

export interface OpenInfo {
  name: string;
  description: string;
  devices: number;
  scenarios: unknown;
  extras: Record<string, unknown>;
}

type Scen = { getScenarios?: () => unknown; setScenarios?: (d: unknown) => void };

/**
 * Persistenz im Worker: `.nsim` speichern/öffnen, Vorlagen laden, Kopieren/Einfügen und Undo/Redo.
 * Alle ändernden Dienstmethoden werden umhüllt, sodass jede Änderung genau einen Undo-Schritt ergibt.
 */
export class Persistence {
  readonly undoMgr: UndoManager;
  name = '';
  description = '';
  assets: Record<string, string> = {};
  /** Szenarien (Platzhalter, gehört der Lehr-Komponente) – wird unverändert durchgereicht. */
  scenarios: unknown;
  /** Oberflächen-Zustand (Notizen, Gruppen …) – Teil jedes Undo-Schritts und der Datei. */
  extras: Record<string, unknown> = {};
  private undoCb: ((i: UndoInfo) => void) | undefined;

  constructor(
    private readonly svc: EngineService5,
    /** Wird nach Undo/Öffnen mit den noch vorhandenen Geräte-Ids aufgerufen (Terminals aufräumen). */
    private readonly pruneTerms: (alive: Set<string>) => void,
  ) {
    this.undoMgr = new UndoManager(
      () => designJson(svc.engine, { extras: this.extras }),
      (s) => this.restoreJson(s),
      (i) => this.undoCb?.(i),
    );
    this.install();
  }

  onUndoInfo(cb: (i: UndoInfo) => void): void {
    this.undoCb = cb;
    cb(this.undoMgr.info());
  }

  private install(): void {
    const seen = new Set<string>();
    const target = this.svc as unknown as Record<string, unknown>;
    for (
      let o: object | null = Object.getPrototypeOf(this.svc);
      o && o !== Object.prototype;
      o = Object.getPrototypeOf(o)
    ) {
      for (const name of Object.getOwnPropertyNames(o)) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (NO_WRAP.has(name) || NO_WRAP_PREFIX.some((p) => name.startsWith(p))) continue;
        const d = Object.getOwnPropertyDescriptor(o, name);
        if (!d || typeof d.value !== 'function') continue;
        const orig = d.value as (...a: unknown[]) => unknown;
        target[name] = (...a: unknown[]) => this.undoMgr.run(() => orig.apply(this.svc, a));
      }
    }
  }

  private scen(): Scen {
    return this.svc as unknown as Scen;
  }

  private restoreJson(json: string): boolean {
    const parsed = parseNsimJson(json);
    if (!parsed.ok) return false;
    return this.load(parsed.value);
  }

  private load(doc: NsimDoc): boolean {
    const r = importNsim(this.svc.engine, doc);
    if (!r.ok) return false;
    this.extras = doc.extras ?? {};
    this.svc.reset();
    this.pruneTerms(new Set(Object.keys(this.svc.engine.state.devices)));
    return true;
  }

  // ---------------------------------------------------------------- Datei

  save(extras?: Record<string, unknown>): Uint8Array {
    if (extras) this.extras = extras;
    const sc = this.scen().getScenarios?.() ?? this.scenarios;
    const doc = exportNsim(this.svc.engine, {
      name: this.name,
      description: this.description,
      savedAt: new Date().toISOString(),
      scenarios: sc,
      assets: this.assets,
      extras: this.extras,
    });
    return encodeNsim(doc);
  }

  open(bytes: Uint8Array): Result<OpenInfo> {
    const doc = decodeNsim(bytes);
    if (!doc.ok) return doc;
    const d = doc.value;
    let ok = true;
    this.undoMgr.run(() => {
      ok = this.load(d);
    });
    if (!ok) return { ok: false, error: 'nsim.invalid' };
    this.name = d.meta.name;
    this.description = d.meta.description ?? '';
    this.assets = d.assets;
    this.scenarios = d.scenarios;
    this.scen().setScenarios?.(d.scenarios);
    return {
      ok: true,
      value: {
        name: this.name,
        description: this.description,
        devices: d.topology.devices.length,
        scenarios: d.scenarios,
        extras: d.extras ?? {},
      },
    };
  }

  /** Neues, leeres Netz (Datei → Neu); der Zustand davor bleibt per Undo erreichbar. */
  newTopology(): void {
    this.undoMgr.run(() => {
      this.svc.clear();
      this.extras = {};
    });
    this.name = '';
    this.description = '';
    this.assets = {};
    this.scenarios = undefined;
    this.scen().setScenarios?.(undefined);
    this.pruneTerms(new Set());
  }

  // ---------------------------------------------------------------- Vorlagen

  listTemplates(): TemplateInfo[] {
    return TEMPLATES.map((t) => ({
      id: t.id,
      level: t.level,
      title: t.title,
      summary: t.summary,
      goals: t.goals,
      devices: 0,
    }));
  }

  loadTemplate(id: string): Result<{ devices: number }> {
    const tpl = TEMPLATES.find((t) => t.id === id);
    if (!tpl) return { ok: false, error: 'tpl.unknown' };
    try {
      this.undoMgr.run(() => {
        this.svc.clear();
        this.extras = {};
        buildTemplate(this.svc.engine, id);
      });
    } catch {
      return { ok: false, error: 'tpl.failed' };
    }
    this.name = tpl.title.en;
    this.description = '';
    this.assets = {};
    this.scenarios = undefined;
    this.scen().setScenarios?.(undefined);
    this.svc.touch();
    this.pruneTerms(new Set(Object.keys(this.svc.engine.state.devices)));
    return { ok: true, value: { devices: Object.keys(this.svc.engine.state.devices).length } };
  }

  /** Neuer Oberflächen-Zustand von der Hauptseite; ändert er sich, entsteht ein Undo-Schritt. */
  setExtras(e: Record<string, unknown>): void {
    this.undoMgr.run(() => {
      this.extras = e;
    });
  }

  /** Mehrere Geräte in einem Schritt verschieben. */
  moveMany(moves: Record<string, Point>): void {
    this.undoMgr.run(() => {
      for (const [id, p] of Object.entries(moves)) this.svc.moveDevice(id, p);
    });
  }

  /** Mehrere Geräte in einem Schritt löschen. */
  removeMany(ids: string[]): void {
    this.undoMgr.run(() => {
      for (const id of ids) this.svc.removeDevice(id);
    });
  }

  // ---------------------------------------------------------------- Kopieren/Einfügen

  paste(ids: string[], offset: Point): Result<PasteResult> {
    const r = this.undoMgr.run(() => cloneDevices(this.svc.engine, ids, offset));
    this.svc.touch();
    return r;
  }

  // ---------------------------------------------------------------- Undo/Redo

  undo(): boolean {
    return this.undoMgr.undo();
  }
  redo(): boolean {
    return this.undoMgr.redo();
  }
  get revision(): number {
    return this.undoMgr.revision;
  }

  /** Vor einer CLI-Eingabe: Zustand und running-config des Geräts merken. */
  cliBegin(id: string): { snap: string; rc: string } {
    return { snap: this.undoMgr.capture(), rc: this.rcOf(id) };
  }
  /** Nach der Eingabe: hat sich die Konfiguration geändert, entsteht ein Undo-Schritt. */
  cliEnd(id: string, pre: { snap: string; rc: string }): void {
    if (this.rcOf(id) !== pre.rc) this.undoMgr.commit(pre.snap);
  }
  private rcOf(id: string): string {
    const d = this.svc.engine.getDevice(id);
    if (!d || (d.config.kind !== 'router' && d.config.kind !== 'switch')) return '';
    return renderRunningConfig(
      this.svc.engine,
      d as Parameters<typeof renderRunningConfig>[1],
    ).join('\n');
  }
}
