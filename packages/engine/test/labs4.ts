import { type Engine, type DynRoute } from '../src';

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
