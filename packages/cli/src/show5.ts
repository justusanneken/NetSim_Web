import type { Device, Engine, MgmtCfg } from '@netsim/engine';
import { clockOf, formatClock, idleText, mgmtOf, oidName } from '@netsim/engine';
import { ifDisplay } from './ifnames';

type D = Device;

const cli = (d: D) =>
  d.config.kind === 'router' || d.config.kind === 'switch' ? d.config : undefined;

/** `show clock` – Gerätezeit (mit `*`, solange nicht per NTP synchronisiert). */
export function showClock(e: Engine, d: D): string[] {
  const ms = e.p5.clockMs(d.id) ?? 0;
  return [formatClock(ms, clockOf(d)?.syncedTo !== undefined)];
}

export function showNtpStatus(d: D): string[] {
  const c = clockOf(d);
  const m = cli(d) ? mgmtOf(cli(d)!.sys) : undefined;
  if (m?.ntp.master !== undefined && !c?.syncedTo) {
    return [
      `Clock is synchronized, stratum ${m.ntp.master}, reference is 127.127.1.1`,
      'nominal freq is 250.0000 Hz, actual freq is 250.0000 Hz, precision is 2**18',
    ];
  }
  if (!c?.syncedTo) {
    return [
      'Clock is unsynchronized, stratum 16, no reference clock',
      'nominal freq is 250.0000 Hz, actual freq is 250.0000 Hz, precision is 2**18',
    ];
  }
  return [
    `Clock is synchronized, stratum ${c.stratum}, reference is ${c.syncedTo}`,
    'nominal freq is 250.0000 Hz, actual freq is 250.0000 Hz, precision is 2**18',
    `reference time is synchronized to NTP server ${c.syncedTo}`,
  ];
}

export function showNtpAssociations(d: D): string[] {
  const c = clockOf(d);
  const m = cli(d) ? mgmtOf(cli(d)!.sys) : undefined;
  const out = [
    '      address         ref clock       st   when   poll reach  delay  offset   disp',
  ];
  for (const s of m?.ntp.servers ?? []) {
    const synced = c?.syncedTo === s;
    out.push(
      `${synced ? '*~' : ' ~'}${s.padEnd(15)} ${'.LOCL.'.padEnd(15)} ${String(synced ? c.stratum - 1 : 16).padStart(2)}    ${'-'.padStart(4)}     64   ${synced ? '377' : '  0'}  ${synced ? '1.000' : '0.000'}   0.000  ${synced ? '0.050' : '15937'}`,
    );
  }
  out.push(' * sys.peer, # selected, + candidate, - outlyer, x falseknave, ~ configured');
  return out;
}

/** `show users` – Console und vty-Sitzungen. `selfLine` = Zeile dieser Sitzung (-1 Console). */
export function showUsers(e: Engine, d: D, selfLine: number): string[] {
  const cfg = cli(d);
  const m = cfg ? mgmtOf(cfg.sys) : undefined;
  const out = ['    Line       User       Host(s)              Idle       Location'];
  const idle = (since: number): string => {
    const s = Math.floor(Math.max(0, e.state.now - since) / 1_000_000);
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  };
  out.push(`${selfLine === -1 ? '*' : ' '}  0 con 0                idle                 00:00:00`);
  const rows = [...(m?.sessions ?? [])].sort((a, b) => a.line - b.line);
  for (const s of rows) {
    out.push(
      `${selfLine === s.line ? '*' : ' '}${String(s.line + 1).padStart(3)} vty ${String(s.line).padEnd(5)}${(s.user || '').padEnd(11)}idle                 ${idle(s.since)} ${s.from}`,
    );
  }
  return out;
}

export function showSsh(d: D, e: Engine): string[] {
  const m = cli(d) ? mgmtOf(cli(d)!.sys) : undefined;
  const rows = (m?.sessions ?? []).filter((s) => s.protocol === 'ssh');
  if (rows.length === 0)
    return ['%No SSHv2 server connections running.', '%No SSHv1 server connections running.'];
  const out = ['Connection Version Mode Encryption  Hmac         State                 Username'];
  rows.forEach((s, i) =>
    out.push(
      `${i}          2.0     IN   aes128-cbc  hmac-sha1    Session started       ${s.user}`,
      `${i}          2.0     OUT  aes128-cbc  hmac-sha1    Session started       ${s.user}`,
    ),
  );
  void e;
  return out;
}

export function showIpSsh(d: D): string[] {
  const cfg = cli(d);
  const m = cfg ? mgmtOf(cfg.sys) : undefined;
  const on = !!cfg?.sys.domainName && m?.ssh.keyBits !== undefined;
  return [
    `SSH ${on ? 'Enabled' : 'Disabled'} - version ${m?.ssh.version ?? 2}.0`,
    'Authentication timeout: 120 secs; Authentication retries: 3',
  ];
}

export function showKeys(d: D): string[] {
  const cfg = cli(d);
  const m = cfg ? mgmtOf(cfg.sys) : undefined;
  if (!cfg || m?.ssh.keyBits === undefined)
    return ['% No Signature RSA Keys found in configuration.'];
  const name = `${cfg.sys.hostname}${cfg.sys.domainName ? '.' + cfg.sys.domainName : ''}`;
  return [
    '% Key pair was generated at: 00:00:00 UTC Mar 1 1993',
    `Key name: ${name}`,
    ' Key type: RSA KEYS',
    ' Storage Device: not specified',
    ' Usage: General Purpose Key',
    ' Key is not exportable.',
    ` Key Data (${m.ssh.keyBits} bit, simulated):`,
    '  30819F30 0D06092A 864886F7 0D010101 05000381 8D003081 89028181 00C4AF21',
  ];
}

export function showLogging(d: D): string[] {
  const cfg = cli(d);
  const m: MgmtCfg | undefined = cfg ? mgmtOf(cfg.sys) : undefined;
  const sevName = [
    'emergencies',
    'alerts',
    'critical',
    'errors',
    'warnings',
    'notifications',
    'informational',
    'debugging',
  ];
  const out = [
    'Syslog logging: enabled (0 messages dropped, 0 messages rate-limited, 0 flushes, 0 overruns)',
    '    Console logging: level debugging',
    `    Monitor logging: level debugging`,
    `    Buffer logging: ${m?.syslog.buffered ? `level debugging, ${m.logBuffer.length} messages logged` : 'disabled'}`,
    `    Trap logging: level ${sevName[m?.syslog.trap ?? 6]}, ${m?.logBuffer.length ?? 0} message lines logged`,
  ];
  for (const h of m?.syslog.hosts ?? [])
    out.push(`        Logging to ${h}  (udp port 514, audit disabled, link up)`);
  out.push('', 'Log Buffer (4096 bytes):', '');
  out.push(...(m?.logBuffer ?? []));
  return out;
}

export function showSnmp(d: D): string[] {
  const cfg = cli(d);
  const m = cfg ? mgmtOf(cfg.sys) : undefined;
  if (!m || m.snmp.communities.length === 0) return ['%SNMP agent not enabled'];
  const out: string[] = [];
  if (m.snmp.contact) out.push(`Contact: ${m.snmp.contact}`);
  if (m.snmp.location) out.push(`Location: ${m.snmp.location}`);
  out.push('0 SNMP packets input', '0 SNMP packets output');
  for (const c of m.snmp.communities)
    out.push(
      '',
      `Community name: ${c.name}`,
      `Community Index: ${c.name}`,
      `Community SecurityName: ${c.name}`,
      `storage-type: nonvolatile\t active`,
      `access: ${c.rw ? 'read-write' : 'read-only'}`,
    );
  return out;
}

export function showAaa(d: D): string[] {
  const cfg = cli(d);
  const m = cfg ? mgmtOf(cfg.sys) : undefined;
  if (!m?.aaa.newModel) return ['AAA is not enabled (aaa new-model)'];
  return [
    `AAA new-model enabled; login list "${m.aaa.listName}": ${m.aaa.methods.map((x) => (x === 'radius' ? 'group radius' : x)).join(' ') || 'none'}`,
    ...m.aaa.radius.map((r) => `RADIUS server ${r.host} (udp port 1812)`),
  ];
}

/** Firewall: `show conn` */
export function showConn(e: Engine, d: D): string[] {
  const fw = d.config.kind === 'router' ? d.config.fw : undefined;
  if (!fw) return [];
  const conns = fw.conns.filter((c) => e.state.now - c.lastAt < 3_600_000_000);
  const out = [`${conns.length} in use, ${Math.max(conns.length, fw.built)} most used`];
  for (const c of conns) {
    const a = fw.ifaces[c.inIface]?.nameif ?? c.inIface;
    const b = fw.ifaces[c.outIface]?.nameif ?? c.outIface;
    const proto = c.proto.toUpperCase();
    const ep = (ip: string, port: number): string =>
      c.proto === 'icmp' ? `${ip}:${port}` : `${ip}:${port}`;
    out.push(
      `${proto} ${b} ${ep(c.dst, c.dport)} ${a} ${ep(c.src, c.sport)}, idle ${idleText(e.state.now - c.lastAt)}, bytes 0, flags ${c.flags}`,
    );
  }
  return out;
}

/** Firewall: `show xlate` */
export function showXlate(e: Engine, d: D): string[] {
  const cfg = d.config.kind === 'router' ? d.config : undefined;
  if (!cfg?.fw) return [];
  const now = e.state.now;
  const rows = cfg.nat.table.filter((x) => x.expiresAt > now);
  const out = [`${rows.length} in use, ${rows.length} most used`];
  for (const x of rows) {
    out.push(
      `${x.kind === 'static' ? 'NAT' : 'PAT'} Global ${x.insideGlobal.ip}${x.proto === 'icmp' ? '' : `(${x.insideGlobal.port})`} Local ${x.insideLocal.ip}${x.proto === 'icmp' ? '' : `(${x.insideLocal.port})`}`,
    );
  }
  return out;
}

export function showNameif(d: D): string[] {
  const cfg = d.config.kind === 'router' ? d.config : undefined;
  if (!cfg?.fw) return [];
  const out = ['Interface                Name                     Security'];
  for (const p of d.ports) {
    const f = cfg.fw.ifaces[p.id];
    if (f)
      out.push(
        `${ifDisplay(d, p.id).padEnd(24)} ${f.nameif.padEnd(24)} ${String(f.level).padStart(3)}`,
      );
  }
  return out;
}

export { oidName };
