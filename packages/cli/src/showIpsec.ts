import type { Device, IpsecSa } from '@netsim/engine';
import { ifDisplay } from './ifnames';
import { aclEntryText } from './render';

const l3 = (d: Device) =>
  d.config.kind === 'router' || d.config.kind === 'switch' ? d.config : undefined;

const hexSpi = (n: number): string => '0x' + n.toString(16).toUpperCase();

/** `show crypto isakmp sa`. */
export function showIsakmpSa(d: Device): string[] {
  const sas = Object.values(l3(d)?.crypto?.sas ?? {});
  const out = [
    'IPv4 Crypto ISAKMP SA',
    'dst             src             state          conn-id status',
  ];
  const seen = new Set<string>();
  for (const s of sas) {
    const k = `${s.peer}|${s.local}`;
    if (s.state === 'up' && seen.has(k)) continue;
    seen.add(k);
    const [dst, src] = s.role === 'initiator' ? [s.peer, s.local] : [s.local, s.peer];
    const state = s.state === 'up' ? 'QM_IDLE' : 'MM_NO_STATE';
    const status = s.state === 'up' ? 'ACTIVE' : s.state === 'failed' ? 'ACTIVE (deleted)' : 'NEW';
    out.push(
      `${dst.padEnd(16)}${src.padEnd(16)}${state.padEnd(15)}${String(s.connId).padStart(7)} ${status}`,
    );
  }
  out.push('', 'IPv6 Crypto ISAKMP SA');
  return out;
}

const encrText = {
  des: 'DES-CBC (56 bit keys).',
  '3des': 'Three key triple DES',
  aes: 'AES - Advanced Encryption Standard (128 bit keys).',
} as const;
const dhText = { 1: '#1 (768 bit)', 2: '#2 (1024 bit)', 5: '#5 (1536 bit)' } as const;

/** `show crypto isakmp policy`. */
export function showIsakmpPolicy(d: Device): string[] {
  const out: string[] = ['Global IKE policy'];
  for (const p of Object.values(l3(d)?.crypto?.policies ?? {}).sort((a, b) => a.prio - b.prio))
    out.push(
      `Protection suite of priority ${p.prio}`,
      `        encryption algorithm:   ${encrText[p.encr]}`,
      `        hash algorithm:         ${p.hash === 'md5' ? 'Message Digest 5' : 'Secure Hash Standard'}`,
      `        authentication method:  ${p.auth === 'pre-share' ? 'Pre-Shared Key' : 'Rivest-Shamir-Adleman Signature'}`,
      `        Diffie-Hellman group:   ${dhText[p.group]}`,
      `        lifetime:               ${p.lifetime} seconds, no volume limit`,
    );
  return out;
}

/** `show crypto ipsec transform-set`. */
export function showTransformSets(d: Device): string[] {
  const out: string[] = [];
  for (const t of Object.values(l3(d)?.crypto?.transformSets ?? {}))
    out.push(
      `Transform set ${t.name}: { ${t.transforms.join(' ')}  }`,
      `   will negotiate = { ${t.mode === 'tunnel' ? 'Tunnel' : 'Transport'},  },`,
      '',
    );
  return out;
}

/** `show crypto map`. */
export function showCryptoMap(d: Device): string[] {
  const cfg = l3(d);
  const out: string[] = [];
  for (const m of Object.values(cfg?.crypto?.maps ?? {})) {
    for (const e of Object.values(m.entries).sort((a, b) => a.seq - b.seq)) {
      out.push(`Crypto Map "${m.name}" ${e.seq} ipsec-isakmp`);
      if (e.peer) out.push(`        Peer = ${e.peer}`);
      if (e.acl) {
        out.push(`        Extended IP access list ${e.acl}`);
        for (const x of cfg?.acls[e.acl]?.entries ?? [])
          out.push(`            access-list ${e.acl} ${aclEntryText(x, 'extended')}`);
      }
      out.push(
        `        Current peer: ${e.peer ?? ''}`,
        `        Security association lifetime: 4608000 kilobytes/${e.lifetimeSec ?? 3600} seconds`,
        `        PFS (Y/N): ${e.pfs ? 'Y' : 'N'}`,
        `        Transform sets={ ${e.transformSet ?? ''}, }`,
        `        Interfaces using crypto map ${m.name}:`,
      );
      for (const [id, c] of Object.entries(cfg?.ifaces ?? {}))
        if (c.cryptoMap === m.name) out.push(`                ${ifDisplay(d, id)}`);
    }
  }
  return out;
}

/** `ip/wildcard` → `ip/mask`; `any` → 0.0.0.0/0.0.0.0. */
function identText(sel: string): string {
  if (sel === 'any') return '0.0.0.0/0.0.0.0';
  if (sel.startsWith('host ')) return `${sel.slice(5)}/255.255.255.255`;
  const [ip, wc] = sel.split('/');
  const mask = (wc ?? '0.0.0.0')
    .split('.')
    .map((o) => 255 - Number(o))
    .join('.');
  return `${ip}/${mask}`;
}

/** `show crypto ipsec sa` (Paketzähler je SA). */
export function showIpsecSa(d: Device): string[] {
  const out: string[] = [];
  const byIface = new Map<string, IpsecSa[]>();
  for (const s of Object.values(l3(d)?.crypto?.sas ?? {})) {
    const list = byIface.get(s.ifaceId) ?? [];
    list.push(s);
    byIface.set(s.ifaceId, list);
  }
  if (byIface.size === 0) return ['No IPsec security associations.'];
  for (const [ifaceId, list] of byIface) {
    out.push(
      `interface: ${ifDisplay(d, ifaceId)}`,
      `    Crypto map tag: ${list[0]?.mapName}, local addr ${list[0]?.local}`,
      '',
    );
    for (const s of list) {
      out.push(
        '   protected vrf: (none)',
        `   local  ident (addr/mask/prot/port): (${identText(s.sel.src)}/${s.sel.proto ?? 0}/0)`,
        `   remote ident (addr/mask/prot/port): (${identText(s.sel.dst)}/${s.sel.proto ?? 0}/0)`,
        `   current_peer ${s.peer} port 500`,
        '     PERMIT, flags={origin_is_acl,}',
        `    #pkts encaps: ${s.encaps}, #pkts encrypt: ${s.encaps}, #pkts digest: ${s.encaps}`,
        `    #pkts decaps: ${s.decaps}, #pkts decrypt: ${s.decaps}, #pkts verify: ${s.decaps}`,
        '    #pkts compressed: 0, #pkts decompressed: 0',
        '    #pkts not compressed: 0, #pkts compr. failed: 0',
        `    #send errors ${s.dropped}, #recv errors 0`,
        '',
        `     local crypto endpt.: ${s.local}, remote crypto endpt.: ${s.peer}`,
      );
      if (s.state === 'up')
        out.push(
          '',
          '     inbound esp sas:',
          `      spi: ${hexSpi(s.inSpi)} (${s.inSpi})`,
          `        transform: ${s.transform} ,`,
          '        in use settings ={Tunnel, }',
          `        conn id: ${s.connId}, flow_id: SW:${s.connId}, crypto map: ${s.mapName}`,
          '',
          '     outbound esp sas:',
          `      spi: ${hexSpi(s.outSpi)} (${s.outSpi})`,
          `        transform: ${s.transform} ,`,
          '        in use settings ={Tunnel, }',
          `        conn id: ${s.connId + 1}, flow_id: SW:${s.connId + 1}, crypto map: ${s.mapName}`,
        );
      else out.push(`     (no IPsec SA: ${s.state}${s.reason ? ' – ' + s.reason : ''})`);
      out.push('');
    }
  }
  return out;
}
