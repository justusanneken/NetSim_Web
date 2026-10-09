import { describe, expect, it } from 'vitest';
import { Engine, type HostConfig, type Result } from '../src';

const host = (e: Engine, id: string): HostConfig => e.getDevice(id)?.config as HostConfig;
const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const run = (e: Engine, s: number): void => {
  e.runUntil(e.state.now + s * 1_000_000);
};

/** Switch – AP (10.0.0.20), Switch – RADIUS-Server (10.0.0.10); Laptop in Reichweite. */
function lab(secret = 'radkey') {
  const e = new Engine();
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
        clients: [{ ip: '10.0.0.20', secret }],
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
  run(e, 35);
  return { e, sw, ap, srv, lap };
}

describe('WPA2-Enterprise (802.1X)', () => {
  it('korrekte Zugangsdaten: RADIUS Access-Request/Accept, dann Assoziation', () => {
    const { e, ap, lap } = lab();
    must(
      e.p5.wifiAddProfile(lap, 'Corp', undefined, { username: 'alice', password: 'wonderland' }),
    );
    // Authentifizierung läuft über das Netz, nicht synchron
    expect(host(e, lap).wifi?.status).toBe('authenticating');
    expect(host(e, lap).wifi?.assoc).toBeUndefined();
    run(e, 3);
    expect(host(e, lap).wifi?.status).toBe('connected');
    expect(host(e, lap).wifi?.assoc?.apId).toBe(ap);
    const keys = e.log.map((l) => l.msg.key);
    expect(keys).toContain('wifi.eapStart');
    expect(keys).toContain('wifi.eapSuccess');
    expect(keys).toContain('svc.aaa.accept');
    expect(keys).toContain('wifi.assoc');
    // RADIUS-Pakete stehen im Ereignisprotokoll (UDP/1812)
    const wire = e.log.filter((l) => l.summary?.includes('1812'));
    expect(wire.length).toBeGreaterThanOrEqual(2);
  });

  it('falsches Passwort: Access-Reject, keine Assoziation, kein Link', () => {
    const { e, lap } = lab();
    must(e.p5.wifiAddProfile(lap, 'Corp', undefined, { username: 'alice', password: 'nope' }));
    run(e, 3);
    expect(host(e, lap).wifi?.status).toBe('auth-failed');
    expect(host(e, lap).wifi?.assoc).toBeUndefined();
    expect(e.getDevice(lap)?.ports[1]?.operUp).toBe(false);
    const keys = e.log.map((l) => l.msg.key);
    expect(keys).toContain('svc.aaa.reject');
    expect(keys).toContain('wifi.eapFailure');
    // Korrektur der Zugangsdaten verbindet
    must(
      e.p5.wifiAddProfile(lap, 'Corp', undefined, { username: 'alice', password: 'wonderland' }),
    );
    run(e, 3);
    expect(host(e, lap).wifi?.status).toBe('connected');
  });

  it('ohne Benutzername im Profil: Authentifizierung scheitert sofort', () => {
    const { e, lap } = lab();
    must(e.p5.wifiAddProfile(lap, 'Corp'));
    run(e, 3);
    expect(host(e, lap).wifi?.status).toBe('auth-failed');
    expect(e.log.map((l) => l.msg.key)).not.toContain('wifi.eapStart');
  });

  it('falsches Shared Secret zwischen AP und Server: Timeout, kein Zugang', () => {
    const { e, lap } = lab('other-secret');
    must(
      e.p5.wifiAddProfile(lap, 'Corp', undefined, { username: 'alice', password: 'wonderland' }),
    );
    run(e, 10);
    expect(host(e, lap).wifi?.status).toBe('auth-failed');
    expect(host(e, lap).wifi?.assoc).toBeUndefined();
  });

  it('Benutzer wird nachträglich am Server angelegt: erneuter Versuch gelingt', () => {
    const { e, srv, lap } = lab();
    must(e.p5.wifiAddProfile(lap, 'Corp', undefined, { username: 'bob', password: 'pw' }));
    run(e, 3);
    expect(host(e, lap).wifi?.status).toBe('auth-failed');
    must(
      e.p5.setServices(srv, {
        aaa: {
          enabled: true,
          clients: [{ ip: '10.0.0.20', secret: 'radkey' }],
          users: [
            { user: 'alice', pass: 'wonderland' },
            { user: 'bob', pass: 'pw' },
          ],
        },
      }),
    );
    run(e, 3);
    expect(host(e, lap).wifi?.status).toBe('connected');
  });

  it('Verlassen der Reichweite trennt; Rückkehr authentifiziert erneut', () => {
    const { e, lap } = lab();
    must(
      e.p5.wifiAddProfile(lap, 'Corp', undefined, { username: 'alice', password: 'wonderland' }),
    );
    run(e, 3);
    e.moveDevice(lap, { x: 1000, y: 0 });
    expect(host(e, lap).wifi?.assoc).toBeUndefined();
    const before = e.log.filter((l) => l.msg.key === 'wifi.eapSuccess').length;
    e.moveDevice(lap, { x: 150, y: 0 });
    run(e, 3);
    expect(host(e, lap).wifi?.status).toBe('connected');
    expect(e.log.filter((l) => l.msg.key === 'wifi.eapSuccess').length).toBe(before + 1);
  });

  it('WLC-WLAN mit wpa2-enterprise wird an den Lightweight-AP verteilt', () => {
    const { e, sw, ap, lap } = lab();
    // AP als Autonomous zurücksetzen und über den WLC verwalten
    must(e.p5.setApRadio(ap, '2.4', { security: 'open', ssid: '' }));
    const wlc = e.addDevice('wlc', { pos: { x: 0, y: 200 } });
    must(e.connect({ deviceId: wlc, portId: 'p0' }, { deviceId: sw, portId: 'p2' }, 'straight'));
    must(e.setHostIp(wlc, '10.0.0.30', '255.255.255.0'));
    must(
      e.p5.wlcSetWlan(wlc, {
        ssid: 'Corp',
        security: 'wpa2-enterprise',
        band: 'both',
        enabled: true,
        radius: { host: '10.0.0.10', secret: 'radkey' },
      }),
    );
    must(e.p5.setApController(ap, '10.0.0.30'));
    run(e, 40);
    must(
      e.p5.wifiAddProfile(lap, 'Corp', undefined, { username: 'alice', password: 'wonderland' }),
    );
    run(e, 4);
    expect(host(e, lap).wifi?.status).toBe('connected');
  });

  it('Verlauf ist deterministisch', () => {
    const go = () => {
      const { e, lap } = lab();
      must(
        e.p5.wifiAddProfile(lap, 'Corp', undefined, { username: 'alice', password: 'wonderland' }),
      );
      run(e, 5);
      return JSON.stringify(e.log.map((l) => [l.t, l.msg.key]));
    };
    expect(go()).toBe(go());
  });
});
