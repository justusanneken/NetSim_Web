import {
  isBroadcastMac,
  isMulticastMac,
  pduSize as sizeOf,
  summarizeFrame,
  type DhcpPdu,
  type Frame,
  type ArpPdu,
} from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import { syslogEmit } from '../p5/syslog';
import type {
  DaiCfg,
  DaiVlanStats,
  SnoopCfg,
  StormCfg,
  StormThresh,
  SwitchConfig,
  SwitchPortCfg,
} from '../types';
import { errdisable, lpMembers, lpOf, type SwitchDev } from './switch';

// ------------------------------------------------------------------ Konfiguration

export const defaultSnoop = (): SnoopCfg => ({
  enabled: false,
  vlans: [],
  option82: true,
  verifyMac: true,
  allowUntrusted: false,
  bindings: [],
  stats: { forwarded: 0, macFail: 0, untrustedDrop: 0, opt82Drop: 0, rateDrop: 0 },
});

export const snoopOf = (cfg: SwitchConfig): SnoopCfg => (cfg.snoop ??= defaultSnoop());

export const defaultDai = (): DaiCfg => ({
  vlans: [],
  validate: { srcMac: false, dstMac: false, ip: false },
  acls: {},
  filters: [],
  stats: {},
});

export const daiOf = (cfg: SwitchConfig): DaiCfg => (cfg.dai ??= defaultDai());

export const daiStats = (dai: DaiCfg, vlan: number): DaiVlanStats =>
  (dai.stats[vlan] ??= {
    forwarded: 0,
    dropped: 0,
    dhcpDrops: 0,
    dhcpPermits: 0,
    aclDrops: 0,
    aclPermits: 0,
    srcMacFail: 0,
    dstMacFail: 0,
    ipFail: 0,
  });

/** Standard-Rate für DAI auf untrusted Ports (pps). */
export const DAI_DEFAULT_RATE = 15;

export const snoopActive = (cfg: SwitchConfig, vlan: number): boolean =>
  !!cfg.snoop?.enabled && cfg.snoop.vlans.includes(vlan);

export const daiActive = (cfg: SwitchConfig, vlan: number): boolean =>
  !!cfg.dai && cfg.dai.vlans.includes(vlan);

/** Ablauf der Bindungen berücksichtigen. */
export function liveBindings(cfg: SwitchConfig, now: number): SnoopCfg['bindings'] {
  const sn = cfg.snoop;
  if (!sn) return [];
  sn.bindings = sn.bindings.filter((b) => b.type === 'static' || b.expiresAt > now);
  return sn.bindings;
}

// ------------------------------------------------------------------ Hilfen

const ciscoMac = (mac: string): string => {
  const h = mac.replace(/:/g, '');
  return `${h.slice(0, 4)}.${h.slice(4, 8)}.${h.slice(8, 12)}`;
};

function dhcpOf(frame: Frame): DhcpPdu | undefined {
  const p = frame.payload;
  if (p.kind !== 'ipv4' || p.payload.kind !== 'udp') return undefined;
  const app = p.payload.app;
  return app?.kind === 'dhcp' ? app : undefined;
}

const DHCP_MSG: Record<DhcpPdu['op'], string> = {
  discover: 'DHCPDISCOVER',
  offer: 'DHCPOFFER',
  request: 'DHCPREQUEST',
  ack: 'DHCPACK',
  nak: 'DHCPNAK',
  decline: 'DHCPDECLINE',
  release: 'DHCPRELEASE',
};

type Base = {
  from: string;
  port: ReturnType<DeviceCtx['port']>;
  frame: Frame;
  summary: string;
  proto: ReturnType<typeof summarizeFrame>['proto'];
};

function dropLog(ctx: DeviceCtx, base: Base, key: string, params: Record<string, string | number>) {
  ctx.log({ ...base, kind: 'drop', status: 'drop', msg: { key, params } });
}

/** 1-s-Fenster des Ports (Zähler zurücksetzen, wenn eine neue Sekunde begonnen hat). */
function window(ctx: DeviceCtx, pc: SwitchPortCfg): NonNullable<SwitchPortCfg['rt']> {
  const win = Math.floor(ctx.now / 1_000_000);
  if (!pc.rt || pc.rt.win !== win)
    pc.rt = { win, dhcp: 0, arp: 0, bc: [0, 0], mc: [0, 0], uc: [0, 0] };
  return pc.rt;
}

// ------------------------------------------------------------------ Storm Control

const STORM_NAME = { broadcast: 'Broadcast', multicast: 'Multicast', unicast: 'Unicast' } as const;

function exceeds(t: StormThresh, bytes: number, pkts: number, speedMbps: number): boolean {
  if (t.unit === 'pps') return pkts > t.rising;
  const bps = bytes * 8;
  const limit = t.unit === 'bps' ? t.rising : (t.rising / 100) * speedMbps * 1_000_000;
  return bps > limit;
}

/** Storm-Control auf Eingangsseite. `true` = Frame verwerfen. */
function storm(
  ctx: DeviceCtx,
  dev: SwitchDev,
  portId: string,
  frame: Frame,
  unknownUnicast: boolean,
  base: Base,
): boolean {
  const pc = dev.config.ports[portId] as SwitchPortCfg;
  const sc: StormCfg | undefined = pc.storm;
  if (!sc) return false;
  const cls = isBroadcastMac(frame.dst)
    ? 'broadcast'
    : isMulticastMac(frame.dst)
      ? 'multicast'
      : unknownUnicast
        ? 'unicast'
        : undefined;
  if (!cls) return false;
  const th = sc[cls];
  if (!th) return false;
  const rt = window(ctx, pc);
  const k = cls === 'broadcast' ? 'bc' : cls === 'multicast' ? 'mc' : 'uc';
  rt[k][0] += sizeOf(frame);
  rt[k][1] += 1;
  const speed = ctx.port(portId).operSpeed || 100;
  if (!exceeds(th, rt[k][0], rt[k][1], speed)) return false;
  const name = ctx.port(portId).name;
  if (!rt.stormLogged) {
    rt.stormLogged = true;
    if (sc.action === 'shutdown') {
      syslogEmit(
        ctx,
        dev,
        3,
        'STORM_CONTROL-3-SHUTDOWN',
        `A ${STORM_NAME[cls]} storm detected on ${name}. Interface has been disabled.`,
      );
      ctx.log({
        ...base,
        kind: 'error',
        status: 'drop',
        msg: { key: 'storm.shutdown', params: { port: name, type: STORM_NAME[cls] } },
      });
      errdisable(ctx, dev, portId, 'storm-control');
    } else if (sc.action === 'filter') {
      syslogEmit(
        ctx,
        dev,
        3,
        'STORM_CONTROL-3-FILTERED',
        `A ${STORM_NAME[cls]} storm detected on ${name}. A packet filter action has been applied on the interface.`,
      );
      ctx.log({
        ...base,
        kind: 'error',
        status: 'drop',
        msg: { key: 'storm.filtered', params: { port: name, type: STORM_NAME[cls] } },
      });
    } else
      syslogEmit(
        ctx,
        dev,
        3,
        'STORM_CONTROL-3-TRAP',
        `A ${STORM_NAME[cls]} storm detected on ${name}. A trap has been sent.`,
      );
  }
  // `trap` verwirft nichts; `filter` und `shutdown` verwerfen
  return sc.action !== 'trap';
}

// ------------------------------------------------------------------ DHCP-Snooping

function snoop(
  ctx: DeviceCtx,
  dev: SwitchDev,
  portId: string,
  vlan: number,
  frame: Frame,
  dhcp: DhcpPdu,
  base: Base,
): Frame | undefined {
  const cfg = dev.config;
  const sn = snoopOf(cfg);
  const pc = cfg.ports[portId] as SwitchPortCfg;
  const name = ctx.port(portId).name;
  const serverMsg = dhcp.op === 'offer' || dhcp.op === 'ack' || dhcp.op === 'nak';
  const msg = DHCP_MSG[dhcp.op];
  if (pc.snoopTrust) {
    if (dhcp.op === 'ack') learnBinding(ctx, dev, vlan, dhcp);
    return frame;
  }
  if (serverMsg) {
    sn.stats.untrustedDrop++;
    syslogEmit(
      ctx,
      dev,
      5,
      'DHCP_SNOOPING-5-DHCP_SNOOPING_UNTRUSTED_PORT',
      `DHCP_SNOOPING drop message on untrusted port, message type: ${msg}, MAC sa: ${ciscoMac(frame.src)}`,
    );
    dropLog(ctx, base, 'snoop.untrusted', { port: name, msg });
    return undefined;
  }
  // Rate-Limit (nur für DHCP-Pakete auf diesem Port)
  const rt = window(ctx, pc);
  rt.dhcp++;
  if (pc.snoopRate !== undefined && rt.dhcp > pc.snoopRate) {
    sn.stats.rateDrop++;
    syslogEmit(
      ctx,
      dev,
      4,
      'DHCP_SNOOPING-4-DHCP_SNOOPING_ERRDISABLE_WARNING',
      `DHCP Snooping received ${rt.dhcp} DHCP packets on interface ${name}`,
    );
    syslogEmit(
      ctx,
      dev,
      4,
      'DHCP_SNOOPING-4-DHCP_SNOOPING_RATE_LIMIT_EXCEEDED',
      `The interface ${name} is receiving more than the threshold set`,
    );
    dropLog(ctx, base, 'snoop.rate', { port: name, rate: pc.snoopRate });
    errdisable(ctx, dev, portId, 'dhcp-rate-limit');
    return undefined;
  }
  if (!sn.allowUntrusted && (dhcp.options.opt82 || dhcp.giaddr !== '0.0.0.0')) {
    sn.stats.opt82Drop++;
    syslogEmit(
      ctx,
      dev,
      5,
      'DHCP_SNOOPING-5-DHCP_SNOOPING_NONZERO_GIADDR',
      `DHCP_SNOOPING drop message with non-zero giaddr or option82 value on untrusted port, message type: ${msg}, MAC sa: ${ciscoMac(frame.src)}`,
    );
    dropLog(ctx, base, 'snoop.opt82', { port: name, msg });
    return undefined;
  }
  if (sn.verifyMac && dhcp.chaddr !== frame.src) {
    sn.stats.macFail++;
    syslogEmit(
      ctx,
      dev,
      5,
      'DHCP_SNOOPING-5-DHCP_SNOOPING_MATCH_MAC_FAIL',
      `DHCP_SNOOPING drop message because the chaddr doesn't match source mac, message type: ${msg}, chaddr: ${ciscoMac(dhcp.chaddr)}, MAC sa: ${ciscoMac(frame.src)}`,
    );
    dropLog(ctx, base, 'snoop.macFail', { port: name, msg });
    return undefined;
  }
  if (dhcp.op === 'release' || dhcp.op === 'decline') {
    const b = sn.bindings.find((x) => x.mac === dhcp.chaddr && x.vlan === vlan);
    if (b && b.portId !== lpOf(cfg, portId)) {
      sn.stats.untrustedDrop++;
      syslogEmit(
        ctx,
        dev,
        5,
        'DHCP_SNOOPING-5-DHCP_SNOOPING_UNTRUSTED_PORT',
        `DHCP_SNOOPING drop message on untrusted port, message type: ${msg}, MAC sa: ${ciscoMac(frame.src)}`,
      );
      dropLog(ctx, base, 'snoop.untrusted', { port: name, msg });
      return undefined;
    }
    if (b) sn.bindings = sn.bindings.filter((x) => x !== b);
  }
  sn.stats.forwarded++;
  if (!sn.option82) return frame;
  // Option 82 einfügen (Circuit-ID = VLAN + Port, Remote-ID = Switch-MAC)
  const out = structuredClone(frame);
  const d = dhcpOf(out);
  if (d)
    d.options.opt82 = {
      circuitId: `${vlan}:${name}`,
      remoteId: dev.ports[0]?.mac ?? '',
    };
  return out;
}

function learnBinding(ctx: DeviceCtx, dev: SwitchDev, vlan: number, dhcp: DhcpPdu): void {
  const cfg = dev.config;
  const sn = snoopOf(cfg);
  const e = cfg.macTable[`${vlan}|${dhcp.chaddr}`];
  if (!e) return;
  const lease = dhcp.options.leaseSec ?? 86400;
  sn.bindings = sn.bindings.filter((b) => !(b.mac === dhcp.chaddr && b.vlan === vlan));
  sn.bindings.push({
    mac: dhcp.chaddr,
    ip: dhcp.yiaddr,
    vlan,
    portId: e.portId,
    expiresAt: ctx.now + lease * 1_000_000,
    type: 'dhcp-snooping',
  });
}

// ------------------------------------------------------------------ Dynamic ARP Inspection

function dai(
  ctx: DeviceCtx,
  dev: SwitchDev,
  portId: string,
  vlan: number,
  frame: Frame,
  arp: ArpPdu,
  base: Base,
): boolean {
  const cfg = dev.config;
  const d = daiOf(cfg);
  const pc = cfg.ports[portId] as SwitchPortCfg;
  if (pc.daiTrust) return false;
  const st = daiStats(d, vlan);
  const name = ctx.port(portId).name;
  const rt = window(ctx, pc);
  rt.arp++;
  const limit = pc.daiRate ?? DAI_DEFAULT_RATE;
  if (limit > 0 && rt.arp > limit) {
    syslogEmit(
      ctx,
      dev,
      4,
      'SW_DAI-4-PACKET_RATE_EXCEEDED',
      `${rt.arp} packets received in ${(pc.daiBurst ?? 1) * 1000} milliseconds on ${name}.`,
    );
    st.dropped++;
    dropLog(ctx, base, 'dai.rate', { port: name, count: rt.arp });
    errdisable(ctx, dev, portId, 'arp-inspection');
    return true;
  }
  const isReq = arp.op === 'request';
  const deny = (why: 'dhcp' | 'acl' | 'srcMac' | 'dstMac' | 'ip'): true => {
    st.dropped++;
    if (why === 'dhcp') st.dhcpDrops++;
    else if (why === 'acl') st.aclDrops++;
    else if (why === 'srcMac') st.srcMacFail++;
    else if (why === 'dstMac') st.dstMacFail++;
    else st.ipFail++;
    const tag =
      why === 'srcMac'
        ? 'SW_DAI-4-SRC_MAC_VALIDATION_FAILED'
        : why === 'dstMac'
          ? 'SW_DAI-4-DST_MAC_VALIDATION_FAILED'
          : why === 'ip'
            ? 'SW_DAI-4-INVALID_ARP'
            : why === 'acl'
              ? 'SW_DAI-4-ACL_DENY'
              : 'SW_DAI-4-DHCP_SNOOPING_DENY';
    const label =
      why === 'srcMac' || why === 'dstMac' || why === 'ip' ? `Invalid ARPs` : `Invalid ARPs`;
    syslogEmit(
      ctx,
      dev,
      4,
      tag,
      `1 ${label} (${isReq ? 'Req' : 'Res'}) on ${name}, vlan ${vlan}.([${ciscoMac(arp.senderMac)}/${arp.senderIp}/${ciscoMac(arp.targetMac)}/${arp.targetIp}/${new Date(0).toISOString().slice(11, 19)} UTC])`,
    );
    dropLog(ctx, base, `dai.${why}`, { port: name, vlan, ip: arp.senderIp, mac: arp.senderMac });
    return true;
  };
  if (d.validate.srcMac && arp.senderMac !== frame.src) return deny('srcMac');
  if (d.validate.dstMac && !isReq && arp.targetMac !== frame.dst) return deny('dstMac');
  if (d.validate.ip) {
    const bad = (ip: string): boolean =>
      ip === '0.0.0.0' || ip === '255.255.255.255' || /^2(2[4-9]|3\d)\./.test(ip);
    if (bad(arp.senderIp) || (!isReq && bad(arp.targetIp))) return deny('ip');
  }
  // ARP-ACL (statisch) und DHCP-Bindings
  const filt = d.filters.find((f) => f.vlan === vlan);
  if (filt) {
    const acl = d.acls[filt.acl] ?? [];
    if (acl.some((e) => e.ip === arp.senderIp && e.mac === arp.senderMac)) {
      st.aclPermits++;
      st.forwarded++;
      return false;
    }
    if (filt.static) return deny('acl');
  }
  const b = liveBindings(cfg, ctx.now).find(
    (x) => x.vlan === vlan && x.mac === arp.senderMac && x.ip === arp.senderIp,
  );
  if (!b) return deny('dhcp');
  st.dhcpPermits++;
  st.forwarded++;
  return false;
}

// ------------------------------------------------------------------ Einstieg

/**
 * Eingangsprüfungen: Storm-Control, DHCP-Snooping, DAI. Liefert den (ggf. veränderten) Frame
 * oder `undefined` bei Verwurf.
 */
export function securityIngress(
  ctx: DeviceCtx,
  dev: SwitchDev,
  portId: string,
  vlan: number,
  frame: Frame,
  base: Base,
): Frame | undefined {
  const cfg = dev.config;
  const pc = cfg.ports[portId] as SwitchPortCfg;
  if (pc.storm) {
    const unknown =
      !isMulticastMac(frame.dst) && !cfg.macTable[`${vlan}|${frame.dst}`] && frame.dst !== '';
    if (storm(ctx, dev, portId, frame, unknown, base)) return undefined;
  }
  let out: Frame | undefined = frame;
  const dhcp = dhcpOf(frame);
  if (dhcp && snoopActive(cfg, vlan)) {
    out = snoop(ctx, dev, portId, vlan, frame, dhcp, base);
    if (!out) return undefined;
  }
  if (frame.payload.kind === 'arp' && daiActive(cfg, vlan)) {
    if (dai(ctx, dev, portId, vlan, frame, frame.payload, base)) return undefined;
  }
  return out;
}

export { lpMembers };
