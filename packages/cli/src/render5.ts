import type { RouterConfig, SwitchConfig } from '@netsim/engine';
import { mgmtOf } from '@netsim/engine';
import { asaEntryText } from './commands5';
import { type7Encrypt } from './secrets';

type CliConfig = RouterConfig | SwitchConfig;

/** Methodenname in `aaa authentication login …`. */
export const aaaMethodText = (x: 'radius' | 'tacacs' | 'local'): string =>
  x === 'radius' ? 'group radius' : x === 'tacacs' ? 'group tacacs+' : x;

/** Management-Abschnitt der running-config (Benutzer, AAA, SSH, NTP, Syslog, SNMP). */
export function mgmtGlobalLines(cfg: CliConfig): string[] {
  const m = cfg.sys.mgmt;
  if (!m) return [];
  const L: string[] = [];
  if (m.aaa.newModel) L.push('aaa new-model');
  if (m.aaa.methods.length > 0)
    L.push(
      `aaa authentication login ${m.aaa.listName} ${m.aaa.methods.map(aaaMethodText).join(' ')}`,
    );
  for (const [name, u] of Object.entries(m.users))
    L.push(
      `username ${name}${u.privilege !== 1 ? ` privilege ${u.privilege}` : ''} secret 5 ${type7Encrypt(u.secret)}`,
    );
  for (const r of m.aaa.radius)
    L.push(`radius-server host ${r.host}${r.key ? ` key ${r.key}` : ''}`);
  for (const t of m.aaa.tacacs ?? []) {
    if (t.name) {
      L.push(`tacacs server ${t.name}`);
      if (t.host) L.push(` address ipv4 ${t.host}`);
      if (t.key) L.push(` key ${t.key}`);
      L.push('!');
    } else L.push(`tacacs-server host ${t.host}${t.key ? ` key ${t.key}` : ''}`);
  }
  if (m.ssh.keyBits !== undefined || m.ssh.version === 1) L.push(`ip ssh version ${m.ssh.version}`);
  for (const s of m.ntp.servers) L.push(`ntp server ${s}`);
  if (m.ntp.master !== undefined) L.push(`ntp master ${m.ntp.master}`);
  if (!m.syslog.buffered) L.push('no logging buffered');
  if (m.syslog.trap !== 6) L.push(`logging trap ${m.syslog.trap}`);
  for (const h of m.syslog.hosts) L.push(`logging host ${h}`);
  for (const c of m.snmp.communities)
    L.push(`snmp-server community ${c.name} ${c.rw ? 'RW' : 'RO'}`);
  if (m.snmp.location) L.push(`snmp-server location ${m.snmp.location}`);
  if (m.snmp.contact) L.push(`snmp-server contact ${m.snmp.contact}`);
  if (L.length > 0) L.push('!');
  return L;
}

/** vty-spezifische Zeilen (transport, login local/authentication). */
export function vtyExtraLines(cfg: CliConfig): string[] {
  const m = cfg.sys.mgmt;
  if (!m) return [];
  const L: string[] = [];
  const t = m.vty.transport;
  if (t.length === 0) L.push(' transport input none');
  else if (t.length === 1) L.push(` transport input ${t[0]}`);
  if (m.vty.loginLocal) L.push(' login local');
  if (m.vty.authList) L.push(` login authentication ${m.vty.authList}`);
  return L;
}

/** Anzahl der vty-Leitungen (letzte Nummer). */
export const vtyLast = (cfg: CliConfig): number => (cfg.sys.mgmt?.vty.lines ?? 5) - 1;

/** nameif/security-level einer Firewall-Schnittstelle. */
export function fwIfaceLines(cfg: RouterConfig, portId: string): string[] {
  const f = cfg.fw?.ifaces[portId];
  return f ? [` nameif ${f.nameif}`, ` security-level ${f.level}`] : [];
}

/** ASA-Teile der Firewall: Objekte, ACLs, access-group, same-security-traffic. */
export function fwGlobalLines(cfg: RouterConfig): string[] {
  const fw = cfg.fw;
  if (!fw) return [];
  const L: string[] = [];
  if (fw.sameSecurity) L.push('same-security-traffic permit inter-interface', '!');
  for (const o of Object.values(fw.objects)) {
    L.push(`object network ${o.name}`);
    if (o.net)
      L.push(
        o.net.mask === '255.255.255.255'
          ? ` host ${o.net.ip}`
          : ` subnet ${o.net.ip} ${o.net.mask}`,
      );
    if (o.nat)
      L.push(
        ` nat (${o.nat.from},${o.nat.to}) ${o.nat.kind === 'static' ? `static ${o.nat.mapped}` : 'dynamic interface'}`,
      );
    L.push('!');
  }
  for (const acl of Object.values(cfg.acls)) {
    if (acl.name.startsWith('__fwnat_')) continue;
    for (const e of acl.entries) L.push(`access-list ${acl.name} extended ${asaEntryText(e)}`);
  }
  for (const [id, name] of Object.entries(fw.accessGroups)) {
    const nameif = fw.ifaces[id]?.nameif;
    if (nameif) L.push(`access-group ${name} in interface ${nameif}`);
  }
  L.push('!');
  return L;
}

export { mgmtOf };
