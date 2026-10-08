import { Engine, type DynRoute } from '../src';

export const must = (r: { ok: boolean; error?: string }): void => {
  if (!r.ok) throw new Error(r.error);
};

/** Verbindet zwei Router-Ports (Crossover) und schaltet beide ein. */
export function rlink(e: Engine, a: string, ap: string, b: string, bp: string): string {
  const r = e.connect({ deviceId: a, portId: ap }, { deviceId: b, portId: bp }, 'crossover');
  if (!r.ok) throw new Error(r.error);
  e.setPortAdmin(a, ap, true);
  e.setPortAdmin(b, bp, true);
  return r.value.id;
}

/** IP an einer Router-Schnittstelle setzen und Port einschalten. */
export function rip4(
  e: Engine,
  id: string,
  port: string,
  ip: string,
  mask = '255.255.255.0',
): void {
  must(e.setInterfaceIp(id, port, ip, mask));
  e.setPortAdmin(id, port, true);
}

export function pcOn(
  e: Engine,
  router: string,
  rport: string,
  ip: string,
  gw: string,
  name?: string,
): string {
  const pc = e.addDevice('pc', { name });
  const r = e.connect(
    { deviceId: pc, portId: 'p0' },
    { deviceId: router, portId: rport },
    'crossover',
  );
  if (!r.ok) throw new Error(r.error);
  e.setPortAdmin(router, rport, true);
  must(e.setHostIp(pc, ip, '255.255.255.0', gw));
  return pc;
}

export const routes = (e: Engine, id: string): DynRoute[] => {
  const d = e.getDevice(id);
  return d && (d.config.kind === 'router' || d.config.kind === 'switch') ? d.config.dynRoutes : [];
};

export const fmtRoute = (r: DynRoute): string =>
  `${r.proto}${r.sub ? ' ' + r.sub : ''} ${r.prefix}/${r.plen} [${r.ad}/${r.metric}] ${r.nextHop ?? 'direct'}`;

export const sec = (e: Engine, s: number): void => {
  e.runUntil(e.state.now + s * 1_000_000);
};

/** R1 – (R2 | R3) – R4: zwei gleichwertige Pfade; LANs 10.1.0.0/24 (R1) und 10.4.0.0/24 (R4). */
export function diamond() {
  const e = new Engine({ seed: 1 });
  const [r1, r2, r3, r4] = ['R1', 'R2', 'R3', 'R4'].map((n) =>
    e.addDevice('router', { name: n }),
  ) as [string, string, string, string];
  rlink(e, r1, 'p0', r2, 'p0');
  rlink(e, r1, 'p1', r3, 'p0');
  rlink(e, r2, 'p1', r4, 'p0');
  rlink(e, r3, 'p1', r4, 'p1');
  rip4(e, r1, 'p0', '10.0.12.1');
  rip4(e, r2, 'p0', '10.0.12.2');
  rip4(e, r1, 'p1', '10.0.13.1');
  rip4(e, r3, 'p0', '10.0.13.3');
  rip4(e, r2, 'p1', '10.0.24.2');
  rip4(e, r4, 'p0', '10.0.24.4');
  rip4(e, r3, 'p1', '10.0.34.3');
  rip4(e, r4, 'p1', '10.0.34.4');
  rip4(e, r1, 'p2', '10.1.0.1');
  rip4(e, r4, 'p2', '10.4.0.1');
  const pc1 = pcOn(e, r1, 'p2', '10.1.0.10', '10.1.0.1', 'PC1');
  const pc4 = pcOn(e, r4, 'p2', '10.4.0.10', '10.4.0.1', 'PC4');
  return { e, r: [r1, r2, r3, r4] as const, pc1, pc4 };
}
