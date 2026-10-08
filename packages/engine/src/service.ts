import type { Engine } from './engine';
import { SimController } from './controller';
import type { PingOptions } from './devices/host';
import type { CableType, EngineConfig, LogEntry, Point, PortRef, Result } from './types';
import type { DeviceType } from './types';
import type { SimMode, ViewModel } from './view';

/**
 * Typisiertes Nachrichtenprotokoll zwischen UI und Engine-Worker (via Comlink).
 * Alle Parameter/Rückgaben sind strukturell klonbar.
 */
export class EngineService {
  private readonly ctl: SimController;

  constructor(seed = 1, config?: Partial<EngineConfig>) {
    this.ctl = new SimController({ seed, config });
  }

  /** Für Tests und Skripting. */
  get engine(): Engine {
    return this.ctl.engine;
  }

  /** `true` im Simulationsmodus: Befehle sollen nicht im Vorlauf bis zum Ende simulieren. */
  get inSimulationMode(): boolean {
    return this.ctl.mode === 'simulation';
  }

  tick(wallMs: number): void {
    this.ctl.tick(wallMs);
  }
  consumeDirty(): boolean {
    return this.ctl.consumeDirty();
  }
  getView(): ViewModel {
    return this.ctl.view();
  }
  getLog(from: number, limit = 5000): LogEntry[] {
    return this.ctl.engine.log.slice(from, from + limit);
  }

  addDevice(type: DeviceType, pos: Point): string {
    const id = this.ctl.engine.addDevice(type, { pos });
    this.ctl.markDirty();
    return id;
  }
  removeDevice(id: string): void {
    this.ctl.engine.removeDevice(id);
    this.ctl.markDirty();
  }
  renameDevice(id: string, name: string): void {
    this.ctl.engine.renameDevice(id, name);
    this.ctl.markDirty();
  }
  moveDevice(id: string, pos: Point): void {
    this.ctl.engine.moveDevice(id, pos);
    this.ctl.markDirty();
  }
  connect(a: PortRef, b: PortRef, cable: CableType): Result<string> {
    const r = this.ctl.engine.connect(a, b, cable);
    this.ctl.markDirty();
    return r.ok ? { ok: true, value: r.value.id } : r;
  }
  connectAuto(a: string, b: string): Result<string> {
    const r = this.ctl.engine.connectAuto(a, b);
    this.ctl.markDirty();
    return r.ok ? { ok: true, value: r.value.id } : r;
  }
  disconnect(linkId: string): void {
    this.ctl.engine.disconnect(linkId);
    this.ctl.markDirty();
  }
  setPower(id: string, on: boolean): void {
    this.ctl.engine.setPower(id, on);
    this.ctl.markDirty();
  }
  setPortAdmin(deviceId: string, portId: string, up: boolean): void {
    this.ctl.engine.setPortAdmin(deviceId, portId, up);
    this.ctl.markDirty();
  }
  setHostIp(id: string, ip: string, mask: string, gateway?: string): Result<true> {
    const r = this.ctl.engine.setHostIp(id, ip, mask, gateway);
    this.ctl.markDirty();
    return r;
  }
  /** Markiert den Zustand als geändert (z. B. nach CLI-Befehlen im Worker). */
  touch(): void {
    this.ctl.markDirty();
  }
  setInterfaceIp(id: string, portId: string, ip: string, mask: string): Result<true> {
    const r = this.ctl.engine.setInterfaceIp(id, portId, ip, mask);
    this.ctl.markDirty();
    return r;
  }
  addStaticRoute(
    id: string,
    r: { prefix: string; mask: string; nextHop?: string; outPortId?: string; ad?: number },
  ): Result<true> {
    const res = this.ctl.engine.addStaticRoute(id, r);
    this.ctl.markDirty();
    return res;
  }
  removeStaticRoute(
    id: string,
    r: { prefix: string; mask: string; nextHop?: string; outPortId?: string },
  ): Result<true> {
    const res = this.ctl.engine.removeStaticRoute(id, r);
    this.ctl.markDirty();
    return res;
  }
  setPortMtu(id: string, portId: string, mtu: number): Result<true> {
    const r = this.ctl.engine.setPortMtu(id, portId, mtu);
    this.ctl.markDirty();
    return r;
  }
  trace(id: string, dst: string): Result<number> {
    const r = this.ctl.engine.trace(id, dst);
    this.ctl.markDirty();
    return r;
  }
  ping(id: string, dst: string, opts?: PingOptions): Result<number> {
    const r = this.ctl.engine.ping(id, dst, opts);
    this.ctl.markDirty();
    return r;
  }

  setMode(mode: SimMode): void {
    this.ctl.setMode(mode);
  }
  setSpeed(f: number): void {
    this.ctl.setSpeed(f);
  }
  play(): void {
    this.ctl.play();
  }
  pause(): void {
    this.ctl.pause();
  }
  step(): boolean {
    return this.ctl.step();
  }
  stepBack(): boolean {
    return this.ctl.stepBack();
  }
  reset(): void {
    this.ctl.reset();
  }
  clear(): void {
    this.ctl.clear();
  }
}
