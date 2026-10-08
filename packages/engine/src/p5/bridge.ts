import { isBroadcastMac, isMulticastMac, summarizeFrame, type Frame } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { BridgeCfg } from '../p5types';

/**
 * Cloud / Modem: lernende Bridge zwischen Ports derselben Gruppe (DSL/Koax ↔ Ethernet).
 * Gruppe 0 = Port ohne Zuordnung. Vereinfachung: Die WAN-Strecke ist transparent (kein PPPoE, kein
 * Frame-Relay, keine Bandbreitenbegrenzung über die Portgeschwindigkeit hinaus).
 */
export function bridgeRx(
  ctx: DeviceCtx,
  cfg: BridgeCfg,
  portId: string,
  frame: Frame,
  fromId: string,
): void {
  const group = cfg.groups[portId] ?? 0;
  const ingress = ctx.port(portId);
  const { proto, info } = summarizeFrame(frame);
  const base = { from: fromId, port: ingress, frame, summary: info, proto } as const;
  if (group === 0) {
    ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'bridge.unmapped', params: { port: ingress.name } },
    });
    return;
  }
  if (!isMulticastMac(frame.src)) cfg.macTable[frame.src] = portId;
  const members = ctx.device.ports.filter(
    (p) => p.id !== portId && p.operUp && cfg.groups[p.id] === group,
  );
  const flood = isBroadcastMac(frame.dst) || isMulticastMac(frame.dst);
  const known = flood ? undefined : cfg.macTable[frame.dst];
  const targets = known !== undefined ? members.filter((p) => p.id === known) : members;
  if (known === portId) return;
  ctx.log({
    ...base,
    kind: 'rx',
    status: 'ok',
    msg: { key: 'bridge.forward', params: { in: ingress.name, count: targets.length } },
  });
  for (const p of targets) ctx.send(p.id, frame, ctx.processingUs);
}
