import { describe, expect, it } from 'vitest';
import type { Ipv4Pdu } from '@netsim/protocols';
import { natHasInbound, natOutside2Inside } from '../src/nat';
import type { L3Cfg } from '../src';

const tcp = (src: string, sport: number, dst: string, dport: number): Ipv4Pdu => ({
  kind: 'ipv4',
  src,
  dst,
  ttl: 64,
  protocol: 6,
  id: 1,
  df: false,
  mf: false,
  fragOffset: 0,
  payload: {
    kind: 'tcp',
    srcPort: sport,
    dstPort: dport,
    flags: { syn: false, ack: true, fin: false, rst: false, psh: false },
    seq: 1,
    ack: 1,
    window: 8192,
    dataSize: 0,
  },
});

describe('QA2: NAT-Rückübersetzung prüft wie die Übersetzung selbst auch den Gegenport', () => {
  it('ein PAT-Eintrag für Port 80 fängt keine Antwort von Port 179 an die Router-Adresse ab', () => {
    const l3 = {
      nat: {
        rules: [{ kind: 'interface', acl: '1', ifaceId: 'p1' }],
        table: [
          {
            proto: 'tcp',
            insideLocal: { ip: '10.1.0.10', port: 40000 },
            insideGlobal: { ip: '203.0.113.1', port: 50000 },
            outside: { ip: '203.0.113.2', port: 80 },
            kind: 'dynamic',
            expiresAt: Number.MAX_SAFE_INTEGER,
          },
        ],
        pools: {},
        nextPort: 1024,
        hits: 0,
        misses: 0,
      },
      acls: {},
    } as unknown as L3Cfg;
    // BGP-Antwort an die eigene Verbindung des Routers (lokaler Port zufällig ebenfalls 50000)
    const bgp = tcp('203.0.113.2', 179, '203.0.113.1', 50000);
    expect(natOutside2Inside(l3, bgp, 0, 'p1').entry).toBeUndefined();
    expect(natHasInbound(l3, bgp, 0, 'p1')).toBe(false);
    // die echte Antwort des Webservers wird weiterhin erkannt
    expect(natHasInbound(l3, tcp('203.0.113.2', 80, '203.0.113.1', 50000), 0, 'p1')).toBe(true);
  });
});
