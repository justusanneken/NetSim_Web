import { isMulticastMac, summarizeFrame, type Frame } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { SwitchConfig } from '../types';

export function switchRx(
  ctx: DeviceCtx,
  cfg: SwitchConfig,
  portId: string,
  frame: Frame,
  fromId: string,
): void {
  const ingress = ctx.port(portId);
  const { proto, info } = summarizeFrame(frame);
  const now = ctx.now;

  // 1) Source-MAC lernen
  let learned = false;
  if (!isMulticastMac(frame.src)) {
    const prev = cfg.macTable[frame.src];
    learned = !prev || prev.portId !== portId;
    cfg.macTable[frame.src] = { portId, updatedAt: now };
  }

  // 2) Ziel suchen
  let out: string | undefined;
  if (!isMulticastMac(frame.dst)) {
    const e = cfg.macTable[frame.dst];
    if (e) {
      if (now - e.updatedAt <= cfg.agingSec * 1_000_000) out = e.portId;
      else delete cfg.macTable[frame.dst];
    }
  }

  const suffix = learned ? '.learned' : '';
  const base = { from: fromId, port: ingress, frame, summary: info, proto } as const;
  const params = { src: frame.src, port: ingress.name };

  if (out !== undefined) {
    if (out === portId) {
      ctx.log({
        ...base,
        kind: 'drop',
        status: 'drop',
        msg: { key: 'switch.filter' + suffix, params },
      });
      return;
    }
    const outPort = ctx.port(out);
    if (!outPort.operUp) {
      ctx.log({ ...base, kind: 'drop', status: 'drop', msg: { key: 'switch.outDown', params } });
      return;
    }
    ctx.log({
      ...base,
      kind: 'rx',
      status: 'ok',
      msg: {
        key: 'switch.unicast' + suffix,
        params: { ...params, dst: frame.dst, out: outPort.name },
      },
    });
    ctx.send(out, frame, ctx.processingUs);
    return;
  }

  const targets = ctx.device.ports.filter((p) => p.id !== portId && p.operUp);
  ctx.log({
    ...base,
    kind: 'rx',
    status: 'ok',
    msg: { key: 'switch.flood' + suffix, params: { ...params, count: targets.length } },
  });
  for (const p of targets) ctx.send(p.id, frame, ctx.processingUs);
}

/** Aktive (nicht gealterte) MAC-Tabelle. */
export function activeMacTable(
  cfg: SwitchConfig,
  now: number,
): { mac: string; portId: string; ageSec: number }[] {
  return Object.entries(cfg.macTable)
    .filter(([, e]) => now - e.updatedAt <= cfg.agingSec * 1_000_000)
    .map(([mac, e]) => ({ mac, portId: e.portId, ageSec: Math.floor((now - e.updatedAt) / 1e6) }))
    .sort((a, b) => a.mac.localeCompare(b.mac));
}

export function switchPortDown(cfg: SwitchConfig, portId: string): void {
  for (const [mac, e] of Object.entries(cfg.macTable)) {
    if (e.portId === portId) delete cfg.macTable[mac];
  }
}
