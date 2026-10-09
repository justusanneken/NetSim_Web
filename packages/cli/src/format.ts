import type { Port } from '@netsim/engine';

/** `0200.0000.0001` (Cisco-Schreibweise). */
export function ciscoMac(mac: string): string {
  const h = mac.replace(/:/g, '');
  return `${h.slice(0, 4)}.${h.slice(4, 8)}.${h.slice(8, 12)}`;
}

/** `02-00-00-00-00-01` (Windows-Schreibweise). */
export function winMac(mac: string): string {
  return mac.replace(/:/g, '-').toUpperCase();
}

export function shortName(name: string): string {
  return name
    .replace('TenGigabitEthernet', 'Te')
    .replace('GigabitEthernet', 'Gi')
    .replace('FastEthernet', 'Fa')
    .replace('Serial', 'Se');
}

const PREFIXES: [RegExp, string][] = [
  [/^(tengigabitethernet|te)/i, 'TenGigabitEthernet'],
  [/^(gigabitethernet|gigabit|gi|g)/i, 'GigabitEthernet'],
  [/^(fastethernet|fa|f)/i, 'FastEthernet'],
  [/^(serial|se|s)/i, 'Serial'],
];

/** `gi0/0`, `Gig 0/0`, `fastethernet0/1` … → Port. */
export function resolvePort(ports: Port[], text: string): Port | undefined {
  const t = text.replace(/\s+/g, '');
  for (const [re, full] of PREFIXES) {
    const m = re.exec(t);
    if (!m) continue;
    const rest = t.slice(m[0].length);
    if (!/^\d+(\/\d+)*$/.test(rest)) return undefined;
    return ports.find((p) => p.name === `${full}${rest}`);
  }
  return undefined;
}

export const pad = (s: string, n: number): string => s.padEnd(n);
