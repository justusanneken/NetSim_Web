import { describe, expect, it } from 'vitest';
import { Engine, type HostConfig } from '@netsim/engine';
import { CliSession, ShellStack } from '../src';

const sec = (e: Engine, s: number): void => void e.runUntil(e.state.now + s * 1_000_000);

describe('QA TFTP backup/restore of a rich config', () => {
  it('backup, write erase + reload, restore => identical running-config', () => {
    const e = new Engine({ seed: 1 });
    const r1 = e.addDevice('router', { name: 'R1' });
    const srv = e.addDevice('server', { name: 'Srv' });
    e.connect({ deviceId: srv, portId: 'p0' }, { deviceId: r1, portId: 'p1' }, 'straight');
    e.setHostIp(srv, '10.0.1.10', '255.255.255.0', '10.0.1.1');
    const d = e.getDevice(r1);
    if (d?.config.kind === 'router') d.config.sys.setupDone = true;
    const r = e.p5.setServices(srv, { tftp: { enabled: true, files: {} } });
    expect(r.ok).toBe(true);
    const st = new ShellStack(new CliSession(e, r1));
    const run = (...ls: string[]): string =>
      ls.map((l) => `${st.prompt()}${st.secret() ? '' : l}\n${st.input(l)}`).join('');
    const errs = run(
      'enable',
      'configure terminal',
      'hostname Edge',
      'enable secret cl4ss',
      'ip domain-name lab.local',
      'username admin privilege 15 secret s3cret',
      'interface gi0/1',
      'ip address 10.0.1.1 255.255.255.0',
      'ip nat inside',
      'ip access-group 110 in',
      'no shutdown',
      'exit',
      'interface gi0/0',
      'ip address 203.0.113.2 255.255.255.252',
      'ip nat outside',
      'standby 5 ip 203.0.113.3',
      'exit',
      'interface loopback0',
      'ip address 1.1.1.1 255.255.255.255',
      'exit',
      'access-list 1 permit 10.0.1.0 0.0.0.255',
      // die eingehende ACL gilt (wie bei IOS) auch für Verkehr an den Router: TFTP-Antworten erlauben
      'access-list 110 permit udp host 10.0.1.10 any',
      'access-list 110 permit tcp any any eq 80',
      'access-list 110 deny ip any any',
      'ip nat inside source list 1 interface gi0/0 overload',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.1',
      'ip prefix-list P1 seq 5 permit 10.0.0.0/8 le 24',
      'route-map RM permit 10',
      'match ip address prefix-list P1',
      'set metric 100',
      'exit',
      'router ospf 1',
      'router-id 1.1.1.1',
      'network 10.0.1.0 0.0.0.255 area 0',
      'redistribute static subnets route-map RM',
      'default-information originate',
      'exit',
      'router bgp 65001',
      'neighbor 203.0.113.1 remote-as 65000',
      'network 10.0.1.0 mask 255.255.255.0',
      'exit',
      'ntp server 10.0.1.10',
      'logging host 10.0.1.10',
      'snmp-server community ro1 RO',
      'banner motd #Authorized only#',
      'line vty 0 4',
      'login local',
      'transport input ssh',
      'end',
    );
    expect(errs).not.toMatch(/% Invalid|% Incomplete|% Ambiguous/);
    sec(e, 2);
    const before = run('show running-config');
    const out = run('copy running-config tftp://10.0.1.10/edge-confg');
    expect(out).toContain('[OK -');
    const file = (e.getDevice(srv)?.config as HostConfig).services.tftp?.files['edge-confg'];
    expect(file).toBeDefined();
    run('write erase', '', 'reload', 'no', '');
    run('', 'enable');
    expect(run('show running-config')).not.toContain('router bgp');
    // minimal reachability to the TFTP server after erase
    run(
      'configure terminal',
      'interface gi0/1',
      'ip address 10.0.1.1 255.255.255.0',
      'no shutdown',
      'end',
    );
    sec(e, 1);
    const back = run('copy tftp://10.0.1.10/edge-confg running-config');
    expect(back).toContain('[OK -');
    const after = run('show running-config');
    const strip = (x: string): string =>
      x
        .replace(/Current configuration.*\n/, '')
        .replace(/^Edge#show running-config\n|^Router#show running-config\n/, '');
    expect(strip(after)).toBe(strip(before));
  });
});
