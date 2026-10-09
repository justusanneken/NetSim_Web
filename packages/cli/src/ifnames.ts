import type { ModeId } from './parser';
import type { Device } from '@netsim/engine';
import { resolvePort, shortName } from './format';

export interface IfRef {
  /** Engine-ID: Port (`p0`), Subinterface (`p0.10`), SVI (`vlan10`) oder Port-Channel (`po1`). */
  id: string;
  kind: 'phys' | 'sub' | 'svi' | 'po' | 'loop' | 'tunnel' | 'dialer' | 'vtemplate';
}

/** `gi0/0`, `gi0/0.10`, `vlan10`, `po1` → Referenz. */
export function resolveIface(dev: Device, text: string): IfRef | undefined {
  const t = text.replace(/\s+/g, '');
  const loop = /^(?:loopback|lo)(\d{1,4})$/i.exec(t);
  if (loop && dev.config.kind !== 'hub') return { id: `lo${Number(loop[1])}`, kind: 'loop' };
  const tun = /^(?:tunnel|tu)(\d{1,4})$/i.exec(t);
  if (tun && dev.config.kind === 'router') return { id: `tu${Number(tun[1])}`, kind: 'tunnel' };
  const dia = /^(?:dialer|di)(\d{1,4})$/i.exec(t);
  if (dia && dev.config.kind === 'router') return { id: `di${Number(dia[1])}`, kind: 'dialer' };
  const vt = /^(?:virtual-template|vt)(\d{1,4})$/i.exec(t);
  if (vt && dev.config.kind === 'router') return { id: `vt${Number(vt[1])}`, kind: 'vtemplate' };
  const svi = /^vlan(\d{1,4})$/i.exec(t);
  if (svi && dev.config.kind === 'switch') return { id: `vlan${Number(svi[1])}`, kind: 'svi' };
  const po = /^(?:po|port-channel)(\d{1,3})$/i.exec(t);
  if (po && dev.config.kind === 'switch') return { id: `po${Number(po[1])}`, kind: 'po' };
  const sub = /^(.*)\.(\d{1,4})$/.exec(t);
  if (sub) {
    const p = resolvePort(dev.ports, sub[1] as string);
    return p && dev.config.kind === 'router'
      ? { id: `${p.id}.${Number(sub[2])}`, kind: 'sub' }
      : undefined;
  }
  const p = resolvePort(dev.ports, t);
  return p ? { id: p.id, kind: 'phys' } : undefined;
}

/** `interface range fa0/1 - 5 , fa0/8 - fa0/9` → Portliste. */
export function resolveRange(dev: Device, text: string): IfRef[] | undefined {
  const out: IfRef[] = [];
  for (const part of text.split(',')) {
    const m = /^\s*(\S+)\s*(?:-\s*(\S+))?\s*$/.exec(part);
    if (!m) return undefined;
    const a = resolveIface(dev, m[1] as string);
    if (!a || a.kind !== 'phys') return undefined;
    if (!m[2]) {
      out.push(a);
      continue;
    }
    const pa = dev.ports.findIndex((p) => p.id === a.id);
    const endText = /^\d+$/.test(m[2]) ? (dev.ports[pa]?.name ?? '').replace(/\d+$/, m[2]) : m[2];
    const b = resolveIface(dev, endText);
    const pb = dev.ports.findIndex((p) => p.id === b?.id);
    if (!b || pb < pa) return undefined;
    for (let i = pa; i <= pb; i++)
      out.push({ id: (dev.ports[i] as { id: string }).id, kind: 'phys' });
  }
  return out;
}

export function ifDisplay(dev: Device, id: string): string {
  if (/^lo\d+$/.test(id)) return `Loopback${id.slice(2)}`;
  if (/^tu\d+$/.test(id)) return `Tunnel${id.slice(2)}`;
  if (/^di\d+$/.test(id)) return `Dialer${id.slice(2)}`;
  if (/^vt\d+$/.test(id)) return `Virtual-Template${id.slice(2)}`;
  if (/^va\d+$/.test(id)) return `Virtual-Access${id.slice(2)}`;
  if (id.startsWith('vlan')) return `Vlan${id.slice(4)}`;
  if (id.startsWith('po')) return `Port-channel${id.slice(2)}`;
  const [pid, vlan] = id.split('.');
  const name = dev.ports.find((p) => p.id === pid)?.name ?? id;
  return vlan ? `${name}.${vlan}` : name;
}

export const ifShort = (dev: Device, id: string): string =>
  /^lo\d+$/.test(id)
    ? `Lo${id.slice(2)}`
    : /^tu\d+$/.test(id)
      ? `Tu${id.slice(2)}`
      : /^di\d+$/.test(id)
        ? `Di${id.slice(2)}`
        : /^va\d+$/.test(id)
          ? `Vi${id.slice(2)}`
          : id.startsWith('vlan')
            ? `Vl${id.slice(4)}`
            : id.startsWith('po')
              ? `Po${id.slice(2)}`
              : shortName(ifDisplay(dev, id));

/** 1,3,5-7 → [1,3,5,6,7] */
export function parseVlanList(text: string): number[] {
  const out: number[] = [];
  for (const part of text.split(',')) {
    const [a, b] = part.split('-').map(Number);
    if (a === undefined || Number.isNaN(a)) continue;
    for (let v = a; v <= (b ?? a); v++) out.push(v);
  }
  return out;
}

/** [1,2,3,7] → `1-3,7` */
export function compressVlans(vlans: number[]): string {
  const v = [...new Set(vlans)].sort((x, y) => x - y);
  const parts: string[] = [];
  for (let i = 0; i < v.length;) {
    let j = i;
    while (v[j + 1] === (v[j] as number) + 1) j++;
    parts.push(j > i ? `${v[i]}-${v[j]}` : String(v[i]));
    i = j + 1;
  }
  return parts.join(',');
}

export const IFM: ModeId[] = ['config-if', 'config-subif', 'config-if-range'];
export const SUBMODES: ModeId[] = [
  ...IFM,
  'config-line',
  'config-vlan',
  'dhcp-config',
  'config-std-nacl',
  'config-ext-nacl',
  'config-rip',
  'config-ospf',
  'config-ospf6',
  'config-eigrp',
  'config-eigrp6',
  'config-tacacs',
  'config-bba',
  'config-bgp',
  'config-obj-net',
  'config-route-map',
  'config-bgp-af6',
  'config-dhcp6',
  'config-rip6',
];
