import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { CliSession, ShellStack } from '../src';
import { diamond, sec } from './gapsLab';

/** R1 (AS 65001) – R2 (AS 65002) über 10.0.12.0/24; R1 kündigt 10.1.0.0/24 an. */
function lab() {
  const L = diamond();
  L.r1.run(
    'configure terminal',
    'router bgp 65001',
    'bgp router-id 1.1.1.1',
    'neighbor 10.0.12.2 remote-as 65002',
    'network 10.1.0.0 mask 255.255.255.0',
    'end',
  );
  L.r2.run(
    'configure terminal',
    'router bgp 65002',
    'bgp router-id 2.2.2.2',
    'neighbor 10.0.12.1 remote-as 65001',
    'end',
  );
  sec(L.e, 30);
  return L;
}

const established = (out: string, ip: string): boolean =>
  new RegExp(`${ip.replace(/\./g, '\\.')}\\s+4\\s+\\d+.*\\s\\d+\\s*$`, 'm').test(out);

describe('QA2: BGP-/TCP-Sitzungen bei Lebenszyklus-Ereignissen', () => {
  it('Ausgangslage: Sitzung steht, Route ist gelernt', () => {
    const { r1, r2 } = lab();
    expect(established(r1.run('show ip bgp summary'), '10.0.12.2')).toBe(true);
    expect(r2.run('show ip route')).toMatch(/B\s+10\.1\.0\.0\/24/);
  });

  it('shutdown der Schnittstelle beendet die eBGP-Sitzung sofort, no shutdown baut sie wieder auf', () => {
    const { e, r1, r2 } = lab();
    r2.run('configure terminal', 'interface gi0/0', 'shutdown', 'end');
    sec(e, 3);
    expect(r2.run('show ip route')).not.toContain('10.1.0.0');
    expect(r2.run('show tcp brief')).not.toContain('ESTAB');
    r2.run('configure terminal', 'interface gi0/0', 'no shutdown', 'end');
    sec(e, 60);
    expect(r2.run('show ip route')).toMatch(/B\s+10\.1\.0\.0\/24/);
    expect(established(r1.run('show ip bgp summary'), '10.0.12.2')).toBe(true);
  });

  it('Aus-/Einschalten des Nachbarn: Sitzung kommt zurück', () => {
    const { e, r1, r2 } = lab();
    e.setPower(r2.id, false);
    sec(e, 5);
    e.setPower(r2.id, true);
    sec(e, 120);
    const s2 = new CliSession(e, r2.id);
    s2.input('enable');
    expect(s2.input('show ip route')).toMatch(/B\s+10\.1\.0\.0\/24/);
    expect(established(r1.run('show ip bgp summary'), '10.0.12.2')).toBe(true);
  });

  it('Löschen des Nachbarn: die verbleibende Seite räumt Sitzung und TCP-Verbindung ab', () => {
    const { e, r1, r2 } = lab();
    e.removeDevice(r2.id);
    sec(e, 200);
    expect(r1.run('show ip bgp summary')).toMatch(/10\.0\.12\.2.*(Idle|Active|Connect)/);
    expect(r1.run('show tcp brief')).not.toContain('ESTAB');
  });

  it('Snapshot/Restore mitten in der Sitzung: der Lauf nach dem Restore ist identisch', () => {
    const { e, r1 } = lab();
    const snap = e.snapshot();
    const from = e.logLength;
    sec(e, 90);
    const a = e.logSlice(from).map((l) => `${l.t} ${l.atDeviceName} ${l.msg.key}`);
    const stateA = JSON.stringify(e.state);
    e.restore(snap);
    sec(e, 90);
    const b = e.logSlice(from).map((l) => `${l.t} ${l.atDeviceName} ${l.msg.key}`);
    expect(b).toEqual(a);
    expect(JSON.stringify(e.state)).toBe(stateA);
    expect(established(r1.run('show ip bgp summary'), '10.0.12.2')).toBe(true);
  });

  it('gleicher Seed, gleicher Ablauf: Log und Zustand sind identisch', () => {
    const run = (): [string[], string] => {
      const { e } = lab();
      sec(e, 60);
      return [
        e.logSlice(0, 1_000_000).map((l) => `${l.id} ${l.t} ${l.atDeviceName} ${l.msg.key}`),
        JSON.stringify(e.state),
      ];
    };
    const [la, sa] = run();
    const [lb, sb] = run();
    expect(lb).toEqual(la);
    expect(sb).toBe(sa);
  });

  it('Eingehende ACL: Telnet gesperrt, BGP läuft weiter', () => {
    const { e, r1, r2 } = lab();
    r2.run(
      'configure terminal',
      'access-list 101 deny tcp any any eq telnet',
      'access-list 101 permit ip any any',
      'interface gi0/0',
      'ip access-group 101 in',
      'exit',
      'line vty 0 4',
      'password cisco',
      'login',
      'end',
    );
    r2.run('clear ip bgp *');
    sec(e, 60);
    expect(established(r1.run('show ip bgp summary'), '10.0.12.2')).toBe(true);
    const st = new ShellStack(new CliSession(e, r1.id));
    st.input('enable');
    const out = st.input('telnet 10.0.12.2');
    expect(out).not.toMatch(/Open/);
    expect(st.prompt()).toBe('R1#');
    // ohne ACL kommt die Anmeldung zustande
    r2.run('configure terminal', 'interface gi0/0', 'no ip access-group 101 in', 'end');
    const o2 = st.input('telnet 10.0.12.2');
    expect(o2).toMatch(/Open/);
    expect(st.prompt()).toMatch(/Password:/);
  });
});

void Engine;
