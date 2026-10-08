import { renderPolicyConfig } from './showGaps';
import { maskToPrefix, parseIpv4 } from '@netsim/protocols';
import type {
  AclEntry,
  AddrMatch,
  Device,
  DistList,
  Engine,
  IfaceCfg,
  L3Cfg,
  PortMatch,
  RedistCfg,
  RouterConfig,
  SwitchConfig,
  SwitchPortCfg,
  SysConfig,
} from '@netsim/engine';
import { ciscoMac } from './format';
import { compressVlans, ifDisplay } from './ifnames';
import { type7Encrypt } from './secrets';
import { fwGlobalLines, fwIfaceLines, mgmtGlobalLines, vtyExtraLines, vtyLast } from './render5';

type CliConfig = RouterConfig | SwitchConfig;

export const isCliDevice = (d: Device): d is Device & { config: CliConfig } =>
  d.config.kind === 'router' || d.config.kind === 'switch';

function password(prefix: string, pw: string, encrypt: boolean): string {
  return encrypt ? `${prefix} 7 ${type7Encrypt(pw)}` : `${prefix} ${pw}`;
}

function renderLine(lines: string[], head: string, line: SysConfig['lineCon'], enc: boolean): void {
  lines.push(head);
  if (line.password !== undefined) lines.push(' ' + password('password', line.password, enc));
  if (line.login) lines.push(' login');
}

// ---------------------------------------------------------------- ACL-Text

const addr = (m: AddrMatch | undefined): string =>
  !m || 'any' in m ? 'any' : m.wildcard === '0.0.0.0' ? `host ${m.ip}` : `${m.ip} ${m.wildcard}`;

const PORT_NAMES: Record<number, string> = {
  20: 'ftp-data',
  21: 'ftp',
  22: 'ssh',
  23: 'telnet',
  25: 'smtp',
  53: 'domain',
  80: 'www',
  110: 'pop3',
  443: '443',
};
const portText = (p: number): string => PORT_NAMES[p] ?? String(p);
const portMatch = (m: PortMatch | undefined): string =>
  !m
    ? ''
    : m.op === 'range'
      ? ` range ${portText(m.a)} ${portText(m.b ?? m.a)}`
      : ` ${m.op} ${portText(m.a)}`;

/** Textform eines ACL-Eintrags (ohne Sequenznummer). */
export function aclEntryText(e: AclEntry, type: 'standard' | 'extended'): string {
  if (type === 'standard') return `${e.action} ${addr(e.src)}`;
  return (
    `${e.action} ${e.proto} ${addr(e.src)}${portMatch(e.srcPort)} ${addr(e.dst)}${portMatch(e.dstPort)}` +
    `${e.established ? ' established' : ''}${e.log ? ' log' : ''}`
  );
}

// ---------------------------------------------------------------- Schnittstellen

const sortedIfaceIds = (cfg: L3Cfg, kind: IfaceCfg['kind'], portId?: string): string[] =>
  Object.entries(cfg.ifaces)
    .filter(([, c]) => c.kind === kind && (portId === undefined || c.portId === portId))
    .sort(([, a], [, b]) => (a.vlan ?? 0) - (b.vlan ?? 0))
    .map(([id]) => id);

function l3Lines(cfg: L3Cfg, c: IfaceCfg | undefined, out: string[]): void {
  out.push(c?.ip && c.mask ? ` ip address ${c.ip} ${c.mask}` : ' no ip address');
  for (const h of c?.helpers ?? []) out.push(` ip helper-address ${h}`);
  if (c?.aclIn) out.push(` ip access-group ${c.aclIn} in`);
  if (c?.aclOut) out.push(` ip access-group ${c.aclOut} out`);
  if (c?.natSide && !(cfg as RouterConfig).fw) out.push(` ip nat ${c.natSide}`);
  if (c) routingIfaceLines(c, out);
}

const area = (a: string): string => a;

/** Schnittstellenbezogene Routing-Konfiguration (OSPF, HSRP, IPv6, Bandbreite …). */
function routingIfaceLines(c: IfaceCfg, out: string[]): void {
  if (c.bandwidth !== undefined) out.push(` bandwidth ${c.bandwidth}`);
  if (c.delay !== undefined) out.push(` delay ${c.delay}`);
  if (c.ripSplitHorizon === false) out.push(' no ip split-horizon');
  const o = c.ospf;
  if (o) {
    if (o.area !== undefined) out.push(` ip ospf ${o.pid ?? 1} area ${area(o.area)}`);
    if (o.auth)
      out.push(
        ` ip ospf authentication${o.auth === 'md5' ? ' message-digest' : o.auth === 'null' ? ' null' : ''}`,
      );
    if (o.authKey !== undefined) out.push(` ip ospf authentication-key ${o.authKey}`);
    for (const [id, key] of Object.entries(o.md5Keys ?? {}))
      out.push(` ip ospf message-digest-key ${id} md5 ${key}`);
    if (o.cost !== undefined) out.push(` ip ospf cost ${o.cost}`);
    if (o.priority !== undefined) out.push(` ip ospf priority ${o.priority}`);
    if (o.helloSec !== undefined) out.push(` ip ospf hello-interval ${o.helloSec}`);
    if (o.deadSec !== undefined) out.push(` ip ospf dead-interval ${o.deadSec}`);
    if (o.network) out.push(` ip ospf network ${o.network}`);
  }
  if (c.hsrpVersion === 2) out.push(' standby version 2');
  const hsrpIds = [
    ...new Set([...Object.keys(c.hsrp ?? {}), ...Object.keys(c.hsrp6 ?? {})].map(Number)),
  ].sort((a, b) => a - b);
  for (const id of hsrpIds) {
    const g4 = c.hsrp?.[id];
    const g6 = c.hsrp6?.[id];
    const g = (g4 ?? g6) as NonNullable<typeof g4>;
    if (g4?.vip) out.push(` standby ${id} ip ${g4.vip}`);
    if (g6)
      out.push(
        ` standby ${id} ipv6 ${g6.autoconfig ? 'autoconfig' : (g6.vip ?? '').toUpperCase()}`,
      );
    if (g.authKey !== undefined) out.push(` standby ${id} authentication ${g.authKey}`);
    if (g.priority !== 100) out.push(` standby ${id} priority ${g.priority}`);
    if (g.preempt) out.push(` standby ${id} preempt`);
    if (g.helloSec !== 3 || g.holdSec !== 10)
      out.push(` standby ${id} timers ${g.helloSec} ${g.holdSec}`);
    for (const t of g.track)
      out.push(` standby ${id} track ${trackName(t.ifaceId)} ${t.decrement}`);
    if (g.name) out.push(` standby ${id} name ${g.name}`);
  }
  const v6 = c.v6;
  if (v6) {
    if (v6.enabled && v6.addrs.length === 0 && !v6.autoconfig) out.push(' ipv6 enable');
    for (const a of v6.addrs)
      out.push(` ipv6 address ${a.addr.toUpperCase()}/${a.plen}${a.eui64 ? ' eui-64' : ''}`);
    if (v6.autoconfig) out.push(' ipv6 address autoconfig');
    if (v6.raSuppress) out.push(' ipv6 nd ra suppress');
    if (v6.managed) out.push(' ipv6 nd managed-config-flag');
    if (v6.otherConfig) out.push(' ipv6 nd other-config-flag');
    if (v6.dhcp6Server) out.push(` ipv6 dhcp server ${v6.dhcp6Server}`);
    if (v6.ripng) out.push(` ipv6 rip ${v6.ripng} enable`);
    const v = v6.ospf;
    if (v) {
      if (v.area !== undefined) out.push(` ipv6 ospf ${v.pid ?? 1} area ${area(v.area)}`);
      if (v.cost !== undefined) out.push(` ipv6 ospf cost ${v.cost}`);
      if (v.priority !== undefined) out.push(` ipv6 ospf priority ${v.priority}`);
      if (v.helloSec !== undefined) out.push(` ipv6 ospf hello-interval ${v.helloSec}`);
      if (v.deadSec !== undefined) out.push(` ipv6 ospf dead-interval ${v.deadSec}`);
      if (v.network) out.push(` ipv6 ospf network ${v.network}`);
    }
  }
}

/** Name der verfolgten Schnittstelle; wird beim Replay wieder aufgelöst (ID → Anzeigename ohne Gerät). */
let trackNamer: (id: string) => string = (id) => id;
const trackName = (id: string): string => trackNamer(id);

function switchportLines(pc: SwitchPortCfg, out: string[]): void {
  if (pc.routed) {
    out.push(' no switchport');
    return;
  }
  if (pc.mode !== 'dynamic-auto') {
    out.push(` switchport mode ${pc.mode === 'dynamic-desirable' ? 'dynamic desirable' : pc.mode}`);
  }
  if (pc.accessVlan !== 1) out.push(` switchport access vlan ${pc.accessVlan}`);
  if (pc.nativeVlan !== 1) out.push(` switchport trunk native vlan ${pc.nativeVlan}`);
  if (pc.allowed !== 'all') {
    out.push(
      ` switchport trunk allowed vlan ${pc.allowed.length ? compressVlans(pc.allowed) : 'none'}`,
    );
  }
  const ps = pc.psec;
  if (ps.enabled) {
    out.push(' switchport port-security');
    if (ps.max !== 1) out.push(` switchport port-security maximum ${ps.max}`);
    if (ps.violation !== 'shutdown')
      out.push(` switchport port-security violation ${ps.violation}`);
    if (ps.sticky) out.push(' switchport port-security mac-address sticky');
    for (const m of ps.macs) {
      out.push(` switchport port-security mac-address ${ps.sticky ? 'sticky ' : ''}${ciscoMac(m)}`);
    }
  }
  if (pc.portfast) out.push(' spanning-tree portfast');
  if (pc.bpduguard) out.push(' spanning-tree bpduguard enable');
  if (pc.rootguard) out.push(' spanning-tree guard root');
  if (pc.channel !== undefined)
    out.push(` channel-group ${pc.channel} mode ${pc.channelMode ?? 'on'}`);
}

function renderInterfaces(d: Device & { config: CliConfig }, L: string[]): void {
  const cfg = d.config;
  const sys = cfg.sys;
  const isSwitch = cfg.kind === 'switch';
  const channels = isSwitch
    ? [
        ...new Set(
          Object.values(cfg.ports)
            .map((p) => p.channel)
            .filter((n): n is number => n !== undefined),
        ),
      ].sort()
    : [];
  for (const n of channels) L.push(`interface Port-channel${n}`, '!');
  for (const p of d.ports) {
    const out = [`interface ${p.name}`];
    const desc = sys.descriptions[p.id];
    if (desc) out.push(` description ${desc}`);
    if (isSwitch) {
      const pc = cfg.ports[p.id];
      if (p.mtu !== 1500) out.push(` mtu ${p.mtu}`);
      if (pc) switchportLines(pc, out);
      if (pc?.routed) {
        if (p.mtu !== 1500) out.push(` ip mtu ${p.mtu}`);
        l3Lines(cfg, cfg.ifaces[p.id], out);
      }
      if (p.duplex !== 'auto') out.push(` duplex ${p.duplex}`);
      if (p.speed !== 'auto') out.push(` speed ${p.speed}`);
    } else {
      if (p.mtu !== 1500) out.push(` ip mtu ${p.mtu}`);
      if (cfg.kind === 'router') out.push(...fwIfaceLines(cfg, p.id));
      l3Lines(cfg, cfg.ifaces[p.id], out);
      out.push(` duplex ${p.duplex}`, ` speed ${p.speed}`);
    }
    if (!p.adminUp) out.push(' shutdown');
    L.push(...out, '!');
    if (!isSwitch) {
      for (const id of sortedIfaceIds(cfg, 'sub', p.id)) {
        const c = cfg.ifaces[id] as IfaceCfg;
        const sub = [`interface ${ifDisplay(d, id)}`];
        if (sys.descriptions[id]) sub.push(` description ${sys.descriptions[id]}`);
        sub.push(` encapsulation dot1Q ${c.vlan}`);
        l3Lines(cfg, c, sub);
        if (c.shutdown) sub.push(' shutdown');
        L.push(...sub, '!');
      }
    }
  }
  for (const kind of ['loop', 'tunnel'] as const) {
    for (const id of sortedIfaceIds(cfg, kind).sort(
      (a, b) => Number(a.slice(2)) - Number(b.slice(2)),
    )) {
      const c = cfg.ifaces[id] as IfaceCfg;
      const out = [`interface ${ifDisplay(d, id)}`];
      if (sys.descriptions[id]) out.push(` description ${sys.descriptions[id]}`);
      l3Lines(cfg, c, out);
      if (kind === 'tunnel') {
        if (c.tunnel?.source)
          out.push(
            ` tunnel source ${cfg.ifaces[c.tunnel.source] ? ifDisplay(d, c.tunnel.source) : c.tunnel.source}`,
          );
        if (c.tunnel?.destination) out.push(` tunnel destination ${c.tunnel.destination}`);
        out.push(' tunnel mode gre ip');
      }
      if (c.shutdown) out.push(' shutdown');
      L.push(...out, '!');
    }
  }
  if (isSwitch) {
    const vlans = sortedIfaceIds(cfg, 'svi');
    if (!vlans.includes('vlan1')) L.push('interface Vlan1', ' no ip address', ' shutdown', '!');
    for (const id of vlans) {
      const c = cfg.ifaces[id] as IfaceCfg;
      const out = [`interface Vlan${c.vlan}`];
      if (sys.descriptions[id]) out.push(` description ${sys.descriptions[id]}`);
      l3Lines(cfg, c, out);
      if (c.shutdown) out.push(' shutdown');
      L.push(...out, '!');
    }
  }
}

// ---------------------------------------------------------------- Gesamte Konfiguration

function leaseText(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m ? `${d} ${h} ${m}` : h ? `${d} ${h}` : `${d}`;
}

/** Deterministisch aus dem Konfigurationsbaum gerenderte `running-config` (Reihenfolge wie IOS). */
export function renderRunningConfig(_e: Engine, d: Device & { config: CliConfig }): string[] {
  const cfg = d.config;
  const sys = cfg.sys;
  const enc = sys.servicePasswordEncryption;
  const L: string[] = ['!', 'version 15.1'];
  L.push('service timestamps log datetime msec', 'service timestamps debug datetime msec');
  L.push(enc ? 'service password-encryption' : 'no service password-encryption');
  L.push('!', `hostname ${sys.hostname}`, '!');
  if (sys.enableSecret) L.push(`enable secret 5 ${sys.enableSecret}`);
  if (sys.enablePassword !== undefined)
    L.push(password('enable password', sys.enablePassword, enc));
  if (sys.enableSecret || sys.enablePassword !== undefined) L.push('!');
  if (cfg.kind === 'switch' && d.type === 'switch-l3' && cfg.ipRouting) L.push('ip routing', '!');
  if (cfg.ipv6Routing) L.push('ipv6 unicast-routing', '!');
  trackNamer = (id) => ifDisplay(d, id);
  for (const p of cfg.dhcp6?.pools ?? []) {
    L.push(`ipv6 dhcp pool ${p.name}`);
    if (p.prefix)
      L.push(
        ` address prefix ${p.prefix.prefix.toUpperCase()}/${p.prefix.plen}${p.leaseSec !== 86400 ? ` lifetime ${p.leaseSec} ${p.leaseSec}` : ''}`,
      );
    for (const dns of p.dns) L.push(` dns-server ${dns.toUpperCase()}`);
    if (p.domain) L.push(` domain-name ${p.domain}`);
    L.push('!');
  }
  for (const ex of cfg.dhcp.excluded) {
    L.push(`ip dhcp excluded-address ${ex.from}${ex.to !== ex.from ? ` ${ex.to}` : ''}`);
  }
  for (const p of cfg.dhcp.pools) {
    L.push(`ip dhcp pool ${p.name}`, ` network ${p.network} ${p.mask}`);
    if (p.router) L.push(` default-router ${p.router}`);
    if (p.dns.length) L.push(` dns-server ${p.dns.join(' ')}`);
    if (p.domain) L.push(` domain-name ${p.domain}`);
    if (p.leaseSec !== 86400) L.push(` lease ${leaseText(p.leaseSec)}`);
    if (p.tftp) L.push(` option 66 ascii ${p.tftp}`);
    L.push('!');
  }
  if (sys.domainName) L.push(`ip domain-name ${sys.domainName}`, '!');
  L.push(...mgmtGlobalLines(cfg));
  if (cfg.kind === 'switch') {
    if (cfg.vtp.mode !== 'server') L.push(`vtp mode ${cfg.vtp.mode}`);
    if (cfg.vtp.domain) L.push(`vtp domain ${cfg.vtp.domain}`);
    L.push(`spanning-tree mode ${cfg.stp.mode}`);
    for (const [v, pr] of Object.entries(cfg.stp.priority).sort(
      ([a], [b]) => Number(a) - Number(b),
    )) {
      L.push(`spanning-tree vlan ${v} priority ${pr}`);
    }
    if (cfg.errdisableRecovery.psecure) {
      L.push('errdisable recovery cause psecure-violation');
      if (cfg.errdisableRecovery.intervalSec !== 300) {
        L.push(`errdisable recovery interval ${cfg.errdisableRecovery.intervalSec}`);
      }
    }
    if (cfg.agingSec !== 300) L.push(`mac address-table aging-time ${cfg.agingSec}`);
    L.push('!');
    for (const [v, info] of Object.entries(cfg.vlans).sort(([a], [b]) => Number(a) - Number(b))) {
      const vid = Number(v);
      if (vid === 1) continue;
      L.push(`vlan ${vid}`);
      if (info.name !== `VLAN${String(vid).padStart(4, '0')}`) L.push(` name ${info.name}`);
      L.push('!');
    }
  }
  renderInterfaces(d, L);
  for (const [name, p] of Object.entries(cfg.nat.pools)) {
    L.push(`ip nat pool ${name} ${p.start} ${p.end} netmask ${p.mask}`);
  }
  if (cfg.nat.timeoutSec !== undefined) L.push(`ip nat translation timeout ${cfg.nat.timeoutSec}`);
  for (const rule of cfg.kind === 'router' && cfg.fw ? [] : cfg.nat.rules) {
    if (rule.kind === 'static') {
      L.push(
        rule.proto
          ? `ip nat inside source static ${rule.proto} ${rule.local} ${rule.lport} ${rule.global} ${rule.gport}`
          : `ip nat inside source static ${rule.local} ${rule.global}`,
      );
    } else if (rule.kind === 'dynamic') {
      L.push(
        `ip nat inside source list ${rule.acl} pool ${rule.pool}${rule.overload ? ' overload' : ''}`,
      );
    } else {
      L.push(
        `ip nat inside source list ${rule.acl} interface ${ifDisplay(d, rule.ifaceId)} overload`,
      );
    }
  }
  renderRouting(d, L);
  L.push(...renderPolicyConfig(cfg.routing));
  if (cfg.defaultGateway) L.push(`ip default-gateway ${cfg.defaultGateway}`);
  if (cfg.staticRoutes.length > 0) {
    const routes = [...cfg.staticRoutes].sort(
      (a, b) =>
        (parseIpv4(a.prefix) ?? 0) - (parseIpv4(b.prefix) ?? 0) ||
        (maskToPrefix(a.mask) ?? 0) - (maskToPrefix(b.mask) ?? 0),
    );
    for (const r of routes) {
      const via = r.outIfaceId ? ifDisplay(d, r.outIfaceId) : r.nextHop;
      L.push(`ip route ${r.prefix} ${r.mask} ${via}${r.ad !== 1 ? ` ${r.ad}` : ''}`);
    }
  }
  for (const r of [...cfg.staticRoutes6].sort(
    (a, b) => a.prefix.localeCompare(b.prefix) || a.plen - b.plen,
  )) {
    const via = [r.nextHop?.toUpperCase(), r.outIfaceId ? ifDisplay(d, r.outIfaceId) : undefined]
      .filter(Boolean)
      .join(' ');
    L.push(`ipv6 route ${r.prefix.toUpperCase()}/${r.plen} ${via}${r.ad !== 1 ? ` ${r.ad}` : ''}`);
  }
  const isFw = cfg.kind === 'router' && cfg.fw !== undefined;
  if (cfg.kind === 'router') L.push(...fwGlobalLines(cfg));
  const acls = (isFw ? [] : Object.values(cfg.acls)).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  for (const acl of acls) {
    if (/^\d+$/.test(acl.name)) {
      for (const e of acl.entries) L.push(`access-list ${acl.name} ${aclEntryText(e, acl.type)}`);
    }
  }
  L.push('!');
  for (const acl of acls) {
    if (/^\d+$/.test(acl.name)) continue;
    L.push(`ip access-list ${acl.type} ${acl.name}`);
    for (const e of acl.entries) L.push(` ${e.seq} ${aclEntryText(e, acl.type)}`);
    L.push('!');
  }
  if (sys.bannerMotd !== undefined) L.push(`banner motd ^C${sys.bannerMotd}^C`, '!');
  renderLine(L, 'line con 0', sys.lineCon, enc);
  L.push('!');
  if (cfg.kind === 'switch' && vtyLast(cfg) === 4) {
    renderLine(L, 'line vty 0 4', sys.lineVty, enc);
    L.push(...vtyExtraLines(cfg), '!');
    renderLine(L, 'line vty 5 15', sys.lineVty, enc);
    L.push(...vtyExtraLines(cfg));
  } else {
    renderLine(L, `line vty 0 ${vtyLast(cfg)}`, sys.lineVty, enc);
    L.push(...vtyExtraLines(cfg));
  }
  L.push('!', 'end');
  return L;
}

// ---------------------------------------------------------------- Routing-Prozesse

const redistText = (r: RedistCfg, proto: 'rip' | 'ospf' | 'eigrp' | 'bgp'): string => {
  let s = ` redistribute ${r.source}${r.id !== undefined ? ' ' + r.id : ''}`;
  if (proto === 'eigrp') {
    if (r.bw !== undefined) s += ` metric ${r.bw} ${r.delay ?? 10} 255 1 1500`;
  } else if (r.metric !== undefined) s += ` metric ${r.metric}`;
  if (proto === 'ospf') {
    if (r.metricType) s += ` metric-type ${r.metricType}`;
    if (r.subnets) s += ' subnets';
  }
  if (r.routeMap) s += ` route-map ${r.routeMap}`;
  return s;
};

function distLines(d: Device, lists: DistList[] | undefined, L: string[]): void {
  for (const l of lists ?? [])
    L.push(
      ` distribute-list ${l.kind === 'prefix-list' ? 'prefix ' : ''}${l.name} ${l.dir}${l.ifaceId ? ' ' + ifDisplay(d, l.ifaceId) : ''}`,
    );
}

const redist6Text = (r: RedistCfg): string => {
  let s = ` redistribute ${r.source}${r.id !== undefined ? ' ' + r.id : ''}`;
  if (r.metric !== undefined) s += ` metric ${r.metric}`;
  if (r.metricType) s += ` metric-type ${r.metricType}`;
  if (r.routeMap) s += ` route-map ${r.routeMap}`;
  return s;
};

function passiveLines(
  d: Device,
  c: { passive: string[]; unpassive: string[]; passiveDefault: boolean },
  L: string[],
): void {
  if (c.passiveDefault) {
    L.push(' passive-interface default');
    for (const id of c.unpassive) L.push(` no passive-interface ${ifDisplay(d, id)}`);
  } else for (const id of c.passive) L.push(` passive-interface ${ifDisplay(d, id)}`);
}

function renderRouting(d: Device & { config: CliConfig }, L: string[]): void {
  const r = d.config.routing;
  if (r.rip) {
    const c = r.rip;
    L.push('router rip', ' version 2');
    passiveLines(d, c, L);
    for (const n of c.networks) L.push(` network ${n}`);
    if (!c.autoSummary) L.push(' no auto-summary');
    if (c.defaultOriginate) L.push(' default-information originate');
    if (c.defaultMetric !== undefined) L.push(` default-metric ${c.defaultMetric}`);
    const t = c.timers;
    if (t.update !== 30 || t.invalid !== 180 || t.holddown !== 180 || t.flush !== 240)
      L.push(` timers basic ${t.update} ${t.invalid} ${t.holddown} ${t.flush}`);
    if (c.maxPaths !== undefined) L.push(` maximum-paths ${c.maxPaths}`);
    distLines(d, c.distributeLists, L);
    for (const x of c.redistribute) L.push(redistText(x, 'rip'));
    L.push('!');
  }
  for (const c of Object.values(r.ospf)) {
    L.push(`router ospf ${c.pid}`);
    if (c.routerId) L.push(` router-id ${c.routerId}`);
    if (c.refBwMbps !== 100) L.push(` auto-cost reference-bandwidth ${c.refBwMbps}`);
    passiveLines(d, c, L);
    for (const n of c.networks) L.push(` network ${n.prefix} ${n.wildcard} area ${n.area}`);
    for (const a of Object.values(c.areas ?? {})) {
      const id = a.id;
      if (a.type === 'stub') L.push(` area ${id} stub${a.noSummary ? ' no-summary' : ''}`);
      if (a.type === 'nssa')
        L.push(
          ` area ${id} nssa${a.noSummary ? ' no-summary' : ''}${a.nssaDefaultOriginate ? ' default-information-originate' : ''}`,
        );
      if (a.defaultCost !== undefined) L.push(` area ${id} default-cost ${a.defaultCost}`);
      if (a.auth) L.push(` area ${id} authentication${a.auth === 'md5' ? ' message-digest' : ''}`);
    }
    for (const v of c.vlinks ?? []) L.push(` area ${v.area} virtual-link ${v.rid}`);
    for (const g of c.ranges)
      L.push(
        ` area ${g.area} range ${g.prefix} ${prefixMaskText(g.plen)}${g.notAdvertise ? ' not-advertise' : ''}`,
      );
    if (c.defaultOriginate) {
      const o = c.defaultOriginate;
      L.push(
        ` default-information originate${o.always ? ' always' : ''} metric ${o.metric} metric-type ${o.metricType}`,
      );
    }
    if (c.maxPaths !== undefined) L.push(` maximum-paths ${c.maxPaths}`);
    distLines(d, c.distributeLists, L);
    for (const x of c.redistribute) L.push(redistText(x, 'ospf'));
    L.push('!');
  }
  for (const c of Object.values(r.ripng ?? {})) {
    L.push(`ipv6 router rip ${c.name}`);
    if (c.defaultOriginate) L.push(' default-information originate');
    if (c.defaultMetric !== undefined) L.push(` default-metric ${c.defaultMetric}`);
    if (c.poison) L.push(' poison-reverse');
    const t = c.timers;
    if (t.update !== 30 || t.invalid !== 180 || t.holddown !== 180 || t.flush !== 240)
      L.push(` timers ${t.update} ${t.invalid} ${t.holddown} ${t.flush}`);
    for (const id of c.passive ?? []) L.push(` passive-interface ${ifDisplay(d, id)}`);
    if (c.maxPaths !== undefined) L.push(` maximum-paths ${c.maxPaths}`);
    distLines(d, c.distributeLists, L);
    for (const x of c.redistribute) L.push(redist6Text(x));
    L.push('!');
  }
  for (const c of Object.values(r.ospf6)) {
    L.push(`ipv6 router ospf ${c.pid}`);
    if (c.routerId) L.push(` router-id ${c.routerId}`);
    if (c.refBwMbps !== 100) L.push(` auto-cost reference-bandwidth ${c.refBwMbps}`);
    passiveLines(d, c, L);
    if (c.defaultOriginate) {
      const o = c.defaultOriginate;
      L.push(
        ` default-information originate${o.always ? ' always' : ''} metric ${o.metric} metric-type ${o.metricType}`,
      );
    }
    if (c.maxPaths !== undefined) L.push(` maximum-paths ${c.maxPaths}`);
    for (const x of c.redistribute) L.push(redist6Text(x));
    L.push('!');
  }
  for (const c of Object.values(r.eigrp)) {
    L.push(`router eigrp ${c.asn}`);
    if (c.routerId) L.push(` eigrp router-id ${c.routerId}`);
    passiveLines(d, c, L);
    for (const n of c.networks) L.push(` network ${n.prefix} ${n.wildcard}`);
    if (!c.autoSummary) L.push(' no auto-summary');
    if (c.variance !== 1) L.push(` variance ${c.variance}`);
    if (c.maxPaths !== undefined) L.push(` maximum-paths ${c.maxPaths}`);
    distLines(d, c.distributeLists, L);
    for (const x of c.redistribute) L.push(redistText(x, 'eigrp'));
    L.push('!');
  }
  if (r.bgp) {
    const c = r.bgp;
    L.push(`router bgp ${c.asn}`);
    if (c.routerId) L.push(` bgp router-id ${c.routerId}`);
    if (c.defaultLocalPref !== 100) L.push(` bgp default local-preference ${c.defaultLocalPref}`);
    for (const n of Object.values(c.neighbors)) {
      L.push(` neighbor ${n.ip} remote-as ${n.asn}`);
      if (n.description) L.push(` neighbor ${n.ip} description ${n.description}`);
      if (n.updateSource) L.push(` neighbor ${n.ip} update-source ${ifDisplay(d, n.updateSource)}`);
      if (n.ebgpMultihop) L.push(` neighbor ${n.ip} ebgp-multihop ${n.ebgpMultihop}`);
      if (n.nextHopSelf) L.push(` neighbor ${n.ip} next-hop-self`);
      if (n.weight !== undefined) L.push(` neighbor ${n.ip} weight ${n.weight}`);
      if (n.sendCommunity) L.push(` neighbor ${n.ip} send-community`);
      if (n.rrClient) L.push(` neighbor ${n.ip} route-reflector-client`);
      if (n.prefixListIn) L.push(` neighbor ${n.ip} prefix-list ${n.prefixListIn} in`);
      if (n.prefixListOut) L.push(` neighbor ${n.ip} prefix-list ${n.prefixListOut} out`);
      if (n.routeMapIn) L.push(` neighbor ${n.ip} route-map ${n.routeMapIn} in`);
      if (n.routeMapOut) L.push(` neighbor ${n.ip} route-map ${n.routeMapOut} out`);
      if (n.shutdown) L.push(` neighbor ${n.ip} shutdown`);
    }
    for (const n of c.networks) L.push(` network ${n.prefix} mask ${prefixMaskText(n.plen)}`);
    if (c.maxPaths !== undefined) L.push(` maximum-paths ${c.maxPaths}`);
    for (const x of c.redistribute) L.push(redistText(x, 'bgp'));
    if (c.clusterId) L.push(` bgp cluster-id ${c.clusterId}`);
    const af6 = Object.values(c.neighbors).filter((n) => n.activate6);
    if (af6.length > 0 || (c.networks6?.length ?? 0) > 0) {
      L.push(' address-family ipv6');
      for (const n of af6) L.push(`  neighbor ${n.ip} activate`);
      for (const n of c.networks6 ?? []) L.push(`  network ${n.prefix.toUpperCase()}/${n.plen}`);
      L.push(' exit-address-family');
    }
    L.push('!');
  }
}

function prefixMaskText(plen: number): string {
  const m = plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0;
  return [m >>> 24, (m >>> 16) & 255, (m >>> 8) & 255, m & 255].join('.');
}
