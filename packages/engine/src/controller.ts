import { Engine, type EngineOptions } from './engine';
import type { EngineSnapshot, LogEntry } from './types';
import { buildDevices, buildLinks, type SimMode, type ViewModel } from './view';

const MAX_HISTORY = 200;
const MIN_SPEED = 0.1;
const MAX_SPEED = 20;

/**
 * Zeitsteuerung: realtime (virtuelle Uhr an Wanduhr gekoppelt), simulation (manuell /
 * Auto-Capture) und paused. Reine Logik ohne Timer – der Aufrufer ruft `tick(wallMs)`.
 */
export class SimController {
  engine: Engine;
  mode: SimMode = 'realtime';
  speed = 1;
  autoCapture = false;
  /** Wartezeit zwischen zwei Auto-Capture-Schritten (Wandzeit, ms). */
  autoDelayMs = 400;
  private lastActive: 'realtime' | 'simulation' = 'realtime';
  private acc = 0;
  private history: EngineSnapshot[] = [];
  private dirty = true;
  /** Wird erhöht, wenn das Log nicht nur wächst (Step Back, Reset, Neu). */
  private epoch = 0;

  constructor(private readonly opts: EngineOptions = {}) {
    this.engine = new Engine(opts);
  }

  markDirty(): void {
    this.dirty = true;
  }

  consumeDirty(): boolean {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }

  setMode(mode: SimMode): void {
    if (mode !== 'paused') this.lastActive = mode;
    this.mode = mode;
    this.autoCapture = false;
    this.acc = 0;
    this.markDirty();
  }

  setSpeed(factor: number): void {
    this.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, factor));
    this.markDirty();
  }

  play(): void {
    if (this.mode === 'paused') this.mode = this.lastActive;
    if (this.mode === 'simulation') this.autoCapture = true;
    this.markDirty();
  }

  pause(): void {
    if (this.mode === 'realtime') {
      this.lastActive = 'realtime';
      this.mode = 'paused';
    }
    this.autoCapture = false;
    this.markDirty();
  }

  /** Vorwärts bis zum nächsten sichtbaren Ereignis (Log-Eintrag). */
  step(): boolean {
    const e = this.engine;
    const before = e.logLength;
    const snap = e.snapshot();
    let processed = 0;
    while (e.logLength === before && e.queueLength > 0 && processed < 10_000) {
      e.step();
      processed++;
    }
    if (processed === 0) return false;
    this.history.push(snap);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.markDirty();
    return true;
  }

  stepBack(): boolean {
    const snap = this.history.pop();
    if (!snap) return false;
    this.engine.restore(snap);
    this.epoch++;
    this.autoCapture = false;
    this.markDirty();
    return true;
  }

  reset(): void {
    this.engine.resetRuntime();
    this.epoch++;
    this.history = [];
    this.autoCapture = false;
    this.acc = 0;
    this.markDirty();
  }

  /** Skriptlauf (Sandbox-Worker) übernehmen; der Verlauf für „Schritt zurück“ wird verworfen. */
  adoptRun(state: EngineSnapshot['state'], entries: LogEntry[]): void {
    this.engine.adoptRun(state, entries);
    this.history = [];
    this.markDirty();
  }

  /** Verwirft die gesamte Topologie und startet mit einem leeren Netz. */
  clear(): void {
    this.engine = new Engine(this.opts);
    this.epoch++;
    this.history = [];
    this.autoCapture = false;
    this.acc = 0;
    this.markDirty();
  }

  /** Vorwärtstakt aus der Wanduhr. */
  tick(wallMs: number): void {
    if (this.mode === 'realtime') {
      const e = this.engine;
      if (e.queueLength > 0 || wallMs > 0) {
        const target = e.state.now + wallMs * 1000 * this.speed;
        const n = e.runUntil(target, 20_000);
        if (n > 0 || e.queueLength > 0) this.markDirty();
        else e.state.now = target;
      }
      this.markDirty();
    } else if (this.mode === 'simulation' && this.autoCapture) {
      this.acc += wallMs;
      let guard = 0;
      while (this.acc >= this.autoDelayMs && guard++ < 50) {
        this.acc -= this.autoDelayMs;
        if (!this.step()) {
          this.autoCapture = false;
          this.markDirty();
          break;
        }
      }
    }
  }

  view(): ViewModel {
    const e = this.engine;
    return {
      now: e.state.now,
      mode: this.mode,
      speed: this.speed,
      autoCapture: this.autoCapture,
      devices: buildDevices(e),
      links: buildLinks(e),
      logLength: e.logLength,
      logStart: e.logOffset,
      logEpoch: this.epoch,
      queueLength: e.queueLength,
      canStepBack: this.history.length > 0,
      domains: e.collisionDomains(),
      physical: structuredClone(e.state.physical),
    };
  }
}
