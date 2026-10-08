import type { Device, Engine } from '@netsim/engine';
import { ifDisplay } from './ifnames';

type D = Device;
const l3 = (d: D) =>
  d.config.kind === 'router' || d.config.kind === 'switch' ? d.config : undefined;
const up6 = (a: string): string => a.toUpperCase();

export function showDhcp6Pool(d: D): string[] {
  const cfg = l3(d);
  const out: string[] = [];
  for (const p of cfg?.dhcp6?.pools ?? []) {
    out.push(`DHCPv6 pool: ${p.name}`);
    if (p.prefix) out.push(`  Address allocation prefix: ${up6(p.prefix.prefix)}/${p.prefix.plen}`);
    for (const dns of p.dns) out.push(`  DNS server: ${up6(dns)}`);
    if (p.domain) out.push(`  Domain name: ${p.domain}`);
    out.push(
      `  Active clients: ${Object.values(cfg?.dhcp6?.bindings ?? {}).filter((b) => b.pool === p.name).length}`,
    );
  }
  return out;
}

export function showDhcp6Binding(e: Engine, d: D): string[] {
  const cfg = l3(d);
  const out: string[] = [];
  for (const [client, b] of Object.entries(cfg?.dhcp6?.bindings ?? {})) {
    out.push(
      `Client: ${client}`,
      `  Pool: ${b.pool}`,
      `  IA NA: Address: ${up6(b.addr)}`,
      `    preferred lifetime ${Math.max(0, Math.floor((b.expiresAt - e.state.now) / 1_000_000))}`,
    );
  }
  return out;
}

export function showRipng(e: Engine, d: D, name?: string): string[] {
  const cfg = l3(d);
  const out: string[] = [];
  for (const c of Object.values(cfg?.routing.ripng ?? {})) {
    if (name && c.name !== name) continue;
    out.push(
      `RIP process "${c.name}", port 521, multicast-group FF02::9, pid 0`,
      `     Administrative distance is 120. Maximum paths is ${c.maxPaths ?? 4}`,
      `     Updates every ${c.timers.update} seconds, expire after ${c.timers.invalid}`,
      `     Holddown lasts ${c.timers.holddown} seconds, garbage collect after ${c.timers.flush}`,
      `     Split horizon is ${c.poison ? 'off' : 'on'}; poison reverse is ${c.poison ? 'on' : 'off'}`,
      `     Default routes are ${c.defaultOriginate ? '' : 'not '}generated`,
      `     Periodic updates 0, trigger updates 0`,
      '  Interfaces:',
    );
    for (const [id, ic] of Object.entries(cfg?.ifaces ?? {}))
      if (ic.v6?.ripng === c.name) out.push(`    ${ifDisplay(d, id)}`);
    out.push(
      '  Redistribution:',
      c.redistribute.length ? c.redistribute.map((x) => `    ${x.source}`).join('\n') : '    None',
      '',
    );
    out.push('  RIP Database:');
    for (const r of Object.values(c.routes).sort((a, b) => a.prefix.localeCompare(b.prefix))) {
      const via =
        r.origin === 'rip' ? ` via ${up6(r.nextHop ?? '')}, ${ifDisplay(d, r.ifaceId ?? '')}` : '';
      out.push(`    ${up6(r.prefix)}/${r.plen}, metric ${r.metric}${via}`);
    }
    out.push('');
  }
  void e;
  return out;
}
