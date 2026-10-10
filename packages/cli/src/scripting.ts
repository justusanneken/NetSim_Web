import {
  CATALOG,
  Interp,
  Native,
  ScriptError,
  jsonOf,
  pickCable,
  toStr,
  type CableType,
  type Device,
  type Engine,
  type IpCore,
  type L3Cfg,
  type LogEntry,
  type Obj,
  type PortRef,
  type Value,
} from '@netsim/engine';
import { CliSession } from './session';
import { HostShell } from './hostshell';
import { ShellStack } from './shellstack';
import type { Shell } from './shell';
import { resolvePort } from './format';

/**
 * Netzwerk-Scripting-API (Spec §6): führt ein JavaScript-Programm im Sandbox-Interpreter aus
 * (`packages/engine/src/p5/script/interp.ts`: kein `eval`, keine Globals/DOM/Netzwerk, Schrittgrenze) und stellt
 * ihm `network`, `engine`, `onPacket`, `onLinkChange`, `log`/`print` bereit.
 *
 * Deterministisch: es gibt weder Uhr noch Zufall im Skript; alle Zeiten sind virtuelle Zeit (ms seit Skriptstart).
 */

export interface ScriptOptions {
  /** Interpreter-Schritte (CPU-Limit, deterministisch). */
  maxSteps?: number;
  /** Zusätzliches Wanduhr-Limit in ms (nur Abbruchschutz; Ergebnis bleibt bei Einhaltung deterministisch). */
  maxWallMs?: number;
  /** Engine-Ereignisse je Lauf. */
  maxEvents?: number;
  /** Gesamte simulierte Zeit je Lauf in ms. */
  maxSimMs?: number;
  /** Zeilen der Ausgabe. */
  maxOutputLines?: number;
  /** Wanduhr (injizierbar für Tests). */
  clock?: () => number;
  /** Wird nach Änderungen der Engine aufgerufen (UI-Aktualisierung). */
  onChange?: () => void;
}

export interface ScriptResult {
  ok: boolean;
  output: string[];
  error?: string;
  line?: number;
  steps: number;
  events: number;
  /** Simulierte Zeit des Laufs in ms. */
  simMs: number;
}

const DEFAULTS = {
  maxSteps: 3_000_000,
  maxWallMs: 8_000,
  maxEvents: 3_000_000,
  maxSimMs: 7_200_000,
  maxOutputLines: 2_000,
};

const MAX_LINE = 4_000;

const nat = (f: (a: Value[]) => Value): Native => new Native(f);
const obj = (): Obj => Object.create(null) as Obj;

/** Wertdarstellung für `log`/`print`. */
function show(v: Value): string {
  if (typeof v === 'string') return v;
  if (v !== null && typeof v === 'object' && !(v instanceof Native)) {
    return jsonOf(v, 0, { left: 200_000 }) ?? '';
  }
  return toStr(v, 200_000);
}

const fail = (msg: string): never => {
  throw new ScriptError(msg);
};

class Run {
  readonly out: string[] = [];
  events = 0;
  private readonly t0: number;
  private readonly wall0: number;
  private cursor: number;
  private dispatching = false;
  private readonly packetHandlers: Value[] = [];
  private readonly linkHandlers: Value[] = [];
  private readonly shells = new Map<string, Shell>();
  private readonly devObjs = new Map<string, Obj>();
  private it!: Interp;
  private autoX = 0;
  private readonly o: Required<Omit<ScriptOptions, 'onChange' | 'clock'>>;
  private readonly clock: () => number;

  constructor(
    private readonly e: Engine,
    private readonly opts: ScriptOptions,
  ) {
    this.o = { ...DEFAULTS, ...stripUndefined(opts) };
    this.clock = opts.clock ?? (() => Date.now());
    this.t0 = e.state.now;
    this.cursor = e.logLength;
    this.wall0 = this.clock();
  }

  get simMs(): number {
    return (this.e.state.now - this.t0) / 1000;
  }

  private emit(text: string): void {
    if (this.out.length >= this.o.maxOutputLines) {
      if (this.out.length === this.o.maxOutputLines) this.out.push('… (output truncated)');
      return;
    }
    this.out.push(text.length > MAX_LINE ? text.slice(0, MAX_LINE) + '…' : text);
  }

  // ------------------------------------------------------------ Engine-Antrieb

  private checkWall(): void {
    if (this.clock() - this.wall0 > this.o.maxWallMs) fail('time limit exceeded');
  }

  /** Genau ein Engine-Ereignis; Ereignis-Handler werden danach bedient. */
  private stepOnce(): boolean {
    if (++this.events > this.o.maxEvents) fail('event limit exceeded');
    if ((this.events & 1023) === 0) this.checkWall();
    const ev = this.e.step();
    this.pump();
    return ev !== undefined;
  }

  private advanceTo(untilUs: number): void {
    if (untilUs - this.t0 > this.o.maxSimMs * 1000) fail('simulation time limit exceeded');
    for (;;) {
      const next = this.e.peekNextTime();
      if (next === undefined || next > untilUs) break;
      this.stepOnce();
    }
    if (this.e.state.now < untilUs) this.e.state.now = untilUs;
    this.pump();
  }

  /** Neue Log-Einträge an `onPacket`/`onLinkChange`-Handler ausliefern. */
  pump(): void {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      for (let guard = 0; guard < 1000; guard++) {
        const batch = this.e.logSlice(this.cursor, 500);
        if (batch.length === 0) break;
        this.cursor = (batch[batch.length - 1] as LogEntry).id + 1;
        if (this.packetHandlers.length === 0 && this.linkHandlers.length === 0) continue;
        for (const l of batch) this.deliver(l);
      }
    } finally {
      this.dispatching = false;
    }
  }

  private deliver(l: LogEntry): void {
    if (l.proto === 'LINK' && (l.msg.key === 'link.up' || l.msg.key === 'link.down')) {
      const evt = obj();
      evt.t = (l.t - this.t0) / 1000;
      evt.device = l.atDeviceName;
      evt.port = l.portName ?? '';
      evt.up = l.msg.key === 'link.up';
      for (const h of this.linkHandlers.slice()) this.it.call(h, [evt]);
      return;
    }
    if ((l.kind === 'rx' || l.kind === 'drop') && l.proto !== 'LINK' && l.proto !== 'CSMA') {
      const evt = obj();
      evt.t = (l.t - this.t0) / 1000;
      evt.from = l.lastDeviceName ?? null;
      evt.at = l.atDeviceName;
      evt.port = l.portName ?? null;
      evt.proto = l.proto;
      evt.dropped = l.kind === 'drop';
      evt.summary = l.summary ?? '';
      const p = l.frame?.payload;
      if (p?.kind === 'ipv4') {
        evt.src = p.src;
        evt.dst = p.dst;
      } else if (p?.kind === 'ipv6') {
        evt.src = p.src;
        evt.dst = p.dst;
      } else if (p?.kind === 'arp') {
        evt.src = p.senderIp;
        evt.dst = p.targetIp;
      }
      for (const h of this.packetHandlers.slice()) this.it.call(h, [evt]);
    }
  }

  // ------------------------------------------------------------ Geräte

  private deviceByName(name: string): Device | undefined {
    return Object.values(this.e.state.devices).find((d) => d.name === name);
  }

  private deviceOf(v: Value, what: string): Device {
    let d: Device | undefined;
    if (typeof v === 'string') d = this.deviceByName(v);
    else if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Native)) {
      const id = (v as Obj).id;
      if (typeof id === 'string') d = this.e.getDevice(id);
    }
    if (!d) fail(`${what}: unknown device`);
    return d as Device;
  }

  private portOf(d: Device, v: Value): PortRef {
    const text = typeof v === 'number' ? String(v) : toStr(v);
    const lc = text.toLowerCase();
    const p =
      d.ports.find((x) => x.id === text) ??
      d.ports.find((x) => x.name.toLowerCase() === lc) ??
      resolvePort(d.ports, text) ??
      (/^\d+$/.test(text) ? d.ports[Number(text)] : undefined);
    if (!p) fail(`${d.name}: unknown port '${text}'`);
    return { deviceId: d.id, portId: (p as { id: string }).id };
  }

  private shellOf(d: Device): Shell {
    let sh = this.shells.get(d.id);
    if (sh) return sh;
    if (d.config.kind === 'host') {
      sh = new ShellStack(new HostShell(this.e, d.id, () => false));
      sh.start();
    } else if (d.config.kind === 'router' || d.config.kind === 'switch') {
      const cli = new CliSession(this.e, d.id, () => false);
      const stack = new ShellStack(cli);
      stack.start();
      // Setup-Dialog und Konsolen-Login beantworten (Skripte arbeiten wie bei der GUI-Konfiguration „direkt“)
      for (let i = 0; i < 4 && (cli as unknown as { pending?: unknown }).pending; i++) {
        if (stack.secret()) stack.input(cli.sys.lineCon.password ?? '');
        else stack.input('no');
      }
      // Skript-Sitzungen beginnen im privilegierten Modus (wie die GUI-Konfiguration „Equivalent IOS Commands“)
      cli.mode = 'priv';
      sh = stack;
    } else fail(`${d.name}: device type '${d.type}' has no command line`);
    this.shells.set(d.id, sh as Shell);
    return sh as Shell;
  }

  private deviceObj(d: Device): Obj {
    const cached = this.devObjs.get(d.id);
    if (cached) return cached;
    const o = obj();
    const id = d.id;
    const live = (): Device => this.e.getDevice(id) ?? fail(`device '${d.name}' no longer exists`);
    o.id = id;
    o.name = d.name;
    o.type = d.type;
    o.model = d.model;
    const cli = obj();
    cli.run = nat((a) => {
      const dev = live();
      const sh = this.shellOf(dev);
      const text = toStr(a[0], 100_000);
      const outs: string[] = [];
      for (const line of text.split('\n')) outs.push(sh.input(line.replace(/\r$/, '')));
      this.opts.onChange?.();
      this.pump();
      return outs.join('').replace(/\r?\n$/, '');
    });
    cli.prompt = nat(() => this.shellOf(live()).prompt());
    o.cli = cli;
    o.ping = nat((a) => this.ping(live(), a[0], a[1]));
    o.ip = nat(() => {
      const cfg = live().config;
      if (cfg.kind === 'host') return cfg.ip ?? null;
      const l3 = cfg as unknown as L3Cfg;
      for (const i of Object.values(l3.ifaces ?? {})) if (i.ip) return i.ip;
      return null;
    });
    o.setIp = nat((a) => {
      const r = this.e.setHostIp(
        id,
        toStr(a[0]),
        a[1] === undefined ? '255.255.255.0' : toStr(a[1]),
        a[2] === undefined ? undefined : toStr(a[2]),
      );
      this.pump();
      return r.ok ? true : fail(`setIp: ${r.error}`);
    });
    o.ports = nat(() =>
      live().ports.map((p) => {
        const x = obj();
        x.name = p.name;
        x.id = p.id;
        x.up = p.operUp;
        x.admin = p.adminUp;
        x.connected = p.linkId !== undefined;
        return x;
      }),
    );
    o.routes = nat(() =>
      this.e.routingTable(id).map((r) => {
        const x = obj();
        x.type = r.type + (r.sub ? ` ${r.sub}` : '');
        x.prefix = r.prefix;
        x.plen = r.plen;
        x.ad = r.ad;
        x.metric = r.metric;
        x.nextHop = r.nextHop ?? null;
        return x;
      }),
    );
    o.setPower = nat((a) => {
      this.e.setPower(id, !!a[0]);
      this.pump();
      return undefined;
    });
    this.devObjs.set(id, o);
    return o;
  }

  private ping(d: Device, dst: Value, count: Value): Value {
    const target = toStr(dst);
    const n = count === undefined ? 1 : Math.max(1, Math.min(100, Number(count) || 1));
    const res = obj();
    const r = this.e.ping(d.id, target, { count: n });
    if (!r.ok) {
      res.ok = false;
      res.error = r.error;
      res.sent = 0;
      res.received = 0;
      res.lost = 0;
      res.rttMs = null;
      return res;
    }
    const cfg = d.config as unknown as IpCore;
    const mine = (): typeof cfg.pings => cfg.pings.filter((p) => p.id === r.value);
    for (;;) {
      const m = mine();
      if (m.length >= n && m.every((p) => p.status !== 'pending')) break;
      if (!this.stepOnce()) break;
    }
    const m = mine();
    const ok = m.filter((p) => p.status === 'reply');
    res.ok = ok.length > 0;
    res.sent = m.length;
    res.received = ok.length;
    res.lost = m.length - ok.length;
    const rtts = ok.map((p) => (p.rttUs ?? 0) / 1000);
    res.rttMs = rtts.length
      ? Math.round((rtts.reduce((a, b) => a + b, 0) / rtts.length) * 1000) / 1000
      : null;
    const last = m[m.length - 1];
    res.status = last?.status ?? 'timeout';
    res.from = last?.from ?? null;
    this.opts.onChange?.();
    return res;
  }

  // ------------------------------------------------------------ API-Objekte

  private networkApi(): Obj {
    const n = obj();
    n.addDevice = nat((a) => {
      const type = toStr(a[0]);
      if (!(type in CATALOG)) fail(`addDevice: unknown device type '${type}'`);
      const name = a[1] === undefined || a[1] === null ? undefined : toStr(a[1]);
      if (name !== undefined && this.deviceByName(name))
        fail(`addDevice: name '${name}' already in use`);
      const x = typeof a[2] === 'number' ? a[2] : (this.autoX += 140);
      const y = typeof a[3] === 'number' ? a[3] : 120;
      const id = this.e.addDevice(type as keyof typeof CATALOG, { name, pos: { x, y } });
      this.opts.onChange?.();
      this.pump();
      return this.deviceObj(this.e.getDevice(id) as Device);
    });
    n.connect = nat((a) => {
      const da = this.deviceOf(a[0], 'connect');
      const pa = this.portOf(da, a[1]);
      const db = this.deviceOf(a[2], 'connect');
      const pb = this.portOf(db, a[3]);
      let cable: CableType;
      if (a[4] === undefined || a[4] === null || a[4] === 'auto') {
        cable = pickCable(
          da,
          da.ports.find((p) => p.id === pa.portId) as never,
          db,
          db.ports.find((p) => p.id === pb.portId) as never,
        );
      } else cable = toStr(a[4]) as CableType;
      const r = this.e.connect(pa, pb, cable);
      this.opts.onChange?.();
      this.pump();
      const res = obj();
      res.ok = r.ok;
      if (r.ok) res.id = r.value.id;
      else {
        res.error = r.error;
        res.id = null;
      }
      return res;
    });
    n.getDevice = nat((a) => {
      const d = this.deviceByName(toStr(a[0]));
      return d ? this.deviceObj(d) : null;
    });
    n.devices = nat(() => Object.values(this.e.state.devices).map((d) => this.deviceObj(d)));
    n.links = nat(() =>
      Object.values(this.e.state.links).map((l) => {
        const x = obj();
        const end = (r: PortRef): string => {
          const d = this.e.getDevice(r.deviceId);
          return `${d?.name ?? '?'}:${d?.ports.find((p) => p.id === r.portId)?.name ?? r.portId}`;
        };
        x.a = end(l.a);
        x.b = end(l.b);
        x.cable = l.cable;
        x.up = l.operUp;
        return x;
      }),
    );
    n.removeDevice = nat((a) => {
      const d = this.deviceOf(a[0], 'removeDevice');
      this.e.removeDevice(d.id);
      this.devObjs.delete(d.id);
      this.shells.delete(d.id);
      this.opts.onChange?.();
      this.pump();
      return undefined;
    });
    return n;
  }

  private engineApi(): Obj {
    const g = obj();
    g.step = nat(() => this.stepOnce());
    g.now = nat(() => this.simMs);
    g.runFor = nat((a) => {
      const ms = Number(a[0]);
      if (!(ms >= 0)) fail('runFor: milliseconds must be >= 0');
      this.advanceTo(this.e.state.now + Math.round(ms * 1000));
      this.opts.onChange?.();
      return this.simMs;
    });
    g.runUntil = nat((a) => {
      const cond = a[0];
      const maxMs = a[1] === undefined ? 60_000 : Number(a[1]);
      if (!(maxMs >= 0)) fail('runUntil: maxMs must be >= 0');
      const end = this.e.state.now + Math.round(maxMs * 1000);
      if (end - this.t0 > this.o.maxSimMs * 1000) fail('simulation time limit exceeded');
      const truthy = (): boolean => {
        const v = this.it.call(cond, []);
        return !(v === undefined || v === null || v === false || v === 0 || v === '');
      };
      for (;;) {
        if (truthy()) return true;
        const next = this.e.peekNextTime();
        if (next === undefined || next > end) {
          this.e.state.now = Math.max(this.e.state.now, end);
          this.pump();
          return truthy();
        }
        this.stepOnce();
      }
    });
    return g;
  }

  // ------------------------------------------------------------ Ausführung

  run(code: string): ScriptResult {
    const host: Record<string, Value> = {
      network: this.networkApi(),
      engine: this.engineApi(),
      log: nat((a) => {
        this.emit(a.map(show).join(' '));
        return undefined;
      }),
      onPacket: nat((a) => {
        this.packetHandlers.push(a[0]);
        return undefined;
      }),
      onLinkChange: nat((a) => {
        this.linkHandlers.push(a[0]);
        return undefined;
      }),
    };
    host.print = host.log;
    let error: string | undefined;
    let line: number | undefined;
    try {
      this.it = new Interp(code, host, {
        maxSteps: this.o.maxSteps,
        maxString: 200_000,
        maxDepth: 60,
        check: () => this.checkWall(),
      });
      this.it.parse();
      this.it.runTop();
      this.pump();
    } catch (e) {
      if (e instanceof ScriptError) {
        error = e.message;
        line = e.line || undefined;
      } else if (e instanceof RangeError) error = 'stack overflow';
      else error = e instanceof Error ? e.message : 'error';
    }
    this.opts.onChange?.();
    return {
      ok: error === undefined,
      output: this.out,
      error,
      line,
      steps: this.it?.steps ?? 0,
      events: this.events,
      simMs: this.simMs,
    };
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Skript ausführen. Der Aufrufer sorgt dafür, dass die Engine währenddessen nicht anderweitig fortschreitet. */
export function runScript(engine: Engine, code: string, opts: ScriptOptions = {}): ScriptResult {
  return new Run(engine, opts).run(code);
}
