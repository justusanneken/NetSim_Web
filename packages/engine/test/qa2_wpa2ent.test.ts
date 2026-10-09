import { describe, expect, it } from 'vitest';
import { Engine, type HostConfig, type Result } from '../src';

const host = (e: Engine, id: string): HostConfig => e.getDevice(id)?.config as HostConfig;
const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const run = (e: Engine, s: number): void => void e.runUntil(e.state.now + s * 1_000_000);

/** Switch – AP (10.0.0.20), Switch – RADIUS-Server (10.0.0.10); Laptop in Reichweite. Ohne Warten auf STP. */
function lab() {
  const e = new Engine({ seed: 2 });
  const sw = e.addDevice('switch-l2', { pos: { x: 0, y: 0 } });
  const ap = e.addDevice('ap', { pos: { x: 100, y: 0 } });
  const srv = e.addDevice('server', { pos: { x: 0, y: 100 } });
  const lap = e.addDevice('laptop', { pos: { x: 180, y: 0 } });
  must(e.connect({ deviceId: ap, portId: 'p0' }, { deviceId: sw, portId: 'p0' }, 'straight'));
  must(e.connect({ deviceId: srv, portId: 'p0' }, { deviceId: sw, portId: 'p1' }, 'straight'));
  must(e.setHostIp(srv, '10.0.0.10', '255.255.255.0'));
  must(e.setHostIp(ap, '10.0.0.20', '255.255.255.0'));
  must(
    e.p5.setServices(srv, {
      aaa: {
        enabled: true,
        clients: [{ ip: '10.0.0.20', secret: 'radkey' }],
        users: [{ user: 'alice', pass: 'wonderland' }],
      },
    }),
  );
  must(
    e.p5.setApRadio(ap, '2.4', {
      ssid: 'Corp',
      security: 'wpa2-enterprise',
      radius: { host: '10.0.0.10', secret: 'radkey' },
    }),
  );
  return { e, sw, ap, srv, lap };
}

const profile = (e: Engine, lap: string): void => {
  must(e.p5.wifiAddProfile(lap, 'Corp', undefined, { username: 'alice', password: 'wonderland' }));
};

describe('QA2: WPA2-Enterprise – vorübergehend nicht erreichbarer RADIUS-Server', () => {
  it('Profil vor der STP-Konvergenz: nach dem Timeout wird die Anmeldung später wiederholt', () => {
    const { e, lap } = lab();
    profile(e, lap);
    run(e, 5);
    expect(host(e, lap).wifi?.status).toBe('auth-failed');
    run(e, 120);
    expect(host(e, lap).wifi?.status).toBe('connected');
  });

  it('RADIUS-Server aus und wieder an: der Client verbindet sich ohne Eingriff', () => {
    const { e, lap, srv } = lab();
    run(e, 35);
    e.setPower(srv, false);
    profile(e, lap);
    run(e, 5);
    expect(host(e, lap).wifi?.status).toBe('auth-failed');
    e.setPower(srv, true);
    run(e, 120);
    expect(host(e, lap).wifi?.status).toBe('connected');
  });

  it('eine Ablehnung (falsches Passwort) wird nicht endlos wiederholt', () => {
    const { e, lap } = lab();
    run(e, 35);
    must(e.p5.wifiAddProfile(lap, 'Corp', undefined, { username: 'alice', password: 'x' }));
    run(e, 300);
    expect(host(e, lap).wifi?.status).toBe('auth-failed');
    expect(e.log.filter((l) => l.msg.key === 'wifi.eapStart').length).toBe(1);
  });

  it('Snapshot während der Authentifizierung: Restore führt zum selben Ergebnis', () => {
    const { e, lap } = lab();
    run(e, 35);
    profile(e, lap);
    expect(host(e, lap).wifi?.status).toBe('authenticating');
    const snap = e.snapshot();
    run(e, 5);
    const a = JSON.stringify(e.state);
    expect(host(e, lap).wifi?.status).toBe('connected');
    e.restore(snap);
    run(e, 5);
    expect(JSON.stringify(e.state)).toBe(a);
  });
});
