import { isBroadcastMac, isMulticastMac, summarizeFrame, type Frame } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { HostConfig } from '../types';

/**
 * Access Point = transparente Bridge zwischen seinem Ethernet-Port (`p0`) und den Funk-Steckplätzen.
 * Lernt Absender-MACs, leitet Unicast gezielt weiter und flutet Broadcast/Unbekanntes. Der Management-IP-Stack
 * des APs (DHCP, Ping, CAPWAP) hängt zusätzlich an `p0`.
 */
export function apRx(
  ctx: DeviceCtx,
  cfg: HostConfig,
  portId: string,
  frame: Frame,
  fromId: string,
  deliverLocal: () => void,
): void {
  const ap = cfg.ap;
  if (!ap) return;
  const own = ctx.device.ports[0]?.mac ?? '';
  if (!isMulticastMac(frame.src)) ap.macTable[frame.src] = portId;
  const flood = isBroadcastMac(frame.dst) || isMulticastMac(frame.dst);
  if (flood || frame.dst === own) deliverLocal();
  if (frame.dst === own) return;
  const known = flood ? undefined : ap.macTable[frame.dst];
  const { proto, info } = summarizeFrame(frame);
  if (known !== undefined && known !== portId) {
    const out = ctx.device.ports.find((p) => p.id === known);
    if (out?.operUp) {
      ctx.log({
        from: fromId,
        port: ctx.port(portId),
        frame,
        summary: info,
        proto,
        kind: 'rx',
        status: 'ok',
        msg: { key: 'ap.bridge', params: { in: ctx.port(portId).name, out: out.name } },
      });
      ctx.send(known, frame, ctx.processingUs);
    }
    return;
  }
  if (known === portId) return;
  const targets = ctx.device.ports.filter((p) => p.id !== portId && p.operUp);
  if (targets.length === 0) return;
  ctx.log({
    from: fromId,
    port: ctx.port(portId),
    frame,
    summary: info,
    proto,
    kind: 'rx',
    status: 'ok',
    msg: { key: 'ap.flood', params: { in: ctx.port(portId).name, count: targets.length } },
  });
  for (const p of targets) ctx.send(p.id, frame, ctx.processingUs);
}

/** Ausgehender Frame des Management-Stacks eines APs: gezielt zum Client oder per Flut. */
export function apXmit(ctx: DeviceCtx, cfg: HostConfig, frame: Frame): void {
  const ap = cfg.ap;
  const ports = ctx.device.ports;
  const flood = isBroadcastMac(frame.dst) || isMulticastMac(frame.dst);
  const known = ap && !flood ? ap.macTable[frame.dst] : undefined;
  if (known && ports.find((p) => p.id === known)?.operUp) {
    ctx.send(known, frame, ctx.processingUs);
    return;
  }
  if (flood) {
    for (const p of ports) if (p.operUp) ctx.send(p.id, frame, ctx.processingUs);
    return;
  }
  const first = ports[0];
  if (first) ctx.send(first.id, frame, ctx.processingUs);
}
