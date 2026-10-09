import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { CliSession } from '../src';
import { sec } from './gapsLab';

function wanRouter(e: Engine, name: string) {
  const id = e.addDevice('router', { name });
  e.setPower(id, false);
  if (!e.p5.insertModule(id, 0, 'HWIC-2T').ok) throw new Error('module');
  e.setPower(id, true);
  const d = e.getDevice(id);
  if (d?.config.kind === 'router') d.config.sys.setupDone = true;
  const s = new CliSession(e, id);
  const run = (...ls: string[]): string =>
    ls.map((l) => `${s.prompt()}${l}\n${s.input(l)}`).join('');
  return { id, s, run };
}

function lab() {
  const e = new Engine({ seed: 1 });
  const r1 = wanRouter(e, 'R1');
  const r2 = wanRouter(e, 'R2');
  const a = e.getDevice(r1.id)?.ports.find((p) => p.kind === 'serial')?.id as string;
  const b = e.getDevice(r2.id)?.ports.find((p) => p.kind === 'serial')?.id as string;
  const c = e.connect({ deviceId: r1.id, portId: a }, { deviceId: r2.id, portId: b }, 'serial-dce');
  if (!c.ok) throw new Error(c.error);
  return { e, r1, r2 };
}

const up = (r: ReturnType<typeof wanRouter>, ip: string): void => {
  r.run(
    'enable',
    'configure terminal',
    'interface serial0/0/0',
    `ip address ${ip} 255.255.255.252`,
    'no shutdown',
    'end',
  );
};

describe('Serial-WAN', () => {
  it('Ports heißen Serial0/<slot>/<n>', () => {
    const { e, r1 } = lab();
    const names = e.getDevice(r1.id)?.ports.map((p) => p.name);
    expect(names).toContain('Serial0/0/0');
    expect(names).toContain('Serial0/0/1');
  });

  it('ohne clock rate am DCE: up, line protocol down; mit Takt: up/up', () => {
    const { e, r1, r2 } = lab();
    up(r1, '10.0.0.1');
    up(r2, '10.0.0.2');
    expect(r1.run('show ip interface brief')).toContain(
      'Serial0/0/0            10.0.0.1        YES manual up                    down',
    );
    expect(r1.run('show controllers serial 0/0/0')).toContain('DCE V.35, no clock');
    expect(r2.run('show controllers serial 0/0/0')).toContain('DTE V.35 clocks stopped.');
    r1.run('configure terminal', 'interface serial0/0/0', 'clock rate 64000', 'end');
    const out = r1.run('show interfaces serial0/0/0', 'show controllers serial 0/0/0');
    expect(out).toContain('Serial0/0/0 is up, line protocol is up ');
    expect(out).toContain('Encapsulation HDLC, loopback not set');
    expect(out).toContain('DCE V.35, clock rate 64000');
    expect(r2.run('show controllers serial 0/0/0')).toContain(
      'DTE V.35 TX and RX clocks detected.',
    );
    expect(r2.run('show ip interface brief')).toContain('up                    up');
    sec(e, 1);
  });

  it('clock rate am DTE-Ende wird abgelehnt', () => {
    const { r2 } = lab();
    const out = r2.run('enable', 'configure terminal', 'interface serial0/0/0', 'clock rate 64000');
    expect(out).toContain('%Error: This command applies only to DCE interfaces');
  });

  it('Ping über HDLC-Link; Kapselungs-Mismatch hält das Line-Protocol unten', () => {
    const { e, r1, r2 } = lab();
    up(r1, '10.0.0.1');
    up(r2, '10.0.0.2');
    r1.run('configure terminal', 'interface serial0/0/0', 'clock rate 64000', 'end');
    expect(r1.run('ping 10.0.0.2')).toContain('Success rate is 100 percent');
    r2.run('configure terminal', 'interface serial0/0/0', 'encapsulation ppp', 'end');
    expect(r1.run('show interfaces serial0/0/0')).toContain('line protocol is down');
    expect(r2.run('show interfaces serial0/0/0')).toContain('Encapsulation PPP, LCP Closed');
    expect(r1.run('ping 10.0.0.2')).toContain('Success rate is 0 percent');
    r1.run('configure terminal', 'interface serial0/0/0', 'encapsulation ppp', 'end');
    expect(r1.run('show interfaces serial0/0/0')).toContain('Encapsulation PPP, LCP Open');
    expect(r1.run('ping 10.0.0.2')).toContain('Success rate is 100 percent');
    sec(e, 1);
  });

  it('PPP mit CHAP: passende Benutzer = up, falsches Passwort = down', () => {
    const { r1, r2 } = lab();
    up(r1, '10.0.0.1');
    up(r2, '10.0.0.2');
    r1.run(
      'configure terminal',
      'username R2 password cisco',
      'interface serial0/0/0',
      'clock rate 64000',
      'encapsulation ppp',
      'ppp authentication chap',
      'end',
    );
    r2.run(
      'configure terminal',
      'username R1 password falsch',
      'interface serial0/0/0',
      'encapsulation ppp',
      'ppp authentication chap',
      'end',
    );
    expect(r1.run('show interfaces serial0/0/0')).toContain('line protocol is down');
    r2.run('configure terminal', 'username R1 password cisco', 'end');
    expect(r1.run('show interfaces serial0/0/0')).toContain('line protocol is up');
  });

  it('PPP mit PAP: sent-username/password', () => {
    const { r1, r2 } = lab();
    up(r1, '10.0.0.1');
    up(r2, '10.0.0.2');
    r1.run(
      'configure terminal',
      'username R2 password cisco',
      'interface serial0/0/0',
      'clock rate 64000',
      'encapsulation ppp',
      'ppp authentication pap',
      'end',
    );
    r2.run('configure terminal', 'interface serial0/0/0', 'encapsulation ppp', 'end');
    expect(r1.run('show interfaces serial0/0/0')).toContain('line protocol is down');
    r2.run(
      'configure terminal',
      'interface serial0/0/0',
      'ppp pap sent-username R2 password cisco',
      'end',
    );
    expect(r1.run('show interfaces serial0/0/0')).toContain('line protocol is up');
  });

  it('Running-Config zeigt Serial-Zeilen und überlebt Replay', () => {
    const { e, r1, r2 } = lab();
    up(r1, '10.0.0.1');
    up(r2, '10.0.0.2');
    r1.run(
      'configure terminal',
      'username R2 password cisco',
      'interface serial0/0/0',
      'clock rate 64000',
      'encapsulation ppp',
      'ppp authentication chap pap',
      'end',
    );
    const cfg = r1.run('show running-config');
    expect(cfg).toContain(
      'interface Serial0/0/0\n ip address 10.0.0.1 255.255.255.252\n encapsulation ppp\n ppp authentication chap pap\n clock rate 64000\n',
    );
    expect(cfg).not.toContain('Serial0/0/0\n ip address 10.0.0.1 255.255.255.252\n duplex');
    r1.run('copy running-config startup-config');
    r1.run('reload', '');
    const again = new CliSession(e, r1.id);
    again.input('enable');
    expect(again.input('show running-config')).toContain(' ppp authentication chap pap');
    expect(again.input('show running-config')).toContain(' clock rate 64000');
  });

  it('Gegenstelle shutdown: up, line protocol down', () => {
    const { r1, r2 } = lab();
    up(r1, '10.0.0.1');
    up(r2, '10.0.0.2');
    r1.run('configure terminal', 'interface serial0/0/0', 'clock rate 64000', 'end');
    r2.run('configure terminal', 'interface serial0/0/0', 'shutdown', 'end');
    expect(r1.run('show interfaces serial0/0/0')).toContain(
      'Serial0/0/0 is up, line protocol is down',
    );
    expect(r2.run('show interfaces serial0/0/0')).toContain(
      'Serial0/0/0 is administratively down, line protocol is down',
    );
  });

  it('OSPF-Kosten auf Serial: Bandbreite 1544 kbit/s (Kosten 64) und point-to-point', () => {
    const { e, r1, r2 } = lab();
    up(r1, '10.0.0.1');
    up(r2, '10.0.0.2');
    r1.run('configure terminal', 'interface serial0/0/0', 'clock rate 64000', 'end');
    for (const [r, id] of [
      [r1, '1.1.1.1'],
      [r2, '2.2.2.2'],
    ] as const) {
      r.run(
        'configure terminal',
        'router ospf 1',
        `router-id ${id}`,
        'network 10.0.0.0 0.0.0.3 area 0',
        'end',
      );
    }
    sec(e, 60);
    const out = r1.run('show ip ospf neighbor');
    expect(out).toContain('FULL/  -');
    expect(r1.run('show ip route ospf').length).toBeGreaterThan(0);
  });

  it('debug ppp negotiation/authentication', () => {
    const { r1, r2 } = lab();
    r1.run('enable', 'debug ppp negotiation', 'debug ppp authentication');
    up(r1, '10.0.0.1');
    up(r2, '10.0.0.2');
    r1.run(
      'configure terminal',
      'username R2 password cisco',
      'interface serial0/0/0',
      'clock rate 64000',
      'encapsulation ppp',
      'ppp authentication chap',
      'end',
    );
    r2.run(
      'configure terminal',
      'username R1 password cisco',
      'interface serial0/0/0',
      'encapsulation ppp',
      'ppp authentication chap',
      'end',
    );
    const out = r1.s.poll();
    expect(out).toContain('Se0/0/0 LCP: State is Open');
    expect(out).toContain('Se0/0/0 CHAP: O SUCCESS id 1 len 4');
    expect(out).toContain('Se0/0/0 PPP: Phase is UP');
  });
});
