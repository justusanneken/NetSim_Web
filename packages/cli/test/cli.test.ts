import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { CliSession } from '../src';
import { matchGolden } from './golden';
import { CONFIG_ROUTER, rig } from './helpers';

describe('Parser: Abkürzungen, Fehler, Hilfe', () => {
  it('eindeutige Abkürzungen werden akzeptiert', () => {
    const r = rig();
    const out = r.run('en', 'conf t', 'int gi0/0', 'ip addr 10.0.1.1 255.255.255.0', 'exit', 'end');
    expect(out).toContain('R1(config-if)#');
    expect(r.s.mode).toBe('priv');
    expect(r.s.engine.getDevice(r.r1)?.config).toMatchObject({
      ifaces: { p0: { ip: '10.0.1.1', mask: '255.255.255.0' } },
    });
  });

  it('Fehlermeldungen im IOS-Stil mit korrekter Caret-Position', () => {
    const r = rig();
    r.run('enable');
    expect(r.s.input('sh ipp')).toBe(
      "      ^\n% Invalid input detected at '^' marker.\n\n".replace('      ^', '      ^'),
    );
    // Prompt "R1#" (3 Zeichen) + "show ip " (8) → Caret unter dem 'x'
    expect(r.s.input('show ip xyz')).toBe(
      `${' '.repeat(3 + 8)}^\n% Invalid input detected at '^' marker.\n\n`,
    );
    expect(r.s.input('show')).toBe('% Incomplete command.\n\n');
    expect(r.s.input('sh i r')).toBe('% Ambiguous command:  "sh i"\n\n');
    expect(r.s.input('show ip route 999.1.1.1')).toContain('Invalid input detected');
    expect(r.s.input('show interfaces gi9/9')).toContain('Invalid input detected');
  });

  it('Caret-Position in untergeordneten Modi', () => {
    const r = rig();
    r.run('enable', 'configure terminal', 'interface gi0/0');
    expect(r.s.input('ip xyz 10.0.0.1')).toBe(
      `${' '.repeat('R1(config-if)#'.length + 3)}^\n% Invalid input detected at '^' marker.\n\n`,
    );
  });

  it('? zeigt Folgeoptionen (kontextsensitiv, auch hinter Wortteil)', () => {
    const r = rig();
    expect(r.s.help('')).toContain('enable');
    r.run('enable');
    const h = r.s.help('show ip route ') as string;
    expect(h).toContain('A.B.C.D');
    expect(h).toContain('<cr>');
    expect(r.s.help('sh')).toBe('show\n');
    expect(r.s.help('co')).toBe('configure  copy\n');
    expect(r.s.help('show ip ')).toContain('route');
    expect(r.s.help('zzz')).toBe('% Unrecognized command\n');
    expect(r.s.help('show ip route 1.1.1.1 ')).toBe('  <cr>\n');
  });

  it('Tab vervollständigt eindeutig oder bis zum gemeinsamen Präfix', () => {
    const r = rig();
    r.run('enable');
    expect(r.s.complete('conf')).toBe('configure ');
    expect(r.s.complete('sh')).toBe('show ');
    expect(r.s.complete('show ru')).toBe('show running-config ');
    expect(r.s.complete('co')).toBe('co');
    expect(r.s.complete('zzz')).toBe('zzz');
    expect(r.s.complete('show ip ')).toBe('show ip ');
    expect(r.s.complete('show startup-c')).toBe('show startup-config ');
    r.run('configure terminal');
    expect(r.s.complete('do sh')).toBe('do show ');
    expect(r.s.help('do sh')).toBe('show\n');
  });

  it('no- und default-Präfix sowie do', () => {
    const r = rig();
    r.run('enable', 'configure terminal', 'hostname Core', 'no hostname');
    expect(r.s.sys.hostname).toBe('Router');
    r.run('hostname Core', 'default hostname');
    expect(r.s.sys.hostname).toBe('Router');
    const o = r.run('do show clock');
    expect(o).toContain('UTC');
    expect(r.s.mode).toBe('config');
  });

  it('Pipes: include, exclude, begin, section, count', () => {
    const r = rig();
    r.run(...CONFIG_ROUTER);
    expect(r.s.input('show running-config | include hostname')).toBe('hostname R1\n');
    expect(r.s.input('show running-config | begin interface')).toMatch(
      /^interface GigabitEthernet0\/0/,
    );
    expect(r.s.input('show ip interface brief | exclude unassigned')).not.toContain('unassigned');
    expect(r.s.input('show running-config | section interface')).toContain(' ip address 10.0.1.1');
    expect(r.s.input('show ip interface brief | count Gigabit')).toBe(
      'Number of lines which match regexp = 3\n',
    );
    expect(r.s.input('show ip interface brief | include (')).toContain('Invalid regular');
    expect(r.s.input('show version | bogus x')).toContain('Invalid input');
  });
});

describe('Modi und Konfiguration', () => {
  it('Prompts, exit/end/disable/Ctrl+Z-Verhalten', () => {
    const r = rig();
    expect(r.s.prompt()).toBe('R1>');
    r.run('enable');
    expect(r.s.prompt()).toBe('R1#');
    r.run('configure terminal', 'interface gi0/0');
    expect(r.s.prompt()).toBe('R1(config-if)#');
    r.run('exit');
    expect(r.s.prompt()).toBe('R1(config)#');
    r.run('line console 0');
    expect(r.s.prompt()).toBe('R1(config-line)#');
    r.s.end();
    expect(r.s.prompt()).toBe('R1#');
    r.run('disable');
    expect(r.s.prompt()).toBe('R1>');
    expect(r.s.input('exit')).toContain('con0 is now available');
  });

  it('configure ohne terminal fragt nach', () => {
    const r = rig();
    r.run('enable');
    r.s.input('configure');
    expect(r.s.prompt()).toContain('terminal');
    r.s.input('');
    expect(r.s.mode).toBe('config');
  });

  it('IP-Konfiguration: Konflikte und Fehler', () => {
    const r = rig();
    r.run(...CONFIG_ROUTER);
    r.run('configure terminal', 'interface gi0/2');
    expect(r.s.input('ip address 10.0.1.5 255.255.255.0')).toBe(
      '% 10.0.1.0 overlaps with GigabitEthernet0/0\n',
    );
    expect(r.s.input('ip address 10.0.9.0 255.255.255.0')).toBe(
      'Bad mask /24 for address 10.0.9.0\n',
    );
    expect(r.s.input('ip address 10.0.9.1 255.0.255.0')).toContain('Invalid input');
    expect(r.s.input('ip mtu 1400')).toBe('');
    expect(r.s.input('mtu 10')).toContain('Invalid input');
    expect(r.s.input('speed 100')).toBe('');
    expect(r.s.input('duplex full')).toBe('');
    expect(r.s.input('description Uplink to ISP')).toBe('');
    expect(r.s.input('no description')).toBe('');
    expect(r.s.input('no ip address')).toBe('');
    expect(r.s.input('shutdown')).toBe('');
  });

  it('statische Routen anlegen/entfernen, auch mit Ausgangsinterface', () => {
    const r = rig();
    r.run(...CONFIG_ROUTER, 'configure terminal');
    r.run(
      'ip route 192.168.0.0 255.255.0.0 10.0.2.10',
      'ip route 172.16.0.0 255.240.0.0 gi0/1 150',
    );
    const out = r.run('end', 'show ip route');
    expect(out).toContain('S        192.168.0.0/16 [1/0] via 10.0.2.10');
    expect(out).toContain(
      'S        172.16.0.0/12 [150/0] is directly connected, GigabitEthernet0/1',
    );
    r.run('configure terminal', 'no ip route 192.168.0.0 255.255.0.0 10.0.2.10', 'end');
    expect(r.run('show ip route 192.168.0.0')).toContain('% Network not in table');
    expect(r.run('show ip route 10.0.2.77')).toContain('Routing entry for 10.0.2.0/24');
    expect(r.run('show ip route 10.0.2.1')).toContain('Known via "receive"');
  });

  it('Default-Route: Gateway of last resort und S*', () => {
    const r = rig();
    r.run(...CONFIG_ROUTER, 'configure terminal', 'ip route 0.0.0.0 0.0.0.0 10.0.2.10', 'end');
    const out = r.run('show ip route');
    expect(out).toContain('Gateway of last resort is 10.0.2.10 to network 0.0.0.0');
    expect(out).toContain('S*   0.0.0.0/0 [1/0] via 10.0.2.10');
  });

  it('Passwörter: enable secret/password, Typ 7, Login an der Console', () => {
    const r = rig();
    r.run(
      'enable',
      'configure terminal',
      'enable secret cisco',
      'enable password hidden',
      'service password-encryption',
      'line console 0',
      'password con123',
      'login',
      'end',
    );
    const cfg = r.run('show running-config');
    expect(cfg).toMatch(/enable secret 5 \$1\$mERr\$\S{22}/);
    expect(cfg).toContain('enable password 7 ');
    expect(cfg).not.toContain('hidden');
    expect(cfg).not.toContain('con123');
    expect(cfg).toContain('service password-encryption\n');
    r.run('disable');
    r.s.input('enable');
    expect(r.s.prompt()).toBe('Password: ');
    expect(r.s.secret()).toBe(true);
    expect(r.s.input('wrong')).toBe('% Bad secrets\n');
    r.s.input('wrong');
    r.s.input('wrong');
    expect(r.s.prompt()).toBe('R1>');
    r.s.input('enable');
    r.s.input('cisco');
    expect(r.s.prompt()).toBe('R1#');
  });

  it('Banner (einzeilig und mehrzeilig), Startdialog, Console-Login', () => {
    const e = new Engine();
    const id = e.addDevice('router', { name: 'R9' });
    const s = new CliSession(e, id);
    expect(s.start()).toContain('System Configuration Dialog');
    expect(s.prompt()).toContain(
      'Would you like to enter the initial configuration dialog? [yes/no]',
    );
    expect(s.input('no')).toContain('Press RETURN to get started!');
    s.input('enable');
    s.input('configure terminal');
    s.input('banner motd #Hallo Welt#');
    s.input('banner motd $Zeile 1');
    expect(s.prompt()).toBe('');
    s.input('Zeile 2$');
    expect(s.sys.bannerMotd).toBe('Zeile 1\nZeile 2');
    s.input('banner motd #Hallo Welt#');
    s.input('line console 0');
    s.input('password pw');
    s.input('login');
    s.input('end');
    const again = new CliSession(e, id);
    const start = again.start();
    expect(start).toContain('Hallo Welt');
    expect(start).toContain('User Access Verification');
    expect(again.input('bad')).toContain('% Bad passwords');
    expect(again.prompt()).toBe('Password: ');
    expect(again.input('pw')).toBe('');
    expect(again.prompt()).toBe('R9>');
    s.input('configure terminal');
    s.input('no banner motd');
    expect(s.sys.bannerMotd).toBeUndefined();
  });

  it('Ping-Dialog (erweitert) und Ping-Optionen', () => {
    const r = rig();
    r.run(...CONFIG_ROUTER);
    r.s.input('ping');
    r.s.input('');
    r.s.input('10.0.2.10');
    r.s.input('3');
    r.s.input('1500');
    r.s.input('');
    r.s.input('y');
    r.s.input('gi0/0');
    const out = r.s.input('yes');
    expect(out).toContain('Sending 3, 1500-byte ICMP Echos to 10.0.2.10, timeout is 2 seconds:');
    expect(out).toContain('Success rate is');
    expect(r.run('ping 10.0.2.10 repeat 2 size 1600 df-bit')).toContain('Sending 2, 1600-byte');
    expect(r.run('ping 172.16.1.1 repeat 2')).toContain('U');
    expect(r.run('ping 10.0.2.99 repeat 1')).toContain('Success rate is 0 percent (0/1)');
    r.s.input('ping');
    r.s.input('');
    expect(r.s.input('bad.host')).toBe('');
    r.s.input('');
    r.s.input('');
    r.s.input('');
    expect(r.s.input('n')).toContain('% Bad IP address or host name');
  });

  it('terminal length/history und show history', () => {
    const r = rig();
    r.run(
      'enable',
      'terminal length 0',
      'terminal history size 3',
      'show clock',
      'show version',
      'show clock',
      'show users'.replace('users', 'clock'),
    );
    expect(r.s.terminalLength).toBe(0);
    expect(r.s.history.length).toBeLessThanOrEqual(3);
    expect(r.s.input('show history')).toContain('show clock');
    expect(r.s.input('terminal monitor')).toBe('');
  });
});

describe('Dateien: copy, erase, reload, Replay', () => {
  it('copy running-config startup-config speichert; running → startup → reload ergibt gleiche Config', () => {
    const r = rig();
    r.run(
      ...CONFIG_ROUTER,
      'configure terminal',
      'hostname Edge',
      'ip route 192.168.0.0 255.255.0.0 10.0.2.10',
      'banner motd #Hi#',
      'interface gi0/0',
      'description LAN',
      'ip mtu 1400',
      'exit',
      'enable secret geheim',
      'line vty 0 4',
      'password tel',
      'login',
      'end',
    );
    const before = r.s.input('show running-config');
    expect(r.s.input('show startup-config')).toBe('startup-config is not present\n');
    r.s.input('copy running-config startup-config');
    expect(r.s.prompt()).toContain('Destination filename');
    expect(r.s.input('')).toBe('Building configuration...\n[OK]\n');
    expect(r.s.input('show startup-config')).toContain('Using ');
    const out = r.run('reload', 'y');
    expect(out).toContain('Proceed with reload? [confirm]');
    expect(out).toContain('System Bootstrap');
    expect(r.s.mode).toBe('user');
    expect(r.s.prompt()).toBe('Edge>');
    r.run('enable');
    // enable secret ist nach dem Reload aktiv → Passwort nötig
    expect(r.s.prompt()).toBe('Password: ');
    r.s.input('geheim');
    expect(r.s.input('show running-config')).toBe(before);
  });

  it('reload fragt bei geänderter Konfiguration nach Speichern; ohne Startup erscheint der Setup-Dialog', () => {
    const r = rig();
    r.run('enable', 'configure terminal', 'hostname Tmp', 'end');
    r.s.input('reload');
    expect(r.s.prompt()).toContain('Save?');
    r.s.input('n');
    expect(r.s.prompt()).toContain('Proceed with reload?');
    const out = r.s.input('');
    expect(out).toContain('System Configuration Dialog');
    expect(r.s.prompt()).toContain('[yes/no]');
    r.s.input('yes');
    expect(r.s.prompt()).toBe('R1>');
    expect(r.s.sys.hostname).toBe('R1');
  });

  it('reload abbrechen, erase startup-config, copy startup running', () => {
    const r = rig();
    r.run('enable', 'configure terminal', 'hostname Keep', 'end', 'write memory');
    r.run('reload', 'n');
    expect(r.s.sys.hostname).toBe('Keep');
    expect(r.run('erase startup-config', 'n')).toContain('Continue? [confirm]');
    expect(r.s.sys.startupConfig).toBeDefined();
    r.run('copy startup-config running-config', '');
    r.run('configure terminal', 'hostname Other', 'end', 'copy startup-config running-config', '');
    expect(r.s.sys.hostname).toBe('Keep');
    expect(r.run('erase startup-config', '')).toContain('Erase of nvram: complete');
    expect(r.s.sys.startupConfig).toBeUndefined();
    expect(r.run('copy startup-config running-config', '')).toContain('No such file');
    r.run('write');
    expect(r.s.sys.startupConfig).toContain('hostname Keep');
  });
});

describe('Abnahme Phase 2: CLI-Golden-Tests', () => {
  it('Router-Konfiguration, show-Befehle, ping und traceroute', () => {
    const r = rig();
    const e = r.e;
    // zweiter Router dahinter
    const r2 = e.addDevice('router', { name: 'R2' });
    e.connect({ deviceId: r.r1, portId: 'p2' }, { deviceId: r2, portId: 'p2' }, 'crossover');
    const pc2 = e.addDevice('pc', { name: 'PC2' });
    e.connect({ deviceId: pc2, portId: 'p0' }, { deviceId: r2, portId: 'p0' }, 'straight');
    e.setHostIp(pc2, '10.0.3.10', '255.255.255.0', '10.0.3.1');
    const d2 = e.getDevice(r2);
    if (d2?.config.kind === 'router') d2.config.sys.setupDone = true;
    const s2 = new CliSession(e, r2);
    const run2 = (...ls: string[]) => ls.map((l) => `${s2.prompt()}${l}\n${s2.input(l)}`).join('');
    run2(
      'enable',
      'configure terminal',
      'interface gi0/2',
      'ip address 10.0.12.2 255.255.255.0',
      'no shutdown',
      'exit',
      'interface gi0/0',
      'ip address 10.0.3.1 255.255.255.0',
      'no shutdown',
      'exit',
      'ip route 10.0.1.0 255.255.255.0 10.0.12.1',
      'ip route 10.0.2.0 255.255.255.0 10.0.12.1',
      'end',
    );
    const out = r.run(
      ...CONFIG_ROUTER,
      'configure terminal',
      'hostname R1',
      'interface gi0/2',
      'description Link zu R2',
      'ip address 10.0.12.1 255.255.255.0',
      'no shutdown',
      'exit',
      'ip route 10.0.3.0 255.255.255.0 10.0.12.2',
      'end',
      'show ip interface brief',
      'show ip route',
      'show ip route 10.0.3.0',
      'ping 10.0.3.10',
      'traceroute 10.0.3.10',
      'ping 10.0.1.10',
      'show ip arp',
      'show interfaces gi0/2',
      'show version',
      'show running-config',
    );
    matchGolden('router-session', out);
  });

  it('Falsches Gateway / fehlende Route liefern die richtigen Fehlermeldungen', () => {
    const r = rig();
    r.run(...CONFIG_ROUTER);
    const out = r.run('ping 172.16.0.1 repeat 1', 'traceroute 172.16.0.1');
    matchGolden('router-unreachable', out);
  });

  it('Switch: Sitzung, MAC-Tabelle, Interface-Status', () => {
    const e = new Engine({ seed: 1 });
    const sw = e.addDevice('switch-l2', { name: 'SW1' });
    const a = e.addDevice('pc', { name: 'A' });
    const b = e.addDevice('pc', { name: 'B' });
    e.connect({ deviceId: a, portId: 'p0' }, { deviceId: sw, portId: 'p0' }, 'straight');
    e.connect({ deviceId: b, portId: 'p0' }, { deviceId: sw, portId: 'p1' }, 'straight');
    e.setHostIp(a, '10.0.0.1', '255.255.255.0');
    e.setHostIp(b, '10.0.0.2', '255.255.255.0');
    e.runUntil(e.state.now + 40_000_000);
    e.ping(a, '10.0.0.2');
    e.runAll();
    const d = e.getDevice(sw);
    if (d?.config.kind === 'switch') d.config.sys.setupDone = true;
    const s = new CliSession(e, sw);
    const run = (...ls: string[]) => ls.map((l) => `${s.prompt()}${l}\n${s.input(l)}`).join('');
    const out = run(
      'enable',
      'show mac address-table',
      'configure terminal',
      'interface fa0/2',
      'description Server B',
      'speed 10',
      'shutdown',
      'end',
      'show interfaces status',
      'show ip route',
      'show ip arp',
      'show running-config | section interface FastEthernet0/2',
      'clear mac address-table dynamic',
      'show mac address-table',
    );
    matchGolden('switch-session', out);
  });
});
