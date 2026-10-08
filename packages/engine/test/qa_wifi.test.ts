import { describe, expect, it } from 'vitest';
import { Engine, type Result, type HostConfig } from '../src';

const host = (e: Engine, id: string): HostConfig => e.getDevice(id)?.config as HostConfig;
const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const sec = (e: Engine, s: number): void => void e.runUntil(e.state.now + s * 1_000_000);

function pingOk(e: Engine, from: string, dst: string): boolean {
  const id = must(e.ping(from, dst, { count: 1 }));
  sec(e, 6);
  return host(e, from).pings.some((p) => p.id === id && p.status === 'reply');
}

/** SW – AP1 (x=100), AP2 (x=600), Server (DHCP); Laptop bei AP1. */
function lab() {
  const e = new Engine({ seed: 7 });
  const sw = e.addDevice('switch-l2', { pos: { x: 0, y: 300 } });
  const ap1 = e.addDevice('ap', { pos: { x: 100, y: 0 } });
  const ap2 = e.addDevice('ap', { pos: { x: 600, y: 0 } });
  const srv = e.addDevice('server', { pos: { x: 0, y: 400 } });
  const lap = e.addDevice('laptop', { pos: { x: 150, y: 0 } });
  must(e.connect({ deviceId: ap1, portId: 'p0' }, { deviceId: sw, portId: 'p0' }, 'straight'));
  must(e.connect({ deviceId: ap2, portId: 'p0' }, { deviceId: sw, portId: 'p2' }, 'straight'));
  must(e.connect({ deviceId: srv, portId: 'p0' }, { deviceId: sw, portId: 'p1' }, 'straight'));
  must(e.setHostIp(srv, '10.0.0.10', '255.255.255.0'));
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
            leaseSec: 3600,
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
  for (const ap of [ap1, ap2])
    must(e.p5.setApRadio(ap, '2.4', { ssid: 'Net', security: 'wpa2-psk', key: 'secret123' }));
  sec(e, 35);
  must(e.p5.wifiAddProfile(lap, 'Net', 'secret123'));
  must(e.setHostDhcp(lap, true));
  sec(e, 10);
  return { e, sw, ap1, ap2, srv, lap };
}

describe('QA WLAN roaming', () => {
  it('roams to AP2 and stays reachable from the wired side (server-initiated ping)', () => {
    const { e, ap2, srv, lap } = lab();
    const ip = host(e, lap).ip as string;
    expect(ip).toMatch(/^10\.0\.0\.1\d\d$/);
    expect(pingOk(e, srv, ip)).toBe(true);
    e.moveDevice(lap, { x: 560, y: 0 });
    expect(host(e, lap).wifi?.assoc?.apId).toBe(ap2);
    const t0 = e.state.now;
    while (host(e, lap).ip !== ip && e.state.now - t0 < 30_000_000) sec(e, 0.1);
    // DHCP läuft nach dem Roaming neu (DORA); dieselbe Adresse kommt zurück
    expect(host(e, lap).ip).toBe(ip);
    expect(e.state.now - t0).toBeLessThan(5_000_000);
    // the wired side must reach the laptop on its new AP without the laptop sending first
    expect(pingOk(e, srv, ip)).toBe(true);
    expect(pingOk(e, lap, '10.0.0.10')).toBe(true);
  });

  it('snapshot/restore with associated clients; state JSON-serializable', () => {
    const { e, lap, srv } = lab();
    const snap = e.snapshot();
    expect(JSON.parse(JSON.stringify(snap.state))).toEqual(structuredClone(snap.state));
    const e2 = new Engine();
    e2.restore(snap);
    expect(pingOk(e2, lap, '10.0.0.10')).toBe(true);
    e2.moveDevice(lap, { x: 5000, y: 0 });
    expect(host(e2, lap).wifi?.assoc).toBeUndefined();
    void srv;
  });

  it('removing the AP the client is associated with disconnects cleanly', () => {
    const { e, ap1, lap } = lab();
    e.removeDevice(ap1);
    sec(e, 2);
    expect(host(e, lap).wifi?.assoc?.apId).not.toBe(ap1);
  });

  it('resetRuntime keeps association working', () => {
    const { e, lap } = lab();
    e.resetRuntime();
    sec(e, 40);
    expect(host(e, lap).wifi?.status).toBe('connected');
    expect(pingOk(e, lap, '10.0.0.10')).toBe(true);
  });
});
