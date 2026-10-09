import { describe, expect, it } from 'vitest';
import { Engine, newCrypto, type AclEntry, type RouterConfig } from '../src';
import { newPolicy } from '../src/ipsecTypes';
import { must, pcOn, rip4, rlink, sec } from './labs4';

const cfgOf = (e: Engine, id: string): RouterConfig => e.getDevice(id)?.config as RouterConfig;

const permit = (src: string, dst: string, n: number): AclEntry => ({
  seq: n,
  action: 'permit',
  proto: 'ip',
  src: { ip: src, wildcard: '0.0.0.255' },
  dst: { ip: dst, wildcard: '0.0.0.255' },
  matches: 0,
});

/** PC1 – R1 ═ ISP ═ R3 – PC3; IPsec-Tunnel R1 ↔ R3 über das öffentliche /30-Netz des ISPs. */
function lab(o: { key3?: string; ts3?: string; enc3?: 'aes' | '3des'; mirror?: boolean } = {}) {
  const e = new Engine({ seed: 1 });
  const [r1, isp, r3] = ['R1', 'ISP', 'R3'].map((n) => e.addDevice('router', { name: n })) as [
    string,
    string,
    string,
  ];
  rlink(e, r1, 'p0', isp, 'p0');
  rlink(e, isp, 'p1', r3, 'p0');
  rip4(e, r1, 'p0', '203.0.113.1', '255.255.255.252');
  rip4(e, isp, 'p0', '203.0.113.2', '255.255.255.252');
  rip4(e, isp, 'p1', '198.51.100.2', '255.255.255.252');
  rip4(e, r3, 'p0', '198.51.100.1', '255.255.255.252');
  rip4(e, r1, 'p1', '10.1.0.1');
  rip4(e, r3, 'p1', '10.2.0.1');
  const pc1 = pcOn(e, r1, 'p1', '10.1.0.10', '10.1.0.1', 'PC1');
  const pc3 = pcOn(e, r3, 'p1', '10.2.0.10', '10.2.0.1', 'PC3');
  must(e.addStaticRoute(r1, { prefix: '0.0.0.0', mask: '0.0.0.0', nextHop: '203.0.113.2' }));
  must(e.addStaticRoute(r3, { prefix: '0.0.0.0', mask: '0.0.0.0', nextHop: '198.51.100.2' }));

  const side = (
    id: string,
    wan: string,
    peer: string,
    local: string,
    remote: string,
    key: string,
    ts: string,
    enc: 'aes' | '3des',
    withAcl = true,
  ): void => {
    const c = cfgOf(e, id);
    c.crypto = newCrypto();
    c.crypto.policies[10] = {
      ...newPolicy(10),
      encr: enc,
      hash: 'sha',
      auth: 'pre-share',
      group: 2,
    };
    c.crypto.keys.push({ key, addr: peer, mask: '255.255.255.255' });
    c.crypto.transformSets['TS'] = { name: 'TS', transforms: ts.split(' '), mode: 'tunnel' };
    c.crypto.maps['VPN'] = {
      name: 'VPN',
      entries: { 10: { seq: 10, peer, transformSet: 'TS', acl: '101' } },
    };
    if (withAcl)
      c.acls['101'] = { name: '101', type: 'extended', entries: [permit(local, remote, 10)] };
    (c.ifaces[wan] ??= { kind: 'phys', portId: wan }).cryptoMap = 'VPN';
  };
  side(r1, 'p0', '198.51.100.1', '10.1.0.0', '10.2.0.0', 'geheim', 'esp-aes esp-sha-hmac', 'aes');
  side(
    r3,
    'p0',
    '203.0.113.1',
    '10.2.0.0',
    '10.1.0.0',
    o.key3 ?? 'geheim',
    o.ts3 ?? 'esp-aes esp-sha-hmac',
    o.enc3 ?? 'aes',
    o.mirror !== false,
  );
  e.routingChanged(r1);
  e.routingChanged(r3);
  return { e, r1, isp, r3, pc1, pc3 };
}

const ping = (e: Engine, from: string, dst: string): string | undefined => {
  e.ping(from, dst, { count: 1 });
  e.runAll();
  const cfg = e.getDevice(from)?.config;
  return cfg?.kind === 'host' ? cfg.pings.at(-1)?.status : undefined;
};

describe('IPsec Site-to-Site', () => {
  it('erster Ping löst IKE aus, danach läuft der Verkehr verschlüsselt (ESP) durch den ISP', () => {
    const { e, r1, isp, r3, pc1 } = lab();
    sec(e, 1);
    expect(ping(e, pc1, '10.2.0.10')).not.toBe('reply'); // SA wird aufgebaut
    sec(e, 2);
    const sa1 = Object.values(cfgOf(e, r1).crypto?.sas ?? {})[0];
    const sa3 = Object.values(cfgOf(e, r3).crypto?.sas ?? {})[0];
    expect(sa1).toMatchObject({ state: 'up', role: 'initiator', peer: '198.51.100.1' });
    expect(sa3).toMatchObject({ state: 'up', role: 'responder', peer: '203.0.113.1' });
    expect(sa1?.outSpi).toBe(sa3?.inSpi);
    expect(sa3?.outSpi).toBe(sa1?.inSpi);
    expect(ping(e, pc1, '10.2.0.10')).toBe('reply');
    expect(sa1?.encaps).toBeGreaterThan(0);
    expect(sa1?.decaps).toBeGreaterThan(0);
    expect(sa3?.encaps).toBeGreaterThan(0);
    // Auf dem ISP: nur ESP/IKE zwischen den öffentlichen Adressen, nie die privaten Adressen
    const atIsp = e.log.filter((l) => l.atDeviceId === isp && l.summary);
    expect(atIsp.some((l) => l.summary?.includes('ESP') || l.proto === 'ESP')).toBe(true);
    expect(atIsp.some((l) => l.proto === 'IKE')).toBe(true);
    expect(atIsp.some((l) => /10\.[12]\.0\.10/.test(l.summary ?? ''))).toBe(false);
    // An den Endpunkten ist das entschlüsselte Paket sichtbar
    expect(
      e.log.some((l) => l.atDeviceId === r3 && (l.summary ?? '').startsWith('decrypted')),
    ).toBe(true);
  });

  it('Pre-Shared-Key passt nicht: keine SA, kein Verkehr', () => {
    const { e, r1, r3, pc1 } = lab({ key3: 'falsch' });
    sec(e, 1);
    ping(e, pc1, '10.2.0.10');
    sec(e, 5);
    expect(ping(e, pc1, '10.2.0.10')).not.toBe('reply');
    const sa1 = Object.values(cfgOf(e, r1).crypto?.sas ?? {})[0];
    expect(sa1?.state).toBe('failed');
    expect(sa1?.reason).toBe('authentication failed');
    expect(Object.values(cfgOf(e, r3).crypto?.sas ?? {})).toHaveLength(0);
  });

  it('anderes Transform-Set, andere ISAKMP-Policy oder fehlende Spiegel-ACL: keine SA', () => {
    for (const [o, reason] of [
      [{ ts3: 'esp-3des esp-sha-hmac' }, 'transform set mismatch'],
      [{ enc3: '3des' as const }, 'no matching ISAKMP policy'],
      [{ mirror: false }, 'proxy identities not supported'],
    ] as const) {
      const { e, r1, pc1 } = lab(o);
      sec(e, 1);
      ping(e, pc1, '10.2.0.10');
      sec(e, 5);
      expect(Object.values(cfgOf(e, r1).crypto?.sas ?? {})[0]?.reason).toBe(reason);
    }
  });

  it('Peer nicht erreichbar: Timeout, später neuer Versuch', () => {
    const { e, r1, pc1 } = lab();
    e.setPortAdmin(r1, 'p0', false);
    sec(e, 1);
    ping(e, pc1, '10.2.0.10');
    expect(Object.values(cfgOf(e, r1).crypto?.sas ?? {})).toHaveLength(0);
  });

  it('Verlauf ist deterministisch', () => {
    const go = () => {
      const { e, pc1 } = lab();
      sec(e, 1);
      ping(e, pc1, '10.2.0.10');
      sec(e, 3);
      ping(e, pc1, '10.2.0.10');
      return JSON.stringify(e.log.map((l) => [l.t, l.msg.key, l.summary]));
    };
    expect(go()).toBe(go());
  });
});
