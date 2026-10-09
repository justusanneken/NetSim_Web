import { describe, expect, it } from 'vitest';
import type { TcpPdu } from '@netsim/protocols';
import { Engine, newBgp, newBgpNbr } from '../src';
import { pcOn, rip4, rlink, sec } from './labs4';

/** R1 (10.0.12.1) – R2 – R3 (10.0.23.3); R3 erlaubt Telnet mit Passwort. Der Link R2–R3 lässt sich trennen. */
function pair() {
  const e = new Engine({ seed: 1 });
  const r1 = e.addDevice('router', { name: 'R1' });
  const r2 = e.addDevice('router', { name: 'R2' });
  const r3 = e.addDevice('router', { name: 'R3' });
  rlink(e, r1, 'p0', r2, 'p0');
  const link = rlink(e, r2, 'p1', r3, 'p0');
  rip4(e, r1, 'p0', '10.0.12.1');
  rip4(e, r2, 'p0', '10.0.12.2');
  rip4(e, r2, 'p1', '10.0.23.2');
  rip4(e, r3, 'p0', '10.0.23.3');
  for (const [id, dst, via] of [
    [r1, '10.0.23.0', '10.0.12.2'],
    [r3, '10.0.12.0', '10.0.23.2'],
  ] as const) {
    const d = e.getDevice(id);
    if (d?.config.kind !== 'router') throw new Error('router');
    d.config.staticRoutes.push({ prefix: dst, mask: '255.255.255.0', nextHop: via, ad: 1 });
    e.routingChanged(id);
  }
  const c3 = e.getDevice(r3)?.config;
  if (c3?.kind === 'router') {
    c3.sys.lineVty.password = 'pw';
    c3.sys.lineVty.login = true;
  }
  sec(e, 3);
  e.log.length = 0;
  return { e, r1, r2: r3, mid: r2, link };
}

const tcpSegs = (e: Engine): TcpPdu[] => {
  const out: TcpPdu[] = [];
  for (const l of e.log) {
    const ip = l.frame?.payload;
    if (ip && ip.kind === 'ipv4' && ip.payload.kind === 'tcp') out.push(ip.payload);
  }
  return out;
};

describe('Gemeinsames TCP (Dienst-Transport)', () => {
  it('Dreiwege-Handshake mit echten Ports und Sequenznummern, Daten werden bestätigt', () => {
    const { e, r1 } = pair();
    const r = e.p5.open(r1, '10.0.23.3', 'telnet');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    sec(e, 1);
    const c = e.p5.connState(r1, r.value);
    expect(c?.state).toBe('open');
    expect(c?.rport).toBe(23);
    e.p5.send(r1, r.value, 'login', { user: '', pass: 'pw' });
    sec(e, 1);
    const c2 = e.p5.connState(r1, r.value);
    expect(c2?.reply?.op).toBe('login-ok');
    expect(c2?.rtx ?? []).toHaveLength(0); // alles bestätigt
    const segs = tcpSegs(e);
    const syn = segs.find((s) => s.flags.syn && !s.flags.ack);
    const synack = segs.find((s) => s.flags.syn && s.flags.ack);
    expect(syn?.dstPort).toBe(23);
    expect(synack?.ack).toBe((syn?.seq ?? 0) + 1);
    const data = segs.find((s) => s.app?.kind === 'svc' && s.app.op === 'login');
    expect(data?.seq).toBe((syn?.seq ?? 0) + 1); // erstes Datenbyte direkt nach dem SYN
    // die Antwort bestätigt die Anfrage kumulativ (ack = seq + Länge)
    const reply = segs.find((s) => s.app?.kind === 'svc' && s.app.op === 'login-ok');
    expect(reply?.ack).toBeGreaterThan(data?.seq ?? 0);
  });

  it('Ein verlorenes Segment wird nach dem Timeout wiederholt und die Sitzung bleibt bestehen', () => {
    const { e, r1, link, mid, r2 } = pair();
    const r = e.p5.open(r1, '10.0.23.3', 'telnet');
    if (!r.ok) throw new Error(r.error);
    sec(e, 1);
    // Link kurz unterbrechen, während die Anfrage unterwegs ist
    e.disconnect(link);
    e.p5.send(r1, r.value, 'login', { user: '', pass: 'pw' });
    sec(e, 1.5);
    const again = rlink(e, mid, 'p1', r2, 'p0');
    void again;
    sec(e, 8);
    const c = e.p5.connState(r1, r.value);
    expect(c?.state).toBe('open');
    expect(c?.reply?.op).toBe('login-ok');
    expect(e.log.some((l) => l.msg.key === 'tcp.retransmit')).toBe(true);
  });

  it('Bleibt der Pfad unterbrochen, bricht die Verbindung nach den Wiederholungen ab', () => {
    const { e, r1, link } = pair();
    const r = e.p5.open(r1, '10.0.23.3', 'telnet');
    if (!r.ok) throw new Error(r.error);
    sec(e, 1);
    e.disconnect(link);
    e.p5.send(r1, r.value, 'login', { user: '', pass: 'pw' });
    sec(e, 20);
    expect(e.p5.connState(r1, r.value)?.state).toBe('open'); // noch am Wiederholen
    sec(e, 20);
    const c = e.p5.connState(r1, r.value);
    expect(c?.state).toBe('failed');
    expect(c?.err).toBe('conn.timeout');
    expect(e.log.filter((l) => l.msg.key === 'tcp.retransmit')).toHaveLength(5);
    expect(e.log.some((l) => l.msg.key === 'tcp.abort')).toBe(true);
  });

  it('Der Server erkennt Duplikate (kein doppelter Login bei wiederholtem Segment)', () => {
    const { e, r1, r2 } = pair();
    const r = e.p5.open(r1, '10.0.23.3', 'telnet');
    if (!r.ok) throw new Error(r.error);
    sec(e, 1);
    e.p5.send(r1, r.value, 'login', { user: '', pass: 'pw' });
    sec(e, 1);
    // Segment künstlich erneut in die Warteschlange legen und per Timer wiederholen lassen
    const c = e.p5.connState(r1, r.value);
    if (!c) throw new Error('conn');
    c.rtx = [{ seq: c.seq - 1, len: 1 }];
    sec(e, 3);
    const cfg2 = e.getDevice(r2)?.config;
    if (cfg2?.kind !== 'router') throw new Error('router');
    expect(cfg2.sys.mgmt?.sessions ?? []).toHaveLength(1);
  });

  it('Daten für eine unbekannte Verbindung beantwortet der Dienst-Port mit RST', () => {
    const { e, r1, r2 } = pair();
    const r = e.p5.open(r1, '10.0.23.3', 'telnet');
    if (!r.ok) throw new Error(r.error);
    sec(e, 1);
    // Server vergisst die Verbindung (z. B. Neustart): das nächste Datensegment wird mit RST beantwortet
    const cfg2 = e.getDevice(r2)?.config;
    if (cfg2?.kind !== 'router' || !cfg2.appc) throw new Error('appc');
    cfg2.appc.conns = {};
    e.p5.send(r1, r.value, 'login', { user: '', pass: 'pw' });
    sec(e, 1);
    const c = e.p5.connState(r1, r.value);
    expect(c?.state).toBe('failed');
    expect(c?.err).toBe('conn.closed');
  });
});

// ------------------------------------------------------------------ BGP über TCP

function bgp(
  e: Engine,
  id: string,
  asn: number,
  nbrs: { ip: string; asn: number; src?: string }[],
  nets: string[] = [],
): void {
  const c = newBgp(asn);
  for (const n of nbrs) {
    const nb = newBgpNbr(n.ip, n.asn);
    nb.updateSource = n.src;
    c.neighbors[n.ip] = nb;
  }
  c.networks = nets.map((x) => {
    const [prefix, plen] = x.split('/') as [string, string];
    return { prefix, plen: Number(plen) };
  });
  const d = e.getDevice(id);
  if (d?.config.kind !== 'router') throw new Error('router');
  d.config.routing.bgp = c;
  e.routingChanged(id);
}

const nbrOf = (e: Engine, id: string, ip: string) => {
  const d = e.getDevice(id);
  return d?.config.kind === 'router' ? d.config.routing.bgp?.neighbors[ip] : undefined;
};

function ebgpPair() {
  const e = new Engine({ seed: 1 });
  const r1 = e.addDevice('router', { name: 'R1' });
  const r2 = e.addDevice('router', { name: 'R2' });
  rlink(e, r1, 'p0', r2, 'p0');
  rip4(e, r1, 'p0', '192.168.12.1', '255.255.255.252');
  rip4(e, r2, 'p0', '192.168.12.2', '255.255.255.252');
  rip4(e, r2, 'p1', '10.2.0.1');
  pcOn(e, r2, 'p1', '10.2.0.10', '10.2.0.1');
  return { e, r1, r2 };
}

describe('BGP über TCP Port 179', () => {
  it('Nachrichten laufen als TCP-Segmente (OPEN/KEEPALIVE/UPDATE) zu Port 179', () => {
    const { e, r1, r2 } = ebgpPair();
    bgp(e, r1, 100, [{ ip: '192.168.12.2', asn: 200 }]);
    bgp(e, r2, 200, [{ ip: '192.168.12.1', asn: 100 }], ['10.2.0.0/24']);
    sec(e, 30);
    expect(nbrOf(e, r1, '192.168.12.2')?.state).toBe('established');
    const segs = tcpSegs(e);
    expect(segs.some((s) => s.dstPort === 179 && s.flags.syn && !s.flags.ack)).toBe(true);
    const ops = segs.flatMap((s) => (s.app?.kind === 'svc' && s.app.bgp ? [s.app.bgp.type] : []));
    expect(ops).toContain('open');
    expect(ops).toContain('keepalive');
    expect(ops).toContain('update');
    // Verbindungstabelle: je Seite genau eine Verbindung mit Port 179
    const d1 = e.getDevice(r1)?.config;
    if (d1?.kind !== 'router') throw new Error('router');
    const conns = Object.values(d1.appc?.conns ?? {}).filter((c) => c.proto === 'bgp');
    expect(conns).toHaveLength(1);
    expect(conns[0]?.state).toBe('open');
  });

  it('Gegenstelle ohne BGP antwortet mit RST: Zustand Active, später Aufbau nach Konfiguration', () => {
    const { e, r1, r2 } = ebgpPair();
    bgp(e, r1, 100, [{ ip: '192.168.12.2', asn: 200 }]);
    sec(e, 9);
    expect(nbrOf(e, r1, '192.168.12.2')?.state).toBe('active');
    bgp(e, r2, 200, [{ ip: '192.168.12.1', asn: 100 }]);
    sec(e, 20);
    expect(nbrOf(e, r1, '192.168.12.2')?.state).toBe('established');
  });

  it('gleichzeitiger Aufbau von beiden Seiten (Collision) ergibt genau eine Sitzung', () => {
    const { e, r1, r2 } = ebgpPair();
    bgp(e, r1, 100, [{ ip: '192.168.12.2', asn: 200 }]);
    bgp(e, r2, 200, [{ ip: '192.168.12.1', asn: 100 }]);
    sec(e, 30);
    expect(nbrOf(e, r1, '192.168.12.2')?.state).toBe('established');
    expect(nbrOf(e, r2, '192.168.12.1')?.state).toBe('established');
    for (const id of [r1, r2]) {
      const cfg = e.getDevice(id)?.config;
      if (cfg?.kind !== 'router') throw new Error('router');
      expect(Object.values(cfg.appc?.conns ?? {}).filter((c) => c.proto === 'bgp')).toHaveLength(1);
    }
  });

  it('no neighbor sendet Cease: die Gegenstelle verwirft Sitzung und Routen sofort', () => {
    const { e, r1, r2 } = ebgpPair();
    bgp(e, r1, 100, [{ ip: '192.168.12.2', asn: 200 }]);
    bgp(e, r2, 200, [{ ip: '192.168.12.1', asn: 100 }], ['10.2.0.0/24']);
    sec(e, 30);
    const has = (): boolean => {
      const c = e.getDevice(r1)?.config;
      return c?.kind === 'router' && c.dynRoutes.some((r) => r.prefix === '10.2.0.0');
    };
    expect(has()).toBe(true);
    // Nachbar R2 an R1 entfernen (wie `no neighbor 192.168.12.2`)
    const d1 = e.getDevice(r1);
    if (d1?.config.kind !== 'router') throw new Error('router');
    delete d1.config.routing.bgp?.neighbors['192.168.12.2'];
    e.routingChanged(r1);
    sec(e, 1);
    expect(has()).toBe(false);
    // R2 hat die Cease-NOTIFICATION erhalten und die Sitzung verworfen (Hold-Timer 180 s nicht abgewartet)
    expect(nbrOf(e, r2, '192.168.12.1')?.state).not.toBe('established');
    expect(
      e.log.some(
        (l) =>
          l.atDeviceName === 'R2' &&
          l.msg.key === 'bgp.state' &&
          String(l.msg.params?.reason).includes('Cease'),
      ),
    ).toBe(true);
  });

  it('Pfad bricht ab (Blackhole): TCP-Timeout bzw. Hold-Timer beenden die Sitzung', () => {
    // R1 -- R2 -- R3: iBGP zwischen R1 und R3 über statische Routen; Link R2–R3 fällt aus
    const e = new Engine({ seed: 1 });
    const r1 = e.addDevice('router', { name: 'R1' });
    const r2 = e.addDevice('router', { name: 'R2' });
    const r3 = e.addDevice('router', { name: 'R3' });
    rlink(e, r1, 'p0', r2, 'p0');
    const l23 = rlink(e, r2, 'p1', r3, 'p0');
    rip4(e, r1, 'p0', '10.0.12.1');
    rip4(e, r2, 'p0', '10.0.12.2');
    rip4(e, r2, 'p1', '10.0.23.2');
    rip4(e, r3, 'p0', '10.0.23.3');
    for (const [id, dst, via] of [
      [r1, '10.0.23.0', '10.0.12.2'],
      [r3, '10.0.12.0', '10.0.23.2'],
    ] as const) {
      const d = e.getDevice(id);
      if (d?.config.kind !== 'router') throw new Error('router');
      d.config.staticRoutes.push({ prefix: dst, mask: '255.255.255.0', nextHop: via, ad: 1 });
      e.routingChanged(id);
    }
    bgp(e, r1, 100, [{ ip: '10.0.23.3', asn: 100, src: 'p0' }]);
    bgp(e, r3, 100, [{ ip: '10.0.12.1', asn: 100, src: 'p0' }]);
    sec(e, 30);
    expect(nbrOf(e, r1, '10.0.23.3')?.state).toBe('established');
    e.disconnect(l23);
    sec(e, 150);
    // R1 hält die statische Route (R2 erreichbar), sieht aber nur noch unbestätigte Segmente → TCP-Abbruch
    expect(nbrOf(e, r1, '10.0.23.3')?.state).not.toBe('established');
  });
});
