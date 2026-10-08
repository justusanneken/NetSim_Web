/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { EngineService, type ViewModel } from '@netsim/engine';

type Subscriber = (v: ViewModel) => void;

/** Fester Default-Seed ⇒ reproduzierbare Läufe (siehe docs/decisions.md). */
class WorkerService extends EngineService {
  private subscriber: Subscriber | undefined;

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
}

export type WorkerApi = WorkerService;
Comlink.expose(new WorkerService());
