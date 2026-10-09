import type { DeviceCtx } from '../../ctx';
import type { IotScript } from '../../p5types';
import type { Device, HostConfig } from '../../types';
import { iotValue } from '../iot';
import { ipNodeOf } from '../node';
import { udpRequest } from '../udputil';
import { exportVars, importVars, Interp, Native, ScriptError, toStr, type Value } from './interp';

/** Programm eines IoT-/SBC-Geräts: Zustand liegt als JSON in `IotCfg.script`, Ausführung auf virtuellen Timern. */

const MAX_OUT = 200;
const MIN_EVERY_MS = 100;
const MAX_STEPS = 100_000;
const TIMER = 'bg:svc:script:';

export const newScript = (code = ''): IotScript => ({ code, running: false, vars: {}, out: [] });

const hostOf = (d: Device): HostConfig | undefined =>
  d.config.kind === 'host' ? d.config : undefined;

interface Handler {
  kind: 'every' | 'report';
  ms: number;
  fn: Value;
}

function emit(script: IotScript, now: number, text: string): void {
  const t = (now / 1_000_000).toFixed(1);
  script.out.push(`[${t}s] ${text}`);
  if (script.out.length > MAX_OUT) script.out.splice(0, script.out.length - MAX_OUT);
}

/**
 * Programm einmal auswerten. `live`: Seiteneffekte der Host-API (log, setActuator) sind aktiv – nur beim Start
 * und beim Aufruf eines Handlers; der Hauptteil wird bei jeder Aktivierung still neu ausgewertet, damit keine
 * Funktionswerte gespeichert werden müssen (gespeichert werden nur die JSON-fähigen Variablen).
 */
function evaluate(
  ctx: DeviceCtx,
  dev: Device,
  script: IotScript,
  live: boolean,
): { it: Interp; handlers: Handler[]; setLive(v: boolean): void } {
  const h = hostOf(dev);
  const handlers: Handler[] = [];
  let on = live;
  const nat = (f: (a: Value[]) => Value): Native => new Native(f);
  const api: Record<string, Value> = {
    log: nat((a) => {
      if (on) emit(script, ctx.now, a.map((x) => toStr(x, 20_000)).join(' '));
      return undefined;
    }),
    readSensor: nat((a) => {
      const name = toStr(a[0]);
      const iot = h?.iot;
      if (iot && (name === 'self' || (iot.sensor !== '' && name === iot.sensor)))
        return iotValue(iot, ctx.now);
      const reg = h?.services.iot?.devices[name];
      return reg?.value ?? null;
    }),
    setActuator: nat((a) => {
      if (!on) return undefined;
      const name = toStr(a[0]);
      const state = a[1] ? 'on' : 'off';
      const iot = h?.iot;
      if (iot && (name === 'self' || name === dev.name)) {
        iot.state = state;
        return true;
      }
      const reg = h?.services.iot?.devices[name];
      const node = ipNodeOf(ctx, dev);
      if (reg && node) {
        reg.state = state;
        udpRequest(ctx, node, { dst: reg.ip, proto: 'iot', op: 'set', args: { state } });
        return true;
      }
      return false;
    }),
    every: nat((a) => {
      handlers.push({ kind: 'every', ms: Math.max(MIN_EVERY_MS, Number(a[0]) || 0), fn: a[1] });
      return undefined;
    }),
    onReport: nat((a) => {
      handlers.push({ kind: 'report', ms: 0, fn: a[0] });
      return undefined;
    }),
  };
  const it = new Interp(script.code, api, { maxSteps: MAX_STEPS });
  it.parse();
  return {
    it,
    handlers,
    setLive(v) {
      on = v;
    },
  };
}

function crash(ctx: DeviceCtx, dev: Device, script: IotScript, e: unknown): void {
  const msg =
    e instanceof ScriptError
      ? `${e.message}${e.line ? ` (line ${e.line})` : ''}`
      : e instanceof Error
        ? e.message
        : 'error';
  script.running = false;
  script.error = msg;
  emit(script, ctx.now, `ERROR: ${msg}`);
  disarm(ctx, script);
  dev.crashed = { message: `script: ${msg}`, t: ctx.now };
  ctx.log({
    kind: 'error',
    proto: 'IOT',
    status: 'error',
    msg: { key: 'iot.script.error', params: { error: msg } },
  });
}

function disarm(ctx: DeviceCtx, script: IotScript): void {
  for (let i = 0; i < 16; i++) ctx.cancelTimer(`${TIMER}${i}`);
  void script;
}

/** Timer der `every`-Handler setzen. */
function arm(ctx: DeviceCtx, handlers: Handler[]): void {
  handlers.forEach((hd, i) => {
    if (hd.kind === 'every' && i < 16) ctx.setTimer(`${TIMER}${i}`, hd.ms * 1000, hd.ms * 1000);
  });
}

/** Programm starten (Hauptteil mit aktiven Seiteneffekten, Timer für `every` anlegen). */
export function scriptStart(ctx: DeviceCtx, dev: Device): string | undefined {
  const script = hostOf(dev)?.iot?.script;
  if (!script) return 'iot.notIot';
  delete dev.crashed;
  disarm(ctx, script);
  script.running = true;
  script.error = undefined;
  script.vars = {};
  script.startedAt = ctx.now;
  emit(script, ctx.now, 'program started');
  try {
    const ev = evaluate(ctx, dev, script, true);
    ev.it.runTop();
    script.vars = exportVars(ev.it);
    arm(ctx, ev.handlers);
  } catch (e) {
    crash(ctx, dev, script, e);
  }
  return undefined;
}

export function scriptStop(ctx: DeviceCtx, dev: Device): void {
  const script = hostOf(dev)?.iot?.script;
  if (!script) return;
  disarm(ctx, script);
  if (script.running) emit(script, ctx.now, 'program stopped');
  script.running = false;
}

/** Nach Einschalten/Wiederherstellen: Timer eines laufenden Programms neu setzen (Hauptteil still auswerten). */
export function scriptResume(ctx: DeviceCtx, dev: Device): void {
  const script = hostOf(dev)?.iot?.script;
  if (!script?.running) return;
  try {
    arm(ctx, evaluate(ctx, dev, script, false).handlers);
  } catch (e) {
    crash(ctx, dev, script, e);
  }
}

function activate(
  ctx: DeviceCtx,
  dev: Device,
  pick: (hd: Handler, i: number) => Value[] | undefined,
): void {
  const script = hostOf(dev)?.iot?.script;
  if (!script?.running) return;
  try {
    const ev = evaluate(ctx, dev, script, false);
    ev.it.runTop(); // still: stellt Funktionen und Handler wieder her
    importVars(ev.it, script.vars);
    ev.setLive(true);
    ev.it.resetBudget();
    ev.handlers.forEach((hd, i) => {
      const args = pick(hd, i);
      if (args) ev.it.call(hd.fn, args);
    });
    script.vars = exportVars(ev.it);
  } catch (e) {
    crash(ctx, dev, script, e);
  }
}

/** Timer `script:<n>` (Handler Nr. n aus `every`). */
export function scriptTimer(ctx: DeviceCtx, dev: Device, name: string): void {
  const n = Number(name.slice('script:'.length));
  activate(ctx, dev, (hd, i) => (hd.kind === 'every' && i === n ? [] : undefined));
}

/** Messwertbericht (eigener Bericht eines Sensors oder eingegangener Bericht am IoT-Server). */
export function scriptReport(ctx: DeviceCtx, dev: Device, name: string, value: number): void {
  if (!hostOf(dev)?.iot?.script?.running) return;
  activate(ctx, dev, (hd) => (hd.kind === 'report' ? [name, value] : undefined));
}
