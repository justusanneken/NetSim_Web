import { isValidIpv4, type Frame, type Ipv4Pdu } from '@netsim/protocols';
import { z } from 'zod';
import type { Engine } from '../engine';
import { hostHttp, hostPing, hostResolve } from '../devices/host';
import { l3Ping, type L3Dev } from '../devices/l3dev';
import { sendUdp } from '../l3';
import { connClose, connOpen, TCP_PORT } from '../p5/conn';
import { appcOf, ipNodeOf } from '../p5/node';
import { nextEphemeral } from '../ports';
import type { SvcProto } from '@netsim/protocols';
import type { Device, Result } from '../types';

/**
 * PDU-Werkzeuge (Simple/Complex PDU): Beschreibung (`PduSpec`), Start eines Versuchs und Auswertung des
 * Ergebnisses als Zustandspraedikat (Antwort erhalten, Verbindung aufgebaut, Antwortcode …).
 */

export const PDU_PROTOCOLS = [
  'icmp',
  'udp',
  'tcp',
  'http',
  'https',
  'dns',
  'telnet',
  'ssh',
  'ftp',
  'smtp',
  'pop3',
] as const;
export type PduProtocol = (typeof PDU_PROTOCOLS)[number];

const US = 1_000_000;

export const PduSpecSchema = z.object({
  protocol: z.enum(PDU_PROTOCOLS),
  /** Quellgeraet (ID; Fallback: Name). */
  src: z.string().min(1).max(64),
  /** Ziel: IPv4-Adresse, Geraetename (nimmt dessen erste IP) bzw. URL/Hostname bei http/https/dns. */
  dst: z.string().min(1).max(255),
  /** Zielport (udp/tcp); bei Anwendungsprotokollen Standardport. */
  dport: z.number().int().min(1).max(65535).optional(),
  sport: z.number().int().min(1).max(65535).optional(),
  /** Absenderadresse (erweitertes Ping, UDP/TCP); sonst Adresse der Ausgangsschnittstelle. */
  srcIp: z.string().max(15).optional(),
  /** Nutzlast: Text (UDP/ICMP: Laenge = Datengroesse), bei dns der Name, bei http der Pfad. */
  payload: z.string().max(1024).optional(),
  /** Verzoegerung bis zum ersten Versand (Sekunden virtuelle Zeit). */
  delaySec: z.number().min(0).max(3600).default(0),
  /** Wiederholungen insgesamt (1 = einmalig). */
  count: z.number().int().min(1).max(100).default(1),
  /** Abstand der Wiederholungen (Sekunden). */
  intervalSec: z.number().min(0.1).max(3600).default(1),
});
export type PduSpec = z.infer<typeof PduSpecSchema>;
export type PduSpecInput = z.input<typeof PduSpecSchema>;

export type PduStatus = 'pending' | 'ok' | 'failed';
export interface PduOutcome {
  status: PduStatus;
  /** i18n-Schluessel der Ursache bei `failed` (oder Zusatzinfo). */
  note?: string;
}

export interface Attempt {
  deviceId: string;
  protocol: PduProtocol;
  startedAt: number;
  startLog: number;
  /** Ping: ID (Sequenz 1); http: Request-ID; dns: Abfrage-ID; tcp: Verbindungsschluessel. */
  ref?: number | string;
  /** UDP-Nachverfolgung. */
  udp?: { src: string; dst: string; sport: number; dport: number; dstDevice?: string };
  /** TCP ueber HTTP-Port: Anfrage nur auf Erreichbarkeit pruefen. */
  reachOnly?: boolean;
  /** Sofort entschieden (z. B. Fehler beim Start). */
  decided?: PduOutcome;
}

/** Verstreichende virtuelle Zeit, nach der ein unentschiedener Versuch als gescheitert gilt. */
export const ATTEMPT_DEADLINE_US = 15 * US;

export function findDevice(e: Engine, ref: string): Device | undefined {
  const devs = e.state.devices;
  if (devs[ref]) return devs[ref];
  return Object.values(devs).find((d) => d.name === ref);
}

/** Erste (niedrigste) konfigurierte IPv4-Adresse eines Geraets. */
export function deviceIp(d: Device): string | undefined {
  const c = d.config;
  if (c.kind === 'host') return c.ip;
  if (c.kind === 'router' || c.kind === 'switch') {
    // bevorzugt Loopback/aktive Schnittstellen nicht – schlicht die erste konfigurierte Adresse in ID-Reihenfolge
    const ids = Object.keys(c.ifaces).sort();
    for (const id of ids) {
      const ip = c.ifaces[id]?.ip;
      if (ip) return ip;
    }
    return undefined;
  }
  return undefined;
}

export function resolveTarget(e: Engine, dst: string): string | undefined {
  if (isValidIpv4(dst)) return dst;
  const d = findDevice(e, dst);
  return d ? deviceIp(d) : undefined;
}

function portProto(port: number): SvcProto | undefined {
  for (const [p, n] of Object.entries(TCP_PORT)) if (n === port) return p as SvcProto;
  return undefined;
}

const fail = (note: string): Result<Attempt> => ({ ok: false, error: note });

/** Startet einen Versuch (ein Paket/eine Verbindung) von `spec.src` aus. */
export function startAttempt(e: Engine, spec: PduSpec): Result<Attempt> {
  const dev = findDevice(e, spec.src);
  if (!dev) return fail('pdu.err.noSource');
  if (dev.config.kind === 'hub' || dev.config.kind === 'none' || dev.config.kind === 'bridge')
    return fail('ip.notAHost');
  if (!dev.powered || dev.crashed) return fail('dev.off');
  const host = dev.config.kind === 'host';
  const base: Attempt = {
    deviceId: dev.id,
    protocol: spec.protocol,
    startedAt: e.state.now,
    startLog: e.logLength,
  };
  const p = spec.protocol;
  const srcIp = spec.srcIp && isValidIpv4(spec.srcIp) ? spec.srcIp : undefined;
  if (spec.srcIp && !srcIp) return fail('ip.invalidIp');

  if (p === 'http' || p === 'https' || p === 'dns') {
    if (!host) return fail('pdu.err.hostOnly');
    if (p === 'dns') {
      const name = (spec.payload || spec.dst).trim();
      const cfg = dev.config;
      const r = e.withCtx(dev, (ctx) => hostResolve(ctx, cfg as never, name));
      if (r.error)
        return { ok: true, value: { ...base, decided: { status: 'failed', note: r.error } } };
      if (r.cached) return { ok: true, value: { ...base, decided: { status: 'ok' } } };
      return { ok: true, value: { ...base, ref: r.id } };
    }
    const asDevice = spec.dst.includes('://') ? undefined : resolveTarget(e, spec.dst);
    const target = spec.dst.includes('://') ? spec.dst : `${p}://${asDevice ?? spec.dst}`;
    const path = spec.payload?.startsWith('/') ? spec.payload : '';
    const port = spec.dport && spec.dport !== (p === 'https' ? 443 : 80) ? `:${spec.dport}` : '';
    const url = target.replace(/^(https?:\/\/[^/:]+)(:\d+)?(\/.*)?$/i, `$1${port}${path || '$3'}`);
    const r = e.httpGet(dev.id, url);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, value: { ...base, ref: r.value } };
  }

  const ip = resolveTarget(e, spec.dst);
  if (!ip) return fail('pdu.err.noTarget');

  if (p === 'icmp') {
    const size = spec.payload ? spec.payload.length : 32;
    const opts = { count: 1, dataSize: Math.max(1, size), source: srcIp };
    const r = e.withCtx(dev, (ctx) =>
      dev.config.kind === 'host'
        ? hostPing(ctx, dev.config, ip, opts)
        : l3Ping(ctx, dev as L3Dev, ip, opts),
    );
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, value: { ...base, ref: r.value } };
  }

  if (p === 'udp') {
    const dport = spec.dport ?? 9;
    const r = e.withCtx(dev, (ctx) => {
      const node = ipNodeOf(ctx, dev);
      if (!node) return undefined;
      const holder = appcOf(dev.config as never) as unknown as { nextPort: number };
      const sport = spec.sport ?? nextEphemeral(holder);
      const res = sendUdp(ctx, node, {
        src: srcIp,
        dst: ip,
        sport,
        dport,
        dataSize: spec.payload ? spec.payload.length : 0,
      });
      return res.ok ? sport : undefined;
    });
    const dstDev = Object.values(e.state.devices).find((d) => deviceIp(d) === ip);
    if (r === undefined)
      return {
        ok: true,
        value: { ...base, decided: { status: 'failed', note: 'pdu.err.noRoute' } },
      };
    return {
      ok: true,
      value: {
        ...base,
        udp: { src: srcIp ?? '', dst: ip, sport: r, dport, dstDevice: dstDev?.id },
      },
    };
  }

  // TCP und TCP-Anwendungsprotokolle
  const port =
    spec.dport ??
    (p === 'telnet'
      ? 23
      : p === 'ssh'
        ? 22
        : p === 'ftp'
          ? 21
          : p === 'smtp'
            ? 25
            : p === 'pop3'
              ? 110
              : 80);
  if (host && (port === 80 || port === 443 || port === 8080)) {
    const r = e.httpGet(
      dev.id,
      `${port === 443 ? 'https' : 'http'}://${ip}${port === 80 || port === 443 ? '' : `:${port}`}/`,
    );
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, value: { ...base, ref: r.value, reachOnly: true } };
  }
  const proto: SvcProto = portProto(port) ?? 'telnet';
  const r = e.withCtx(dev, (ctx) => {
    const node = ipNodeOf(ctx, dev);
    return node ? connOpen(ctx, node, { dst: ip, proto, port, src: srcIp }) : undefined;
  });
  if (!r) return fail('ip.notAHost');
  if (!r.ok) return { ok: true, value: { ...base, decided: { status: 'failed', note: r.error } } };
  return { ok: true, value: { ...base, ref: r.key } };
}

function ipv4Of(f: Frame | undefined): Ipv4Pdu | undefined {
  return f?.payload.kind === 'ipv4' ? f.payload : undefined;
}

/** Aktueller Stand eines Versuchs (rein lesend, ausser dem Abbau einer erfolgreichen TCP-Probeverbindung). */
export function attemptOutcome(e: Engine, a: Attempt): PduOutcome {
  if (a.decided) return a.decided;
  const dev = e.state.devices[a.deviceId];
  if (!dev) return { status: 'failed', note: 'pdu.err.noSource' };
  const cfg = dev.config;
  const timedOut = e.state.now - a.startedAt > ATTEMPT_DEADLINE_US;
  const pend = (): PduOutcome =>
    timedOut ? { status: 'failed', note: 'conn.timeout' } : { status: 'pending' };

  if (a.protocol === 'icmp') {
    if (cfg.kind !== 'host' && cfg.kind !== 'router' && cfg.kind !== 'switch') return pend();
    const r = cfg.pings.find((x) => x.id === a.ref && x.seq === 1);
    if (!r) return { status: 'failed', note: 'pdu.err.noResult' };
    if (r.status === 'reply') return { status: 'ok' };
    if (r.status === 'pending') return pend();
    return {
      status: 'failed',
      note: r.note ?? (r.status === 'timeout' ? 'ping.timeout' : r.status),
    };
  }
  if (a.protocol === 'dns') {
    if (cfg.kind !== 'host') return pend();
    const r = cfg.dnsResults[a.ref as number];
    if (!r?.done) return pend();
    if (r.error) return { status: 'failed', note: r.error };
    return r.rcode === 0 && r.answers.length > 0
      ? { status: 'ok' }
      : { status: 'failed', note: 'pdu.err.nxdomain' };
  }
  if (a.udp) {
    return udpOutcome(e, a, timedOut);
  }
  if (a.ref !== undefined && typeof a.ref === 'number') {
    if (cfg.kind !== 'host') return pend();
    const r = cfg.requests.find((x) => x.id === a.ref);
    if (!r) return { status: 'failed', note: 'pdu.err.noResult' };
    if (r.status === 'done') {
      if (a.reachOnly || (r.code !== undefined && r.code < 400)) return { status: 'ok' };
      return { status: 'failed', note: `http.status.${r.code ?? 0}` };
    }
    if (r.status === 'failed') return { status: 'failed', note: r.error ?? 'conn.timeout' };
    return pend();
  }
  if (typeof a.ref === 'string') {
    if (cfg.kind !== 'host' && cfg.kind !== 'router' && cfg.kind !== 'switch') return pend();
    const c = appcOf(cfg).conns[a.ref];
    if (!c) return { status: 'failed', note: 'pdu.err.noResult' };
    if (c.state === 'open') {
      // Probeverbindung sauber beenden
      e.withCtx(dev, (ctx) => {
        const node = ipNodeOf(ctx, dev);
        if (node) connClose(ctx, node, a.ref as string);
      });
      return { status: 'ok' };
    }
    if (c.state === 'failed' || c.state === 'closed')
      return { status: 'failed', note: c.err ?? 'conn.refused' };
    return pend();
  }
  return pend();
}

function udpOutcome(e: Engine, a: Attempt, timedOut: boolean): PduOutcome {
  const u = a.udp;
  if (!u) return { status: 'pending' };
  let delivered = false;
  for (const l of e.logSlice(a.startLog)) {
    const ip = ipv4Of(l.frame);
    if (!ip) continue;
    const p = ip.payload;
    if (
      p.kind === 'icmp' &&
      p.type === 'dest-unreachable' &&
      p.orig?.dport === u.dport &&
      p.orig.sport === u.sport
    )
      return {
        status: 'failed',
        note: p.code === 13 ? 'ping.adminProhibited' : 'pdu.err.portUnreachable',
      };
    if (
      p.kind === 'udp' &&
      p.srcPort === u.sport &&
      p.dstPort === u.dport &&
      ip.dst === u.dst &&
      l.atDeviceId === u.dstDevice &&
      l.status === 'ok'
    )
      delivered = true;
    if (
      p.kind === 'udp' &&
      p.srcPort === u.sport &&
      p.dstPort === u.dport &&
      l.status === 'drop' &&
      l.atDeviceId !== a.deviceId
    )
      return { status: 'failed', note: l.msg.key };
  }
  // zugestellt und keine ICMP-Fehlermeldung binnen 1 s: erfolgreich
  if (delivered && e.state.now - a.startedAt > 1 * US) return { status: 'ok' };
  return timedOut ? { status: 'failed', note: 'conn.timeout' } : { status: 'pending' };
}

/** Fuehrt einen einzelnen Versuch auf `e` aus, bis er entschieden ist (oder `horizonUs` verstrichen). */
export function runAttempt(e: Engine, spec: PduSpec, horizonUs = 30 * US): PduOutcome {
  const r = startAttempt(e, spec);
  if (!r.ok) return { status: 'failed', note: r.error };
  const a = r.value;
  const end = e.state.now + horizonUs;
  for (let guard = 0; guard < 400; guard++) {
    const o = attemptOutcome(e, a);
    if (o.status !== 'pending') return o;
    if (e.state.now >= end) break;
    e.runUntil(Math.min(end, e.state.now + 100_000));
  }
  const o = attemptOutcome(e, a);
  return o.status === 'pending' ? { status: 'failed', note: 'conn.timeout' } : o;
}
