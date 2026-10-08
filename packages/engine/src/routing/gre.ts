import type { Frame, Ipv4Pdu, GrePdu } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { Iface } from '../ifaces';
import {
  eth,
  ifaceFrameRx,
  ipSend,
  newIpPacket,
  type Base,
  type IpNode,
  type XmitIface,
} from '../l3';
import { eth6, ip6FrameRx } from '../l3v6';
import { rlog, type Rt } from './core';

/** Quelladresse des Tunnels: IP der Quellschnittstelle oder die konfigurierte Adresse. */
export function tunnelSrcIp(node: IpNode, iface: Pick<Iface, 'cfg'>): string | undefined {
  const src = iface.cfg.tunnel?.source;
  if (!src) return undefined;
  const l3 = node.l3;
  const ic = l3?.ifaces[src];
  return ic ? ic.ip : src;
}

/** Senden über einen Tunnel: das Paket des Frames wird GRE-gekapselt und normal geroutet. */
export function greXmit(c: DeviceCtx, node: IpNode, iface: XmitIface, frame: Frame): void {
  const inner = frame.payload;
  if (inner.kind !== 'ipv4' && inner.kind !== 'ipv6') return;
  const dst = iface.cfg.tunnel?.destination;
  const src = tunnelSrcIp(node, iface);
  if (!dst || !src) return;
  const gre: GrePdu = { kind: 'gre', protocolType: inner.kind === 'ipv4' ? 0x0800 : 0x86dd, inner };
  const outer = newIpPacket(node, src, dst, gre, { ttl: 255 });
  const r = ipSend(c, node, outer);
  if (!r.ok)
    c.log({
      kind: 'drop',
      proto: 'GRE',
      status: 'drop',
      msg: { key: 'gre.noRoute', params: { dst } },
    });
}

/** Empfang eines GRE-Pakets: auspacken und auf der Tunnel-Schnittstelle weiterverarbeiten. */
export function greRx(rt: Rt, base: Base, ip: Ipv4Pdu, pdu: GrePdu): void {
  const tun = rt.node.ifaces.find(
    (i) =>
      i.kind === 'tunnel' &&
      i.cfg.tunnel?.destination === ip.src &&
      tunnelSrcIp(rt.node, i) === ip.dst,
  );
  if (!tun) {
    rlog(
      rt,
      'GRE',
      { key: 'gre.noTunnel', params: { src: ip.src } },
      { kind: 'drop', status: 'drop' },
    );
    return;
  }
  rlog(
    rt,
    'GRE',
    { key: 'gre.rx', params: { src: ip.src, tunnel: rt.ctx.deviceIfaceName(tun.id) } },
    {
      kind: 'rx',
      status: 'ok',
      debug: {
        tag: 'gre',
        text: () => `GRE: decapsulated packet from ${ip.src} on ${rt.ctx.deviceIfaceName(tun.id)}`,
      },
    },
  );
  if (pdu.inner.kind === 'ipv4') {
    ifaceFrameRx(rt.ctx, rt.node, tun, eth(tun.mac, tun.mac, pdu.inner), base.from);
    return;
  }
  const i6 = rt.node.v6?.ifaces.find((i) => i.id === tun.id);
  if (rt.node.v6 && i6)
    ip6FrameRx(
      rt.ctx,
      { dev: rt.dev, cfg: rt.node.cfg, v6: rt.node.v6, xmit: rt.node.xmit },
      i6,
      eth6(i6.mac, i6.mac, pdu.inner),
      base.from,
    );
}
