import { isValidIpv4, parseIpv4 } from '@netsim/protocols';
import { z } from 'zod';
import type { Engine } from '../engine';
import { ifaceUp } from '../ifaces';
import type {
  AddrMatch,
  Device,
  HostConfig,
  L3Cfg,
  Msg,
  RouterConfig,
  SwitchConfig,
} from '../types';
import { cloneEngine } from './clone';
import { PduSpecSchema, findDevice, runAttempt, type PduProtocol } from './pdu';
import { netNum, normMask, plenOf, resolveIface, resolvePort } from './ref';

/**
 * Aufgabenpruefungen als Zustandspraedikate. Nie Textvergleich der Konfiguration: es wird der geparste Zustand
 * der Engine befragt (Schnittstellen, VLANs, Routen, ACL-Eintraege, NAT-Regeln …) bzw. Verkehr auf einer
 * Kopie des Netzes simuliert (Ping, Dienstzugriff). Die Auswertung ist deterministisch.
 */

const dev = z.string().min(1).max(64);
/** Text in einer oder mehreren Sprachen (`{ de, en }`); ein einfacher String gilt fuer alle Sprachen. */
export const LTextSchema = z.union([
  z.string().max(4000),
  z.object({ de: z.string().max(4000).optional(), en: z.string().max(4000).optional() }),
]);
export type LText = z.infer<typeof LTextSchema>;

/** Waehlt die Sprachfassung (Fallback: andere Sprache, dann leer). */
export function pickText(t: LText | undefined, lang: string): string {
  if (t === undefined) return '';
  if (typeof t === 'string') return t;
  return (lang === 'en' ? (t.en ?? t.de) : (t.de ?? t.en)) ?? '';
}

const wi = {
  id: z.string().min(1).max(40),
  weight: z.number().min(0.1).max(100).default(1),
  /** Eigene Beschriftung; sonst wird sie aus der Pruefung abgeleitet. */
  label: LTextSchema.optional(),
  hint: LTextSchema.optional(),
};
const ip4 = z.string().refine((s) => isValidIpv4(s), 'IPv4');
const maskStr = z.string().max(15);

export const ConfigItemSchema = z.discriminatedUnion('item', [
  z.object({ item: z.literal('hostname'), value: z.string().min(1).max(63) }),
  z.object({ item: z.literal('domainName'), value: z.string().min(1).max(63) }),
  z.object({ item: z.literal('enableSecret') }),
  z.object({ item: z.literal('username'), name: z.string().min(1).max(63) }),
  z.object({ item: z.literal('ssh') }),
  z.object({ item: z.literal('ntpServer'), ip: ip4 }),
  z.object({
    item: z.literal('description'),
    iface: z.string().max(64),
    text: z.string().max(200).optional(),
  }),
  z.object({
    item: z.literal('ifaceAcl'),
    iface: z.string().max(64),
    direction: z.enum(['in', 'out']),
    acl: z.string().min(1).max(64),
  }),
  z.object({
    item: z.literal('aclEntry'),
    acl: z.string().min(1).max(64),
    action: z.enum(['permit', 'deny']),
    protocol: z.enum(['ip', 'icmp', 'tcp', 'udp']).optional(),
    /** Zielport (eq) – der Eintrag muss genau diesen Port (oder einen Bereich, der ihn enthaelt) treffen. */
    dstPort: z.number().int().min(1).max(65535).optional(),
    /** `any` oder Netz `a.b.c.d/len`. */
    src: z.string().max(32).optional(),
    dst: z.string().max(32).optional(),
  }),
  z.object({
    item: z.literal('natRole'),
    iface: z.string().max(64),
    side: z.enum(['inside', 'outside']),
  }),
  z.object({ item: z.literal('natOverload') }),
  z.object({ item: z.literal('natStatic'), local: ip4, global: ip4 }),
  z.object({
    item: z.literal('dhcpPool'),
    network: ip4,
    router: ip4.optional(),
    dns: ip4.optional(),
  }),
  z.object({ item: z.literal('helperAddress'), iface: z.string().max(64), ip: ip4 }),
  z.object({
    item: z.literal('ospfNetwork'),
    pid: z.number().int().min(1).max(65535),
    /** Netz, das ueber eine `network`-Anweisung (oder `ip ospf … area`) der Area zugeordnet ist. */
    network: ip4,
    area: z.string().max(15).optional(),
  }),
  z.object({ item: z.literal('portSecurity'), port: z.string().max(64) }),
  z.object({ item: z.literal('portfast'), port: z.string().max(64) }),
  z.object({ item: z.literal('stpMode'), mode: z.enum(['pvst', 'rapid-pvst']) }),
  z.object({
    item: z.literal('vtp'),
    mode: z.enum(['server', 'client', 'transparent']),
    domain: z.string().max(32).optional(),
  }),
  z.object({ item: z.literal('defaultGateway'), ip: ip4 }),
]);
export type ConfigItem = z.infer<typeof ConfigItemSchema>;

export const ROUTE_SOURCES = ['any', 'connected', 'static', 'rip', 'ospf', 'eigrp', 'bgp'] as const;

export const CheckSchema = z.discriminatedUnion('type', [
  z.object({
    ...wi,
    type: z.literal('deviceExists'),
    device: dev,
    deviceType: z.string().max(40).optional(),
  }),
  z.object({
    ...wi,
    type: z.literal('hostIp'),
    device: dev,
    ip: ip4,
    mask: maskStr.optional(),
    gateway: ip4.optional(),
  }),
  z.object({
    ...wi,
    type: z.literal('ifaceIp'),
    device: dev,
    iface: z.string().max(64),
    ip: ip4,
    mask: maskStr.optional(),
  }),
  z.object({
    ...wi,
    type: z.literal('ifaceState'),
    device: dev,
    iface: z.string().max(64),
    up: z.boolean().default(true),
  }),
  z.object({
    ...wi,
    type: z.literal('vlanExists'),
    device: dev,
    vlan: z.number().int().min(1).max(4094),
    name: z.string().max(32).optional(),
  }),
  z.object({
    ...wi,
    type: z.literal('vlanMember'),
    device: dev,
    port: z.string().max(64),
    vlan: z.number().int().min(1).max(4094),
  }),
  z.object({
    ...wi,
    type: z.literal('trunk'),
    device: dev,
    port: z.string().max(64),
    allowed: z.array(z.number().int().min(1).max(4094)).max(200).optional(),
    native: z.number().int().min(1).max(4094).optional(),
  }),
  z.object({
    ...wi,
    type: z.literal('route'),
    device: dev,
    prefix: ip4,
    /** Praefixlaenge (0-32) oder Maske. */
    plen: z.union([z.number().int().min(0).max(32), maskStr]),
    via: ip4.optional(),
    source: z.enum(ROUTE_SOURCES).default('any'),
  }),
  z.object({ ...wi, type: z.literal('config'), device: dev, spec: ConfigItemSchema }),
  z.object({
    ...wi,
    type: z.literal('ping'),
    from: dev,
    to: z.string().min(1).max(64),
    expect: z.enum(['success', 'fail']).default('success'),
  }),
  z.object({
    ...wi,
    type: z.literal('service'),
    from: dev,
    to: z.string().min(1).max(255),
    protocol: PduSpecSchema.shape.protocol,
    port: z.number().int().min(1).max(65535).optional(),
    expect: z.enum(['success', 'fail']).default('success'),
  }),
  z.object({
    ...wi,
    type: z.literal('ospfNeighbors'),
    device: dev,
    min: z.number().int().min(1).max(64).default(1),
  }),
  z.object({ ...wi, type: z.literal('dhcpLease'), device: dev }),
  z.object({
    ...wi,
    type: z.literal('natTranslations'),
    device: dev,
    min: z.number().int().min(1).max(10000).default(1),
  }),
]);
export type Check = z.infer<typeof CheckSchema>;
export type CheckInput = z.input<typeof CheckSchema>;
export type CheckType = Check['type'];

export interface CheckResult {
  id: string;
  passed: boolean;
  weight: number;
  /** Warum die Pruefung scheitert (i18n-Schluessel `check.fail.*`). */
  reason?: Msg;
}

export interface EvalSummary {
  results: CheckResult[];
  /** Summe der Gewichte bestandener / aller Pruefungen. */
  earned: number;
  total: number;
  /** 0-100 (ganzzahlig, gerundet). */
  percent: number;
  passedCount: number;
}

/** Virtuelle Zeit, die die Kopie vor dynamischen Pruefungen (Routing, DHCP, STP) einschwingen darf. */
export const SETTLE_US = 60_000_000;

const ok: Msg | undefined = undefined;
const bad = (key: string, params?: Msg['params']): Msg => ({ key: `check.fail.${key}`, params });

function addrCovers(m: AddrMatch, spec: string | undefined): boolean {
  if (spec === undefined || spec === '') return true;
  if (spec === 'any') return 'any' in m;
  if ('any' in m) return false;
  const [ip, len] = spec.split('/');
  const plen = len === undefined ? 32 : Number(len);
  if (!ip || !isValidIpv4(ip) || !(plen >= 0 && plen <= 32)) return false;
  const wc = parseIpv4(m.wildcard);
  if (wc === undefined) return false;
  // Wildcard -> Praefixlaenge (nur zusammenhaengende Wildcards entsprechen einem Praefix)
  const inv = ~wc >>> 0;
  let aclPlen = 0;
  while (aclPlen < 32 && ((inv >>> (31 - aclPlen)) & 1) === 1) aclPlen++;
  const rest = aclPlen === 32 ? 0 : (inv << aclPlen) >>> 0;
  if (rest !== 0 || aclPlen !== plen) return false;
  return netNum(m.ip, aclPlen) === netNum(ip, aclPlen);
}

function checkConfigItem(d: Device, e: Engine, it: ConfigItem): Msg | undefined {
  const c = d.config;
  const isCli = c.kind === 'router' || c.kind === 'switch';
  if (!isCli) return bad('notCliDevice', { device: d.name });
  const cfg = c as RouterConfig | SwitchConfig;
  const need = (cond: boolean, key: string, params?: Msg['params']): Msg | undefined =>
    cond ? ok : bad(key, params);
  switch (it.item) {
    case 'hostname':
      return need(cfg.sys.hostname.toLowerCase() === it.value.toLowerCase(), 'hostname', {
        expected: it.value,
        actual: cfg.sys.hostname,
      });
    case 'domainName':
      return need(
        (cfg.sys.domainName ?? '').toLowerCase() === it.value.toLowerCase(),
        'domainName',
        { expected: it.value },
      );
    case 'enableSecret':
      return need(!!cfg.sys.enableSecret, 'enableSecret');
    case 'username':
      return need(!!cfg.sys.mgmt?.users[it.name], 'username', { name: it.name });
    case 'ssh':
      return need(
        !!cfg.sys.domainName &&
          cfg.sys.mgmt?.ssh.keyBits !== undefined &&
          cfg.sys.mgmt.vty.transport.includes('ssh'),
        'ssh',
      );
    case 'ntpServer':
      return need(!!cfg.sys.mgmt?.ntp.servers.includes(it.ip), 'ntpServer', { ip: it.ip });
    case 'description': {
      const p = resolvePort(d, it.iface);
      const text = p ? cfg.sys.descriptions[p.id] : undefined;
      return need(!!text && (it.text === undefined || text === it.text), 'description', {
        iface: it.iface,
      });
    }
    case 'ifaceAcl': {
      const i = resolveIface(d, cfg, it.iface);
      if (!i) return bad('noIface', { device: d.name, iface: it.iface });
      const applied = it.direction === 'in' ? i.cfg.aclIn : i.cfg.aclOut;
      return need(applied === it.acl, 'ifaceAcl', {
        iface: it.iface,
        acl: it.acl,
        dir: it.direction,
      });
    }
    case 'aclEntry': {
      const acl = cfg.acls[it.acl];
      if (!acl) return bad('noAcl', { acl: it.acl });
      const hit = acl.entries.some((en) => {
        if (en.action !== it.action) return false;
        if (it.protocol && en.proto !== it.protocol) return false;
        if (it.dstPort !== undefined) {
          const pm = en.dstPort;
          if (!pm) return false;
          const a = pm.a;
          const b = pm.b ?? a;
          const covers =
            pm.op === 'eq'
              ? a === it.dstPort
              : pm.op === 'range' && it.dstPort >= a && it.dstPort <= b;
          if (!covers) return false;
        }
        if (!addrCovers(en.src, it.src)) return false;
        if (it.dst !== undefined && (!en.dst || !addrCovers(en.dst, it.dst))) return false;
        return true;
      });
      return need(hit, 'aclEntry', { acl: it.acl, action: it.action });
    }
    case 'natRole': {
      const i = resolveIface(d, cfg, it.iface);
      if (!i) return bad('noIface', { device: d.name, iface: it.iface });
      return need(i.cfg.natSide === it.side, 'natRole', { iface: it.iface, side: it.side });
    }
    case 'natOverload':
      return need(
        cfg.nat.rules.some((r) => (r.kind === 'dynamic' && r.overload) || r.kind === 'interface'),
        'natOverload',
      );
    case 'natStatic':
      return need(
        cfg.nat.rules.some(
          (r) => r.kind === 'static' && r.local === it.local && r.global === it.global,
        ),
        'natStatic',
        { local: it.local, global: it.global },
      );
    case 'dhcpPool': {
      const pool = cfg.dhcp.pools.find((p) => p.network === it.network);
      if (!pool) return bad('dhcpPool', { network: it.network });
      if (it.router && pool.router !== it.router)
        return bad('dhcpPoolRouter', { router: it.router });
      if (it.dns && !pool.dns.includes(it.dns)) return bad('dhcpPoolDns', { dns: it.dns });
      return ok;
    }
    case 'helperAddress': {
      const i = resolveIface(d, cfg, it.iface);
      if (!i) return bad('noIface', { device: d.name, iface: it.iface });
      return need(!!i.cfg.helpers?.includes(it.ip), 'helper', { iface: it.iface, ip: it.ip });
    }
    case 'ospfNetwork': {
      const o = cfg.routing.ospf[it.pid];
      if (!o) return bad('noOspf', { pid: it.pid });
      const net = parseIpv4(it.network);
      const hit = o.networks.some((n) => {
        const base = parseIpv4(n.prefix);
        const wc = parseIpv4(n.wildcard);
        if (net === undefined || base === undefined || wc === undefined) return false;
        const covered = ((net ^ base) & ~wc & 0xffffffff) === 0;
        return covered && (it.area === undefined || n.area === it.area);
      });
      // interface-basierte Zuordnung (`ip ospf PID area A`)
      const viaIface = Object.values(cfg.ifaces).some(
        (i) =>
          i.ospf?.pid === it.pid &&
          (it.area === undefined || i.ospf.area === it.area) &&
          !!i.ip &&
          !!i.mask &&
          netNum(i.ip, plenOf(i.mask) ?? 32) === netNum(it.network, plenOf(i.mask) ?? 32),
      );
      return need(hit || viaIface, 'ospfNetwork', { network: it.network, pid: it.pid });
    }
    case 'portSecurity':
    case 'portfast': {
      if (c.kind !== 'switch') return bad('notSwitch', { device: d.name });
      const p = resolvePort(d, it.port);
      const pc = p ? c.ports[p.id] : undefined;
      if (!pc) return bad('noPort', { device: d.name, port: it.port });
      return need(it.item === 'portfast' ? pc.portfast : pc.psec.enabled, it.item, {
        port: it.port,
      });
    }
    case 'stpMode':
      if (c.kind !== 'switch') return bad('notSwitch', { device: d.name });
      return need(c.stp.mode === it.mode, 'stpMode', { mode: it.mode });
    case 'vtp':
      if (c.kind !== 'switch') return bad('notSwitch', { device: d.name });
      return need(
        c.vtp.mode === it.mode && (it.domain === undefined || c.vtp.domain === it.domain),
        'vtp',
        { mode: it.mode },
      );
    case 'defaultGateway':
      return need((cfg as L3Cfg).defaultGateway === it.ip, 'defaultGateway', { ip: it.ip });
  }
  void e;
}

const ROUTE_TYPE: Record<string, string> = {
  connected: 'C',
  static: 'S',
  rip: 'R',
  ospf: 'O',
  eigrp: 'D',
  bgp: 'B',
};

function runTraffic(base: Engine, spec: Parameters<typeof runAttempt>[1], tries: number): boolean {
  for (let i = 0; i < tries; i++) {
    const c = cloneEngine(base);
    if (runAttempt(c, spec).status === 'ok') return true;
  }
  return false;
}

/** Bestimmt, ob ein Ergebnis verkehrsabhaengig ist (dann wird eine eingeschwungene Kopie benoetigt). */
export function needsSettle(checks: Check[]): boolean {
  return checks.some(
    (c) =>
      c.type === 'ping' ||
      c.type === 'service' ||
      c.type === 'ospfNeighbors' ||
      c.type === 'dhcpLease' ||
      c.type === 'natTranslations' ||
      (c.type === 'route' && c.source !== 'connected' && c.source !== 'static'),
  );
}

function evalOne(e: Engine, settled: Engine, c: Check): Msg | undefined {
  const getDev = (name: string): Device | undefined => findDevice(e, name);

  if (c.type === 'ping' || c.type === 'service') {
    const from = getDev(c.from);
    if (!from) return bad('noDevice', { device: c.from });
    const spec =
      c.type === 'ping'
        ? PduSpecSchema.parse({ protocol: 'icmp', src: from.id, dst: c.to })
        : PduSpecSchema.parse({
            protocol: c.protocol as PduProtocol,
            src: from.id,
            dst: c.to,
            dport: c.port,
          });
    const reached = runTraffic(settled, spec, c.type === 'ping' ? 2 : 1);
    if (c.expect === 'success')
      return reached
        ? ok
        : bad(c.type === 'ping' ? 'pingFails' : 'serviceFails', { from: c.from, to: c.to });
    return reached
      ? bad(c.type === 'ping' ? 'pingShouldFail' : 'serviceShouldFail', { from: c.from, to: c.to })
      : ok;
  }

  const d = getDev(c.device);
  if (!d) return bad('noDevice', { device: c.device });
  if (c.type === 'deviceExists') {
    if (c.deviceType && d.type !== c.deviceType)
      return bad('deviceType', { device: c.device, type: c.deviceType });
    return ok;
  }
  // dynamische Pruefungen laufen auf der eingeschwungenen Kopie desselben Geraets
  const sd = settled.state.devices[d.id] ?? d;

  switch (c.type) {
    case 'hostIp': {
      if (d.config.kind !== 'host') return bad('notHost', { device: d.name });
      const h: HostConfig = d.config;
      if (h.ip !== c.ip) return bad('hostIp', { device: d.name, ip: c.ip, actual: h.ip ?? '-' });
      if (c.mask !== undefined && h.mask !== normMask(c.mask))
        return bad('hostMask', { device: d.name, mask: c.mask });
      if (c.gateway !== undefined && h.gateway !== c.gateway)
        return bad('hostGateway', { device: d.name, gateway: c.gateway });
      return ok;
    }
    case 'ifaceIp': {
      const cfg = d.config;
      if (cfg.kind !== 'router' && cfg.kind !== 'switch') return bad('notL3', { device: d.name });
      const i = resolveIface(d, cfg, c.iface);
      if (!i) return bad('noIface', { device: d.name, iface: c.iface });
      if (i.cfg.ip !== c.ip)
        return bad('ifaceIp', {
          device: d.name,
          iface: c.iface,
          ip: c.ip,
          actual: i.cfg.ip ?? '-',
        });
      if (c.mask !== undefined && i.cfg.mask !== normMask(c.mask))
        return bad('ifaceMask', { device: d.name, iface: c.iface, mask: c.mask });
      return ok;
    }
    case 'ifaceState': {
      const cfg = d.config;
      let up: boolean;
      if (cfg.kind === 'router' || cfg.kind === 'switch') {
        const i = resolveIface(d, cfg, c.iface);
        const p = resolvePort(d, c.iface);
        if (i) up = ifaceUp(sd, sd.config as L3Cfg, i.id, i.cfg);
        else if (p) up = p.adminUp && p.operUp;
        else return bad('noIface', { device: d.name, iface: c.iface });
      } else {
        const p = resolvePort(d, c.iface);
        if (!p) return bad('noIface', { device: d.name, iface: c.iface });
        up = p.adminUp && p.operUp;
      }
      return up === c.up
        ? ok
        : bad(c.up ? 'ifaceDown' : 'ifaceUp', { device: d.name, iface: c.iface });
    }
    case 'vlanExists': {
      if (d.config.kind !== 'switch') return bad('notSwitch', { device: d.name });
      const v = d.config.vlans[c.vlan];
      if (!v) return bad('noVlan', { device: d.name, vlan: c.vlan });
      if (c.name !== undefined && v.name.toLowerCase() !== c.name.toLowerCase())
        return bad('vlanName', { device: d.name, vlan: c.vlan, name: c.name });
      return ok;
    }
    case 'vlanMember': {
      if (d.config.kind !== 'switch') return bad('notSwitch', { device: d.name });
      const p = resolvePort(d, c.port);
      const pc = p ? d.config.ports[p.id] : undefined;
      if (!pc) return bad('noPort', { device: d.name, port: c.port });
      if (pc.routed || pc.mode !== 'access' || pc.accessVlan !== c.vlan)
        return bad('vlanMember', { device: d.name, port: c.port, vlan: c.vlan });
      if (!d.config.vlans[c.vlan]) return bad('noVlan', { device: d.name, vlan: c.vlan });
      return ok;
    }
    case 'trunk': {
      if (d.config.kind !== 'switch') return bad('notSwitch', { device: d.name });
      const p = resolvePort(d, c.port);
      const pc = p ? d.config.ports[p.id] : undefined;
      if (!p || !pc) return bad('noPort', { device: d.name, port: c.port });
      if (pc.mode !== 'trunk') return bad('trunk', { device: d.name, port: c.port });
      if (c.native !== undefined && pc.nativeVlan !== c.native)
        return bad('trunkNative', { port: c.port, vlan: c.native });
      if (c.allowed && pc.allowed !== 'all') {
        const allowed = pc.allowed;
        if (!c.allowed.every((v) => allowed.includes(v)))
          return bad('trunkAllowed', { port: c.port });
      }
      return ok;
    }
    case 'route': {
      if (d.config.kind !== 'router' && d.config.kind !== 'switch')
        return bad('notL3', { device: d.name });
      const plen = plenOf(c.plen);
      if (plen === undefined) return bad('route', { device: d.name, prefix: c.prefix });
      const rt = settled.routingTable(sd.id);
      const want = netNum(c.prefix, plen);
      const hit = rt.some(
        (r) =>
          r.plen === plen &&
          netNum(r.prefix, plen) === want &&
          (c.source === 'any' || r.type === ROUTE_TYPE[c.source]) &&
          (c.via === undefined || r.nextHop === c.via || r.bgpNextHop === c.via),
      );
      return hit ? ok : bad('route', { device: d.name, prefix: `${c.prefix}/${plen}` });
    }
    case 'config':
      return checkConfigItem(sd, settled, c.spec);
    case 'ospfNeighbors': {
      const cfg = sd.config;
      if (cfg.kind !== 'router' && cfg.kind !== 'switch') return bad('notL3', { device: d.name });
      let full = 0;
      for (const o of Object.values(cfg.routing.ospf))
        for (const ifs of Object.values(o.ifs ?? {}))
          for (const n of Object.values(ifs.neighbors)) if (n.state === 'full') full++;
      return full >= c.min
        ? ok
        : bad('ospfNeighbors', { device: d.name, min: c.min, actual: full });
    }
    case 'dhcpLease': {
      const cfg = sd.config;
      if (cfg.kind !== 'host') return bad('notHost', { device: d.name });
      return cfg.dhcpClient.state === 'bound' && cfg.ip ? ok : bad('dhcpLease', { device: d.name });
    }
    case 'natTranslations': {
      const cfg = sd.config;
      if (cfg.kind !== 'router' && cfg.kind !== 'switch') return bad('notL3', { device: d.name });
      return cfg.nat.table.length >= c.min
        ? ok
        : bad('natTranslations', { device: d.name, min: c.min });
    }
  }
}

/**
 * Wertet Pruefungen gegen den Zustand von `engine` aus. Die laufende Engine wird nicht veraendert; verkehrs-
 * und protokollabhaengige Pruefungen laufen auf einer um `SETTLE_US` vorgespulten Kopie.
 */
export function evaluateChecks(engine: Engine, checks: Check[]): EvalSummary {
  let settled = engine;
  if (needsSettle(checks)) {
    settled = cloneEngine(engine);
    settled.runUntil(settled.state.now + SETTLE_US);
  }
  const results: CheckResult[] = checks.map((c) => {
    const reason = evalOne(engine, settled, c);
    return {
      id: c.id,
      passed: reason === undefined,
      weight: c.weight,
      ...(reason ? { reason } : {}),
    };
  });
  const total = results.reduce((s, r) => s + r.weight, 0);
  const earned = results.reduce((s, r) => s + (r.passed ? r.weight : 0), 0);
  return {
    results,
    earned,
    total,
    percent: total > 0 ? Math.round((earned / total) * 100) : 0,
    passedCount: results.filter((r) => r.passed).length,
  };
}
