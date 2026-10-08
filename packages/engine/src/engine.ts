import {
  ipv6Network,
  isLinkLocalIpv6,
  isValidIpv4,
  isValidIpv6,
  normalizeIpv6,
  macFromCounter,
  parseIpv4,
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
  hostDhcp,
  hostHttp,
  hostPing,
  hostResolve,
  hostRx,
  hostTimer,
  hostTrace,
  resetIpRuntime,
  type PingOptions,
} from './devices/host';
import { l3Ping, l3Timer, l3Trace, routerRx, type L3Dev } from './devices/l3dev';
import { routingResetRuntime, routingSync } from './routing';
import { buildRib6, listIfaces6 } from './l3v6';
import { hostV6 } from './devices/host';
import { ifaceName, listIfaces, sviId, subId } from './ifaces';
import { buildRib, networkOf, type RibEntry } from './rib';
import { hubRx } from './devices/hub';
import {
  activeMacTable,
  switchPortDown,
  switchRx,
  switchStart,
  switchTimer,
  type SwitchDev,
} from './devices/switch';
import { stpPortsChanged } from './devices/stp';
import { vtpSend } from './devices/vtp';
import { heapPop, heapPush, heapRemove } from './heap';
import { mulberry32 } from './rng';
import { bridgeRx } from './p5/bridge';
import { mgmtOf } from './p5defaults';
import { Phase5 } from './p5/api';
import type {
  HostConfig,
  V6IfCfg,
  SwitchPortCfg,
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
  private refreshWanted = false;
  /** Phase 5: WLAN-Assoziationen nach dem aktuellen Ereignis neu berechnen. */
  private wifiWanted = false;
  /** Phase 5: WLAN, Server-Dienste, Management, Firewall, IoT, Physical View. */
  readonly p5 = new Phase5(this);
  /** Signatur der zuletzt verarbeiteten Switch-Konfiguration (löst STP-Neuaufbau aus). */
  private readonly switchSig = new Map<string, string>();

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
      if (cfg.kind === 'host' || cfg.kind === 'router' || cfg.kind === 'switch') {
        resetIpRuntime(cfg);
        cfg.pings = [];
        cfg.traces = [];
        cfg.nextPingId = 1;
        cfg.nextTraceId = 1;
        cfg.nextIpId = 1;
      }
      if (cfg.kind === 'host') {
        cfg.tcp = {};
        cfg.requests = [];
        cfg.dnsPending = {};
        cfg.dnsResults = {};
        cfg.dnsCache = {};
        cfg.dhcpClient.state = cfg.dhcpClient.enabled ? 'init' : 'off';
      } else if (cfg.kind === 'router' || cfg.kind === 'switch') {
        cfg.nat.table = [];
        routingResetRuntime(cfg);
        if (cfg.kind === 'switch') {
          cfg.macTable = {};
          cfg.stp.instances = {};
        }
      } else if (cfg.kind === 'hub') cfg.busyUntil = 0;
      this.p5.powerOff(dev);
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
    this.refreshLinks();
    for (const dev of Object.values(s.devices)) this.startTimers(dev);
  }

  /** Hintergrund-Timer (STP, VTP) eines Geräts starten. */
  private startTimers(dev: Device): void {
    if (dev.config.kind === 'switch' && dev.powered) {
      this.withCtx(dev, (ctx) => switchStart(ctx, dev as SwitchDev));
    }
    if ((dev.config.kind === 'router' || dev.config.kind === 'switch') && dev.powered) {
      this.withCtx(dev, (ctx) => routingSync(ctx, dev as L3Dev));
    }
    if (dev.config.kind === 'host' && dev.powered) {
      const h = dev.config;
      this.withCtx(dev, (ctx) => hostV6(ctx, h));
    }
    this.p5.startTimers(dev);
  }

  /** Routing-Konfiguration (CLI/GUI) oder Topologie geändert: Protokollprozesse nachziehen. */
  routingChanged(deviceId: string): void {
    const dev = this.state.devices[deviceId];
    if (!dev?.powered || dev.crashed) return;
    if (dev.config.kind === 'router' || dev.config.kind === 'switch')
      this.withCtx(dev, (ctx) => routingSync(ctx, dev as L3Dev));
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
      adminUp: !spec.portsDefaultDown,
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
      mtu: 1500,
    }));
    const config = spec.makeConfig(name, ports);
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
    this.startTimers(s.devices[id] as Device);
    return id;
  }

  removeDevice(deviceId: string): void {
    const dev = this.state.devices[deviceId];
    if (!dev) return;
    for (const p of dev.ports) if (p.linkId) this.disconnect(p.linkId);
    heapRemove(this.state.queue, (e) => e.deviceId === deviceId);
    delete this.state.devices[deviceId];
    this.p5.wirelessSync();
  }

  renameDevice(deviceId: string, name: string): void {
    const dev = this.state.devices[deviceId];
    if (!dev) return;
    dev.name = name;
    if (dev.config.kind === 'switch' || dev.config.kind === 'router')
      dev.config.sys.hostname = name;
  }

  moveDevice(deviceId: string, pos: Point): void {
    const dev = this.state.devices[deviceId];
    if (dev) dev.pos = pos;
    this.p5.wirelessSync();
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
    if (!check.operUp) {
      // Port war schon down → kein Zustandswechsel; Ursache trotzdem sichtbar machen.
      for (const [dev, p] of [
        [devA, portA],
        [devB, portB],
      ] as const) {
        this.addLog(dev, {
          kind: 'info',
          proto: 'LINK',
          status: 'info',
          port: p,
          msg: {
            key: 'link.down',
            params: { port: p.name, reason: check.problemKey ?? 'cable.problem.generic' },
          },
        });
      }
    }
    return { ok: true, value: link };
  }

  /** „Automatisch wählen“: Kabeltyp und erste freie Ports bestimmen. */
  connectAuto(deviceA: string, deviceB: string): Result<Link> {
    const devA = this.state.devices[deviceA];
    const devB = this.state.devices[deviceB];
    if (!devA || !devB) return { ok: false, error: 'cable.reject.notFound' };
    const pa = devA.ports.find((p) => !p.linkId && p.kind !== 'console' && p.kind !== 'wifi');
    const pb = devB.ports.find((p) => !p.linkId && p.kind !== 'console' && p.kind !== 'wifi');
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
    this.refreshSwitches();
  }

  setPower(deviceId: string, on: boolean): void {
    const dev = this.state.devices[deviceId];
    if (!dev || dev.powered === on) return;
    dev.powered = on;
    if (!on) {
      heapRemove(this.state.queue, (e) => e.deviceId === deviceId);
      if (
        dev.config.kind === 'host' ||
        dev.config.kind === 'router' ||
        dev.config.kind === 'switch'
      )
        resetIpRuntime(dev.config);
      if (dev.config.kind === 'switch') {
        dev.config.macTable = {};
        dev.config.stp.instances = {};
      }
      if (dev.config.kind === 'router' || dev.config.kind === 'switch')
        routingResetRuntime(dev.config);
      if (dev.config.kind === 'host') {
        dev.config.v6.slaac = [];
        dev.config.v6.raGateway = undefined;
        dev.config.tcp = {};
        dev.config.dnsPending = {};
        if (dev.config.dhcpClient.enabled) dev.config.dhcpClient.state = 'init';
      }
      if (dev.config.kind === 'hub') dev.config.busyUntil = 0;
      for (const p of dev.ports) p.txBusyUntil = 0;
      this.p5.powerOff(dev);
    } else {
      delete dev.crashed;
    }
    this.refreshLinks();
    if (on) this.startTimers(dev);
    this.p5.wirelessSync();
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
    if (cfg.dhcpClient.enabled && dev.powered)
      this.withCtx(dev, (ctx) => hostDhcp(ctx, cfg, false));
    else cfg.dhcpClient.enabled = false;
    if (ip === '') {
      cfg.ip = undefined;
      cfg.mask = undefined;
      cfg.gateway = undefined;
      resetIpRuntime(cfg);
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
    resetIpRuntime(cfg);
    if (dev.powered && !dev.crashed) this.withCtx(dev, (ctx) => announce(ctx, cfg));
    return { ok: true, value: true };
  }

  /** Ping von einem Host oder Router aus (Ergebnisse in `config.pings`). */
  ping(deviceId: string, dst: string, opts?: PingOptions): Result<number> {
    const dev = this.state.devices[deviceId];
    if (
      !dev ||
      dev.config.kind === 'hub' ||
      dev.config.kind === 'none' ||
      dev.config.kind === 'bridge'
    )
      return { ok: false, error: 'ip.notAHost' };
    if (!dev.powered || dev.crashed) return { ok: false, error: 'dev.off' };
    const v6 = isValidIpv6(dst);
    if (!v6 && !isValidIpv4(dst)) return { ok: false, error: 'ip.invalidIp' };
    const target = v6 ? (normalizeIpv6(dst) as string) : dst;
    const cfg = dev.config;
    return this.withCtx(dev, (ctx) =>
      cfg.kind === 'host'
        ? hostPing(ctx, cfg, target, opts)
        : l3Ping(ctx, dev as L3Dev, target, opts),
    );
  }

  /** Traceroute (Ergebnis in `config.traces`). */
  trace(deviceId: string, dst: string, maxHops = 30): Result<number> {
    const dev = this.state.devices[deviceId];
    if (
      !dev ||
      dev.config.kind === 'hub' ||
      dev.config.kind === 'none' ||
      dev.config.kind === 'bridge'
    )
      return { ok: false, error: 'ip.notAHost' };
    if (!dev.powered || dev.crashed) return { ok: false, error: 'dev.off' };
    if (!isValidIpv4(dst)) return { ok: false, error: 'ip.invalidIp' };
    const cfg = dev.config;
    return this.withCtx(dev, (ctx) =>
      cfg.kind === 'host'
        ? hostTrace(ctx, cfg, dst, maxHops)
        : l3Trace(ctx, dev as L3Dev, dst, maxHops),
    );
  }

  // ------------------------------------------------------------ Router-Konfiguration

  private l3(deviceId: string): L3Dev | undefined {
    const d = this.state.devices[deviceId];
    return d && (d.config.kind === 'router' || d.config.kind === 'switch')
      ? (d as L3Dev)
      : undefined;
  }

  /** L3-Schnittstelle anlegen (Subinterface `p0.10`, SVI `vlan10`); physische existieren implizit. */
  ensureIface(deviceId: string, id: string): Result<string> {
    const dev = this.l3(deviceId);
    if (!dev) return { ok: false, error: 'ip.notARouter' };
    const cfg = dev.config;
    if (cfg.ifaces[id]) return { ok: true, value: id };
    const sub = /^(p\d+)\.(\d+)$/.exec(id);
    const svi = /^vlan(\d+)$/.exec(id);
    if (/^lo\d+$/.test(id)) {
      cfg.ifaces[id] = { kind: 'loop' };
      return { ok: true, value: id };
    }
    if (/^tu\d+$/.test(id)) {
      cfg.ifaces[id] = { kind: 'tunnel', tunnel: { mode: 'gre' } };
      return { ok: true, value: id };
    }
    if (sub && dev.config.kind === 'router' && dev.ports.some((p) => p.id === sub[1])) {
      cfg.ifaces[id] = { kind: 'sub', portId: sub[1], vlan: Number(sub[2]), shutdown: false };
    } else if (svi && dev.config.kind === 'switch') {
      cfg.ifaces[id] = { kind: 'svi', vlan: Number(svi[1]), shutdown: false };
    } else if (dev.ports.some((p) => p.id === id)) {
      cfg.ifaces[id] = { kind: 'phys', portId: id };
    } else return { ok: false, error: 'cable.reject.notFound' };
    return { ok: true, value: id };
  }

  /** Subinterface (`encapsulation dot1Q`) auf einem Routerport anlegen. */
  createSubIface(deviceId: string, portId: string, vlan: number): Result<string> {
    return this.ensureIface(deviceId, subId(portId, vlan));
  }

  /** SVI (`interface vlan N`) auf einem Switch anlegen. */
  createSvi(deviceId: string, vlan: number): Result<string> {
    return this.ensureIface(deviceId, sviId(vlan));
  }

  /** IP-Adresse einer L3-Schnittstelle setzen (`ip=''` löscht sie). */
  setInterfaceIp(deviceId: string, ifaceId: string, ip: string, mask: string): Result<true> {
    const dev = this.l3(deviceId);
    if (!dev) return { ok: false, error: 'ip.notARouter' };
    const cfg = dev.config;
    const made = this.ensureIface(deviceId, ifaceId);
    if (!made.ok) return made;
    const ic = cfg.ifaces[ifaceId];
    if (!ic) return { ok: false, error: 'ip.notARouter' };
    if (ip === '') {
      ic.ip = undefined;
      ic.mask = undefined;
      this.routingChanged(deviceId);
      return { ok: true, value: true };
    }
    if (!isValidIpv4(ip)) return { ok: false, error: 'ip.invalidIp' };
    const plen = maskToPrefix(mask);
    if (plen === undefined) return { ok: false, error: 'ip.invalidMask' };
    if (plen < 31 && (parseIpv4(ip) as number) === parseIpv4(networkOf(ip, plen))) {
      return { ok: false, error: 'ip.networkAddress' };
    }
    for (const [oid, o] of Object.entries(cfg.ifaces)) {
      if (oid === ifaceId || !o.ip || !o.mask) continue;
      const olen = maskToPrefix(o.mask) as number;
      const common = Math.min(plen, olen);
      if (networkOf(ip, common) === networkOf(o.ip, common)) {
        return {
          ok: false,
          error: 'ip.overlap',
          params: { net: networkOf(ip, plen), port: ifaceName(dev, oid, o) },
        };
      }
    }
    ic.ip = ip;
    ic.mask = mask;
    this.routingChanged(deviceId);
    return { ok: true, value: true };
  }

  addStaticRoute(
    deviceId: string,
    r: { prefix: string; mask: string; nextHop?: string; outIfaceId?: string; ad?: number },
  ): Result<true> {
    const dev = this.l3(deviceId);
    if (!dev) return { ok: false, error: 'ip.notARouter' };
    if (!isValidIpv4(r.prefix)) return { ok: false, error: 'ip.invalidIp' };
    if (maskToPrefix(r.mask) === undefined) return { ok: false, error: 'ip.invalidMask' };
    if (r.nextHop !== undefined && !isValidIpv4(r.nextHop))
      return { ok: false, error: 'ip.invalidGateway' };
    if (r.nextHop === undefined && r.outIfaceId === undefined)
      return { ok: false, error: 'ip.invalidGateway' };
    const entry = {
      prefix: networkOf(r.prefix, maskToPrefix(r.mask) as number),
      mask: r.mask,
      nextHop: r.nextHop,
      outIfaceId: r.outIfaceId,
      ad: r.ad ?? 1,
    };
    const routes = dev.config.staticRoutes;
    const same = (x: (typeof routes)[number]) =>
      x.prefix === entry.prefix &&
      x.mask === entry.mask &&
      x.nextHop === entry.nextHop &&
      x.outIfaceId === entry.outIfaceId;
    if (!routes.some(same)) routes.push(entry);
    return { ok: true, value: true };
  }

  removeStaticRoute(
    deviceId: string,
    r: { prefix: string; mask: string; nextHop?: string; outIfaceId?: string },
  ): Result<true> {
    const dev = this.l3(deviceId);
    if (!dev) return { ok: false, error: 'ip.notARouter' };
    const plen = maskToPrefix(r.mask);
    if (plen === undefined) return { ok: false, error: 'ip.invalidMask' };
    const prefix = networkOf(r.prefix, plen);
    const routes = dev.config.staticRoutes;
    const i = routes.findIndex(
      (x) =>
        x.prefix === prefix &&
        x.mask === r.mask &&
        x.nextHop === r.nextHop &&
        x.outIfaceId === r.outIfaceId,
    );
    if (i >= 0) routes.splice(i, 1);
    return { ok: true, value: true };
  }

  // ------------------------------------------------------------ IPv6

  setIpv6Routing(deviceId: string, on: boolean): Result<true> {
    const dev = this.l3(deviceId);
    if (!dev) return { ok: false, error: 'ip.notARouter' };
    dev.config.ipv6Routing = on;
    this.routingChanged(deviceId);
    return { ok: true, value: true };
  }

  private v6cfg(deviceId: string, ifaceId: string): Result<V6IfCfg> {
    const dev = this.l3(deviceId);
    if (!dev) return { ok: false, error: 'ip.notARouter' };
    const made = this.ensureIface(deviceId, ifaceId);
    if (!made.ok) return made;
    const ic = dev.config.ifaces[ifaceId];
    if (!ic) return { ok: false, error: 'ip.notARouter' };
    ic.v6 ??= { enabled: false, addrs: [], autoconfig: false, slaac: [] };
    return { ok: true, value: ic.v6 };
  }

  /** `ipv6 enable` (Link-Local ohne globale Adresse). */
  enableIpv6(deviceId: string, ifaceId: string, on: boolean): Result<true> {
    const v = this.v6cfg(deviceId, ifaceId);
    if (!v.ok) return v;
    v.value.enabled = on;
    this.routingChanged(deviceId);
    return { ok: true, value: true };
  }

  setIpv6Autoconfig(deviceId: string, ifaceId: string, on: boolean): Result<true> {
    const v = this.v6cfg(deviceId, ifaceId);
    if (!v.ok) return v;
    v.value.autoconfig = on;
    if (!on) v.value.slaac = [];
    this.routingChanged(deviceId);
    return { ok: true, value: true };
  }

  /** IPv6-Adresse an einer Router-/L3-Switch-Schnittstelle setzen (`eui64`: `addr` ist das Präfix). */
  setInterfaceIp6(
    deviceId: string,
    ifaceId: string,
    addr: string,
    plen: number,
    opts: { eui64?: boolean; remove?: boolean } = {},
  ): Result<true> {
    const v = this.v6cfg(deviceId, ifaceId);
    if (!v.ok) return v;
    const norm = normalizeIpv6(addr);
    if (!norm) return { ok: false, error: 'ip6.invalidAddress' };
    if (!Number.isInteger(plen) || plen < 1 || plen > 128)
      return { ok: false, error: 'ip6.invalidPrefix' };
    const cfg = v.value;
    if (opts.remove) {
      cfg.addrs = cfg.addrs.filter((a) => a.addr !== norm);
    } else {
      const dev = this.l3(deviceId) as L3Dev;
      for (const [oid, o] of Object.entries(dev.config.ifaces)) {
        if (oid === ifaceId) continue;
        for (const a of o.v6?.addrs ?? []) {
          const common = Math.min(plen, a.plen);
          if (ipv6Network(norm, common) === ipv6Network(a.addr, common))
            return {
              ok: false,
              error: 'ip6.overlap',
              params: { net: ipv6Network(norm, plen), port: ifaceName(dev, oid, o) },
            };
        }
      }
      cfg.addrs = cfg.addrs.filter((a) => a.addr !== norm);
      cfg.addrs.push({ addr: norm, plen, eui64: opts.eui64 });
    }
    this.routingChanged(deviceId);
    return { ok: true, value: true };
  }

  addStaticRoute6(
    deviceId: string,
    r: { prefix: string; plen: number; nextHop?: string; outIfaceId?: string; ad?: number },
  ): Result<true> {
    const dev = this.l3(deviceId);
    if (!dev) return { ok: false, error: 'ip.notARouter' };
    const prefix = normalizeIpv6(r.prefix);
    if (!prefix) return { ok: false, error: 'ip6.invalidAddress' };
    if (!Number.isInteger(r.plen) || r.plen < 0 || r.plen > 128)
      return { ok: false, error: 'ip6.invalidPrefix' };
    const nextHop = r.nextHop ? normalizeIpv6(r.nextHop) : undefined;
    if (r.nextHop && !nextHop) return { ok: false, error: 'ip6.invalidAddress' };
    if (!nextHop && !r.outIfaceId) return { ok: false, error: 'ip.routeNeedsTarget' };
    if (nextHop && isLinkLocalIpv6(nextHop) && !r.outIfaceId)
      return { ok: false, error: 'ip6.linkLocalNeedsIface' };
    const n = ipv6Network(prefix, r.plen);
    const list = dev.config.staticRoutes6;
    if (
      !list.some(
        (x) =>
          x.prefix === n &&
          x.plen === r.plen &&
          x.nextHop === nextHop &&
          x.outIfaceId === r.outIfaceId,
      )
    )
      list.push({ prefix: n, plen: r.plen, nextHop, outIfaceId: r.outIfaceId, ad: r.ad ?? 1 });
    this.routingChanged(deviceId);
    return { ok: true, value: true };
  }

  removeStaticRoute6(
    deviceId: string,
    r: { prefix: string; plen: number; nextHop?: string; outIfaceId?: string },
  ): Result<true> {
    const dev = this.l3(deviceId);
    if (!dev) return { ok: false, error: 'ip.notARouter' };
    const prefix = ipv6Network(r.prefix, r.plen);
    const nextHop = r.nextHop ? normalizeIpv6(r.nextHop) : undefined;
    const list = dev.config.staticRoutes6;
    const i = list.findIndex(
      (x) =>
        x.prefix === prefix &&
        x.plen === r.plen &&
        x.nextHop === nextHop &&
        x.outIfaceId === r.outIfaceId,
    );
    if (i >= 0) list.splice(i, 1);
    this.routingChanged(deviceId);
    return { ok: true, value: true };
  }

  /** Host: IPv6-Adresse/Gateway/SLAAC setzen. `addr: ''` entfernt die statische Adresse. */
  setHostIpv6(
    deviceId: string,
    patch: {
      enabled?: boolean;
      addr?: string;
      plen?: number;
      gateway?: string;
      autoconfig?: boolean;
    },
  ): Result<true> {
    const dev = this.state.devices[deviceId];
    if (!dev || dev.config.kind !== 'host') return { ok: false, error: 'ip.notAHost' };
    const h = dev.config;
    if (patch.enabled !== undefined) h.v6.enabled = patch.enabled;
    if (patch.addr !== undefined) {
      if (patch.addr === '') h.v6.addrs = [];
      else {
        const a = normalizeIpv6(patch.addr);
        if (!a) return { ok: false, error: 'ip6.invalidAddress' };
        const plen = patch.plen ?? 64;
        if (!Number.isInteger(plen) || plen < 1 || plen > 128)
          return { ok: false, error: 'ip6.invalidPrefix' };
        h.v6.addrs = [{ addr: a, plen }];
      }
    }
    if (patch.gateway !== undefined) {
      if (patch.gateway === '') h.v6.gateway = undefined;
      else {
        const g = normalizeIpv6(patch.gateway);
        if (!g) return { ok: false, error: 'ip6.invalidAddress' };
        h.v6.gateway = g;
      }
    }
    if (patch.autoconfig !== undefined) {
      h.v6.autoconfig = patch.autoconfig;
      if (!patch.autoconfig) {
        h.v6.slaac = [];
        h.v6.raGateway = undefined;
      }
    }
    h.nd = {};
    h.ndPending = {};
    if (dev.powered && !dev.crashed) this.withCtx(dev, (ctx) => hostV6(ctx, h));
    return { ok: true, value: true };
  }

  /** IPv6-Routing-Tabelle (Router/L3-Switch). */
  routingTable6(deviceId: string): RibEntry[] {
    const dev = this.l3(deviceId);
    if (!dev) return [];
    return buildRib6(dev.config, listIfaces6(dev, dev.config)).filter((e) => e.type !== 'L');
  }

  /** IPv6-Nachbar-Cache. */
  ndTable(deviceId: string): { ip: string; mac: string }[] {
    const dev = this.state.devices[deviceId];
    if (
      !dev ||
      !(dev.config.kind === 'host' || dev.config.kind === 'router' || dev.config.kind === 'switch')
    )
      return [];
    return Object.entries(dev.config.nd)
      .filter(([, e]) => e.expiresAt > this.state.now)
      .map(([ip, e]) => ({ ip, mac: e.mac }));
  }

  setPortMtu(deviceId: string, portId: string, mtu: number): Result<true> {
    const p = this.getPort({ deviceId, portId });
    if (!p) return { ok: false, error: 'cable.reject.notFound' };
    if (!Number.isInteger(mtu) || mtu < 68 || mtu > 9216)
      return { ok: false, error: 'ip.invalidMtu' };
    p.mtu = mtu;
    return { ok: true, value: true };
  }

  /** Routing-Tabelle eines Routers bzw. L3-Switches. */
  routingTable(deviceId: string): RibEntry[] {
    const dev = this.l3(deviceId);
    return dev ? buildRib(dev.config, listIfaces(dev, dev.config)) : [];
  }

  // ------------------------------------------------------------ Switch-Konfiguration

  private sw(deviceId: string): SwitchDev | undefined {
    const d = this.state.devices[deviceId];
    return d?.config.kind === 'switch' ? (d as SwitchDev) : undefined;
  }

  /** Nach Konfigurationsänderungen: Trunks/Channels neu berechnen, STP neu aufbauen. */
  switchChanged(deviceId: string): void {
    const dev = this.sw(deviceId);
    if (!dev) return;
    this.refreshLinks();
    this.withCtx(dev, (ctx) => stpPortsChanged(ctx, dev));
  }

  private bumpVtp(dev: SwitchDev): void {
    const vtp = dev.config.vtp;
    if (vtp.mode === 'transparent') return;
    vtp.revision++;
    this.withCtx(dev, (ctx) => vtpSend(ctx, dev));
  }

  addVlan(deviceId: string, vid: number, name?: string): Result<true> {
    const dev = this.sw(deviceId);
    if (!dev) return { ok: false, error: 'sw.notASwitch' };
    if (!Number.isInteger(vid) || vid < 1 || vid > 4094)
      return { ok: false, error: 'sw.invalidVlan' };
    if (dev.config.vtp.mode === 'client') return { ok: false, error: 'sw.vtpClient' };
    const cur = dev.config.vlans[vid];
    const n = name ?? cur?.name ?? `VLAN${String(vid).padStart(4, '0')}`;
    if (cur?.name === n) return { ok: true, value: true };
    dev.config.vlans[vid] = { name: n };
    this.bumpVtp(dev);
    this.switchChanged(deviceId);
    return { ok: true, value: true };
  }

  removeVlan(deviceId: string, vid: number): Result<true> {
    const dev = this.sw(deviceId);
    if (!dev) return { ok: false, error: 'sw.notASwitch' };
    if (vid === 1 || (vid >= 1002 && vid <= 1005)) return { ok: false, error: 'sw.defaultVlan' };
    if (dev.config.vtp.mode === 'client') return { ok: false, error: 'sw.vtpClient' };
    delete dev.config.vlans[vid];
    this.bumpVtp(dev);
    this.switchChanged(deviceId);
    return { ok: true, value: true };
  }

  setVtp(
    deviceId: string,
    patch: { mode?: 'server' | 'client' | 'transparent'; domain?: string },
  ): Result<true> {
    const dev = this.sw(deviceId);
    if (!dev) return { ok: false, error: 'sw.notASwitch' };
    const vtp = dev.config.vtp;
    if (patch.mode) vtp.mode = patch.mode;
    if (patch.domain !== undefined) {
      vtp.domain = patch.domain;
      vtp.revision = 0;
    }
    this.withCtx(dev, (ctx) => vtpSend(ctx, dev));
    return { ok: true, value: true };
  }

  /** Switchport-Einstellungen eines Ports ändern. */
  setSwitchport(deviceId: string, portId: string, patch: Partial<SwitchPortCfg>): Result<true> {
    const dev = this.sw(deviceId);
    const pc = dev?.config.ports[portId];
    if (!dev || !pc) return { ok: false, error: 'sw.notASwitch' };
    if (patch.accessVlan !== undefined && (patch.accessVlan < 1 || patch.accessVlan > 4094))
      return { ok: false, error: 'sw.invalidVlan' };
    Object.assign(pc, patch);
    this.switchChanged(deviceId);
    return { ok: true, value: true };
  }

  setStp(
    deviceId: string,
    patch: { mode?: 'pvst' | 'rapid-pvst'; vlan?: number; priority?: number },
  ): Result<true> {
    const dev = this.sw(deviceId);
    if (!dev) return { ok: false, error: 'sw.notASwitch' };
    if (patch.mode) {
      dev.config.stp.mode = patch.mode;
      dev.config.stp.instances = {};
    }
    if (patch.vlan !== undefined && patch.priority !== undefined) {
      if (patch.priority % 4096 !== 0 || patch.priority > 61440)
        return { ok: false, error: 'sw.invalidPriority' };
      dev.config.stp.priority[patch.vlan] = patch.priority;
      delete dev.config.stp.instances[patch.vlan];
    }
    this.switchChanged(deviceId);
    return { ok: true, value: true };
  }

  /** err-disabled aufheben (`shutdown` / `no shutdown`). */
  clearErrdisable(deviceId: string, portId: string): void {
    const p = this.getPort({ deviceId, portId });
    if (p?.errdisabled) {
      delete p.errdisabled;
      this.refreshLinks();
    }
  }

  // ------------------------------------------------------------ Dienste (Hosts)

  private host(deviceId: string): (Device & { config: HostConfig }) | undefined {
    const d = this.state.devices[deviceId];
    return d?.config.kind === 'host' ? (d as Device & { config: HostConfig }) : undefined;
  }

  setHostDhcp(deviceId: string, on: boolean): Result<true> {
    const dev = this.host(deviceId);
    if (!dev) return { ok: false, error: 'ip.notAHost' };
    if (on) {
      dev.config.ip = undefined;
      dev.config.mask = undefined;
      dev.config.gateway = undefined;
      if (dev.powered) this.withCtx(dev, (ctx) => hostDhcp(ctx, dev.config, true));
      else dev.config.dhcpClient.enabled = true;
    } else if (dev.config.dhcpClient.enabled) {
      this.withCtx(dev, (ctx) => hostDhcp(ctx, dev.config, false));
    }
    return { ok: true, value: true };
  }

  setDnsServers(deviceId: string, servers: string[]): Result<true> {
    const dev = this.host(deviceId);
    if (!dev) return { ok: false, error: 'ip.notAHost' };
    if (servers.some((x) => !isValidIpv4(x))) return { ok: false, error: 'ip.invalidIp' };
    dev.config.dnsServers = servers;
    dev.config.dnsCache = {};
    return { ok: true, value: true };
  }

  /** Server-Dienste (HTTP/DNS/DHCP) eines Hosts konfigurieren. */
  setService(
    deviceId: string,
    patch: {
      http?: Partial<HostConfig['services']['http']>;
      dns?: Partial<HostConfig['services']['dns']>;
      dhcp?: Partial<HostConfig['services']['dhcp']>;
    },
  ): Result<true> {
    const dev = this.host(deviceId);
    if (!dev) return { ok: false, error: 'ip.notAHost' };
    Object.assign(dev.config.services.http, patch.http);
    Object.assign(dev.config.services.dns, patch.dns);
    Object.assign(dev.config.services.dhcp, patch.dhcp);
    return { ok: true, value: true };
  }

  /** HTTP(S)-Abruf (Browser): Ergebnis in `config.requests`. */
  httpGet(deviceId: string, url: string): Result<number> {
    const dev = this.host(deviceId);
    if (!dev) return { ok: false, error: 'ip.notAHost' };
    if (!dev.powered || dev.crashed) return { ok: false, error: 'dev.off' };
    return { ok: true, value: this.withCtx(dev, (ctx) => hostHttp(ctx, dev.config, url)) };
  }

  /** Namensauflösung (`nslookup`): Ergebnis in `config.dnsResults`. */
  resolveName(deviceId: string, name: string): Result<{ id?: number; cached?: string }> {
    const dev = this.host(deviceId);
    if (!dev) return { ok: false, error: 'ip.notAHost' };
    if (!dev.powered || dev.crashed) return { ok: false, error: 'dev.off' };
    const r = this.withCtx(dev, (ctx) => hostResolve(ctx, dev.config, name));
    return r.error ? { ok: false, error: r.error } : { ok: true, value: r };
  }

  /** Werkseinstellungen für Router/Switch (Startup-Config bleibt erhalten) – Basis für `reload`. */
  factoryReset(deviceId: string): void {
    const dev = this.state.devices[deviceId];
    const spec = dev ? CATALOG[dev.type] : undefined;
    if (!dev || !spec) return;
    if (dev.config.kind !== 'router' && dev.config.kind !== 'switch') return;
    const startup = dev.config.sys.startupConfig;
    const keyBits = dev.config.sys.mgmt?.ssh.keyBits; // RSA-Schlüssel überstehen `reload` (NVRAM)
    dev.config = spec.makeConfig(dev.name, dev.ports);
    if (dev.config.kind === 'router' || dev.config.kind === 'switch') {
      dev.config.sys.startupConfig = startup;
      if (keyBits !== undefined) mgmtOf(dev.config.sys).ssh.keyBits = keyBits;
    }
    for (const p of dev.ports) {
      p.adminUp = !spec.portsDefaultDown;
      p.speed = 'auto';
      p.duplex = 'auto';
      p.mtu = 1500;
      delete p.errdisabled;
    }
    heapRemove(this.state.queue, (e) => e.deviceId === deviceId);
    this.refreshLinks();
    this.startTimers(dev);
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
      else if (pa.errdisabled || pb.errdisabled) reason = 'link.reason.errdisable';
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
    this.refreshSwitches();
  }

  /** Trunk-Aushandlung (DTP) und EtherChannel-Bündelung je Switch neu berechnen. */
  private refreshSwitches(): void {
    const peerPort = (dev: Device, portId: string): { dev: Device; port: Port } | undefined => {
      const p = dev.ports.find((x) => x.id === portId);
      const link = p?.linkId ? this.state.links[p.linkId] : undefined;
      if (!link) return undefined;
      const ref = link.a.deviceId === dev.id && link.a.portId === portId ? link.b : link.a;
      const pd = this.state.devices[ref.deviceId];
      const pp = pd?.ports.find((x) => x.id === ref.portId);
      return pd && pp ? { dev: pd, port: pp } : undefined;
    };
    const compat = (a?: string, b?: string): boolean =>
      (a === 'on' && b === 'on') ||
      ((a === 'active' || a === 'passive') &&
        (b === 'active' || (b === 'passive' && a === 'active'))) ||
      ((a === 'desirable' || a === 'auto') &&
        (b === 'desirable' || (b === 'auto' && a === 'desirable')));
    for (const dev of Object.values(this.state.devices)) {
      if (dev.config.kind !== 'switch') continue;
      const cfg = dev.config;
      const trunk: Record<string, boolean> = {};
      for (const p of dev.ports) {
        const pc = cfg.ports[p.id];
        if (!pc || pc.routed) continue;
        let t = pc.mode === 'trunk';
        if (pc.mode === 'dynamic-auto' || pc.mode === 'dynamic-desirable') {
          const peer = peerPort(dev, p.id);
          const pm =
            peer?.dev.config.kind === 'switch'
              ? peer.dev.config.ports[peer.port.id]?.mode
              : undefined;
          if (pm) {
            t =
              pc.mode === 'dynamic-desirable'
                ? pm === 'trunk' || pm === 'dynamic-desirable' || pm === 'dynamic-auto'
                : pm === 'trunk' || pm === 'dynamic-desirable';
          }
        }
        if (t) trunk[p.id] = true;
      }
      const bundles: Record<number, string[]> = {};
      const groups: Record<number, string[]> = {};
      for (const p of dev.ports) {
        const n = cfg.ports[p.id]?.channel;
        if (n !== undefined && p.operUp) (groups[n] ??= []).push(p.id);
      }
      for (const [n, members] of Object.entries(groups)) {
        const peers = members.map((m) => peerPort(dev, m));
        const first = peers[0];
        const ok =
          first?.dev.config.kind === 'switch' &&
          peers.every((q) => q?.dev.id === first.dev.id) &&
          peers.every((q) => {
            const qc = q?.dev.config;
            const mine = cfg.ports[members[peers.indexOf(q)] as string];
            const theirs = qc?.kind === 'switch' ? qc.ports[q?.port.id as string] : undefined;
            return theirs?.channel !== undefined && compat(mine?.channelMode, theirs.channelMode);
          }) &&
          new Set(
            peers.map((q) =>
              q?.dev.config.kind === 'switch' ? q.dev.config.ports[q.port.id]?.channel : -1,
            ),
          ).size === 1;
        if (ok) bundles[Number(n)] = members;
      }
      cfg.operTrunk = trunk;
      cfg.bundles = bundles;
      const sig = JSON.stringify([
        trunk,
        bundles,
        dev.ports.map((p) => p.operUp),
        Object.keys(cfg.vlans),
        Object.values(cfg.ports).map((q) => [
          q.accessVlan,
          q.allowed,
          q.portfast,
          q.routed,
          q.nativeVlan,
        ]),
      ]);
      if (this.switchSig.get(dev.id) !== sig) {
        this.switchSig.set(dev.id, sig);
        const sw = dev as SwitchDev;
        this.withCtx(dev, (ctx) => {
          stpPortsChanged(ctx, sw);
          if (Object.keys(trunk).length) vtpSend(ctx, sw);
        });
      }
    }
  }

  private setPortOper(dev: Device, p: Port, up: boolean, reason?: string): void {
    if (p.operUp === up) return;
    p.operUp = up;
    if (!up) {
      if (dev.config.kind === 'switch') {
        const sw = dev as SwitchDev;
        this.withCtx(dev, (ctx) => switchPortDown(ctx, sw, p.id));
      }
      p.txBusyUntil = 0;
    }
    if ((dev.config.kind === 'router' || dev.config.kind === 'switch') && dev.powered)
      this.withCtx(dev, (ctx) => routingSync(ctx, dev as L3Dev));
    if (dev.config.kind === 'host' && dev.powered && up) {
      const h = dev.config;
      this.withCtx(dev, (ctx) => hostV6(ctx, h));
    }
    this.p5.linkChanged(dev, p, up);
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

  macTable(deviceId: string): { mac: string; vlan: number; portId: string; ageSec: number }[] {
    const dev = this.state.devices[deviceId];
    return dev?.config.kind === 'switch' ? activeMacTable(dev.config, this.state.now) : [];
  }

  arpTable(deviceId: string): { ip: string; mac: string }[] {
    const dev = this.state.devices[deviceId];
    if (
      !dev ||
      dev.config.kind === 'hub' ||
      dev.config.kind === 'none' ||
      dev.config.kind === 'bridge'
    )
      return [];
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

  /** Anzahl der Vordergrund-Ereignisse (ohne periodische Hintergrund-Timer wie STP). */
  get queueLength(): number {
    return this.state.queue.filter((e) => !(e.kind === 'timer' && e.payload.name.startsWith('bg:')))
      .length;
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
    this.refreshWanted = false;
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
      if (this.refreshWanted) this.refreshLinks();
      if (this.wifiWanted) {
        this.wifiWanted = false;
        this.p5.wirelessSync();
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

  /** Läuft, bis nur noch Hintergrund-Timer übrig sind (oder `maxEvents` erreicht – Schutz vor Broadcast-Stürmen). */
  runAll(maxEvents = 100_000): number {
    let n = 0;
    while (this.hasForeground() && n < maxEvents) {
      this.step();
      n++;
    }
    return n;
  }

  /** Gibt es Ereignisse außer periodischen Hintergrund-Timern (STP, VTP)? */
  hasForeground(): boolean {
    return this.state.queue.some((e) => !(e.kind === 'timer' && e.payload.name.startsWith('bg:')));
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
        case 'router':
          routerRx(ctx, dev as L3Dev, p.portId, p.frame, fromId);
          break;
        case 'switch':
          switchRx(ctx, dev as SwitchDev, p.portId, p.frame, fromId);
          break;
        case 'hub':
          hubRx(ctx, cfg, p.portId, p.frame, p.txId, fromId);
          break;
        case 'bridge':
          bridgeRx(ctx, cfg, p.portId, p.frame, fromId);
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
    const name = p.name.startsWith('bg:') ? p.name.slice(3) : p.name;
    if (name.startsWith('svc:')) {
      this.withCtx(dev, (ctx) => this.p5.timer(ctx, dev, name.slice(4)));
      return;
    }
    if (cfg.kind === 'host') this.withCtx(dev, (ctx) => hostTimer(ctx, cfg, name));
    else if (cfg.kind === 'router') this.withCtx(dev, (ctx) => l3Timer(ctx, dev as L3Dev, name));
    else if (cfg.kind === 'switch') {
      this.withCtx(dev, (ctx) => {
        if (/^(arp|ping|ping-timeout|trace-timeout|rt|nd|ra):/.test(name))
          l3Timer(ctx, dev as L3Dev, name);
        else switchTimer(ctx, dev as SwitchDev, name);
      });
    }
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
      debug: e.debug,
    });
  }

  withCtx<T>(dev: Device, fn: (ctx: DeviceCtx) => T): T {
    const eng = this;
    const s = this.state;
    const ctx: DeviceCtx = {
      now: s.now,
      device: dev,
      processingUs: s.config.processingUs,
      propagationUs: s.config.propagationUs,
      rand: (max) => eng.rand(max),
      deviceIfaceName: (id) => ifaceName(dev, id),
      requestRefresh: () => {
        eng.refreshWanted = true;
      },
      requestWifiSync: () => {
        eng.wifiWanted = true;
      },
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
