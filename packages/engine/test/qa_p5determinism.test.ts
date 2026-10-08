import { describe, expect, it } from 'vitest';
import { Engine, type Result } from '../src';

const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const sec = (e: Engine, s: number): void => void e.runUntil(e.state.now + s * 1_000_000);

/** Phase-5-Mix: WLC + LAP + Laptop (DHCP), IoT-Regel, NTP, Syslog, SNMP, Router mit Management. */
function build(): Engine {
  const e = new Engine({ seed: 42 });
  const sw = e.addDevice('switch-l2', { pos: { x: 0, y: 300 } });
  const r1 = e.addDevice('router', { name: 'R1' });
  const srv = e.addDevice('server', { name: 'Srv', pos: { x: 0, y: 400 } });
  const wlc = e.addDevice('wlc', { name: 'WLC', pos: { x: 100, y: 400 } });
  const ap = e.addDevice('ap', { name: 'AP', pos: { x: 100, y: 0 } });
  const lap = e.addDevice('laptop', { name: 'Lap', pos: { x: 150, y: 0 } });
  const sen = e.addDevice('iot-sensor', { name: 'Temp1', pos: { x: 300, y: 300 } });
  const act = e.addDevice('iot-actuator', { name: 'Fan1', pos: { x: 400, y: 300 } });
  const devs = [r1, srv, wlc, ap, sen, act];
  devs.forEach((d, i) =>
    must(e.connect({ deviceId: d, portId: 'p0' }, { deviceId: sw, portId: `p${i}` }, 'straight')),
  );
  must(e.setInterfaceIp(r1, 'p0', '10.0.0.1', '255.255.255.0'));
  e.setPortAdmin(r1, 'p0', true);
  must(e.setHostIp(srv, '10.0.0.10', '255.255.255.0', '10.0.0.1'));
  must(e.setHostIp(wlc, '10.0.0.20', '255.255.255.0', '10.0.0.1'));
  must(e.setHostIp(ap, '10.0.0.21', '255.255.255.0', '10.0.0.1'));
  must(e.setHostIp(sen, '10.0.0.30', '255.255.255.0', '10.0.0.1'));
  must(e.setHostIp(act, '10.0.0.31', '255.255.255.0', '10.0.0.1'));
  must(
    e.setService(srv, {
      dhcp: {
        enabled: true,
        pools: [
          {
            name: 'p',
            network: '10.0.0.0',
            mask: '255.255.255.0',
            router: '10.0.0.1',
            dns: [],
            leaseSec: 60,
            rangeStart: '10.0.0.100',
            rangeEnd: '10.0.0.150',
          },
        ],
        excluded: [],
        bindings: {},
        conflicts: [],
      },
    }),
  );
  must(
    e.p5.setServices(srv, {
      ntp: { enabled: true },
      syslog: { enabled: true, messages: [] },
      iot: {
        enabled: true,
        devices: {},
        rules: [
          {
            id: 1,
            sensor: 'Temp1',
            op: '>',
            threshold: 5,
            actuator: 'Fan1',
            action: 'on',
            elseAction: 'off',
          },
        ],
      },
    }),
  );
  must(
    e.p5.wlcSetWlan(wlc, {
      ssid: 'Corp',
      security: 'wpa2-psk',
      key: 'corp-key-1',
      band: 'both',
      enabled: true,
    }),
  );
  must(e.p5.setApController(ap, '10.0.0.20'));
  must(
    e.p5.setIot(sen, {
      server: '10.0.0.10',
      reportSec: 3,
      pattern: 'wave',
      min: 0,
      max: 10,
      periodSec: 40,
    }),
  );
  must(e.p5.setIot(act, { server: '10.0.0.10', reportSec: 3 }));
  must(e.p5.setHostNtp(lap, '10.0.0.10'));
  e.p5.setMgmt(r1, {
    ntp: { servers: ['10.0.0.10'] },
    syslog: { hosts: ['10.0.0.10'], trap: 7 },
    snmp: { communities: [{ name: 'public', rw: false }] },
  } as never);
  sec(e, 40);
  must(e.p5.wifiAddProfile(lap, 'Corp', 'corp-key-1'));
  must(e.setHostDhcp(lap, true));
  return e;
}

const norm = (e: Engine, from = 0): string[] =>
  e.log.slice(from).map((l) => JSON.stringify({ ...l, id: 0 }));

describe('QA Phase 5 determinism and snapshot', () => {
  it('same build twice yields an identical log', () => {
    const a = build();
    sec(a, 200);
    const b = build();
    sec(b, 200);
    expect(norm(b)).toEqual(norm(a));
    const keys = new Set(a.log.map((l) => l.msg.key));
    for (const k of ['svc.iot.rule', 'svc.ntp.synced', 'wlc.joined', 'wifi.assoc', 'dhcp.discover'])
      expect(keys.has(k), k).toBe(true);
  });

  it('snapshot mid-run + restore in a fresh engine continues identically; state JSON-safe', () => {
    const a = build();
    sec(a, 77);
    const snap = a.snapshot();
    expect(JSON.parse(JSON.stringify(snap.state))).toEqual(structuredClone(snap.state));
    const mark = a.log.length;
    sec(a, 150);
    const b = new Engine();
    b.restore(snap);
    sec(b, 150);
    expect(norm(b)).toEqual(norm(a, mark));
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
  });

  it('resetRuntime and re-run reproduces the post-reset log', () => {
    const a = build();
    sec(a, 60);
    a.resetRuntime();
    sec(a, 100);
    const first = norm(a);
    a.resetRuntime();
    sec(a, 100);
    expect(norm(a)).toEqual(first);
  });
});
