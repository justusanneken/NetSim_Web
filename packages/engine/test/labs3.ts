import { Engine, type Device, type L3Cfg, type RouterConfig, type SwitchConfig } from '../src';
import { converge } from './helpers';

export const ok = (r: { ok: boolean; error?: string }): void => {
  if (!r.ok) throw new Error(r.error);
};

export const dev = (e: Engine, id: string): Device => e.getDevice(id) as Device;
export const swCfg = (e: Engine, id: string): SwitchConfig => dev(e, id).config as SwitchConfig;
export const rtCfg = (e: Engine, id: string): RouterConfig => dev(e, id).config as RouterConfig;
export const l3Cfg = (e: Engine, id: string): L3Cfg => dev(e, id).config as unknown as L3Cfg;

export function link(e: Engine, a: string, ap: string, b: string, bp: string, cable: 'straight' | 'crossover' = 'straight'): void {
  ok(e.connect({ deviceId: a, portId: ap }, { deviceId: b, portId: bp }, cable));
}

export function host(e: Engine, name: string, ip: string, gw?: string, mask = '255.255.255.0'): string {
  const id = e.addDevice('pc', { name });
  if (ip) ok(e.setHostIp(id, ip, mask, gw));
  return id;
}

export const pingStatus = (e: Engine, id: string, idx = -1): string | undefined => {
  const c = dev(e, id).config;
  if (c.kind !== 'host' && c.kind !== 'router' && c.kind !== 'switch') return undefined;
  return c.pings.at(idx)?.status;
};

export function ping(e: Engine, from: string, dst: string, opts?: Parameters<Engine['ping']>[2]): string | undefined {
  const r = e.ping(from, dst, opts);
  if (!r.ok) return r.error;
  e.runAll();
  return pingStatus(e, from);
}

export function noShut(e: Engine, id: string, ...ports: string[]): void {
  for (const p of ports) e.setPortAdmin(id, p, true);
}

/** Zählt Ports, die in irgendeiner VLAN-Instanz nicht im Forwarding-Zustand sind. */
export function blockedPorts(e: Engine, vlan = 1): { dev: string; port: string; state: string }[] {
  const out: { dev: string; port: string; state: string }[] = [];
  for (const d of Object.values(e.state.devices)) {
    if (d.config.kind !== 'switch') continue;
    const inst = d.config.stp.instances[vlan];
    for (const [lp, ps] of Object.entries(inst?.ports ?? {})) {
      if (ps.state !== 'forwarding') out.push({ dev: d.name, port: lp, state: ps.state });
    }
  }
  return out;
}

export { converge };
