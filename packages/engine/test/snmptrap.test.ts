import { describe, expect, it } from 'vitest';
import { Engine, type HostConfig, type Result, type RouterConfig } from '../src';
import { mgmtOf } from '../src/p5defaults';

const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const host = (e: Engine, id: string): HostConfig => e.getDevice(id)?.config as HostConfig;
const rcfg = (e: Engine, id: string): RouterConfig => e.getDevice(id)?.config as RouterConfig;
const run = (e: Engine, s = 10): void => void e.runUntil(e.state.now + s * 1_000_000);

/** PC – R1 – Server (SNMP-Trap-Empfänger 10.0.1.10). */
function lab(traps: ('linkdown' | 'linkup' | 'coldstart')[] = ['linkdown', 'linkup']) {
  const e = new Engine();
  const r1 = e.addDevice('router');
  const pc = e.addDevice('pc');
  const srv = e.addDevice('server');
  must(e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: r1, portId: 'p0' }, 'straight'));
  must(e.connect({ deviceId: srv, portId: 'p0' }, { deviceId: r1, portId: 'p1' }, 'straight'));
  must(e.setInterfaceIp(r1, 'p0', '10.0.0.1', '255.255.255.0'));
  must(e.setInterfaceIp(r1, 'p1', '10.0.1.1', '255.255.255.0'));
  e.setPortAdmin(r1, 'p0', true);
  e.setPortAdmin(r1, 'p1', true);
  must(e.setHostIp(pc, '10.0.0.2', '255.255.255.0', '10.0.0.1'));
  must(e.setHostIp(srv, '10.0.1.10', '255.255.255.0', '10.0.1.1'));
  must(
    e.p5.setServices(srv, {
      snmp: { enabled: true, communities: [{ name: 'trapcomm', rw: false }] },
    }),
  );
  const sn = mgmtOf(rcfg(e, r1).sys).snmp;
  sn.trapHosts = [{ host: '10.0.1.10', community: 'trapcomm', version: '2c' }];
  sn.traps = traps;
  run(e, 2);
  return { e, r1, pc, srv, sn };
}

describe('SNMP-Traps', () => {
  it('linkDown/linkUp werden per UDP 162 an den Trap-Empfänger gesendet', () => {
    const { e, r1, srv } = lab();
    e.setPortAdmin(r1, 'p0', false);
    run(e, 3);
    e.setPortAdmin(r1, 'p0', true);
    run(e, 3);
    const traps = host(e, srv).services.snmp?.traps ?? [];
    expect(traps.map((t) => t.trap)).toEqual(['linkDown', 'linkUp']);
    expect(traps[0]).toMatchObject({ from: '10.0.1.1', community: 'trapcomm', version: '2c' });
    expect(traps[0]?.ifDescr).toMatch(/^GigabitEthernet0\/0|FastEthernet0\/0|Gi/);
    const wire = e.log.filter((l) => l.summary?.includes(':162'));
    expect(wire.length).toBeGreaterThan(0);
    expect(e.log.map((l) => l.msg.key)).toContain('svc.snmp.trap');
  });

  it('nicht freigeschaltete Trap-Typen und falsche Community werden nicht gespeichert', () => {
    const a = lab(['linkup']);
    a.e.setPortAdmin(a.r1, 'p0', false);
    run(a.e, 3);
    expect(host(a.e, a.srv).services.snmp?.traps ?? []).toHaveLength(0);
    const b = lab();
    b.sn.trapHosts = [{ host: '10.0.1.10', community: 'wrong', version: '2c' }];
    b.e.setPortAdmin(b.r1, 'p0', false);
    run(b.e, 3);
    expect(host(b.e, b.srv).services.snmp?.traps ?? []).toHaveLength(0);
    expect(b.e.log.map((l) => l.msg.key)).toContain('svc.snmp.badCommunity');
  });

  it('coldStart nach Aus-/Einschalten des Geräts', () => {
    const { e, r1, srv } = lab(['coldstart']);
    e.setPower(r1, false);
    e.setPower(r1, true);
    run(e, 30);
    const traps = host(e, srv).services.snmp?.traps ?? [];
    expect(traps.map((t) => t.trap)).toEqual(['coldStart']);
  });

  it('Verlauf ist deterministisch', () => {
    const go = () => {
      const { e, r1 } = lab();
      e.setPortAdmin(r1, 'p0', false);
      run(e, 3);
      return JSON.stringify(e.log.map((l) => [l.t, l.msg.key]));
    };
    expect(go()).toBe(go());
  });
});
