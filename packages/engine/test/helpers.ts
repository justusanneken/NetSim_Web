import { Engine, type LogEntry } from '../src';

export interface Lab {
  e: Engine;
  ids: string[];
  sw?: string;
}

/** n PCs (10.0.0.1…/24) an einem Switch, alles per Straight verkabelt. */
export function switchLab(n = 3, seed = 1): Lab {
  const e = new Engine({ seed });
  const sw = e.addDevice('switch-l2', { pos: { x: 200, y: 200 } });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const pc = e.addDevice('pc', { pos: { x: 50 * i, y: 50 } });
    const r = e.connect(
      { deviceId: pc, portId: 'p0' },
      { deviceId: sw, portId: `p${i}` },
      'straight',
    );
    if (!r.ok) throw new Error(r.error);
    e.setHostIp(pc, `10.0.0.${i + 1}`, '255.255.255.0');
    ids.push(pc);
  }
  return { e, ids, sw };
}

export function hubLab(n = 3, seed = 1): Lab {
  const e = new Engine({ seed });
  const hub = e.addDevice('hub');
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const pc = e.addDevice('pc');
    const r = e.connect(
      { deviceId: pc, portId: 'p0' },
      { deviceId: hub, portId: `p${i}` },
      'straight',
    );
    if (!r.ok) throw new Error(r.error);
    e.setHostIp(pc, `10.0.0.${i + 1}`, '255.255.255.0');
    ids.push(pc);
  }
  return { e, ids, sw: hub };
}

export const keys = (log: LogEntry[]): string[] => log.map((l) => l.msg.key);

/** Kompakte, deterministische Darstellung für Golden-Files. */
export function serializeLog(log: LogEntry[]): string[] {
  return log.map(
    (l) =>
      `${l.t}µs ${l.lastDeviceName ?? '-'} -> ${l.atDeviceName} [${l.proto}/${l.status}] ` +
      `${l.msg.key} ${JSON.stringify(l.msg.params ?? {})}`,
  );
}

export interface RouterLab {
  e: Engine;
  pc0: string;
  pc1: string;
  r1: string;
  r2?: string;
}

const must = (r: { ok: boolean; error?: string }): void => {
  if (!r.ok) throw new Error(r.error);
};

/** PC0 (10.0.1.10) – R1 – PC1 (10.0.2.10); Gateways .1 */
export function routerLab(seed = 1): RouterLab {
  const e = new Engine({ seed });
  const r1 = e.addDevice('router');
  const pc0 = e.addDevice('pc');
  const pc1 = e.addDevice('pc');
  must(e.connect({ deviceId: pc0, portId: 'p0' }, { deviceId: r1, portId: 'p0' }, 'straight'));
  must(e.connect({ deviceId: pc1, portId: 'p0' }, { deviceId: r1, portId: 'p1' }, 'straight'));
  must(e.setInterfaceIp(r1, 'p0', '10.0.1.1', '255.255.255.0'));
  must(e.setInterfaceIp(r1, 'p1', '10.0.2.1', '255.255.255.0'));
  e.setPortAdmin(r1, 'p0', true);
  e.setPortAdmin(r1, 'p1', true);
  must(e.setHostIp(pc0, '10.0.1.10', '255.255.255.0', '10.0.1.1'));
  must(e.setHostIp(pc1, '10.0.2.10', '255.255.255.0', '10.0.2.1'));
  e.runAll();
  return { e, pc0, pc1, r1 };
}

/** PC0 – R1 – R2 – PC1 mit statischen Routen (Transitnetz 10.0.12.0/24). */
export function chainLab(seed = 1): RouterLab {
  const e = new Engine({ seed });
  const r1 = e.addDevice('router');
  const r2 = e.addDevice('router');
  const pc0 = e.addDevice('pc');
  const pc1 = e.addDevice('pc');
  must(e.connect({ deviceId: pc0, portId: 'p0' }, { deviceId: r1, portId: 'p0' }, 'straight'));
  must(e.connect({ deviceId: r1, portId: 'p1' }, { deviceId: r2, portId: 'p1' }, 'crossover'));
  must(e.connect({ deviceId: pc1, portId: 'p0' }, { deviceId: r2, portId: 'p0' }, 'straight'));
  const cfg = (r: string, p: string, ip: string): void => {
    must(e.setInterfaceIp(r, p, ip, '255.255.255.0'));
    e.setPortAdmin(r, p, true);
  };
  cfg(r1, 'p0', '10.0.1.1');
  cfg(r1, 'p1', '10.0.12.1');
  cfg(r2, 'p1', '10.0.12.2');
  cfg(r2, 'p0', '10.0.2.1');
  must(e.addStaticRoute(r1, { prefix: '10.0.2.0', mask: '255.255.255.0', nextHop: '10.0.12.2' }));
  must(e.addStaticRoute(r2, { prefix: '10.0.1.0', mask: '255.255.255.0', nextHop: '10.0.12.1' }));
  must(e.setHostIp(pc0, '10.0.1.10', '255.255.255.0', '10.0.1.1'));
  must(e.setHostIp(pc1, '10.0.2.10', '255.255.255.0', '10.0.2.1'));
  e.runAll();
  return { e, pc0, pc1, r1, r2 };
}
