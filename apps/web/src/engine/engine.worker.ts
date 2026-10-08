/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { CliSession, HostShell, Terminal, type Shell } from '@netsim/cli';
import { EngineService, type ViewModel } from '@netsim/engine';

type Subscriber = (v: ViewModel) => void;

interface TermEntry {
  term: Terminal;
  transcript: string;
}
const MAX_TRANSCRIPT = 60_000;

/** Fester Default-Seed ⇒ reproduzierbare Läufe (siehe docs/decisions.md). */
class WorkerService extends EngineService {
  private subscriber: Subscriber | undefined;
  private readonly terms = new Map<string, TermEntry>();

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
      return new HostShell(this.engine, id, () => this.inSimulationMode);
    if (d.config.kind === 'router' || d.config.kind === 'switch')
      return new CliSession(this.engine, id, () => this.inSimulationMode);
    return undefined;
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

  /** Verarbeitet Tastatureingaben; liefert die auszugebenden Terminal-Daten. */
  termData(id: string, data: string): string {
    const entry = this.terms.get(id);
    const dev = this.engine.getDevice(id);
    if (!entry || !dev?.powered) return '';
    const out = entry.term.handle(data);
    entry.transcript = (entry.transcript + out).slice(-MAX_TRANSCRIPT);
    this.touch();
    return out;
  }
}

export type WorkerApi = WorkerService;
Comlink.expose(new WorkerService());
