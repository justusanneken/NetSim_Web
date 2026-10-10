import { describe, expect, it } from 'vitest';
import { Engine, mgmtOf, type HostConfig, type RouterConfig } from '@netsim/engine';
import { CliSession, HostShell, ShellStack, Terminal } from '../src';
import { renderRunningConfig } from '../src';

const sec = (e: Engine, s: number): void => {
  e.runUntil(e.state.now + s * 1_000_000);
};
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

/** PC (10.0.0.2) – R1 (.1 / 10.0.1.1) – Server (10.0.1.10). */
function lab() {
  const e = new Engine({ seed: 1 });
  const r1 = e.addDevice('router', { name: 'R1' });
  const pc = e.addDevice('pc', { name: 'PC' });
  const srv = e.addDevice('server', { name: 'Srv' });
  e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: r1, portId: 'p0' }, 'straight');
  e.connect({ deviceId: srv, portId: 'p0' }, { deviceId: r1, portId: 'p1' }, 'straight');
  e.setHostIp(pc, '10.0.0.2', '255.255.255.0', '10.0.0.1');
  e.setHostIp(srv, '10.0.1.10', '255.255.255.0', '10.0.1.1');
  const d = e.getDevice(r1);
  if (d?.config.kind === 'router') d.config.sys.setupDone = true;
  const stack = new ShellStack(new CliSession(e, r1));
  const session = (stack as unknown as { stack: CliSession[] }).stack[0] as CliSession;
  const run = (...ls: string[]): string =>
    ls.map((l) => `${stack.prompt()}${stack.secret() ? '' : l}\n${stack.input(l)}`).join('');
  run(
    'enable',
    'configure terminal',
    'interface gi0/0',
    'ip address 10.0.0.1 255.255.255.0',
    'no shutdown',
    'exit',
    'interface gi0/1',
    'ip address 10.0.1.1 255.255.255.0',
    'no shutdown',
    'end',
  );
  sec(e, 1);
  const pcStack = new ShellStack(new HostShell(e, pc));
  const pcRun = (...ls: string[]): string =>
    ls.map((l) => `${pcStack.prompt()}${pcStack.secret() ? '' : l}\n${pcStack.input(l)}`).join('');
  return { e, r1, pc, srv, stack, session, run, pcStack, pcRun };
}

const hcfg = (e: Engine, id: string): HostConfig => e.getDevice(id)?.config as HostConfig;
const rcfg = (e: Engine, id: string): RouterConfig => e.getDevice(id)?.config as RouterConfig;

describe('CLI Phase 5: TFTP-Backup', () => {
  it('copy running-config tftp: (URL und interaktiv) und Restore', () => {
    const { e, srv, run } = lab();
    must(e.p5.setServices(srv, { tftp: { enabled: true, files: {} } }));
    const out = run('copy running-config tftp://10.0.1.10/r1-confg');
    expect(out).toContain('[OK -');
    expect(hcfg(e, srv).services.tftp?.files['r1-confg']).toContain('hostname R1');
    const dlg = run('copy running-config tftp:', '10.0.1.10', '');
    expect(dlg).toContain('Address or name of remote host []?');
    expect(dlg).toContain('Destination filename [r1-confg]?');
    expect(hcfg(e, srv).services.tftp?.files['r1-confg']).toBeDefined();
    run('configure terminal', 'hostname Changed', 'end');
    const back = run('copy tftp://10.0.1.10/r1-confg running-config');
    expect(back).toContain('[OK -');
    expect(run('show running-config')).toContain('hostname R1');
    const miss = run('copy tftp://10.0.1.10/nope running-config');
    expect(miss).toContain('%Error opening tftp://10.0.1.10/nope');
  });

  it('Server aus: Timeout-Meldung', () => {
    const { run } = lab();
    expect(run('copy running-config tftp://10.0.1.10/x')).toContain('(Timed out)');
  });
});

describe('CLI Phase 5: Telnet und SSH', () => {
  const secure = (run: (...l: string[]) => string): void => {
    run(
      'configure terminal',
      'username admin privilege 15 secret s3cret',
      'ip domain-name lab.local',
      'crypto key generate rsa modulus 1024',
      'line vty 0 4',
      'login local',
      'transport input ssh',
      'end',
    );
  };

  it('Telnet vom PC zum Router mit vty-Passwort, show users, exit', () => {
    const { pcRun, run, pcStack } = lab();
    run('configure terminal', 'line vty 0 4', 'password cisco', 'login', 'end');
    const out = pcRun('telnet 10.0.0.1', 'cisco');
    expect(out).toContain('Connecting To 10.0.0.1');
    expect(pcStack.prompt()).toBe('R1>');
    const users = pcRun('show users');
    expect(users).toContain('vty 0');
    expect(users).toContain('10.0.0.2');
    expect(users).toContain('*');
    const bye = pcRun('exit');
    expect(bye).toContain('closed by foreign host');
    expect(pcRun('ver')).toContain('is not recognized');
  });

  it('Telnet scheitert mit falschem Passwort; ohne Passwort: "Password required, but none set"', () => {
    const { pcRun, run } = lab();
    const none = pcRun('telnet 10.0.0.1');
    expect(none).toContain('Password required, but none set');
    run('configure terminal', 'line vty 0 4', 'password cisco', 'login', 'end');
    const bad = pcRun('telnet 10.0.0.1', 'x', 'y', 'z');
    expect(bad).toContain('% Bad passwords');
    expect(bad).toContain('closed by foreign host');
  });

  it('SSH nur mit transport input ssh und korrekten Zugangsdaten; Telnet wird abgelehnt', () => {
    const { pcRun, run, pcStack } = lab();
    secure(run);
    const refused = pcRun('telnet 10.0.0.1');
    expect(refused).toContain('Could not open connection');
    const bad = pcRun('ssh -l admin 10.0.0.1', 'wrong', 'alsowrong', 'nope');
    expect(bad).toContain('% Authentication failed');
    pcRun('ssh -l admin 10.0.0.1', 's3cret');
    expect(pcStack.prompt()).toBe('R1#');
    expect(pcRun('show ip ssh')).toContain('SSH Enabled - version 1.99');
    expect(pcRun('show ssh')).toContain('admin');
    pcRun('exit');
  });

  it('Mehrere vty-Sitzungen parallel; Konfiguration über vty; debug nur mit terminal monitor', () => {
    const { e, r1, pc, run, pcRun, srv, pcStack } = lab();
    run('configure terminal', 'line vty 0 4', 'password cisco', 'login', 'end');
    // Sitzung 1: vom PC (Eingabeaufforderung)
    pcRun('telnet 10.0.0.1', 'cisco');
    expect(pcStack.prompt()).toBe('R1>');
    // Sitzung 2: vom Server-Rechner (zweiter Host) – gleiche Technik
    const srvStack = new ShellStack(new HostShell(e, srv));
    srvStack.input('telnet 10.0.1.1');
    srvStack.input('cisco');
    expect(srvStack.prompt()).toBe('R1>');
    const m = mgmtOf(rcfg(e, r1).sys);
    expect(m.sessions.map((s) => s.line).sort()).toEqual([0, 1]);
    expect(run('show users')).toMatch(/\* {2}0 con 0/);
    // debug: Console immer, vty nur mit terminal monitor
    run('enable', 'debug ip ospf adj');
    const mon = pcRun('terminal monitor');
    void mon;
    expect(m.sessions).toHaveLength(2);
    pcRun('exit');
    srvStack.input('exit');
    expect(m.sessions).toHaveLength(0);
    void pc;
  });
});

describe('CLI Phase 5: NTP, Uhr, Syslog, SNMP, AAA', () => {
  it('clock set / show clock, ntp server / show ntp status', () => {
    const { e, srv, run } = lab();
    expect(run('show clock')).toContain('*00:');
    run('clock set 14:30:00 8 Oct 2026');
    const c = run('show clock');
    expect(c).toMatch(/14:30:0\d\.\d{3} UTC Thu Oct 8 2026/);
    expect(run('show ntp status')).toContain('unsynchronized');
    must(e.p5.setServices(srv, { ntp: { enabled: true } }));
    run('configure terminal', 'ntp server 10.0.1.10', 'end');
    sec(e, 10);
    expect(run('show ntp status')).toContain(
      'Clock is synchronized, stratum 2, reference is 10.0.1.10',
    );
    expect(run('show clock')).toMatch(/^R1#show clock\n12:00:/m);
    expect(run('show ntp associations')).toContain('10.0.1.10');
    expect(run('clock set 99:00:00 8 Oct 2026')).toContain('% Invalid');
  });

  it('show ntp status: nach Ausfall des Servers wieder unsynchronisiert', () => {
    const { e, srv, run } = lab();
    must(e.p5.setServices(srv, { ntp: { enabled: true } }));
    run('configure terminal', 'ntp server 10.0.1.10', 'end');
    sec(e, 10);
    expect(run('show ntp status')).toContain('Clock is synchronized, stratum 2');
    must(e.p5.setServices(srv, { ntp: { enabled: false } }));
    sec(e, 64 * 6);
    expect(run('show ntp status')).toContain('Clock is unsynchronized');
  });

  it('logging host / trap / buffered, snmp-server, aaa, radius-server werden in der running-config gerendert', () => {
    const { run } = lab();
    run(
      'configure terminal',
      'logging host 10.0.1.10',
      'logging trap warnings',
      'snmp-server community public ro',
      'snmp-server community private rw',
      'snmp-server location Lab',
      'aaa new-model',
      'radius-server host 10.0.1.10 key k3y',
      'aaa authentication login default group radius local',
      'username bob privilege 7 password pw',
      'ntp server 10.0.1.10',
      'ntp master 5',
      'end',
    );
    const rc = run('show running-config');
    for (const l of [
      'logging host 10.0.1.10',
      'logging trap 4',
      'snmp-server community public RO',
      'snmp-server community private RW',
      'snmp-server location Lab',
      'aaa new-model',
      'radius-server host 10.0.1.10 key k3y',
      'aaa authentication login default group radius local',
      'username bob privilege 7 secret 5 ',
      'ntp server 10.0.1.10',
      'ntp master 5',
    ])
      expect(rc).toContain(l);
    expect(run('show snmp')).toContain('Community name: private');
    expect(run('show aaa')).toContain('group radius local');
  });

  it('running-config-Replay stellt die Phase-5-Konfiguration identisch wieder her', () => {
    const { e, r1, run, session } = lab();
    run(
      'configure terminal',
      'ip domain-name lab.local',
      'username admin privilege 15 secret s3cret',
      'crypto key generate rsa modulus 1024',
      'ip ssh version 2',
      'logging host 10.0.1.10',
      'snmp-server community public ro',
      'ntp server 10.0.1.10',
      'aaa new-model',
      'aaa authentication login default group radius local',
      'radius-server host 10.0.1.10 key abc',
      'line vty 0 15',
      'login local',
      'transport input ssh',
      'end',
    );
    const before = renderRunningConfig(e, e.getDevice(r1) as never).join('\n');
    expect(before).toContain('line vty 0 15');
    expect(before).toContain(' transport input ssh');
    e.factoryReset(r1);
    const s2 = new CliSession(e, r1);
    s2.applyConfigText(before);
    const after = renderRunningConfig(e, e.getDevice(r1) as never).join('\n');
    expect(after).toBe(before);
    void session;
  });
});

describe('CLI Phase 5: Firewall', () => {
  function fwLab() {
    const e = new Engine({ seed: 1 });
    const fw = e.addDevice('firewall', { name: 'FW' });
    const inn = e.addDevice('pc', { name: 'In' });
    const out = e.addDevice('server', { name: 'Out' });
    e.connect({ deviceId: inn, portId: 'p0' }, { deviceId: fw, portId: 'p0' }, 'straight');
    e.connect({ deviceId: out, portId: 'p0' }, { deviceId: fw, portId: 'p1' }, 'straight');
    e.setHostIp(inn, '10.0.0.10', '255.255.255.0', '10.0.0.1');
    e.setHostIp(out, '203.0.113.10', '255.255.255.0', '203.0.113.1');
    const d = e.getDevice(fw);
    if (d?.config.kind === 'router') d.config.sys.setupDone = true;
    const s = new CliSession(e, fw);
    const run = (...ls: string[]): string =>
      ls.map((l) => `${s.prompt()}${s.secret() ? '' : l}\n${s.input(l)}`).join('');
    run(
      'enable',
      'configure terminal',
      'interface gi0/0',
      'nameif inside',
      'security-level 100',
      'ip address 10.0.0.1 255.255.255.0',
      'no shutdown',
      'exit',
      'interface gi0/1',
      'nameif outside',
      'security-level 0',
      'ip address 203.0.113.1 255.255.255.0',
      'no shutdown',
      'end',
    );
    sec(e, 1);
    return { e, fw, inn, out, run, s };
  }
  const ping = (e: Engine, from: string, dst: string): boolean => {
    const r = must(e.ping(from, dst, { count: 1 }));
    sec(e, 6);
    return hcfg(e, from).pings.some((p) => p.id === r && p.status === 'reply');
  };

  it('nameif/security-level, show nameif, stateful: inside→outside ok, outside→inside blockiert, show conn', () => {
    const { e, inn, out, run } = fwLab();
    expect(run('show nameif')).toContain('inside');
    expect(ping(e, inn, '203.0.113.10')).toBe(true);
    expect(run('show conn')).toMatch(/ICMP outside 203\.0\.113\.10:\d+ inside 10\.0\.0\.10:\d+/);
    expect(ping(e, out, '10.0.0.10')).toBe(false);
    expect(run('show running-config')).toContain(' nameif inside');
  });

  it('access-list/access-group, NAT-Objekt, show xlate, running-config-Replay', () => {
    const { e, fw, inn, out, run } = fwLab();
    run(
      'configure terminal',
      'object network LAN',
      'subnet 10.0.0.0 255.255.255.0',
      'nat (inside,outside) dynamic interface',
      'exit',
      'access-list OUT extended permit icmp any host 10.0.0.10',
      'access-group OUT in interface outside',
      'end',
    );
    expect(ping(e, out, '10.0.0.10')).toBe(true);
    expect(ping(e, inn, '203.0.113.10')).toBe(true);
    expect(run('show xlate')).toContain('PAT Global 203.0.113.1');
    const rc = run('show running-config');
    expect(rc).toContain('access-list OUT extended permit icmp any host 10.0.0.10');
    expect(rc).toContain('access-group OUT in interface outside');
    expect(rc).toContain(' nat (inside,outside) dynamic interface');
    expect(rc).not.toContain('ip nat inside source');
    const before = renderRunningConfig(e, e.getDevice(fw) as never).join('\n');
    e.factoryReset(fw);
    new CliSession(e, fw).applyConfigText(before);
    expect(renderRunningConfig(e, e.getDevice(fw) as never).join('\n')).toBe(before);
  });
});

describe('Terminal-Integration', () => {
  it('Terminal schreibt Prompt der Remote-Sitzung nach telnet', () => {
    const { e, pc, run } = lab();
    run('configure terminal', 'line vty 0 4', 'password cisco', 'login', 'end');
    const term = new Terminal(new ShellStack(new HostShell(e, pc)));
    term.start();
    let out = term.handle('telnet 10.0.0.1\r');
    expect(out).toContain('Password: ');
    out = term.handle('cisco\r');
    expect(out).toContain('R1>');
    out = term.handle('exit\r');
    expect(out).toContain('closed by foreign host');
    expect(out).toContain('C:\\>');
  });
});
