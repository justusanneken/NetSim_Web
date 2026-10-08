import { maskToPrefix, parseIpv4 } from '@netsim/protocols';
import type {
  AclEntry,
  AddrMatch,
  Device,
  Engine,
  IfaceCfg,
  L3Cfg,
  PortMatch,
  RouterConfig,
  SwitchConfig,
  SwitchPortCfg,
  SysConfig,
} from '@netsim/engine';
import { ciscoMac } from './format';
import { compressVlans, ifDisplay } from './ifnames';
import { type7Encrypt } from './secrets';

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
  if (c?.natSide) out.push(` ip nat ${c.natSide}`);
  void cfg;
}

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
  for (const rule of cfg.nat.rules) {
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
  const acls = Object.values(cfg.acls).sort((a, b) =>
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
  if (cfg.kind === 'switch') {
    renderLine(L, 'line vty 0 4', sys.lineVty, enc);
    L.push('!');
    renderLine(L, 'line vty 5 15', sys.lineVty, enc);
  } else renderLine(L, 'line vty 0 4', sys.lineVty, enc);
  L.push('!', 'end');
  return L;
}
