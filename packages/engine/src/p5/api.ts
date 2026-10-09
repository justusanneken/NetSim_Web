import { isValidIpv4, macFromCounter, type Ipv4Addr, type SvcProto } from '@netsim/protocols';
import type { Engine } from '../engine';
import type { DeviceCtx } from '../ctx';
import { CATALOG, MODULES } from '../catalog';
import { CHANNELS, HOST_EPOCH_MS, mgmtOf, newClock } from '../p5defaults';
import type {
  AppConn,
  IotCfg,
  MailMsg,
  MgmtCfg,
  Radio,
  ServerSvc5,
  UdpReq,
  WifiBand,
  Wlan,
} from '../p5types';
import type { Device, HostConfig, Port, Result, RouterConfig, SwitchConfig } from '../types';
import { apBss, wirelessSync } from './wifi';
import { capwapTick } from './capwap';
import { clockOf, deviceTimeMs, setDeviceTime } from './clock';
import { connClose, connOpen, connSend } from './conn';
import { svcTimer } from './dispatch';
import { iotTick } from './iot';
import { appcOf, ipNodeOf } from './node';
import {
  ensureLocation,
  physicalOf,
  removeLocation,
  parseLocation,
  type LocPath,
} from './physical';
import { ntpPoll, ntpServersOf } from './services';
import { syslogEmit } from './syslog';
import { udpRequest } from './udputil';

const err = (error: string, params?: Record<string, string | number>): Result<never> => ({
  ok: false,
  error,
  params,
});
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

const NTP_INTERVAL_US = 64_000_000;

type CliCfg = RouterConfig | SwitchConfig;

/**
 * Phase-5-Schnittstelle der Engine (`engine.p5`): WLAN, Server-Dienste, Management (SSH/Telnet, NTP,
 * Syslog, SNMP, AAA), Firewall, IoT, Cloud/Modem, Module und Physical View. Neuer Code lebt in
 * `engine/src/p5/*`, damit Phase-5-Änderungen die gemeinsamen Dateien kaum berühren.
 */
export class Phase5 {
  constructor(private readonly eng: Engine) {}

  private dev(id: string): Device | undefined {
    return this.eng.state.devices[id];
  }
  private host(id: string): (Device & { config: HostConfig }) | undefined {
    const d = this.dev(id);
    return d?.config.kind === 'host' ? (d as Device & { config: HostConfig }) : undefined;
  }
  private cli(id: string): (Device & { config: CliCfg }) | undefined {
    const d = this.dev(id);
    return d && (d.config.kind === 'router' || d.config.kind === 'switch')
      ? (d as Device & { config: CliCfg })
      : undefined;
  }

  // ------------------------------------------------------------ Engine-Hooks

  wirelessSync(): void {
    wirelessSync(this.eng);
  }

  /** Hintergrund-Timer der Dienste (WLC-Join, NTP, IoT) für ein Gerät (neu) aufziehen. */
  startTimers(dev: Device): void {
    if (!dev.powered) return;
    const wants: [string, number][] = [];
    if (dev.config.kind === 'host') {
      if (dev.config.ap?.wlc) wants.push(['bg:svc:capwap', 1_000_000]);
      if (dev.config.iot?.server) wants.push(['bg:svc:iot', 2_000_000]);
    }
    if (ntpServersOf(dev).length > 0) wants.push(['bg:svc:ntp', 2_000_000]);
    if (wants.length === 0) return;
    this.eng.withCtx(dev, (ctx) => {
      for (const [name, delay] of wants) ctx.setTimer(name, delay);
    });
  }

  /** Laufzeitzustand der Dienste beim Ausschalten/Zurücksetzen verwerfen. */
  powerOff(dev: Device): void {
    const c = dev.config;
    this.dropRemotePeers(dev);
    if (c.kind === 'host' || c.kind === 'router' || c.kind === 'switch') c.appc = undefined;
    if (c.kind === 'host') {
      if (c.ap) {
        c.ap.macTable = {};
        c.ap.managed = undefined;
      }
      if (c.wlc) c.wlc.aps = {};
      if (c.iot) c.iot.registered = false;
      if (c.mail) c.mail.status = undefined;
    } else if (c.kind === 'router' || c.kind === 'switch') {
      if (c.sys.mgmt) c.sys.mgmt.sessions = [];
      if (c.kind === 'router' && c.fw) c.fw.conns = [];
    } else if (c.kind === 'bridge') c.macTable = {};
  }

  /**
   * Telnet/SSH: verschwindet der Client (aus, entfernt, zurückgesetzt), räumt die Gegenstelle ihre vty-Sitzung
   * sofort ab (Vereinfachung statt exec-timeout), damit keine Leitungen dauerhaft belegt bleiben.
   */
  private dropRemotePeers(dev: Device): void {
    const c = dev.config;
    if (c.kind !== 'host' && c.kind !== 'router' && c.kind !== 'switch') return;
    for (const conn of Object.values(c.appc?.conns ?? {})) {
      if (conn.role !== 'c' || (conn.proto !== 'telnet' && conn.proto !== 'ssh')) continue;
      const peer = this.cli(String(conn.banner?.args.dev ?? ''));
      const sk = String(conn.banner?.args.sk ?? '');
      const sconn = peer?.config.appc?.conns[sk];
      if (!peer || !sconn) continue;
      delete peer.config.appc?.conns[sk];
      const m = peer.config.sys.mgmt;
      if (m && sconn.vty !== undefined) m.sessions = m.sessions.filter((x) => x.line !== sconn.vty);
    }
  }

  timer(ctx: DeviceCtx, dev: Device, name: string): void {
    if (name === 'capwap') return capwapTick(ctx, dev);
    if (name === 'ntp') {
      ntpPoll(ctx, dev);
      if (ntpServersOf(dev).length > 0) ctx.setTimer('bg:svc:ntp', NTP_INTERVAL_US);
      return;
    }
    if (name === 'iot') {
      iotTick(ctx, dev);
      const iot = dev.config.kind === 'host' ? dev.config.iot : undefined;
      if (iot?.server) ctx.setTimer('bg:svc:iot', Math.max(1, iot.reportSec) * 1_000_000);
      return;
    }
    const node = ipNodeOf(ctx, dev);
    if (node) svcTimer(ctx, node, name);
  }

  /** Link-Status eines Ports hat sich geändert: Syslog-Meldungen der IOS-Geräte. */
  linkChanged(dev: Device, p: Port, up: boolean): void {
    if (!dev.powered || (dev.config.kind !== 'router' && dev.config.kind !== 'switch')) return;
    const state = up ? 'up' : 'down';
    this.eng.withCtx(dev, (ctx) => {
      syslogEmit(ctx, dev, 3, 'LINK-3-UPDOWN', `Interface ${p.name}, changed state to ${state}`);
      syslogEmit(
        ctx,
        dev,
        5,
        'LINEPROTO-5-UPDOWN',
        `Line protocol on Interface ${p.name}, changed state to ${state}`,
      );
    });
  }

  /** Syslog-Meldung eines CLI-Geräts auslösen (z. B. `%SYS-5-CONFIG_I`). */
  syslog(deviceId: string, sev: number, tag: string, text: string): void {
    const d = this.dev(deviceId);
    if (d?.powered) this.eng.withCtx(d, (ctx) => syslogEmit(ctx, d, sev, tag, text));
  }

  // ------------------------------------------------------------ WLAN

  setApRadio(id: string, band: WifiBand, patch: Partial<Omit<Radio, 'band'>>): Result<true> {
    const h = this.host(id);
    const r = h?.config.ap?.radios.find((x) => x.band === band);
    if (!h || !r) return err('wifi.notAnAp');
    if (patch.channel !== undefined && !CHANNELS[band].includes(patch.channel))
      return err('wifi.invalidChannel');
    if (patch.security === 'wpa2-psk' || (patch.key !== undefined && r.security === 'wpa2-psk')) {
      const key = patch.key ?? r.key ?? '';
      if (key.length < 8 || key.length > 63) return err('wifi.invalidKey');
    }
    Object.assign(r, patch);
    if (r.security === 'open') delete r.key;
    wirelessSync(this.eng);
    return ok(true);
  }

  setApController(id: string, ip: string): Result<true> {
    const h = this.host(id);
    if (!h?.config.ap) return err('wifi.notAnAp');
    if (ip !== '' && !isValidIpv4(ip)) return err('ip.invalidIp');
    h.config.ap.wlc = ip === '' ? undefined : ip;
    if (ip === '') h.config.ap.managed = undefined;
    this.startTimers(h);
    wirelessSync(this.eng);
    return ok(true);
  }

  wifiAddProfile(id: string, ssid: string, key?: string): Result<true> {
    const h = this.host(id);
    const w = h?.config.wifi;
    if (!h || !w) return err('wifi.noWifi');
    if (ssid.trim() === '') return err('wifi.invalidSsid');
    if (key !== undefined && key !== '' && (key.length < 8 || key.length > 63))
      return err('wifi.invalidKey');
    w.profiles = w.profiles.filter((p) => p.ssid !== ssid);
    w.profiles.unshift({ ssid, key: key === '' ? undefined : key });
    w.status = 'idle';
    wirelessSync(this.eng);
    return ok(true);
  }

  wifiRemoveProfile(id: string, ssid: string): Result<true> {
    const h = this.host(id);
    const w = h?.config.wifi;
    if (!h || !w) return err('wifi.noWifi');
    w.profiles = w.profiles.filter((p) => p.ssid !== ssid);
    wirelessSync(this.eng);
    return ok(true);
  }

  wifiEnable(id: string, on: boolean): Result<true> {
    const h = this.host(id);
    if (!h?.config.wifi) return err('wifi.noWifi');
    h.config.wifi.enabled = on;
    wirelessSync(this.eng);
    return ok(true);
  }

  /** WLAN am WLC anlegen/ändern (`id` fehlt = neu). */
  wlcSetWlan(id: string, w: Omit<Wlan, 'id'> & { id?: number }): Result<number> {
    const h = this.host(id);
    const wlc = h?.config.wlc;
    if (!h || !wlc) return err('wifi.notAWlc');
    if (w.ssid.trim() === '') return err('wifi.invalidSsid');
    if (w.security === 'wpa2-psk' && ((w.key ?? '').length < 8 || (w.key ?? '').length > 63))
      return err('wifi.invalidKey');
    const wid = w.id ?? Math.max(0, ...wlc.wlans.map((x) => x.id)) + 1;
    const next: Wlan = { ...w, id: wid, key: w.security === 'open' ? undefined : w.key };
    const i = wlc.wlans.findIndex((x) => x.id === wid);
    if (i >= 0) wlc.wlans[i] = next;
    else wlc.wlans.push(next);
    return ok(wid);
  }

  wlcRemoveWlan(id: string, wlanId: number): Result<true> {
    const wlc = this.host(id)?.config.wlc;
    if (!wlc) return err('wifi.notAWlc');
    wlc.wlans = wlc.wlans.filter((x) => x.id !== wlanId);
    return ok(true);
  }

  /** Ausgesendete Netze eines APs (für Anzeige/Tests). */
  apNetworks(id: string) {
    const h = this.host(id);
    return h ? apBss(h.config) : [];
  }

  // ------------------------------------------------------------ Server-Dienste

  /** Server-Dienste (FTP, TFTP, Mail, NTP, Syslog, SNMP, AAA, IoT) ersetzen. */
  setServices(id: string, patch: Partial<ServerSvc5>): Result<true> {
    const h = this.host(id);
    if (!h) return err('ip.notAHost');
    Object.assign(h.config.services, structuredClone(patch));
    this.startTimers(h);
    return ok(true);
  }

  /** Mail-Konto/-Server des Clients. */
  setMailAccount(id: string, a: { server?: Ipv4Addr; user: string; pass: string }): Result<true> {
    const h = this.host(id);
    if (!h) return err('ip.notAHost');
    if (a.server && !isValidIpv4(a.server)) return err('ip.invalidIp');
    const m = (h.config.mail ??= { user: '', pass: '', inbox: [], sent: [] });
    m.server = a.server || undefined;
    m.user = a.user;
    m.pass = a.pass;
    return ok(true);
  }

  private mailStart(
    id: string,
    purpose: 'mail-send' | 'mail-fetch',
    proto: SvcProto,
    first: NonNullable<AppConn['first']>,
    data?: AppConn['data'],
  ): Result<true> {
    const h = this.host(id);
    const m = h?.config.mail;
    if (!h || !m?.server || !m.user) return err('mail.notConfigured');
    if (!h.powered) return err('dev.off');
    m.status = { key: 'mail.working' };
    const dst = m.server;
    const r = this.eng.withCtx(h, (ctx) => {
      const node = ipNodeOf(ctx, h);
      return node ? connOpen(ctx, node, { dst, proto }) : undefined;
    });
    if (!r?.ok) {
      m.status = { key: 'mail.timeout' };
      return err('conn.unreachable');
    }
    const c = appcOf(h.config).conns[r.key];
    if (c) {
      c.first = first;
      c.purpose = purpose;
      c.data = data;
    }
    return ok(true);
  }

  mailSend(id: string, to: string, subject: string, body: string): Result<true> {
    const m = this.host(id)?.config.mail;
    if (!m) return err('mail.notConfigured');
    return this.mailStart(
      id,
      'mail-send',
      'smtp',
      { op: 'send', args: { from: m.user, to, subject, pass: m.pass }, body },
      { to, subject, body },
    );
  }

  mailFetch(id: string): Result<true> {
    const m = this.host(id)?.config.mail;
    if (!m) return err('mail.notConfigured');
    return this.mailStart(id, 'mail-fetch', 'pop3', {
      op: 'fetch',
      args: { user: m.user.split('@')[0] ?? m.user, pass: m.pass },
    });
  }

  // ------------------------------------------------------------ Client-Anfragen (CLI, Apps)

  /** UDP-Dienstanfrage (TFTP, SNMP, NTP …) von einem Gerät aus; Ergebnis über `reqStatus`. */
  request(
    id: string,
    dst: string,
    proto: SvcProto,
    op: string,
    args: Record<string, string | number | boolean> = {},
    body?: string,
  ): Result<number> {
    const d = this.dev(id);
    if (!d) return err('cable.reject.notFound');
    if (!d.powered || d.crashed) return err('dev.off');
    if (!isValidIpv4(dst)) return err('ip.invalidIp');
    const r = this.eng.withCtx(d, (ctx) => {
      const node = ipNodeOf(ctx, d);
      return node ? udpRequest(ctx, node, { dst, proto, op, args, body }) : undefined;
    });
    if (!r) return err('ip.notAHost');
    return r.ok ? ok(r.id) : err(r.error);
  }

  reqStatus(id: string, reqId: number): UdpReq | undefined {
    const d = this.dev(id);
    const c = d?.config;
    if (!c || !('appc' in c) || !c.appc) return undefined;
    return c.appc.reqs[reqId];
  }

  /** TCP-Dienstverbindung öffnen (Telnet, SSH, FTP). */
  open(id: string, dst: string, proto: SvcProto, port?: number): Result<string> {
    const d = this.dev(id);
    if (!d) return err('cable.reject.notFound');
    if (!d.powered || d.crashed) return err('dev.off');
    if (!isValidIpv4(dst)) return err('ip.invalidIp');
    const r = this.eng.withCtx(d, (ctx) => {
      const node = ipNodeOf(ctx, d);
      return node ? connOpen(ctx, node, { dst, proto, port }) : undefined;
    });
    if (!r) return err('ip.notAHost');
    return r.ok ? ok(r.key) : err(r.error);
  }

  connState(id: string, key: string): AppConn | undefined {
    const c = this.dev(id)?.config;
    return c && 'appc' in c ? c.appc?.conns[key] : undefined;
  }

  send(
    id: string,
    key: string,
    op: string,
    args: Record<string, string | number | boolean> = {},
    body?: string,
  ): boolean {
    const d = this.dev(id);
    if (!d) return false;
    return this.eng.withCtx(d, (ctx) => {
      const node = ipNodeOf(ctx, d);
      return node ? connSend(ctx, node, key, op, args, body) : false;
    });
  }

  close(id: string, key: string): void {
    const d = this.dev(id);
    if (!d) return;
    this.eng.withCtx(d, (ctx) => {
      const node = ipNodeOf(ctx, d);
      if (node) connClose(ctx, node, key);
    });
  }

  /** NTP-Abfrage sofort auslösen. */
  ntpNow(id: string): void {
    const d = this.dev(id);
    if (d?.powered) this.eng.withCtx(d, (ctx) => ntpPoll(ctx, d));
  }

  /** Server für die Zeitsynchronisation eines Hosts. */
  setHostNtp(id: string, server: string): Result<true> {
    const h = this.host(id);
    if (!h) return err('ip.notAHost');
    if (server !== '' && !isValidIpv4(server)) return err('ip.invalidIp');
    h.config.ntpServer = server === '' ? undefined : server;
    if (server === '' && h.config.clock) h.config.clock.syncedTo = undefined;
    this.startTimers(h);
    return ok(true);
  }

  // ------------------------------------------------------------ Uhr

  clockMs(id: string): number | undefined {
    const d = this.dev(id);
    return d ? deviceTimeMs(d, this.eng.state.now) : undefined;
  }

  setClock(id: string, epochMs: number): Result<true> {
    const d = this.dev(id);
    const c = d ? clockOf(d) : undefined;
    if (!d || !c) return err('ip.notAHost');
    setDeviceTime(d, this.eng.state.now, epochMs);
    c.syncedTo = undefined;
    c.stratum = 16;
    return ok(true);
  }

  // ------------------------------------------------------------ Management (Router/Switch/Firewall)

  mgmt(id: string): MgmtCfg | undefined {
    const d = this.cli(id);
    return d ? mgmtOf(d.config.sys) : undefined;
  }

  /** Abschnitte der Management-Konfiguration ersetzen (GUI). */
  setMgmt(
    id: string,
    patch: Partial<Pick<MgmtCfg, 'users' | 'ssh' | 'vty' | 'ntp' | 'syslog' | 'snmp' | 'aaa'>>,
  ): Result<true> {
    const d = this.cli(id);
    if (!d) return err('ip.notARouter');
    const m = mgmtOf(d.config.sys);
    for (const h of [...(patch.ntp?.servers ?? []), ...(patch.syslog?.hosts ?? [])])
      if (!isValidIpv4(h)) return err('ip.invalidIp');
    Object.assign(m, structuredClone(patch));
    // `no ntp server`: ein entfernter Zeitgeber verliert sofort seine Synchronisation
    if (m.clock.syncedTo !== undefined && !m.ntp.servers.includes(m.clock.syncedTo)) {
      m.clock.syncedTo = undefined;
      m.clock.stratum = 16;
    }
    this.startTimers(d);
    return ok(true);
  }

  // ------------------------------------------------------------ IoT

  setIot(id: string, patch: Partial<IotCfg>): Result<true> {
    const h = this.host(id);
    if (!h?.config.iot) return err('iot.notIot');
    if (patch.server && !isValidIpv4(patch.server)) return err('ip.invalidIp');
    const iot = h.config.iot;
    const serverChanged = patch.server !== undefined && patch.server !== iot.server;
    Object.assign(iot, patch);
    if (iot.server === '') iot.server = undefined;
    if (serverChanged) iot.registered = false;
    this.startTimers(h);
    if (h.powered && iot.server) this.eng.withCtx(h, (ctx) => iotTick(ctx, h));
    return ok(true);
  }

  // ------------------------------------------------------------ Cloud / Modem

  setBridgeGroup(id: string, portId: string, group: number): Result<true> {
    const d = this.dev(id);
    if (d?.config.kind !== 'bridge') return err('bridge.notABridge');
    if (d.config.fixed) return err('bridge.fixed');
    if (!d.ports.some((p) => p.id === portId)) return err('cable.reject.notFound');
    if (!Number.isInteger(group) || group < 0 || group > 8) return err('bridge.invalidGroup');
    d.config.groups[portId] = group;
    d.config.macTable = {};
    return ok(true);
  }

  // ------------------------------------------------------------ Module

  insertModule(id: string, slot: number, name: string): Result<true> {
    const d = this.dev(id);
    const spec = d ? CATALOG[d.type] : undefined;
    const mod = MODULES[name];
    const sl = spec?.slots?.[slot];
    if (!d || !spec || !sl) return err('module.noSlot');
    if (!mod || !sl.accepts.includes(name)) return err('module.incompatible');
    if (d.powered) return err('module.needPowerOff');
    const cur = d.modules[slot];
    if (cur?.module) return err('module.slotUsed');
    const base = d.ports.length;
    const s = this.eng.state;
    const isRouter = d.config.kind === 'router';
    mod.ports.forEach((ps, i) => {
      d.ports.push({
        id: `p${base + i}`,
        name: /\d$/.test(ps.name) ? ps.name : `${ps.name}${slot + 1}/${i}`,
        kind: ps.kind,
        mac: macFromCounter(++s.macCounter),
        adminUp: !isRouter,
        operUp: false,
        speed: 'auto',
        duplex: 'auto',
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
      });
    });
    d.modules[slot] = { id: `m${slot}`, name: sl.name, module: name };
    return ok(true);
  }

  removeModule(id: string, slot: number): Result<true> {
    const d = this.dev(id);
    const m = d?.modules[slot];
    if (!d || !m?.module) return err('module.empty');
    if (d.powered) return err('module.needPowerOff');
    const mod = MODULES[m.module];
    if (!mod) return err('module.empty');
    // Die zuletzt hinzugefügten Ports gehören zu diesem Modul (Module werden in Steckreihenfolge entfernt).
    const drop = d.ports.slice(d.ports.length - mod.ports.length);
    for (const p of drop) if (p.linkId) this.eng.disconnect(p.linkId);
    d.ports.length -= mod.ports.length;
    if (d.config.kind === 'router' || d.config.kind === 'switch')
      for (const p of drop) delete d.config.ifaces[p.id];
    d.modules[slot] = { id: m.id, name: m.name };
    return ok(true);
  }

  // ------------------------------------------------------------ Physical View

  addLocation(path: string): Result<true> {
    const p = parseLocation(path);
    if (!p) return err('physical.invalidPath');
    ensureLocation(physicalOf(this.eng.state), p);
    return ok(true);
  }

  deleteLocation(path: string): Result<true> {
    const p = parseLocation(path);
    if (!p) return err('physical.invalidPath');
    removeLocation(physicalOf(this.eng.state), p);
    for (const d of Object.values(this.eng.state.devices)) {
      const l = parseLocation(d.physical.location);
      if (l && withinPath(l, p)) {
        d.physical.location = undefined;
        d.physical.rackPos = undefined;
      }
    }
    this.wirelessSync();
    return ok(true);
  }

  /** Gerät in Raum/Rack platzieren (`path` leer = entfernen). */
  placeDevice(id: string, path: string, rackPos?: number): Result<true> {
    const d = this.dev(id);
    if (!d) return err('cable.reject.notFound');
    if (path === '') {
      d.physical = {};
    } else {
      const p = parseLocation(path);
      if (!p) return err('physical.invalidPath');
      ensureLocation(physicalOf(this.eng.state), p);
      d.physical = { location: path, rackPos };
    }
    this.wirelessSync();
    return ok(true);
  }

  setPower(id: string, on: boolean): void {
    this.eng.setPower(id, on);
  }

  mailInbox(id: string): MailMsg[] {
    return this.host(id)?.config.mail?.inbox ?? [];
  }

  /** Uhr zurücksetzen (Standard). */
  resetClock(id: string): void {
    const d = this.dev(id);
    const c = d ? clockOf(d) : undefined;
    if (d && c) Object.assign(c, newClock(d.config.kind === 'host' ? HOST_EPOCH_MS : c.baseMs));
  }
}

function withinPath(l: LocPath, p: LocPath): boolean {
  if (l.city !== p.city) return false;
  if (p.building && l.building !== p.building) return false;
  if (p.room && l.room !== p.room) return false;
  if (p.rack && l.rack !== p.rack) return false;
  return true;
}
