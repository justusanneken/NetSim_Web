/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import {
  CliSession,
  HostShell,
  ShellStack,
  Terminal,
  renderRunningConfig,
  type Shell,
} from '@netsim/cli';
import { EngineService5, type ViewModel } from '@netsim/engine';
import { Persistence } from './persistGlue';
import type { UndoInfo } from './undo';

type Subscriber = (v: ViewModel) => void;

interface TermEntry {
  term: Terminal;
  transcript: string;
}
const MAX_TRANSCRIPT = 60_000;

/** Fester Default-Seed ⇒ reproduzierbare Läufe (siehe docs/decisions.md). */
class WorkerService extends EngineService5 {
  private subscriber: Subscriber | undefined;
  private readonly terms = new Map<string, TermEntry>();
  /** Persistenz: .nsim, Vorlagen, Copy/Paste, Undo/Redo (umhüllt alle ändernden Methoden). */
  private readonly persist = new Persistence(this, (alive) => {
    for (const k of [...this.terms.keys()]) if (!alive.has(k)) this.terms.delete(k);
  });

  constructor() {
    super(1);
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      this.tick(now - last);
      last = now;
      if (this.consumeDirty()) this.subscriber?.(this.getView());
    }, 33);
  }

  subscribe(cb: Subscriber): void {
    this.subscriber = cb;
    cb(this.getView());
  }

  override removeDevice(id: string): void {
    this.terms.delete(id);
    super.removeDevice(id);
  }

  override clear(): void {
    this.terms.clear();
    super.clear();
  }

  private shellFor(id: string): Shell | undefined {
    const d = this.engine.getDevice(id);
    if (!d) return undefined;
    if (d.config.kind === 'host')
      return new ShellStack(new HostShell(this.engine, id, () => this.inSimulationMode));
    if (d.config.kind === 'router' || d.config.kind === 'switch')
      return new ShellStack(new CliSession(this.engine, id, () => this.inSimulationMode));
    return undefined;
  }

  /**
   * Führt IOS-Konfigurationszeilen im globalen Konfigurationsmodus aus (GUI → „Equivalent IOS Commands“) und
   * liefert die Ausgabe (Fehlermeldungen, falls ein Befehl abgelehnt wurde).
   */
  cliExec(id: string, lines: string[]): string {
    const d = this.engine.getDevice(id);
    if (!d || (d.config.kind !== 'router' && d.config.kind !== 'switch')) return '';
    const s = new CliSession(this.engine, id, () => false);
    s.silent = false;
    s.mode = 'config';
    (s as unknown as { started: boolean }).started = true;
    let out = '';
    for (const l of lines) {
      if (!l.startsWith(' ') && !/^(exit|end)$/.test(l)) s.mode = 'config';
      out += s.input(l.trim());
    }
    this.touch();
    return out;
  }

  /** running-config als Text (für „Equivalent IOS Commands“ der GUI); leer bei Geräten ohne IOS. */
  runningConfig(id: string): string {
    const d = this.engine.getDevice(id);
    if (!d || (d.config.kind !== 'router' && d.config.kind !== 'switch')) return '';
    return renderRunningConfig(this.engine, d as Parameters<typeof renderRunningConfig>[1]).join(
      '\n',
    );
  }

  /** Öffnet (oder verbindet erneut mit) dem Terminal des Geräts; liefert Terminal-Daten. */
  termOpen(id: string): string | undefined {
    let entry = this.terms.get(id);
    if (!entry) {
      const shell = this.shellFor(id);
      if (!shell) return undefined;
      const term = new Terminal(shell);
      entry = { term, transcript: term.start() };
      this.terms.set(id, entry);
      return entry.transcript;
    }
    return '\x1bc' + entry.transcript + entry.term.redraw();
  }

  /** Asynchrone Terminalausgaben (z. B. `debug`-Meldungen) seit dem letzten Abruf. */
  termPoll(id: string): string {
    const entry = this.terms.get(id);
    const dev = this.engine.getDevice(id);
    if (!entry || !dev?.powered) return '';
    const out = entry.term.poll();
    if (out) entry.transcript = (entry.transcript + out).slice(-MAX_TRANSCRIPT);
    return out;
  }

  /** Verarbeitet Tastatureingaben; liefert die auszugebenden Terminal-Daten. */
  termData(id: string, data: string): string {
    const entry = this.terms.get(id);
    const dev = this.engine.getDevice(id);
    if (!entry || !dev?.powered) return '';
    const enter = /[\r\n]/.test(data);
    const pre = enter ? this.persist.cliBegin(id) : undefined;
    const out = entry.term.handle(data);
    if (pre) this.persist.cliEnd(id, pre);
    entry.transcript = (entry.transcript + out).slice(-MAX_TRANSCRIPT);
    this.touch();
    return out;
  }

  // ---- Persistenz (Datei, Vorlagen, Einfügen, Undo/Redo)
  saveNsim(extras?: Record<string, unknown>): Uint8Array {
    return this.persist.save(extras);
  }
  openNsim(bytes: Uint8Array) {
    const r = this.persist.open(bytes);
    this.touch();
    return r;
  }
  newTopology(): void {
    this.persist.newTopology();
    this.touch();
  }
  listTemplates() {
    return this.persist.listTemplates();
  }
  loadTemplate(id: string) {
    const r = this.persist.loadTemplate(id);
    this.touch();
    return r;
  }
  pasteDevices(ids: string[], dx: number, dy: number) {
    return this.persist.paste(ids, { x: dx, y: dy });
  }
  undo(): { ok: boolean; extras: Record<string, unknown> } {
    const ok = this.persist.undo();
    this.touch();
    return { ok, extras: this.persist.extras };
  }
  redo(): { ok: boolean; extras: Record<string, unknown> } {
    const ok = this.persist.redo();
    this.touch();
    return { ok, extras: this.persist.extras };
  }
  setExtras(e: Record<string, unknown>): void {
    this.persist.setExtras(e);
  }
  moveMany(moves: Record<string, { x: number; y: number }>): void {
    this.persist.moveMany(moves);
    this.touch();
  }
  removeMany(ids: string[]): void {
    this.persist.removeMany(ids);
    this.touch();
  }
  subscribeUndo(cb: (i: UndoInfo) => void): void {
    this.persist.onUndoInfo(cb);
  }
  /** Zähler der Entwurfsänderungen (Autosave speichert nur bei Änderung). */
  revision(): number {
    return this.persist.revision;
  }
  fileName(): string {
    return this.persist.name;
  }
  setFileName(name: string): void {
    this.persist.name = name;
  }
}

export type WorkerApi = WorkerService;
Comlink.expose(new WorkerService());
