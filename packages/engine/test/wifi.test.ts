import { describe, expect, it } from 'vitest';
import { Engine, type HostConfig } from '../src';

const host = (e: Engine, id: string): HostConfig => e.getDevice(id)?.config as HostConfig;
const must = (r: { ok: boolean; error?: string }): void => {
  if (!r.ok) throw new Error(r.error);
};

/** Switch – AP, Switch – Server (DHCP 10.0.0.0/24, Pool .100–.150); Laptop in Reichweite. */
function lab() {
  const e = new Engine();
  const sw = e.addDevice('switch-l2', { pos: { x: 0, y: 0 } });
  const ap = e.addDevice('ap', { pos: { x: 100, y: 0 } });
  const srv = e.addDevice('server', { pos: { x: 0, y: 100 } });
  const lap = e.addDevice('laptop', { pos: { x: 180, y: 0 } });
  must(e.connect({ deviceId: ap, portId: 'p0' }, { deviceId: sw, portId: 'p0' }, 'straight'));
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
  must(e.p5.setApRadio(ap, '2.4', { ssid: 'HomeNet', security: 'wpa2-psk', key: 'secret123' }));
  e.runUntil(e.state.now + 35_000_000);
  return { e, sw, ap, srv, lap };
}

describe('WLAN', () => {
  it('Client verbindet sich per WPA2, bekommt DHCP über den AP und pingt den Server', () => {
    const { e, ap, srv, lap } = lab();
    must(e.p5.wifiAddProfile(lap, 'HomeNet', 'secret123'));
    expect(host(e, lap).wifi?.status).toBe('connected');
    expect(host(e, lap).wifi?.assoc?.apId).toBe(ap);
    expect(host(e, ap).ap?.clients).not.toEqual({});
    must(e.setHostDhcp(lap, true));
    e.runUntil(e.state.now + 10_000_000);
    expect(host(e, lap).ip).toMatch(/^10\.0\.0\.1\d\d$/);
    const r = e.ping(lap, '10.0.0.10');
    expect(r.ok).toBe(true);
    e.runUntil(e.state.now + 5_000_000);
    expect(host(e, lap).pings.some((p) => p.status === 'reply')).toBe(true);
    const keys = e.log.map((l) => l.msg.key);
    expect(keys).toContain('wifi.authOk');
    expect(keys).toContain('wifi.assoc');
    expect(keys).toContain('ap.bridge');
    void srv;
  });

  it('falscher Schlüssel: Authentifizierung scheitert, kein Link', () => {
    const { e, lap } = lab();
    must(e.p5.wifiAddProfile(lap, 'HomeNet', 'wrongpass1'));
    expect(host(e, lap).wifi?.status).toBe('auth-failed');
    expect(host(e, lap).wifi?.assoc).toBeUndefined();
    expect(e.log.map((l) => l.msg.key)).toContain('wifi.authFailed');
    // Korrektur des Profils verbindet
    must(e.p5.wifiAddProfile(lap, 'HomeNet', 'secret123'));
    expect(host(e, lap).wifi?.status).toBe('connected');
  });

  it('Reichweite: außerhalb getrennt, wieder in Reichweite verbunden; 5 GHz kürzer', () => {
    const { e, lap } = lab();
    must(e.p5.wifiAddProfile(lap, 'HomeNet', 'secret123'));
    e.moveDevice(lap, { x: 1000, y: 0 });
    expect(host(e, lap).wifi?.assoc).toBeUndefined();
    expect(host(e, lap).wifi?.status).toBe('no-ap');
    e.moveDevice(lap, { x: 150, y: 0 });
    expect(host(e, lap).wifi?.status).toBe('connected');
    expect(e.getDevice(lap)?.ports[1]?.operUp).toBe(true);
  });

  it('Drucker unterstützt nur 2,4 GHz; Roaming zum näheren AP', () => {
    const { e, ap, lap } = lab();
    must(e.p5.setApRadio(ap, '2.4', { ssid: '' }));
    must(e.p5.setApRadio(ap, '5', { ssid: 'HomeNet', security: 'wpa2-psk', key: 'secret123' }));
    const pr = e.addDevice('printer', { pos: { x: 120, y: 0 } });
    must(e.p5.wifiAddProfile(pr, 'HomeNet', 'secret123'));
    expect(host(e, pr).wifi?.status).toBe('no-ap');
    must(e.p5.setApRadio(ap, '2.4', { ssid: 'HomeNet', security: 'wpa2-psk', key: 'secret123' }));
    expect(host(e, pr).wifi?.status).toBe('connected');
    // zweiter AP
    const ap2 = e.addDevice('ap', { pos: { x: 600, y: 0 } });
    must(e.p5.setApRadio(ap2, '2.4', { ssid: 'HomeNet', security: 'wpa2-psk', key: 'secret123' }));
    must(e.p5.wifiAddProfile(lap, 'HomeNet', 'secret123'));
    expect(host(e, lap).wifi?.assoc?.apId).toBe(ap);
    e.moveDevice(lap, { x: 560, y: 0 });
    expect(host(e, lap).wifi?.assoc?.apId).toBe(ap2);
    expect(e.log.map((l) => l.msg.key)).toContain('wifi.disassoc');
  });

  it('Strom aus am AP trennt Clients; Physical View: anderes Gebäude außer Reichweite', () => {
    const { e, ap, lap } = lab();
    must(e.p5.wifiAddProfile(lap, 'HomeNet', 'secret123'));
    e.setPower(ap, false);
    expect(host(e, lap).wifi?.assoc).toBeUndefined();
    e.setPower(ap, true);
    expect(host(e, lap).wifi?.status).toBe('connected');
    must(e.p5.placeDevice(ap, 'Berlin/HQ/Raum1'));
    must(e.p5.placeDevice(lap, 'Berlin/Annex/Raum1'));
    expect(host(e, lap).wifi?.assoc).toBeUndefined();
    must(e.p5.placeDevice(lap, 'Berlin/HQ/Raum2'));
    expect(host(e, lap).wifi?.status).toBe('connected');
  });

  it('WLC: Lightweight-AP erhält die SSID zentral', () => {
    const e = new Engine();
    const sw = e.addDevice('switch-l2');
    const wlc = e.addDevice('wlc');
    const ap = e.addDevice('ap', { pos: { x: 0, y: 0 } });
    const lap = e.addDevice('laptop', { pos: { x: 50, y: 0 } });
    must(e.connect({ deviceId: wlc, portId: 'p0' }, { deviceId: sw, portId: 'p0' }, 'straight'));
    must(e.connect({ deviceId: ap, portId: 'p0' }, { deviceId: sw, portId: 'p1' }, 'straight'));
    must(e.setHostIp(wlc, '10.1.0.1', '255.255.255.0'));
    must(e.setHostIp(ap, '10.1.0.2', '255.255.255.0'));
    must(
      e.p5.wlcSetWlan(wlc, {
        ssid: 'Corp',
        security: 'wpa2-psk',
        key: 'corp-key-1',
        band: 'both',
        enabled: true,
      }),
    );
    must(e.p5.setApController(ap, '10.1.0.1'));
    e.runUntil(e.state.now + 40_000_000);
    expect(host(e, ap).ap?.managed?.wlans).toHaveLength(1);
    expect(Object.keys(host(e, wlc).wlc?.aps ?? {})).toHaveLength(1);
    must(e.p5.wifiAddProfile(lap, 'Corp', 'corp-key-1'));
    expect(host(e, lap).wifi?.status).toBe('connected');
    // WLAN am WLC löschen → AP übernimmt beim nächsten Refresh
    must(e.p5.wlcRemoveWlan(wlc, 1));
    e.runUntil(e.state.now + 35_000_000);
    expect(host(e, lap).wifi?.assoc).toBeUndefined();
  });

  it('Validierung und Verkabelung', () => {
    const { e, ap, lap, sw } = lab();
    expect(e.p5.setApRadio(ap, '2.4', { channel: 14 }).ok).toBe(false);
    expect(e.p5.setApRadio(ap, '5', { channel: 40 }).ok).toBe(true);
    expect(e.p5.setApRadio(ap, '2.4', { security: 'wpa2-psk', key: 'short' }).ok).toBe(false);
    expect(e.p5.wifiAddProfile(lap, '', 'x').ok).toBe(false);
    expect(
      e.connect({ deviceId: lap, portId: 'p1' }, { deviceId: sw, portId: 'p5' }, 'straight').ok,
    ).toBe(false);
    // Auto-Verkabelung überspringt Funk-Ports
    const r = e.connectAuto(lap, sw);
    expect(r.ok && r.value.cable).toBe('straight');
  });
});
