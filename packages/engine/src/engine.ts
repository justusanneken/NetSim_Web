import {
  isValidIpv4,
  macFromCounter,
  maskToPrefix,
  pduSize,
  sameSubnet,
  type Frame,
} from '@netsim/protocols';
import { pickCable, validateCable } from './cabling';
import { CATALOG, PORT_MAX_SPEED } from './catalog';
import type { DeviceCtx, LogInput } from './ctx';
import {
  announce,
  hostRx,
  hostTimer,
  resetHostRuntime,
  startPing,
  type PingOptions,
} from './devices/host';
import { hubRx } from './devices/hub';
import { activeMacTable, switchPortDown, switchRx } from './devices/switch';
import { heapPop, heapPush, heapRemove } from './heap';
import { mulberry32 } from './rng';
import type {
  CableType,
  CollisionPayload,
  Device,
  DeviceType,
  EngineConfig,
  EngineSnapshot,
  EngineState,
  Link,
  LogEntry,
  Point,
  Port,
  PortRef,
  Result,
  RxPayload,
  SimEvent,
  TimerPayload,
  Transmission,
  TxPayload,
} from './types';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewEvent = DistributiveOmit<SimEvent, 'seq'>;

export const DEFAULT_CONFIG: EngineConfig = {
  propagationUs: 5,
  processingUs: 50,
  maxCopperLengthM: 100,
};

export interface EngineOptions {
  seed?: number;
  config?: Partial<EngineConfig>;
}

const MAX_RETRIES = 16;
const TX_HISTORY_US = 2_000_000;

export class Engine {
  state: EngineState;
  /** Event-Log (außerhalb des Zustands, damit Snapshots klein bleiben). */
  log: LogEntry[] = [];

  constructor(opts: EngineOptions = {}) {
    const seed = opts.seed ?? 1;
    this.state = {
      version: 1,
      seed,
      rng: seed | 0,
      now: 0,
      seq: 0,
      nextTxId: 1,
      nextId: 1,
      macCounter: 0,
      nameCounters: {},
      config: { ...DEFAULT_CONFIG, ...opts.config },
      devices: {},
      links: {},
      queue: [],
      transmissions: [],
    };
  }

  // ------------------------------------------------------------ Snapshot

  snapshot(): EngineSnapshot {
    return { state: structuredClone(this.state), logLength: this.log.length };
  }

  restore(snap: EngineSnapshot): void {
    this.state = structuredClone(snap.state);
    this.log.length = Math.min(this.log.length, snap.logLength);
  }

  /** Setzt Zeit, Queue, Log und Laufzeitzustand zurück; Topologie und Konfiguration bleiben. */
  resetRuntime(): void {
    const s = this.state;
    s.now = 0;
    s.seq = 0;
    s.rng = s.seed | 0;
    s.nextTxId = 1;
    s.queue = [];
    s.transmissions = [];
    for (const link of Object.values(s.links)) {
      link.busyFrom = 0;
      link.busyUntil = 0;
      link.lastActivityT = -1;
    }
    for (const dev of Object.values(s.devices)) {
      delete dev.crashed;
      const cfg = dev.config;
      if (cfg.kind === 'host') {
        resetHostRuntime(cfg);
        cfg.pings = [];
        cfg.nextPingId = 1;
        cfg.nextIpId = 1;
      } else if (cfg.kind === 'switch') cfg.macTable = {};
      else if (cfg.kind === 'hub') cfg.busyUntil = 0;
      for (const p of dev.ports) {
        p.txBusyUntil = 0;
        p.counters = {
          inPkts: 0,
          outPkts: 0,
          inBytes: 0,
          outBytes: 0,
          inErrors: 0,
          outErrors: 0,
          collisions: 0,
        };
      }
    }
    this.log.length = 0;
  }

  // ------------------------------------------------------------ Topologie

  addDevice(type: DeviceType, opts: { name?: string; pos?: Point } = {}): string {
    const spec = CATALOG[type];
    if (!spec) throw new Error(`Device type not supported yet: ${type}`);
    const s = this.state;
    const id = `d${s.nextId++}`;
    const n = s.nameCounters[spec.namePrefix] ?? 0;
    s.nameCounters[spec.namePrefix] = n + 1;
    const name = opts.name ?? `${spec.namePrefix}${n}`;
    const ports: Port[] = spec.ports.map((ps, i) => ({
      id: `p${i}`,
      name: ps.name,
      kind: ps.kind,
      mac: macFromCounter(++s.macCounter),
      adminUp: true,
      operUp: false,
      speed: 'auto',
      duplex: type === 'hub' ? 'half' : 'auto',
      counters: {
        inPkts: 0,
        outPkts: 0,
        inBytes: 0,
        outBytes: 0,
        inErrors: 0,
        outErrors: 0,
        collisions: 0,
      },
      operSpeed: 0,
      operDuplex: 'full',
      txBusyUntil: 0,
    }));
    const config = spec.makeConfig();
    if (config.kind === 'switch') config.hostname = name;
    s.devices[id] = {
      id,
      type,
      model: spec.model,
      name,
      pos: opts.pos ?? { x: 0, y: 0 },
      ports,
      modules: [],
      powered: true,
      config,
      physical: {},
    };
    return id;
  }

  removeDevice(deviceId: string): void {
    const dev = this.state.devices[deviceId];
    if (!dev) return;
    for (const p of dev.ports) if (p.linkId) this.disconnect(p.linkId);
    heapRemove(this.state.queue, (e) => e.deviceId === deviceId);
    delete this.state.devices[deviceId];
  }

  renameDevice(deviceId: string, name: string): void {
    const dev = this.state.devices[deviceId];
    if (!dev) return;
    dev.name = name;
    if (dev.config.kind === 'switch') dev.config.hostname = name;
  }

  moveDevice(deviceId: string, pos: Point): void {
    const dev = this.state.devices[deviceId];
    if (dev) dev.pos = pos;
  }

  getDevice(deviceId: string): Device | undefined {
    return this.state.devices[deviceId];
  }

  private getPort(ref: PortRef): Port | undefined {
    return this.state.devices[ref.deviceId]?.ports.find((p) => p.id === ref.portId);
  }

  connect(a: PortRef, b: PortRef, cable: CableType, lengthM?: number): Result<Link> {
    const devA = this.state.devices[a.deviceId];
    const devB = this.state.devices[b.deviceId];
    const portA = this.getPort(a);
    const portB = this.getPort(b);
    if (!devA || !devB || !portA || !portB) return { ok: false, error: 'cable.reject.notFound' };
    if (devA.id === devB.id) return { ok: false, error: 'cable.reject.sameDevice' };
    if (portA.linkId || portB.linkId) return { ok: false, error: 'cable.reject.portBusy' };
    const check = validateCable(cable, devA, portA, devB, portB, lengthM, this.state.config);
    if (!check.allowed) return { ok: false, error: check.rejectKey ?? 'cable.reject.unsupported' };
    const id = `l${this.state.nextId++}`;
    const link: Link = {
      id,
      cable,
      a,
      b,
      operUp: false,
      lengthM,
      cableOk: check.operUp,
      cableProblem: check.problemKey,
      busyFrom: 0,
      busyUntil: 0,
      lastActivityT: -1,
    };
    this.state.links[id] = link;
    portA.linkId = id;
    portB.linkId = id;
    this.refreshLinks();
    return { ok: true, value: link };
  }

  /** „Automatisch wählen“: Kabeltyp und erste freie Ports bestimmen. */
  connectAuto(deviceA: string, deviceB: string): Result<Link> {
    const devA = this.state.devices[deviceA];
    const devB = this.state.devices[deviceB];
    if (!devA || !devB) return { ok: false, error: 'cable.reject.notFound' };
    const pa = devA.ports.find((p) => !p.linkId && p.kind !== 'console');
    const pb = devB.ports.find((p) => !p.linkId && p.kind !== 'console');
    if (!pa || !pb) return { ok: false, error: 'cable.reject.noFreePort' };
    return this.connect(
      { deviceId: deviceA, portId: pa.id },
      { deviceId: deviceB, portId: pb.id },
      pickCable(devA, pa, devB, pb),
    );
  }

  disconnect(linkId: string): void {
    const link = this.state.links[linkId];
    if (!link) return;
    for (const ref of [link.a, link.b]) {
      const p = this.getPort(ref);
      if (p) {
        delete p.linkId;
        this.setPortOper(
          this.state.devices[ref.deviceId] as Device,
          p,
          false,
          'link.reason.removed',
        );
      }
    }
    delete this.state.links[linkId];
  }

  setPower(deviceId: string, on: boolean): void {
    const dev = this.state.devices[deviceId];
    if (!dev || dev.powered === on) return;
    dev.powered = on;
    if (!on) {
      heapRemove(this.state.queue, (e) => e.deviceId === deviceId);
      if (dev.config.kind === 'host') resetHostRuntime(dev.config);
      if (dev.config.kind === 'switch') dev.config.macTable = {};
      if (dev.config.kind === 'hub') dev.config.busyUntil = 0;
      for (const p of dev.ports) p.txBusyUntil = 0;
    } else {
      delete dev.crashed;
    }
    this.refreshLinks();
  }

  setPortAdmin(deviceId: string, portId: string, up: boolean): void {
    const p = this.getPort({ deviceId, portId });
    if (!p || p.adminUp === up) return;
    p.adminUp = up;
    this.refreshLinks();
  }

  setPortSettings(
    deviceId: string,
    portId: string,
    s: { speed?: Port['speed']; duplex?: Port['duplex'] },
  ): void {
    const p = this.getPort({ deviceId, portId });
    if (!p) return;
    if (s.speed !== undefined) p.speed = s.speed;
    if (s.duplex !== undefined) p.duplex = s.duplex;
    this.refreshLinks();
  }

  setHostIp(deviceId: string, ip: string, mask: string, gateway?: string): Result<true> {
    const dev = this.state.devices[deviceId];
    if (!dev || dev.config.kind !== 'host') return { ok: false, error: 'ip.notAHost' };
    const cfg = dev.config;
    if (ip === '') {
      cfg.ip = undefined;
      cfg.mask = undefined;
      cfg.gateway = undefined;
      resetHostRuntime(cfg);
      return { ok: true, value: true };
    }
    if (!isValidIpv4(ip)) return { ok: false, error: 'ip.invalidIp' };
    if (maskToPrefix(mask) === undefined) return { ok: false, error: 'ip.invalidMask' };
    if (gateway) {
      if (!isValidIpv4(gateway)) return { ok: false, error: 'ip.invalidGateway' };
      if (!sameSubnet(ip, gateway, mask)) return { ok: false, error: 'ip.gatewayOffSubnet' };
    }
    cfg.ip = ip;
    cfg.mask = mask;
    cfg.gateway = gateway || undefined;
    resetHostRuntime(cfg);
    if (dev.powered && !dev.crashed) this.withCtx(dev, (ctx) => announce(ctx, cfg));
    return { ok: true, value: true };
  }

  ping(deviceId: string, dst: string, opts?: PingOptions): Result<number> {
    const dev = this.state.devices[deviceId];
    if (!dev || dev.config.kind !== 'host') return { ok: false, error: 'ip.notAHost' };
    if (!dev.powered || dev.crashed) return { ok: false, error: 'dev.off' };
    if (!isValidIpv4(dst)) return { ok: false, error: 'ip.invalidIp' };
    const cfg = dev.config;
    return this.withCtx(dev, (ctx) => startPing(ctx, cfg, dst, opts));
  }

  // ------------------------------------------------------------ Link-Status

  private effectiveSpeed(p: Port): number {
    const max = PORT_MAX_SPEED[p.kind];
    return p.speed === 'auto' ? max : Math.min(p.speed, max);
  }

  /** Berechnet oper-Status aller Ports/Links neu und protokolliert Änderungen. */
  refreshLinks(): void {
    for (const link of Object.values(this.state.links)) {
      const devA = this.state.devices[link.a.deviceId] as Device;
      const devB = this.state.devices[link.b.deviceId] as Device;
      const pa = this.getPort(link.a) as Port;
      const pb = this.getPort(link.b) as Port;
      let reason: string | undefined;
      if (!link.cableOk) reason = link.cableProblem ?? 'cable.problem.generic';
      else if (!devA.powered || !devB.powered) reason = 'link.reason.power';
      else if (!pa.adminUp || !pb.adminUp) reason = 'link.reason.admin';
      const up = reason === undefined;
      link.operUp = up;
      const speed = up ? Math.min(this.effectiveSpeed(pa), this.effectiveSpeed(pb)) : 0;
      const duplex = pa.duplex === 'half' || pb.duplex === 'half' ? 'half' : 'full';
      for (const [dev, p] of [
        [devA, pa],
        [devB, pb],
      ] as const) {
        p.operSpeed = speed;
        p.operDuplex = duplex;
        this.setPortOper(dev, p, up, reason);
      }
    }
  }

  private setPortOper(dev: Device, p: Port, up: boolean, reason?: string): void {
    if (p.operUp === up) return;
    p.operUp = up;
    if (!up) {
      if (dev.config.kind === 'switch') switchPortDown(dev.config, p.id);
      p.txBusyUntil = 0;
    }
    this.addLog(dev, {
      kind: 'info',
      proto: 'LINK',
      status: up ? 'ok' : 'info',
      port: p,
      msg: up
        ? { key: 'link.up', params: { port: p.name, speed: p.operSpeed, duplex: p.operDuplex } }
        : { key: 'link.down', params: { port: p.name, reason: reason ?? 'link.reason.removed' } },
    });
  }

  /** Kollisionsdomänen: zusammenhängende Hub-Gruppen inkl. ihrer Endgeräte-Ports. */
  collisionDomains(): { hubs: string[]; endpoints: PortRef[] }[] {
    const seen = new Set<string>();
    const result: { hubs: string[]; endpoints: PortRef[] }[] = [];
    for (const dev of Object.values(this.state.devices)) {
      if (dev.type !== 'hub' || seen.has(dev.id)) continue;
      const hubs: string[] = [];
      const endpoints: PortRef[] = [];
      const stack = [dev.id];
      seen.add(dev.id);
      while (stack.length > 0) {
        const id = stack.pop() as string;
        hubs.push(id);
        for (const p of (this.state.devices[id] as Device).ports) {
          const link = p.linkId ? this.state.links[p.linkId] : undefined;
          if (!link) continue;
          const peer = link.a.deviceId === id && link.a.portId === p.id ? link.b : link.a;
          const peerDev = this.state.devices[peer.deviceId] as Device;
          if (peerDev.type === 'hub') {
            if (!seen.has(peerDev.id)) {
              seen.add(peerDev.id);
              stack.push(peerDev.id);
            }
          } else endpoints.push(peer);
        }
      }
      result.push({ hubs: hubs.sort(), endpoints });
    }
    return result;
  }

  // ------------------------------------------------------------ Abfragen

  macTable(deviceId: string): { mac: string; portId: string; ageSec: number }[] {
    const dev = this.state.devices[deviceId];
    return dev?.config.kind === 'switch' ? activeMacTable(dev.config, this.state.now) : [];
  }

  arpTable(deviceId: string): { ip: string; mac: string }[] {
    const dev = this.state.devices[deviceId];
    if (dev?.config.kind !== 'host') return [];
    const now = this.state.now;
    return Object.entries(dev.config.arpCache)
      .filter(([, e]) => e.expiresAt > now)
      .map(([ip, e]) => ({ ip, mac: e.mac }));
  }

  // ------------------------------------------------------------ Scheduler

  private schedule(ev: NewEvent): void {
    heapPush(this.state.queue, { ...ev, seq: this.state.seq++ } as SimEvent);
  }

  private rand(max: number): number {
    const r = mulberry32(this.state.rng);
    this.state.rng = r.state;
    return Math.floor(r.value * max);
  }

  get queueLength(): number {
    return this.state.queue.length;
  }

  peekNextTime(): number | undefined {
    return this.state.queue[0]?.t;
  }

  /** Verarbeitet genau ein Ereignis. */
  step(): SimEvent | undefined {
    const ev = heapPop(this.state.queue);
    if (!ev) return undefined;
    this.state.now = Math.max(this.state.now, ev.t);
    const dev = this.state.devices[ev.deviceId];
    if (!dev || dev.crashed) return ev;
    try {
      switch (ev.kind) {
        case 'rx':
          this.onRx(dev, ev.payload);
          break;
        case 'timer':
          this.onTimer(dev, ev.payload);
          break;
        case 'tx':
          this.onTx(dev, ev.payload);
          break;
        case 'collision':
          this.onCollision(dev, ev.payload);
          break;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      dev.crashed = { message, t: this.state.now };
      this.addLog(dev, {
        kind: 'error',
        proto: 'SYS',
        status: 'error',
        msg: { key: 'sys.deviceCrashed', params: { message } },
      });
    }
    return ev;
  }

  runUntil(t: number, maxEvents = 1_000_000): number {
    let n = 0;
    while (n < maxEvents) {
      const next = this.state.queue[0];
      if (!next || next.t > t) break;
      this.step();
      n++;
    }
    if (this.state.now < t && n < maxEvents) this.state.now = t;
    return n;
  }

  /** Läuft, bis die Queue leer ist (oder `maxEvents` erreicht – Schutz vor Broadcast-Stürmen). */
  runAll(maxEvents = 100_000): number {
    let n = 0;
    while (this.state.queue.length > 0 && n < maxEvents) {
      this.step();
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------ Ereignisbehandlung

  private serializationUs(frame: Frame, speedMbps: number): number {
    return Math.ceil((sizeOf(frame) * 8) / Math.max(speedMbps, 1));
  }

  private onTx(dev: Device, p: TxPayload): void {
    if (!dev.powered) return;
    const port = dev.ports.find((x) => x.id === p.portId);
    const link = port?.linkId ? this.state.links[port.linkId] : undefined;
    const now = this.state.now;
    if (!port || !link || !port.operUp) {
      if (port) port.counters.outErrors++;
      this.addLog(dev, {
        kind: 'drop',
        proto: 'LINK',
        status: 'drop',
        port,
        msg: { key: 'tx.linkDown', params: { port: port?.name ?? p.portId } },
      });
      return;
    }
    const half = port.operDuplex === 'half';
    if (half && dev.type !== 'hub' && now >= link.busyFrom && now < link.busyUntil) {
      // Carrier Sense: Medium belegt → warten (1-persistent CSMA).
      this.schedule({ t: link.busyUntil + 1, deviceId: dev.id, kind: 'tx', payload: p });
      return;
    }
    const prop = this.state.config.propagationUs;
    const dur = this.serializationUs(p.frame, port.operSpeed);
    const start = half ? now : Math.max(now, port.txBusyUntil);
    port.txBusyUntil = start + dur;
    if (link.busyUntil <= start + prop) link.busyFrom = start + prop;
    link.busyUntil = Math.max(link.busyUntil, start + dur + prop);
    link.lastActivityT = start;

    const peer = link.a.deviceId === dev.id && link.a.portId === port.id ? link.b : link.a;
    const tx: Transmission = {
      id: this.state.nextTxId++,
      linkId: link.id,
      from: { deviceId: dev.id, portId: port.id },
      to: peer,
      sendStart: start,
      arrStart: start + prop,
      arrEnd: start + dur + prop,
      frame: p.frame,
      attempts: p.attempts,
      collided: false,
      origin: p.origin,
    };
    const s = this.state;
    s.transmissions = s.transmissions.filter((t) => t.arrEnd >= now - TX_HISTORY_US);
    s.transmissions.push(tx);
    port.counters.outPkts++;
    port.counters.outBytes += sizeOf(p.frame);
    this.schedule({
      t: tx.arrEnd,
      deviceId: peer.deviceId,
      kind: 'rx',
      payload: { portId: peer.portId, txId: tx.id, frame: p.frame },
    });
  }

  private onRx(dev: Device, p: RxPayload): void {
    const port = dev.ports.find((x) => x.id === p.portId);
    if (!dev.powered || !port || !port.operUp) return;
    const tx = this.state.transmissions.find((t) => t.id === p.txId);
    const from = tx ? this.state.devices[tx.from.deviceId] : undefined;
    if (tx?.collided) {
      if (dev.type !== 'hub') {
        port.counters.inErrors++;
        this.addLog(dev, {
          kind: 'drop',
          proto: 'CSMA',
          status: 'drop',
          port,
          from: from?.id,
          msg: { key: 'rx.collisionRunt' },
        });
      }
      return;
    }
    port.counters.inPkts++;
    port.counters.inBytes += sizeOf(p.frame);
    const fromId = from?.id ?? '';
    const cfg = dev.config;
    this.withCtx(dev, (ctx) => {
      switch (cfg.kind) {
        case 'host':
          hostRx(ctx, cfg, p.portId, p.frame, fromId);
          break;
        case 'switch':
          switchRx(ctx, cfg, p.portId, p.frame, fromId);
          break;
        case 'hub':
          hubRx(ctx, cfg, p.portId, p.frame, p.txId, fromId);
          break;
        case 'none':
          break;
      }
    });
  }

  private onTimer(dev: Device, p: TimerPayload): void {
    if (!dev.powered) return;
    if (p.repeatUs !== undefined) {
      this.schedule({
        t: this.state.now + p.repeatUs,
        deviceId: dev.id,
        kind: 'timer',
        payload: p,
      });
    }
    const cfg = dev.config;
    if (cfg.kind === 'host') this.withCtx(dev, (ctx) => hostTimer(ctx, cfg, p.name));
  }

  private onCollision(dev: Device, p: CollisionPayload): void {
    const tx = this.state.transmissions.find((t) => t.id === p.txId);
    const port = dev.ports.find((x) => x.id === p.portId);
    if (!tx || !port || !dev.powered) return;
    port.counters.collisions++;
    const attempts = tx.attempts + 1;
    if (attempts > MAX_RETRIES) {
      port.counters.outErrors++;
      this.addLog(dev, {
        kind: 'drop',
        proto: 'CSMA',
        status: 'drop',
        port,
        msg: { key: 'csma.excessive', params: { port: port.name } },
      });
      return;
    }
    const speed = port.operSpeed || 10;
    const slots = this.rand(2 ** Math.min(attempts, 10));
    const delay = Math.ceil(32 / speed) + slots * Math.ceil(512 / speed);
    this.addLog(dev, {
      kind: 'collision',
      proto: 'CSMA',
      status: 'info',
      port,
      msg: { key: 'csma.backoff', params: { attempt: attempts, slots, port: port.name } },
    });
    this.schedule({
      t: this.state.now + delay,
      deviceId: dev.id,
      kind: 'tx',
      payload: { portId: port.id, frame: tx.frame, attempts },
    });
  }

  // ------------------------------------------------------------ Kontext & Log

  private addLog(dev: Device, e: LogInput): void {
    const from = e.from ? this.state.devices[e.from] : undefined;
    this.log.push({
      id: this.log.length,
      t: this.state.now,
      kind: e.kind,
      proto: e.proto,
      status: e.status,
      lastDeviceId: from?.id,
      lastDeviceName: from?.name,
      atDeviceId: dev.id,
      atDeviceName: dev.name,
      portName: e.port?.name,
      msg: e.msg,
      summary: e.summary,
      frame: e.frame,
    });
  }

  private withCtx<T>(dev: Device, fn: (ctx: DeviceCtx) => T): T {
    const eng = this;
    const s = this.state;
    const ctx: DeviceCtx = {
      now: s.now,
      device: dev,
      processingUs: s.config.processingUs,
      propagationUs: s.config.propagationUs,
      rand: (max) => eng.rand(max),
      port(portId) {
        const p = dev.ports.find((x) => x.id === portId);
        if (!p) throw new Error(`Unknown port ${portId} on ${dev.name}`);
        return p;
      },
      send(portId, frame, delayUs = 0, origin) {
        eng.schedule({
          t: s.now + delayUs,
          deviceId: dev.id,
          kind: 'tx',
          payload: { portId, frame, attempts: 0, origin },
        });
      },
      log: (e) => eng.addLog(dev, e),
      setTimer(name, delayUs, repeatUs) {
        ctx.cancelTimer(name);
        eng.schedule({
          t: s.now + delayUs,
          deviceId: dev.id,
          kind: 'timer',
          payload: { name, repeatUs },
        });
      },
      cancelTimer(name) {
        heapRemove(
          s.queue,
          (e) => e.kind === 'timer' && e.deviceId === dev.id && e.payload.name === name,
        );
      },
      peerOf(portId) {
        const p = dev.ports.find((x) => x.id === portId);
        const link = p?.linkId ? s.links[p.linkId] : undefined;
        if (!link) return undefined;
        return link.a.deviceId === dev.id && link.a.portId === portId ? link.b : link.a;
      },
      transmission: (id) => s.transmissions.find((t) => t.id === id),
      overlappingIncoming(txId) {
        const me = s.transmissions.find((t) => t.id === txId);
        if (!me) return [];
        return s.transmissions.filter(
          (t) =>
            t.id !== txId &&
            t.to.deviceId === dev.id &&
            t.arrStart < me.arrEnd &&
            me.arrStart < t.arrEnd,
        );
      },
      signalCollision(txs) {
        for (const t of txs) {
          const target = t.origin !== undefined ? ctx.transmission(t.origin) : t;
          const fresh = target !== undefined && !target.collided;
          t.collided = true;
          if (target && fresh) {
            target.collided = true;
            eng.schedule({
              t: s.now + s.config.propagationUs,
              deviceId: target.from.deviceId,
              kind: 'collision',
              payload: { portId: target.from.portId, txId: target.id },
            });
          }
        }
      },
      corruptOutgoing() {
        return s.transmissions.filter(
          (t) =>
            t.from.deviceId === dev.id && t.origin !== undefined && t.arrEnd > s.now && !t.collided,
        );
      },
    };
    return fn(ctx);
  }
}

function sizeOf(frame: Frame): number {
  return pduSize(frame);
}
