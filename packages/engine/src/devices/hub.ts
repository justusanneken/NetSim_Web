import { summarizeFrame, type Frame } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { HubConfig } from '../types';

/**
 * Hub = Repeater einer Kollisionsdomäne. Vereinfachung: Der Frame wird nach vollständigem
 * Empfang wiederholt (statt bitweise). Kollisionen werden über überlappende
 * Empfangsfenster erkannt; Jam wird als Kollisionsereignis an die Sender gemeldet.
 */
export function hubRx(
  ctx: DeviceCtx,
  cfg: HubConfig,
  portId: string,
  frame: Frame,
  txId: number,
  fromId: string,
): void {
  const tx = ctx.transmission(txId);
  const ingress = ctx.port(portId);
  const { proto, info } = summarizeFrame(frame);
  const base = { from: fromId, port: ingress, frame, summary: info, proto } as const;
  if (!tx) return;
  if (tx.collided) return; // bereits als Kollision behandelt

  const overlaps = ctx.overlappingIncoming(txId);
  const repeating = cfg.busyUntil > tx.arrStart;
  if (overlaps.length > 0 || repeating) {
    const victims = [tx, ...overlaps];
    if (repeating) victims.push(...ctx.corruptOutgoing());
    ctx.signalCollision(victims);
    ctx.log({
      ...base,
      kind: 'collision',
      proto: 'CSMA',
      status: 'error',
      msg: { key: 'hub.collision', params: { count: victims.length } },
    });
    return;
  }

  const targets = ctx.device.ports.filter((p) => p.id !== portId && p.operUp);
  cfg.busyUntil = ctx.now + (tx.arrEnd - tx.arrStart);
  ctx.log({
    ...base,
    kind: 'rx',
    status: 'ok',
    msg: { key: 'hub.repeat', params: { port: ingress.name, count: targets.length } },
  });
  for (const p of targets) ctx.send(p.id, frame, 0, txId);
}
