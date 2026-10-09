import { describe, expect, it } from 'vitest';
import type { Engine } from '@netsim/engine';
import { CliSession } from '../src';
import { sec } from './gapsLab';
import { vpnLab } from './qa2Labs';

/** VPN + PAT + eBGP + NTP + SNMP-Traps + TACACS+ + Telnet; danach zufällige Störungen. */
function scenario() {
  const L = vpnLab({ nat: true });
  const { r1, isp, r3 } = L;
  r1.run(
    'configure terminal',
    'router bgp 65001',
    'neighbor 203.0.113.2 remote-as 65000',
    'network 10.1.0.0 mask 255.255.255.0',
    'exit',
    'ntp server 203.0.113.2',
    'snmp-server community public RO',
    'snmp-server host 10.1.0.10 version 2c public',
    'snmp-server enable traps',
    'aaa new-model',
    'tacacs-server host 10.1.0.10 key k',
    'aaa authentication login default group tacacs+ local',
    'username admin secret pw',
    'line vty 0 4',
    'login authentication default',
    'end',
  );
  isp.run(
    'configure terminal',
    'router bgp 65000',
    'neighbor 203.0.113.1 remote-as 65001',
    'neighbor 198.51.100.1 remote-as 65003',
    'exit',
    'ntp master 3',
    'end',
  );
  r3.run(
    'configure terminal',
    'router bgp 65003',
    'neighbor 198.51.100.2 remote-as 65000',
    'network 10.2.0.0 mask 255.255.255.0',
    'end',
  );
  return L;
}

/** Deterministischer Zufall (LCG). */
const rng = (seed: number) => {
  let x = seed >>> 0;
  return (n: number): number => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x % n;
  };
};

function chaos(seed: number): { e: Engine; crashed: string[] } {
  const L = scenario();
  const { e } = L;
  const r = rng(seed);
  const routers = [L.r1, L.isp, L.r3];
  const pcs = [L.pc1, L.pc3];
  const crashed: string[] = [];
  const snaps: ReturnType<Engine['snapshot']>[] = [];
  sec(e, 30);
  for (let i = 0; i < 60; i++) {
    const op = r(9);
    const rt = routers[r(routers.length)];
    if (!rt) continue;
    switch (op) {
      case 0: {
        const d = e.getDevice(rt.id);
        if (d) e.setPower(rt.id, !d.powered);
        break;
      }
      case 1:
        rt.s.input('enable');
        rt.run(
          'configure terminal',
          `interface gi0/${r(2)}`,
          r(2) ? 'shutdown' : 'no shutdown',
          'end',
        );
        break;
      case 2:
        rt.run('clear crypto sa');
        break;
      case 3:
        rt.run('clear ip bgp *');
        break;
      case 4: {
        const pc = pcs[r(pcs.length)];
        if (pc) e.ping(pc, r(2) ? '10.2.0.10' : '10.1.0.10', { count: 2 });
        break;
      }
      case 5:
        snaps.push(e.snapshot());
        break;
      case 6: {
        const s = snaps[r(Math.max(1, snaps.length))];
        if (s) e.restore(s);
        break;
      }
      case 7: {
        const s = new CliSession(e, rt.id);
        s.input('enable');
        s.input('show ip bgp summary');
        s.input('show crypto ipsec sa');
        s.input('show tcp brief');
        break;
      }
      case 8:
        if (e.getDevice(L.pc3) && r(4) === 0) e.removeDevice(L.pc3);
        break;
    }
    sec(e, 1 + r(40));
    for (const d of Object.values(e.state.devices))
      if (d.crashed) crashed.push(`${i}: ${d.name}: ${d.crashed.message}`);
    expect(() => JSON.stringify(e.state)).not.toThrow();
  }
  // Heilen: alles an, alle Schnittstellen hoch – danach muss das Netz von selbst wieder konvergieren
  for (const rt of routers) {
    e.setPower(rt.id, true);
    const s = new CliSession(e, rt.id);
    for (const l of [
      'enable',
      'configure terminal',
      'interface gi0/0',
      'no shutdown',
      'interface gi0/1',
      'no shutdown',
      'end',
    ])
      s.input(l);
  }
  sec(e, 240);
  return { e, crashed };
}

const pingOk = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  sec(e, 6);
  const c = e.getDevice(pc)?.config;
  return c?.kind === 'host' && c.pings.at(-1)?.status === 'reply';
};

describe('QA2: Störungen über alle Funktionen hinweg (Chaos)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`Seed ${seed}: kein Gerät stürzt ab, Zustand bleibt serialisierbar und deterministisch`, () => {
      const a = chaos(seed);
      expect(a.crashed).toEqual([]);
      const b = chaos(seed);
      expect(JSON.stringify(b.e.state)).toBe(JSON.stringify(a.e.state));
      const s1 = new CliSession(
        a.e,
        Object.values(a.e.state.devices).find((d) => d.name === 'R1')?.id ?? '',
      );
      s1.input('enable');
      expect(s1.input('show ip bgp summary')).toMatch(/203\.0\.113\.2\s+4\s+65000.*\s\d+\s*$/m);
      const pc1 = Object.values(a.e.state.devices).find((d) => d.name === 'PC1')?.id ?? '';
      pingOk(a.e, pc1, '8.8.8.8');
      expect(pingOk(a.e, pc1, '8.8.8.8')).toBe(true);
      if (Object.values(a.e.state.devices).some((d) => d.name === 'PC3')) {
        pingOk(a.e, pc1, '10.2.0.10');
        expect(pingOk(a.e, pc1, '10.2.0.10')).toBe(true);
      }
    }, 60_000);
  }
});
