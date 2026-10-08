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
