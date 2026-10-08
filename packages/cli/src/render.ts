import { maskToPrefix, parseIpv4 } from '@netsim/protocols';
import type { Device, Engine, Port, RouterConfig, SwitchConfig, SysConfig } from '@netsim/engine';
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

function renderInterface(d: Device, p: Port, cfg: CliConfig): string[] {
  const out = [`interface ${p.name}`];
  const desc = cfg.sys.descriptions[p.id];
  if (desc) out.push(` description ${desc}`);
  if (cfg.kind === 'router') {
    if (p.mtu !== 1500) out.push(` ip mtu ${p.mtu}`);
    const i = cfg.ifaces[p.id];
    out.push(i?.ip && i.mask ? ` ip address ${i.ip} ${i.mask}` : ' no ip address');
    out.push(` duplex ${p.duplex}`, ` speed ${p.speed}`);
  } else {
    if (p.mtu !== 1500) out.push(` mtu ${p.mtu}`);
    if (p.duplex !== 'auto') out.push(` duplex ${p.duplex}`);
    if (p.speed !== 'auto') out.push(` speed ${p.speed}`);
  }
  if (!p.adminUp) out.push(' shutdown');
  void d;
  return out;
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
  if (sys.domainName) L.push(`ip domain-name ${sys.domainName}`, '!');
  for (const p of d.ports) L.push(...renderInterface(d, p, cfg), '!');
  if (cfg.kind === 'switch') L.push('interface Vlan1', ' no ip address', ' shutdown', '!');
  if (cfg.kind === 'router' && cfg.staticRoutes.length > 0) {
    const routes = [...cfg.staticRoutes].sort(
      (a, b) =>
        (parseIpv4(a.prefix) ?? 0) - (parseIpv4(b.prefix) ?? 0) ||
        (maskToPrefix(a.mask) ?? 0) - (maskToPrefix(b.mask) ?? 0),
    );
    for (const r of routes) {
      const via = r.outPortId ? (d.ports.find((p) => p.id === r.outPortId)?.name ?? '') : r.nextHop;
      L.push(`ip route ${r.prefix} ${r.mask} ${via}${r.ad !== 1 ? ` ${r.ad}` : ''}`);
    }
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
