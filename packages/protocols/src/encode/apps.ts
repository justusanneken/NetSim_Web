import type { Dhcp6Pdu, DhcpPdu, DnsPdu, HsrpPdu, HttpPdu, IkePdu, RipPdu, SvcPdu } from '../types';
import { parseIpv4, prefixToMask } from '../addr';
import { ascii, macBytes, scramble, W } from './bytes';
import { encodeBgp } from './routing';

// ------------------------------------------------------------------ DHCPv4 (RFC 2131/2132)

const DHCP_TYPE: Record<DhcpPdu['op'], number> = {
  discover: 1,
  offer: 2,
  request: 3,
  decline: 4,
  ack: 5,
  nak: 6,
  release: 7,
};

export function encodeDhcp(p: DhcpPdu): Uint8Array {
  const reply = p.op === 'offer' || p.op === 'ack' || p.op === 'nak';
  const bcast = (p.op === 'discover' || p.op === 'request') && p.ciaddr === '0.0.0.0';
  const w = new W()
    .u8(reply ? 2 : 1)
    .u8(1)
    .u8(6)
    .u8(0)
    .u32(p.xid)
    .u16(0)
    .u16(bcast ? 0x8000 : 0)
    .ip4(p.ciaddr)
    .ip4(p.yiaddr)
    .ip4(p.siaddr)
    .ip4(p.giaddr)
    .mac(p.chaddr)
    .zeros(10)
    .zeros(64)
    .zeros(128)
    .u32(0x63825363);
  const o = p.options;
  w.u8(53).u8(1).u8(DHCP_TYPE[p.op]);
  if (o.mask) w.u8(1).u8(4).ip4(o.mask);
  if (o.router) w.u8(3).u8(4).ip4(o.router);
  if (o.dns?.length) {
    w.u8(6).u8(o.dns.length * 4);
    for (const d of o.dns) w.ip4(d);
  }
  if (o.domain) w.u8(15).u8(o.domain.length).str(o.domain);
  if (o.requestedIp) w.u8(50).u8(4).ip4(o.requestedIp);
  if (o.leaseSec !== undefined) w.u8(51).u8(4).u32(o.leaseSec);
  if (o.serverId) w.u8(54).u8(4).ip4(o.serverId);
  if (o.tftp) {
    w.u8(66).u8(o.tftp.length).str(o.tftp);
    w.u8(150)
      .u8(4)
      .ip4(parseIpv4(o.tftp) !== undefined ? o.tftp : '0.0.0.0');
  }
  if (o.opt82) {
    const c = ascii(o.opt82.circuitId);
    const r = ascii(o.opt82.remoteId);
    w.u8(82)
      .u8(4 + c.length + r.length)
      .u8(1)
      .u8(c.length)
      .bytes(c)
      .u8(2)
      .u8(r.length)
      .bytes(r);
  }
  w.u8(255);
  // BOOTP-Mindestlänge 300 Byte
  if (w.length < 300) w.zeros(300 - w.length);
  return w.out();
}

// ------------------------------------------------------------------ DHCPv6 (RFC 8415)

const DHCP6_TYPE: Record<Dhcp6Pdu['op'], number> = {
  solicit: 1,
  advertise: 2,
  request: 3,
  reply: 7,
  'information-request': 11,
};

export function encodeDhcp6(p: Dhcp6Pdu): Uint8Array {
  const w = new W().u8(DHCP6_TYPE[p.op]).u24(p.xid);
  const duid = (mac: string): number[] => [0, 3, 0, 1, ...macBytes(mac)];
  const opt = (code: number, body: number[]): void => {
    w.u16(code).u16(body.length).bytes(body);
  };
  opt(1, duid(p.clientId));
  if (p.serverId) opt(2, duid(p.serverId));
  opt(8, [0, 0]);
  if (p.op === 'solicit' || p.op === 'request' || p.op === 'advertise' || p.op === 'reply') {
    const ia = new W()
      .u32(1)
      .u32(p.leaseSec ? p.leaseSec / 2 : 0)
      .u32(p.leaseSec ? (p.leaseSec * 4) / 5 : 0);
    if (p.addr)
      ia.u16(5)
        .u16(24)
        .ip6(p.addr)
        .u32(p.leaseSec ?? 0)
        .u32(p.leaseSec ?? 0);
    if (p.addr || p.op === 'solicit' || p.op === 'request') opt(3, ia.b);
  }
  if (p.op === 'solicit' || p.op === 'request' || p.op === 'information-request')
    opt(6, [0, 23, 0, 24]);
  if (p.dns?.length)
    opt(
      23,
      p.dns.flatMap((d) => new W().ip6(d).b),
    );
  if (p.domain) opt(24, dnsName(p.domain));
  return w.out();
}

// ------------------------------------------------------------------ DNS (RFC 1035)

const DNS_TYPE = { A: 1, CNAME: 5, PTR: 12, MX: 15, AAAA: 28 } as const;

function dnsName(name: string): number[] {
  const out: number[] = [];
  for (const label of name.replace(/\.$/, '').split('.')) {
    if (label === '') continue;
    const l = ascii(label).slice(0, 63);
    out.push(l.length, ...l);
  }
  out.push(0);
  return out;
}

export function encodeDns(p: DnsPdu): Uint8Array {
  const w = new W().u16(p.id);
  // QR | Opcode 0 | AA (bei Antwort) | RD | RA (bei Antwort) | RCODE
  w.u16((p.response ? 0x8400 : 0) | 0x0100 | (p.response ? 0x0080 : 0) | p.rcode);
  w.u16(1).u16(p.answers.length).u16(0).u16(0);
  w.bytes(dnsName(p.question.name)).u16(DNS_TYPE[p.question.type]).u16(1);
  for (const a of p.answers) {
    if (a.name === p.question.name) w.u16(0xc00c);
    else w.bytes(dnsName(a.name));
    w.u16(DNS_TYPE[a.type]).u16(1).u32(a.ttl);
    let rdata: number[];
    switch (a.type) {
      case 'A':
        rdata = new W().ip4(a.data).b;
        break;
      case 'AAAA':
        rdata = new W().ip6(a.data).b;
        break;
      case 'MX': {
        const m = /^(\d+)\s+(.+)$/.exec(a.data);
        rdata = [
          ...new W().u16(m ? Number(m[1]) : 10).b,
          ...dnsName(m ? (m[2] as string) : a.data),
        ];
        break;
      }
      default:
        rdata = dnsName(a.data);
    }
    w.u16(rdata.length).bytes(rdata);
  }
  return w.out();
}

// ------------------------------------------------------------------ RIP / RIPng (RFC 2453 / 2080)

export function encodeRip(p: RipPdu): Uint8Array {
  const w = new W()
    .u8(p.command === 'request' ? 1 : 2)
    .u8(p.ng ? 1 : 2)
    .u16(0);
  for (const e of p.entries) {
    if (p.ng) {
      w.ip6(e.prefix)
        .u16(e.tag)
        .u8(e.plen ?? 64)
        .u8(e.metric);
    } else {
      w.u16(2)
        .u16(e.tag)
        .ip4(e.prefix)
        .ip4(e.mask || prefixToMask(e.plen ?? 24))
        .ip4(e.nextHop)
        .u32(e.metric);
    }
  }
  return w.out();
}

// ------------------------------------------------------------------ HSRP (RFC 2281 / Cisco v2)

const HSRP_STATE = { init: 0, learn: 1, listen: 2, speak: 4, standby: 8, active: 16 } as const;
const HSRP_OP = { hello: 0, coup: 1, resign: 2 } as const;

export function encodeHsrp(p: HsrpPdu): Uint8Array {
  if (p.version === 2) {
    const w = new W().u8(1).u8(40);
    w.u8(2).u8(HSRP_OP[p.op]).u8(HSRP_STATE[p.state]).u8(4).u16(p.group);
    w.bytes([0x00, 0x00, 0x0c, 0x9f, 0xf0 | ((p.group >> 8) & 0x0f), p.group & 0xff]);
    w.u32(p.priority)
      .u32(p.helloSec * 1000)
      .u32(p.holdSec * 1000);
    w.ip4(p.vip).zeros(12);
    return w.out();
  }
  return new W()
    .u8(0)
    .u8(HSRP_OP[p.op])
    .u8(HSRP_STATE[p.state])
    .u8(p.helloSec)
    .u8(p.holdSec)
    .u8(p.priority)
    .u8(p.group)
    .u8(0)
    .fixed(p.auth ?? 'cisco', 8)
    .ip4(p.vip)
    .out();
}

// ------------------------------------------------------------------ IKE / ISAKMP (stark vereinfacht)

/**
 * ISAKMP-Kopf (RFC 2408) mit korrekten Feldern; der Rumpf ist ein deterministischer Platzhalter, da der
 * Simulator den IKE-Austausch nicht Byte für Byte nachbildet.
 */
export function encodeIke(p: IkePdu): Uint8Array {
  const body = p.selector ? 96 : 72;
  const rsp = p.op === 'request';
  const w = new W()
    .u32(p.cookie)
    .u32(~p.cookie >>> 0)
    .u32(rsp ? 0 : p.cookie ^ 0x5a5a5a5a)
    .u32(rsp ? 0 : ~p.cookie >>> 0)
    .u8(1) // Next Payload: SA
    .u8(0x10)
    .u8(p.selector ? 32 : 2) // Quick Mode bzw. Identity Protection
    .u8(0)
    .u32(p.selector ? 1 : 0)
    .u32(28 + body);
  w.bytes(scramble(`${p.encr}${p.hash}${p.transform}${p.authHash}`, body));
  return w.out();
}

// ------------------------------------------------------------------ HTTP / Textprotokolle

export function encodeHttp(p: HttpPdu): Uint8Array {
  const body = p.body ?? '';
  if (p.method) {
    return new W()
      .str(
        `${p.method} ${p.path ?? '/'} HTTP/1.1\r\nHost: ${p.host ?? ''}\r\nConnection: close\r\n\r\n`,
      )
      .out();
  }
  const reason: Record<number, string> = {
    200: 'OK',
    301: 'Moved Permanently',
    403: 'Forbidden',
    404: 'Not Found',
  };
  const st = p.status ?? 200;
  return new W()
    .str(
      `HTTP/1.1 ${st} ${reason[st] ?? 'Status'}\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
    )
    .out();
}

const str = (v: unknown): string => (v === undefined ? '' : String(v));

function textLine(m: SvcPdu): string {
  const a = m.args;
  if (a.text !== undefined) return `${str(a.text)}\r\n${m.body ? m.body + '\r\n' : ''}`;
  const words = [m.op.toUpperCase().replace(/-/g, ' ')];
  for (const k of ['user', 'pass', 'file', 'to', 'from', 'subject'])
    if (a[k] !== undefined) words.push(str(a[k]));
  return `${words.join(' ')}\r\n${m.body ? m.body + '\r\n' : ''}`;
}

const SNMP_OPS = { get: 0xa0, 'get-next': 0xa1, response: 0xa2, set: 0xa3, trap: 0xa7 } as const;

function ber(tag: number, content: number[]): number[] {
  const n = content.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >>> 8, n & 0xff];
  return [tag, ...len, ...content];
}
function berInt(v: number): number[] {
  const out: number[] = [];
  let x = Math.trunc(v);
  do {
    out.unshift(x & 0xff);
    x = Math.floor(x / 256);
  } while (x > 0 || (out[0] as number) & 0x80);
  return ber(0x02, out);
}
function berOid(oid: string): number[] {
  const p = oid.split('.').map(Number);
  const out: number[] = [(p[0] ?? 1) * 40 + (p[1] ?? 3)];
  for (const n of p.slice(2)) {
    const bytes = [n & 0x7f];
    let x = n >>> 7;
    while (x > 0) {
      bytes.unshift((x & 0x7f) | 0x80);
      x >>>= 7;
    }
    out.push(...bytes);
  }
  return ber(0x06, out);
}

function encodeSnmp(m: SvcPdu): number[] {
  const a = m.args;
  const community = str(a.community ?? 'public');
  const version = str(a.version) === '1' ? 0 : 1;
  const oid = str(a.oid ?? (m.op === 'trap' ? '1.3.6.1.6.3.1.1.5.3' : '1.3.6.1.2.1.1.1.0'));
  const value =
    a.value === undefined
      ? [0x05, 0x00]
      : typeof a.value === 'number'
        ? berInt(a.value)
        : ber(0x04, ascii(str(a.value)));
  const varbind = ber(0x30, [...berOid(oid), ...value]);
  const tag = SNMP_OPS[m.op as keyof typeof SNMP_OPS] ?? SNMP_OPS.get;
  const pdu = ber(tag, [
    ...berInt(Number(a.rid ?? 1)),
    ...berInt(0),
    ...berInt(0),
    ...ber(0x30, varbind),
  ]);
  return ber(0x30, [...berInt(version), ...ber(0x04, ascii(community)), ...pdu]);
}

function encodeRadius(m: SvcPdu): number[] {
  const code =
    m.op === 'access-request'
      ? 1
      : m.op === 'access-accept'
        ? 2
        : m.op === 'access-reject'
          ? 3
          : 11;
  const attrs = new W();
  const user = m.args.user;
  if (user !== undefined)
    attrs
      .u8(1)
      .u8(2 + str(user).length)
      .str(str(user));
  if (m.args.pass !== undefined)
    attrs
      .u8(2)
      .u8(18)
      .bytes(scramble(`pw${str(m.args.pass)}`, 16));
  return new W()
    .u8(code)
    .u8(Number(m.args.rid ?? 1) & 0xff)
    .u16(20 + attrs.length)
    .bytes(scramble('radius-auth', 16))
    .bytes(attrs.b).b;
}

function encodeTacacs(m: SvcPdu): number[] {
  const body = new W()
    .u8(1)
    .u8(1)
    .u8(1)
    .u8(1)
    .u8(str(m.args.user).length)
    .u8(0)
    .u8(0)
    .u8(0)
    .str(str(m.args.user)).b;
  return new W().u8(0xc0).u8(1).u8(1).u8(0).u32(0x1234).u32(body.length).bytes(body).b;
}

function encodeTftp(m: SvcPdu): number[] {
  const file = str(m.args.file ?? m.args.name);
  switch (m.op) {
    case 'rrq':
    case 'get':
      return new W().u16(1).str(file).u8(0).str('octet').u8(0).b;
    case 'wrq':
    case 'put':
      return new W().u16(2).str(file).u8(0).str('octet').u8(0).b;
    case 'data':
      return new W()
        .u16(3)
        .u16(Number(m.args.block ?? 1))
        .str(m.body ?? '').b;
    case 'ack':
      return new W().u16(4).u16(Number(m.args.block ?? 0)).b;
    default:
      return new W()
        .u16(5)
        .u16(1)
        .str(str(m.args.text ?? m.op))
        .u8(0).b;
  }
}

function encodeNtp(m: SvcPdu): number[] {
  const client = m.op === 'request' && m.args.reply !== true;
  const w = new W()
    .u8((0 << 6) | (4 << 3) | (client ? 3 : 4))
    .u8(client ? 0 : 2)
    .u8(6)
    .u8(0xec);
  w.u32(0)
    .u32(client ? 0 : 0x00000100)
    .bytes(client ? [0, 0, 0, 0] : [10, 0, 0, 1]);
  const ts = Number(m.args.ts ?? 0);
  const secs = Math.floor(ts / 1000) + 2208988800;
  w.u32(client ? 0 : secs).u32(0); // Reference
  w.u32(0).u32(0); // Origin
  w.u32(client ? 0 : secs).u32(0); // Receive
  w.u32(client ? 0 : secs).u32(0); // Transmit (Client: 0)
  return w.b;
}

function encodeSyslog(m: SvcPdu): number[] {
  const sev = Number(m.args.sev ?? 6);
  const host = str(m.args.host);
  return ascii(`<${(23 << 3) | (sev & 7)}>${host ? host + ' ' : ''}${m.body ?? str(m.args.text)}`);
}

/** Anwendungsnachricht der Phase 5 → Bytes (soweit ein reales Format existiert, sonst lesbares JSON). */
export function encodeSvc(m: SvcPdu): Uint8Array {
  if (m.bgp) return encodeBgp(m.bgp);
  if (m.encrypted || m.proto === 'ssh') {
    if (m.op === 'banner' || m.args.text) return new W().str('SSH-2.0-NetSim_1.0\r\n').out();
    return new W()
      .bytes(scramble(`ssh${m.op}${m.body ?? ''}`, 48 + ((m.body?.length ?? 0) & ~15)))
      .out();
  }
  switch (m.proto) {
    case 'snmp':
      return Uint8Array.from(encodeSnmp(m));
    case 'radius':
      return Uint8Array.from(encodeRadius(m));
    case 'tacacs':
      return Uint8Array.from(encodeTacacs(m));
    case 'tftp':
      return Uint8Array.from(encodeTftp(m));
    case 'ntp':
      return Uint8Array.from(encodeNtp(m));
    case 'syslog':
      return Uint8Array.from(encodeSyslog(m));
    case 'ftp':
    case 'smtp':
    case 'pop3':
    case 'telnet':
      return new W().str(textLine(m)).out();
    default:
      return new W().str(JSON.stringify({ op: m.op, args: m.args, body: m.body })).out();
  }
}
