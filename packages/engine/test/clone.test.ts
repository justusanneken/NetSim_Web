import { describe, expect, it } from 'vitest';
import { Engine, cloneDevices, nextFreeIp } from '../src';
import { switchLab, converge } from './helpers';

describe('cloneDevices (Copy/Paste)', () => {
  it('copies devices with new names, new MACs and the link between them', () => {
    const { e, ids, sw } = switchLab(2);
    const r = cloneDevices(e, [ids[0] as string, sw as string], { x: 40, y: 40 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ids).toHaveLength(2);
    const names = Object.values(e.state.devices).map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    const macs = Object.values(e.state.devices).flatMap((d) => d.ports.map((p) => p.mac));
    expect(new Set(macs).size).toBe(macs.length);
    // Kabel PC0-Switch wurde mitkopiert, die zum nicht kopierten PC1 nicht
    const newPc = e.state.devices[r.value.map[ids[0] as string] as string];
    const newSw = e.state.devices[r.value.map[sw as string] as string];
    expect(newPc?.ports[0]?.linkId).toBeDefined();
    expect(newSw?.ports.filter((p) => p.linkId)).toHaveLength(1);
    expect(newPc?.pos).toEqual({ x: (e.state.devices[ids[0] as string]?.pos.x ?? 0) + 40, y: 90 });
  });

  it('assigns the next free IP instead of a duplicate', () => {
    const { e, ids } = switchLab(3);
    const r = cloneDevices(e, [ids[0] as string], { x: 0, y: 60 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = e.state.devices[r.value.ids[0] as string]?.config;
    expect(c?.kind === 'host' && c.ip).toBe('10.0.0.4');
    expect(r.value.readdressed[0]).toMatchObject({ from: '10.0.0.1', to: '10.0.0.4' });
  });

  it('copies router configuration, hostname follows the new name; the copy converges', () => {
    const e = new Engine();
    const r1 = e.addDevice('router');
    e.setInterfaceIp(r1, 'p0', '10.9.0.1', '255.255.255.0');
    const res = cloneDevices(e, [r1], { x: 80, y: 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d = e.state.devices[res.value.ids[0] as string];
    expect(d?.name).not.toBe(e.state.devices[r1]?.name);
    expect(d?.config.kind === 'router' && d.config.sys.hostname).toBe(d?.name);
    expect(d?.config.kind === 'router' && d.config.ifaces['p0']?.ip).toBe('10.9.0.2');
    converge(e, 5);
  });

  it('rejects an empty selection and handles full subnets', () => {
    const e = new Engine();
    expect(cloneDevices(e, ['x'], { x: 0, y: 0 })).toMatchObject({ ok: false });
    expect(nextFreeIp('10.0.0.1', '255.255.255.252', new Set(['10.0.0.1', '10.0.0.2']))).toBe(
      undefined,
    );
    expect(nextFreeIp('10.0.0.2', '255.255.255.252', new Set(['10.0.0.2']))).toBe('10.0.0.1');
    expect(nextFreeIp('bogus', '255.255.255.0', new Set())).toBeUndefined();
    expect(nextFreeIp('10.0.0.1', '255.255.255.255', new Set())).toBeUndefined();
  });
});
