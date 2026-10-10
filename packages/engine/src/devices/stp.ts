import { MAC_PVST, MAC_STP, ETHERTYPE, type BpduPdu, type Frame } from '@netsim/protocols';
import type { DeviceCtx } from '../ctx';
import type { Base } from '../l3';
import { syslogEmit } from '../p5/syslog';
import type { StpInstance, StpPortState } from '../types';
import {
  carriesVlan,
  errdisable,
  flushMacs,
  isBpduguard,
  isPortfast,
  logicalPorts,
  lpMembers,
  lpOf,
  type SwitchDev,
} from './switch';

const HELLO = 2_000_000;
const MAX_AGE = 20_000_000;
const FWD_DELAY = 15_000_000;
const RAPID_FALLBACK = 6_000_000;

export const bridgeId = (dev: SwitchDev, vlan: number): string =>
  `${String((dev.config.stp.priority[vlan] ?? 32768) + vlan).padStart(5, '0')}.${dev.ports[0]?.mac ?? ''}`;

const isRstp = (dev: SwitchDev): boolean => dev.config.stp.mode === 'rapid-pvst';

function portIdOf(dev: SwitchDev, lp: string): string {
  const first = lpMembers(dev.config, lp)[0] ?? lp;
  const idx = dev.ports.findIndex((p) => p.id === first);
  return `128.${String(idx + 1).padStart(3, '0')}`;
}

function portCost(dev: SwitchDev, lp: string): number {
  const speed = lpMembers(dev.config, lp).reduce(
    (a, id) => a + (dev.ports.find((p) => p.id === id)?.operSpeed ?? 0),
    0,
  );
  return speed >= 10000
    ? 2
    : speed >= 2000
      ? 3
      : speed >= 1000
        ? 4
        : speed >= 200
          ? 12
          : speed >= 100
            ? 19
            : 100;
}

function instanceOf(dev: SwitchDev, vlan: number): StpInstance {
  const stp = dev.config.stp;
  return (stp.instances[vlan] ??= {
    vlan,
    rootId: bridgeId(dev, vlan),
    rootCost: 0,
    ports: {},
    tcUntil: 0,
  });
}

export function stpForwarding(cfg: SwitchDev['config'], vlan: number, lp: string): boolean {
  const ps = cfg.stp.instances[vlan]?.ports[lp];
  return ps === undefined ? true : ps.state === 'forwarding';
}
export function stpLearning(cfg: SwitchDev['config'], vlan: number, lp: string): boolean {
  const ps = cfg.stp.instances[vlan]?.ports[lp];
  return ps === undefined ? true : ps.state === 'forwarding' || ps.state === 'learning';
}

// ------------------------------------------------------------------ Vektoren

interface Vec {
  root: string;
  cost: number;
  bridge: string;
  port: string;
}
const cmp = (a: Vec, b: Vec): number =>
  a.root.localeCompare(b.root) ||
  a.cost - b.cost ||
  a.bridge.localeCompare(b.bridge) ||
  a.port.localeCompare(b.port);

const roleText = {
  root: 'root',
  designated: 'designated',
  alternate: 'alternate',
  disabled: 'disabled',
} as const;

function logState(ctx: DeviceCtx, dev: SwitchDev, vlan: number, lp: string, key: string): void {
  const ps = instanceOf(dev, vlan).ports[lp] as StpPortState;
  const name = lp.startsWith('po')
    ? `Po${lp.slice(2)}`
    : (dev.ports.find((p) => p.id === lp)?.name ?? lp);
  ctx.log({
    kind: 'info',
    proto: 'STP',
    status: 'info',
    msg: { key, params: { port: name, vlan, role: ps.role, state: ps.state } },
  });
}

function topologyChange(ctx: DeviceCtx, dev: SwitchDev, vlan: number): void {
  const inst = instanceOf(dev, vlan);
  inst.tcUntil = ctx.now + MAX_AGE + FWD_DELAY;
  flushMacs(dev.config, { vlan });
}

function setState(
  ctx: DeviceCtx,
  dev: SwitchDev,
  vlan: number,
  lp: string,
  state: StpPortState['state'],
): void {
  const ps = instanceOf(dev, vlan).ports[lp] as StpPortState;
  if (ps.state === state) return;
  const wasFwd = ps.state === 'forwarding';
  ps.state = state;
  ps.nextAt = undefined;
  if (wasFwd || state === 'forwarding') {
    if (!ps.edge) topologyChange(ctx, dev, vlan);
    if (wasFwd) flushMacs(dev.config, { vlan, lp });
  }
  logState(ctx, dev, vlan, lp, 'stp.state');
}

// ------------------------------------------------------------------ Neuberechnung

function recompute(ctx: DeviceCtx, dev: SwitchDev, vlan: number): void {
  const cfg = dev.config;
  const inst = instanceOf(dev, vlan);
  const own = bridgeId(dev, vlan);
  const lps = logicalPorts(dev).filter((lp) => carriesVlan(cfg, lp, vlan));
  // Ports anlegen / entfernen
  for (const lp of Object.keys(inst.ports)) if (!lps.includes(lp)) delete inst.ports[lp];
  for (const lp of lps) {
    if (inst.ports[lp]) continue;
    const first = lpMembers(cfg, lp)[0] as string;
    const edge = !lp.startsWith('po') && isPortfast(cfg, first) && !cfg.operTrunk[first];
    const fresh: StpPortState = { role: 'designated', state: 'discarding', edge };
    if (edge) fresh.state = 'forwarding';
    else if (isRstp(dev)) {
      fresh.proposing = true;
      fresh.nextAt = ctx.now + RAPID_FALLBACK;
    } else {
      fresh.state = 'listening';
      fresh.nextAt = ctx.now + FWD_DELAY;
    }
    inst.ports[lp] = fresh;
  }
  // PortFast-Konfiguration kann sich nachträglich geändert haben
  for (const lp of lps) {
    const ps = inst.ports[lp] as StpPortState;
    const first = lpMembers(cfg, lp)[0] as string;
    const want =
      !lp.startsWith('po') && isPortfast(cfg, first) && !cfg.operTrunk[first] && !ps.edgeBroken;
    if (want === ps.edge) continue;
    ps.edge = want;
    ps.proposing = false;
    if (want) {
      ps.role = 'designated';
      ps.nextAt = undefined;
      setState(ctx, dev, vlan, lp, 'forwarding');
    } else {
      ps.state = isRstp(dev) ? 'discarding' : 'listening';
      ps.nextAt = ctx.now + (isRstp(dev) ? RAPID_FALLBACK : FWD_DELAY);
    }
  }
  // Root bestimmen
  let best: { vec: Vec; lp: string } | undefined;
  for (const lp of lps) {
    const ps = inst.ports[lp] as StpPortState;
    if (!ps.info || ps.edge) continue;
    const first = lpMembers(cfg, lp)[0] as string;
    if (cfg.ports[first]?.rootguard && ps.info.rootId < own) continue;
    const vec = {
      root: ps.info.rootId,
      cost: ps.info.cost + portCost(dev, lp),
      bridge: ps.info.bridgeId,
      port: ps.info.portId,
    };
    if (!best || cmp(vec, best.vec) < 0 || (cmp(vec, best.vec) === 0 && lp < best.lp))
      best = { vec, lp };
  }
  const oldRoot = inst.rootId;
  const oldRootPort = inst.rootPort;
  if (best && best.vec.root < own) {
    inst.rootId = best.vec.root;
    inst.rootCost = best.vec.cost;
    inst.rootPort = best.lp;
  } else {
    inst.rootId = own;
    inst.rootCost = 0;
    inst.rootPort = undefined;
  }
  if (oldRoot !== inst.rootId) {
    ctx.log({
      kind: 'info',
      proto: 'STP',
      status: 'info',
      msg: {
        key: inst.rootId === own ? 'stp.rootSelf' : 'stp.rootChanged',
        params: { vlan, root: inst.rootId },
      },
    });
  }
  // Rollen
  for (const lp of lps) {
    const ps = inst.ports[lp] as StpPortState;
    const first = lpMembers(cfg, lp)[0] as string;
    let role: StpPortState['role'];
    if (lp === inst.rootPort) role = 'root';
    else if (ps.info && !ps.edge) {
      const mine: Vec = {
        root: inst.rootId,
        cost: inst.rootCost,
        bridge: own,
        port: portIdOf(dev, lp),
      };
      const theirs: Vec = {
        root: ps.info.rootId,
        cost: ps.info.cost,
        bridge: ps.info.bridgeId,
        port: ps.info.portId,
      };
      role = cmp(mine, theirs) < 0 ? 'designated' : 'alternate';
      if (cfg.ports[first]?.rootguard && ps.info.rootId < own) role = 'designated';
    } else role = 'designated';
    if (role === ps.role) continue;
    const from = ps.role;
    ps.role = role;
    ps.proposing = false;
    ps.synced = false;
    logState(ctx, dev, vlan, lp, 'stp.role');
    if (role === 'alternate') {
      setState(ctx, dev, vlan, lp, 'discarding');
    } else if (ps.edge) {
      setState(ctx, dev, vlan, lp, 'forwarding');
    } else if (isRstp(dev)) {
      // RSTP: Root-Port nach Sync sofort; Designated: Proposal/Agreement
      if (role === 'designated') {
        if (ps.state === 'forwarding' && from === 'designated') continue;
        ps.state = ps.state === 'forwarding' ? 'forwarding' : 'discarding';
        ps.proposing = ps.state !== 'forwarding';
        if (ps.proposing) ps.nextAt = ctx.now + RAPID_FALLBACK;
      } else if (ps.state !== 'forwarding') {
        ps.nextAt = ctx.now + RAPID_FALLBACK;
      }
    } else if (ps.state === 'discarding') {
      ps.state = 'listening';
      ps.nextAt = ctx.now + FWD_DELAY;
      logState(ctx, dev, vlan, lp, 'stp.state');
    }
  }
  if (oldRootPort !== inst.rootPort || oldRoot !== inst.rootId) flushMacs(cfg, { vlan });
}

/** Ports/VLANs/Trunks haben sich geändert: Instanzen neu aufbauen. */
export function stpPortsChanged(ctx: DeviceCtx, dev: SwitchDev): void {
  const cfg = dev.config;
  for (const vlan of Object.keys(cfg.vlans).map(Number)) recompute(ctx, dev, vlan);
  for (const v of Object.keys(cfg.stp.instances).map(Number)) {
    if (!cfg.vlans[v]) delete cfg.stp.instances[v];
  }
}

export function stpPortDown(ctx: DeviceCtx, dev: SwitchDev, lp: string): void {
  for (const inst of Object.values(dev.config.stp.instances)) {
    if (inst.ports[lp]) delete inst.ports[lp];
  }
  void ctx;
}

// ------------------------------------------------------------------ BPDU senden

function frameFor(
  dev: SwitchDev,
  vlan: number,
  lp: string,
  bpdu: BpduPdu,
): { portId: string; frame: Frame } | undefined {
  const members = lpMembers(dev.config, lp).filter(
    (id) => dev.ports.find((p) => p.id === id)?.operUp,
  );
  const portId = members[0];
  if (!portId) return undefined;
  const pc = dev.config.ports[portId];
  const trunk = dev.config.operTrunk[portId];
  const tagged = trunk && vlan !== pc?.nativeVlan;
  const src = dev.ports.find((p) => p.id === portId)?.mac ?? '';
  return {
    portId,
    frame: {
      kind: 'ethernet',
      src,
      dst: tagged || vlan !== 1 ? MAC_PVST : MAC_STP,
      etherType: ETHERTYPE.stp,
      vlan: tagged ? { vid: vlan, pcp: 6 } : undefined,
      payload: bpdu,
    },
  };
}

function sendBpdu(
  ctx: DeviceCtx,
  dev: SwitchDev,
  vlan: number,
  lp: string,
  extra: Partial<BpduPdu['flags']> = {},
): void {
  const inst = instanceOf(dev, vlan);
  const ps = inst.ports[lp] as StpPortState;
  const bpdu: BpduPdu = {
    kind: 'bpdu',
    rstp: isRstp(dev),
    vlan,
    rootId: inst.rootId,
    rootCost: inst.rootCost,
    bridgeId: bridgeId(dev, vlan),
    portId: portIdOf(dev, lp),
    flags: {
      proposal: !!ps.proposing && ps.role === 'designated',
      agreement: false,
      topologyChange: inst.tcUntil > ctx.now,
      role: ps.role === 'disabled' ? 'unknown' : ps.role,
      ...extra,
    },
  };
  const f = frameFor(dev, vlan, lp, bpdu);
  if (f) ctx.send(f.portId, f.frame, 0);
}

export function stpHello(ctx: DeviceCtx, dev: SwitchDev): void {
  for (const [v, inst] of Object.entries(dev.config.stp.instances)) {
    for (const [lp, ps] of Object.entries(inst.ports)) {
      if (ps.role === 'designated') sendBpdu(ctx, dev, Number(v), lp);
    }
  }
}

// ------------------------------------------------------------------ BPDU empfangen

export function stpRx(
  ctx: DeviceCtx,
  dev: SwitchDev,
  portId: string,
  lp: string,
  vlan: number,
  b: BpduPdu,
  base: Base,
): void {
  const cfg = dev.config;
  const pc = cfg.ports[portId];
  if (!pc) return;
  const inst = instanceOf(dev, vlan);
  let ps = inst.ports[lp];
  if (!ps) {
    recompute(ctx, dev, vlan);
    ps = inst.ports[lp];
    if (!ps) return;
  }
  const local = !cfg.operTrunk[portId];
  if (ps.edge && local) {
    if (isBpduguard(cfg, portId)) {
      syslogEmit(
        ctx,
        dev,
        2,
        'SPANTREE-2-BLOCK_BPDUGUARD',
        `Received BPDU on port ${base.port?.name ?? portId} with BPDU Guard enabled. Disabling port.`,
      );
      ctx.log({
        ...base,
        kind: 'error',
        status: 'error',
        msg: { key: 'stp.bpduGuard', params: { port: base.port?.name ?? portId } },
      });
      errdisable(ctx, dev, portId, 'bpduguard');
      return;
    }
    ps.edge = false; // PortFast wird betrieblich deaktiviert
    ps.edgeBroken = true;
    ps.state = isRstp(dev) ? 'discarding' : 'listening';
    ps.nextAt = ctx.now + (isRstp(dev) ? RAPID_FALLBACK : FWD_DELAY);
  }
  const incoming: StpPortState['info'] = {
    rootId: b.rootId,
    cost: b.rootCost,
    bridgeId: b.bridgeId,
    portId: b.portId,
    rstp: b.rstp,
  };
  const old = ps.info;
  const sameSender = old && old.bridgeId === b.bridgeId && old.portId === b.portId;
  const inc: Vec = { root: b.rootId, cost: b.rootCost, bridge: b.bridgeId, port: b.portId };
  const oldVec: Vec | undefined = old && {
    root: old.rootId,
    cost: old.cost,
    bridge: old.bridgeId,
    port: old.portId,
  };
  if (!old || sameSender || (oldVec && cmp(inc, oldVec) <= 0)) {
    ps.info = incoming;
    ps.infoAt = ctx.now;
  }
  const before = JSON.stringify([
    inst.rootId,
    inst.rootPort,
    ...Object.values(inst.ports).map((x) => x.role),
  ]);
  recompute(ctx, dev, vlan);
  const changed =
    before !==
    JSON.stringify([inst.rootId, inst.rootPort, ...Object.values(inst.ports).map((x) => x.role)]);
  if (changed) {
    ctx.log({
      ...base,
      kind: 'rx',
      proto: 'STP',
      status: 'info',
      msg: { key: 'stp.bpdu', params: { vlan, root: b.rootId, cost: b.rootCost } },
    });
  }
  // Topologieänderung
  if (b.flags.topologyChange && lp === inst.rootPort && inst.tcUntil <= ctx.now)
    topologyChange(ctx, dev, vlan);
  // RSTP: Proposal / Agreement
  if (isRstp(dev) && b.rstp) {
    if (b.flags.proposal && ps.role === 'root') {
      for (const [other, ops] of Object.entries(inst.ports)) {
        if (other === lp || ops.edge || ops.role === 'alternate') continue;
        if (ops.role === 'designated' && ops.state === 'forwarding') {
          ops.state = 'discarding';
          ops.proposing = true;
          ops.nextAt = ctx.now + RAPID_FALLBACK;
          flushMacs(cfg, { vlan, lp: other });
          logState(ctx, dev, vlan, other, 'stp.state');
        }
      }
      if (ps.state !== 'forwarding') setState(ctx, dev, vlan, lp, 'forwarding');
      sendBpdu(ctx, dev, vlan, lp, { agreement: true, proposal: false, role: 'root' });
    }
    if (b.flags.agreement && ps.role === 'designated' && ps.proposing) {
      ps.proposing = false;
      ps.nextAt = undefined;
      setState(ctx, dev, vlan, lp, 'forwarding');
    }
  }
  // Neue Designated-Ports erhalten sofort ein BPDU (Proposal)
  for (const [other, ops] of Object.entries(inst.ports)) {
    if (ops.role === 'designated' && ops.proposing && other !== lp) sendBpdu(ctx, dev, vlan, other);
  }
}

// ------------------------------------------------------------------ Zeitgeber

export function stpTick(ctx: DeviceCtx, dev: SwitchDev): void {
  const rstp = isRstp(dev);
  for (const [v, inst] of Object.entries(dev.config.stp.instances)) {
    const vlan = Number(v);
    let again = false;
    for (const [lp, ps] of Object.entries(inst.ports)) {
      if (
        ps.info &&
        ps.infoAt !== undefined &&
        ctx.now - ps.infoAt > (rstp ? 3 * HELLO : MAX_AGE)
      ) {
        ps.info = undefined;
        ps.infoAt = undefined;
        again = true;
      }
      if (ps.nextAt !== undefined && ctx.now >= ps.nextAt) {
        if (rstp) {
          ps.nextAt = undefined;
          ps.proposing = false;
          if (ps.role !== 'alternate' && ps.state !== 'forwarding')
            setState(ctx, dev, vlan, lp, 'forwarding');
        } else if (ps.state === 'listening') {
          ps.state = 'learning';
          ps.nextAt = ctx.now + FWD_DELAY;
          logState(ctx, dev, vlan, lp, 'stp.state');
        } else if (ps.state === 'learning') {
          ps.nextAt = undefined;
          setState(ctx, dev, vlan, lp, 'forwarding');
        }
      }
    }
    if (again) recompute(ctx, dev, vlan);
  }
}

export { lpOf, roleText };
