import { ETHERTYPE, MAC_VTP, type Frame, type VtpPdu } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { Base } from '../l3';
import { flushMacs, type SwitchDev } from './switch';
import { stpPortsChanged } from './stp';

function advert(dev: SwitchDev): VtpPdu {
  const cfg = dev.config;
  return {
    kind: 'vtp',
    domain: cfg.vtp.domain,
    revision: cfg.vtp.revision,
    vlans: Object.entries(cfg.vlans).map(([id, v]) => ({ id: Number(id), name: v.name })),
  };
}

/** VTP-Advertisement auf allen (oder allen außer einem) Trunk-Ports senden. */
export function vtpSend(ctx: DeviceCtx, dev: SwitchDev, except?: string, msg: VtpPdu = advert(dev)): void {
  const cfg = dev.config;
  if (cfg.vtp.mode === 'transparent' && msg.domain === cfg.vtp.domain && except === undefined) return;
  for (const p of dev.ports) {
    if (p.id === except || !p.operUp || !cfg.operTrunk[p.id]) continue;
    const frame: Frame = { kind: 'ethernet', src: p.mac, dst: MAC_VTP, etherType: ETHERTYPE.vtp, payload: msg };
    ctx.send(p.id, frame, ctx.processingUs);
  }
}

export function vtpTimer(ctx: DeviceCtx, dev: SwitchDev, name: string): void {
  if (name === 'vtp:periodic' && dev.config.vtp.mode !== 'transparent' && dev.config.vtp.domain) vtpSend(ctx, dev);
}

export function vtpRx(ctx: DeviceCtx, dev: SwitchDev, portId: string, m: VtpPdu, base: Base): void {
  const cfg = dev.config;
  const vtp = cfg.vtp;
  if (vtp.mode === 'transparent') {
    vtpSend(ctx, dev, portId, m); // nur weiterreichen
    return;
  }
  if (vtp.domain === '') {
    vtp.domain = m.domain;
    ctx.log({ ...base, kind: 'info', proto: 'VTP', status: 'info', msg: { key: 'vtp.domainLearned', params: { domain: m.domain } } });
  }
  if (m.domain !== vtp.domain || m.revision <= vtp.revision) return;
  cfg.vlans = Object.fromEntries(m.vlans.map((v) => [v.id, { name: v.name }]));
  vtp.revision = m.revision;
  flushMacs(cfg);
  ctx.log({
    ...base,
    kind: 'info',
    proto: 'VTP',
    status: 'ok',
    msg: { key: 'vtp.updated', params: { revision: m.revision, count: m.vlans.length } },
  });
  stpPortsChanged(ctx, dev);
  vtpSend(ctx, dev, portId);
}
