import { describe, expect, it } from 'vitest';
import { Engine, newHsrp, newOspf, type HsrpCfg, type OspfCfg } from '../src';
import { fmtRoute, must, pcOn, rip4, rlink, routes, sec } from './labs4';

const pingOk = (e: Engine, from: string, dst: string, count = 1): boolean => {
  e.ping(from, dst, { count });
  e.runAll();
  const d = e.getDevice(from);
  const pings = d && (d.config.kind === 'host' || d.config.kind === 'router') ? d.config.pings : [];
  return pings.at(-1)?.status === 'reply';
};

function hsrpLab() {
  const e = new Engine({ seed: 1 });
  const r1 = e.addDevice('router', { name: 'R1' });
  const r2 = e.addDevice('router', { name: 'R2' });
  const r3 = e.addDevice('router', { name: 'R3' });
  const sw = e.addDevice('switch-l2', { name: 'SW' });
  const pc = e.addDevice('pc', { name: 'PC' });
  must(e.connect({ deviceId: r1, portId: 'p0' }, { deviceId: sw, portId: 'p0' }, 'straight'));
  must(e.connect({ deviceId: r2, portId: 'p0' }, { deviceId: sw, portId: 'p1' }, 'straight'));
  must(e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: sw, portId: 'p2' }, 'straight'));
  rlink(e, r1, 'p1', r3, 'p0');
  rlink(e, r2, 'p1', r3, 'p1');
  rip4(e, r1, 'p0', '10.0.0.2');
  rip4(e, r2, 'p0', '10.0.0.3');
  rip4(e, r1, 'p1', '10.9.1.1');
  rip4(e, r2, 'p1', '10.9.2.1');
  rip4(e, r3, 'p0', '10.9.1.3');
  rip4(e, r3, 'p1', '10.9.2.3');
  rip4(e, r3, 'p2', '10.9.0.1');
  must(e.setHostIp(pc, '10.0.0.10', '255.255.255.0', '10.0.0.1'));
  const srv = pcOn(e, r3, 'p2', '10.9.0.10', '10.9.0.1', 'SRV');
  void srv;
  must(e.addStaticRoute(r1, { prefix: '10.9.0.0', mask: '255.255.255.0', nextHop: '10.9.1.3' }));
  must(e.addStaticRoute(r2, { prefix: '10.9.0.0', mask: '255.255.255.0', nextHop: '10.9.2.3' }));
  // R3: Rückroute über R1, Floating Static über R2
  must(e.addStaticRoute(r3, { prefix: '10.0.0.0', mask: '255.255.255.0', nextHop: '10.9.1.1' }));
  must(
    e.addStaticRoute(r3, { prefix: '10.0.0.0', mask: '255.255.255.0', nextHop: '10.9.2.1', ad: 5 }),
  );
  for (const [id, prio] of [
    [r1, 110],
    [r2, 100],
  ] as const) {
    const d = e.getDevice(id);
    if (d?.config.kind !== 'router') throw new Error('router');
    const g: HsrpCfg = { ...newHsrp(1), vip: '10.0.0.1', priority: prio, preempt: true };
    if (id === r1) g.track = [{ ifaceId: 'p1', decrement: 20 }];
    const ic = d.config.ifaces['p0'];
    if (ic) ic.hsrp = { 1: g };
    e.routingChanged(id);
  }
  return { e, r1, r2, r3, pc };
}

const hs = (e: Engine, id: string): HsrpCfg => {
  const d = e.getDevice(id);
  if (d?.config.kind !== 'router') throw new Error('router');
  return d.config.ifaces['p0']?.hsrp?.[1] as HsrpCfg;
};

describe('HSRP', () => {
  it('wählt Active (höhere Priorität) und Standby; Gateway = virtuelle IP', () => {
    const { e, r1, r2, pc } = hsrpLab();
    sec(e, 120);
    expect(hs(e, r1).state).toBe('active');
    expect(hs(e, r2).state).toBe('standby');
    expect(pingOk(e, pc, '10.9.0.10')).toBe(true);
    // ARP des PCs zeigt die virtuelle MAC
    const cfg = e.getDevice(pc)?.config;
    expect(cfg?.kind === 'host' && cfg.arpCache['10.0.0.1']?.mac).toBe('00:00:0c:07:ac:01');
  });

  it('Abnahme: Tracking-Ausfall führt zum Umschalten auf den Standby-Router', () => {
    const { e, r1, r2, pc } = hsrpLab();
    sec(e, 120);
    e.setPortAdmin(r1, 'p1', false); // Uplink von R1 fällt aus → Priorität 110−20 = 90 < 100
    sec(e, 15);
    expect(hs(e, r2).state).toBe('active');
    expect(hs(e, r1).state).not.toBe('active');
    sec(e, 10);
    expect(pingOk(e, pc, '10.9.0.10')).toBe(true);
    // Uplink kommt zurück → R1 übernimmt dank Preempt wieder
    e.setPortAdmin(r1, 'p1', true);
    sec(e, 30);
    expect(hs(e, r1).state).toBe('active');
    expect(hs(e, r2).state).toBe('standby');
  });

  it('Ausfall des Active-Routers: Standby übernimmt nach Hold-Time', () => {
    const { e, r1, r2, pc } = hsrpLab();
    sec(e, 120);
    e.setPower(r1, false);
    sec(e, 20);
    expect(hs(e, r2).state).toBe('active');
    expect(pingOk(e, pc, '10.9.0.10')).toBe(true);
  });
});

describe('GRE und Loopback', () => {
  function greLab() {
    const e = new Engine({ seed: 1 });
    const [r1, r2, r3] = ['R1', 'R2', 'R3'].map((n) => e.addDevice('router', { name: n })) as [
      string,
      string,
      string,
    ];
    rlink(e, r1, 'p0', r2, 'p0');
    rlink(e, r2, 'p1', r3, 'p0');
    rip4(e, r1, 'p0', '10.0.12.1');
    rip4(e, r2, 'p0', '10.0.12.2');
    rip4(e, r2, 'p1', '10.0.23.2');
    rip4(e, r3, 'p0', '10.0.23.3');
    must(e.setInterfaceIp(r1, 'lo0', '1.1.1.1', '255.255.255.255'));
    must(e.setInterfaceIp(r3, 'lo0', '3.3.3.3', '255.255.255.255'));
    must(
      e.addStaticRoute(r1, { prefix: '3.3.3.3', mask: '255.255.255.255', nextHop: '10.0.12.2' }),
    );
    must(
      e.addStaticRoute(r2, { prefix: '1.1.1.1', mask: '255.255.255.255', nextHop: '10.0.12.1' }),
    );
    must(
      e.addStaticRoute(r2, { prefix: '3.3.3.3', mask: '255.255.255.255', nextHop: '10.0.23.3' }),
    );
    must(
      e.addStaticRoute(r3, { prefix: '1.1.1.1', mask: '255.255.255.255', nextHop: '10.0.23.2' }),
    );
    for (const [id, src, dst, ip] of [
      [r1, 'lo0', '3.3.3.3', '172.16.0.1'],
      [r3, 'lo0', '1.1.1.1', '172.16.0.2'],
    ] as const) {
      must(e.setInterfaceIp(id, 'tu0', ip, '255.255.255.252'));
      const d = e.getDevice(id);
      if (d?.config.kind !== 'router') throw new Error('router');
      const t = d.config.ifaces['tu0'];
      if (t) t.tunnel = { mode: 'gre', source: src, destination: dst };
      e.routingChanged(id);
    }
    return { e, r1, r2, r3 };
  }

  it('Ping durch den GRE-Tunnel; Zwischen-Router sieht nur GRE (Protokoll 47)', () => {
    const { e, r1, r2 } = greLab();
    sec(e, 2);
    expect(pingOk(e, r1, '172.16.0.2')).toBe(true);
    const seen = e.log.filter((l) => l.atDeviceName === 'R2' && l.frame?.payload.kind === 'ipv4');
    expect(
      seen.some((l) => l.frame?.payload.kind === 'ipv4' && l.frame.payload.protocol === 47),
    ).toBe(true);
    void r2;
  });

  it('OSPF über den Tunnel lernt entfernte LANs', () => {
    const { e, r1, r3 } = greLab();
    rip4(e, r1, 'p1', '10.1.0.1');
    rip4(e, r3, 'p1', '10.3.0.1');
    pcOn(e, r1, 'p1', '10.1.0.10', '10.1.0.1', 'PC1');
    pcOn(e, r3, 'p1', '10.3.0.10', '10.3.0.1', 'PC3');
    for (const id of [r1, r3]) {
      const d = e.getDevice(id);
      if (d?.config.kind !== 'router') throw new Error('router');
      const c = newOspf(1);
      c.networks = [
        { prefix: '172.16.0.0', wildcard: '0.0.0.3', area: '0' },
        { prefix: '10.0.0.0', wildcard: '0.255.255.255', area: '0' },
      ];
      d.config.routing.ospf[1] = c;
      const t = d.config.ifaces['tu0'];
      if (t) t.ospf = { pid: 1, area: '0', network: 'point-to-point' };
      void (null as unknown as OspfCfg);
      e.routingChanged(id);
    }
    sec(e, 60);
    const rs = routes(e, r1).map(fmtRoute);
    expect(rs.some((x) => x.startsWith('O 10.3.0.0/24') && x.endsWith('172.16.0.2'))).toBe(true);
  });
});
