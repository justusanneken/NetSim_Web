import type { Engine } from '../engine';
import { announce, hostDhcp, resetIpRuntime } from '../devices/host';
import type { DeviceCtx } from '../ctx';
import type { IpNode } from '../l3';
import type { Bss, EapEntry, WifiBand, WifiProfile, WifiStatus } from '../p5types';
import type { Device, HostConfig } from '../types';
import { appcOf, ipNodeOf } from './node';
import { deviceDistance } from './physical';
import { udpRequest } from './udputil';

/** Funkreichweite in Canvas-Pixeln (vereinfachtes Modell, kein Funkphysik-Modell). */
export const WIFI_RANGE: Record<WifiBand, number> = { '2.4': 260, '5': 170 };

const hostOf = (d: Device): HostConfig | undefined =>
  d.config.kind === 'host' ? d.config : undefined;

/** Ausgesendete Netze (BSS) eines Access Points. */
export function apBss(cfg: HostConfig): Bss[] {
  const ap = cfg.ap;
  if (!ap) return [];
  const out: Bss[] = [];
  for (const r of ap.radios) {
    if (!r.enabled) continue;
    if (ap.managed) {
      for (const w of ap.managed.wlans) {
        if (!w.enabled || !w.ssid) continue;
        if (w.band === 'both' || w.band === r.band)
          out.push({
            ssid: w.ssid,
            security: w.security,
            key: w.key,
            radius: w.radius,
            band: r.band,
            channel: r.channel,
          });
      }
    } else if (r.ssid) {
      out.push({
        ssid: r.ssid,
        security: r.security,
        key: r.key,
        radius: r.radius,
        band: r.band,
        channel: r.channel,
      });
    }
  }
  return out;
}

/** Stand des 802.1X-Verfahrens eines Kandidaten (nur `wpa2-enterprise`). */
type EapState = 'nocred' | 'new' | EapEntry['state'];

interface Cand {
  ap: Device;
  bss: Bss;
  dist: number;
  authOk: boolean;
  profile: WifiProfile;
  eap?: EapState;
}

const wifiMac = (d: Device): string => d.ports.find((p) => p.kind === 'wifi')?.mac ?? '';
export const eapKey = (client: Device, ssid: string, band: WifiBand): string =>
  `${wifiMac(client)}|${ssid}|${band}`;
const eapSig = (p: WifiProfile): string => `${p.username ?? ''}\u0000${p.password ?? ''}`;

function eapStateOf(client: Device, ac: HostConfig, b: Bss, p: WifiProfile): EapState {
  if (!p.username) return 'nocred';
  const e = ac.ap?.eap?.[eapKey(client, b.ssid, b.band)];
  return !e || e.sig !== eapSig(p) ? 'new' : e.state;
}

const authOk = (b: Bss, p: WifiProfile, eap?: EapState): boolean =>
  b.security === 'open'
    ? true
    : b.security === 'wpa2-enterprise'
      ? eap === 'ok'
      : p.key !== undefined && p.key !== '' && p.key === b.key;

function candidates(eng: Engine, client: Device, cfg: HostConfig): Cand[] {
  const w = cfg.wifi;
  if (!w) return [];
  const out: Cand[] = [];
  for (const ap of Object.values(eng.state.devices)) {
    const ac = hostOf(ap);
    if (!ac?.ap || !ap.powered || ap.crashed) continue;
    const dist = deviceDistance(client, ap);
    for (const bss of apBss(ac)) {
      if (!w.bands.includes(bss.band) || dist > WIFI_RANGE[bss.band]) continue;
      for (const profile of w.profiles) {
        if (profile.ssid !== bss.ssid) continue;
        const eap =
          bss.security === 'wpa2-enterprise' ? eapStateOf(client, ac, bss, profile) : undefined;
        out.push({ ap, bss, dist, authOk: authOk(bss, profile, eap), profile, eap });
      }
    }
  }
  return out;
}

/** 5 GHz wird bei gleicher Eignung bevorzugt (kleinerer Wert = besser). */
const score = (c: Cand): number => c.dist - (c.bss.band === '5' ? 50 : 0);

function disassociate(eng: Engine, client: Device, cfg: HostConfig, reason: string): void {
  const w = cfg.wifi;
  const a = w?.assoc;
  if (!w || !a) return;
  const ap = eng.state.devices[a.apId];
  const apCfg = ap ? hostOf(ap) : undefined;
  const clientPort = client.ports.find((p) => p.id === a.clientPortId);
  const linkId = clientPort?.linkId;
  w.assoc = undefined;
  if (apCfg?.ap) {
    const c = apCfg.ap.clients[a.apPortId];
    delete apCfg.ap.clients[a.apPortId];
    if (apCfg.ap.eap) delete apCfg.ap.eap[eapKey(client, a.ssid, a.band)];
    for (const [mac, port] of Object.entries(apCfg.ap.macTable))
      if (port === a.apPortId) delete apCfg.ap.macTable[mac];
    if (ap && c) logAp(eng, ap, 'wifi.disassoc', { client: client.name, ssid: a.ssid, reason });
  }
  eng.withCtx(client, (ctx) =>
    ctx.log({
      kind: 'info',
      proto: 'WIFI',
      status: 'info',
      from: ap?.id,
      port: clientPort,
      msg: { key: 'wifi.disassoc', params: { client: client.name, ssid: a.ssid, reason } },
    }),
  );
  if (linkId) eng.disconnect(linkId);
  resetIpRuntime(cfg);
}

function logAp(
  eng: Engine,
  ap: Device,
  key: string,
  params: Record<string, string | number>,
): void {
  eng.withCtx(ap, (ctx) =>
    ctx.log({ kind: 'info', proto: 'WIFI', status: 'info', msg: { key, params } }),
  );
}

function setStatus(
  eng: Engine,
  client: Device,
  cfg: HostConfig,
  st: WifiStatus,
  ssid?: string,
): void {
  const w = cfg.wifi;
  if (!w || w.status === st) return;
  w.status = st;
  if (st === 'auth-failed' || st === 'no-ap') {
    eng.withCtx(client, (ctx) =>
      ctx.log({
        kind: 'info',
        proto: 'WIFI',
        status: st === 'auth-failed' ? 'error' : 'info',
        msg: {
          key: st === 'auth-failed' ? 'wifi.authFailed' : 'wifi.noAp',
          params: { ssid: ssid ?? '' },
        },
      }),
    );
  }
}

function associate(eng: Engine, client: Device, cfg: HostConfig, c: Cand): boolean {
  const w = cfg.wifi;
  const ac = hostOf(c.ap);
  const cport = client.ports.find((p) => p.kind === 'wifi');
  if (!w || !ac?.ap || !cport) return false;
  const slot = c.ap.ports.find((p) => p.kind === 'wifi' && !p.linkId && p.adminUp);
  if (!slot) return false;
  const radio = ac.ap.radios.find((r) => r.band === c.bss.band);
  const r = eng.connect(
    { deviceId: c.ap.id, portId: slot.id },
    { deviceId: client.id, portId: cport.id },
    'wireless',
  );
  if (!r.ok) return false;
  w.assoc = {
    apId: c.ap.id,
    apPortId: slot.id,
    clientPortId: cport.id,
    ssid: c.bss.ssid,
    band: c.bss.band,
    channel: radio?.channel ?? c.bss.channel,
  };
  ac.ap.clients[slot.id] = {
    mac: cport.mac,
    ssid: c.bss.ssid,
    band: c.bss.band,
    channel: c.bss.channel,
    since: eng.state.now,
  };
  resetIpRuntime(cfg);
  eng.withCtx(client, (ctx) => {
    ctx.log({
      kind: 'info',
      proto: 'WIFI',
      status: 'ok',
      from: c.ap.id,
      port: cport,
      msg: {
        key: c.bss.security === 'open' ? 'wifi.authOpen' : 'wifi.authOk',
        params: { client: client.name, ssid: c.bss.ssid, ap: c.ap.name },
      },
    });
    ctx.log({
      kind: 'info',
      proto: 'WIFI',
      status: 'ok',
      from: c.ap.id,
      port: cport,
      msg: {
        key: 'wifi.assoc',
        params: {
          client: client.name,
          ssid: c.bss.ssid,
          ap: c.ap.name,
          band: c.bss.band,
          channel: c.bss.channel,
        },
      },
    });
    if (cfg.dhcpClient.enabled) hostDhcp(ctx, cfg, true);
    else announce(ctx, cfg);
  });
  return true;
}

// ------------------------------------------------------------------ 802.1X (WPA2-Enterprise)

function setEap(ap: Device, key: string, e: EapEntry): void {
  const h = hostOf(ap);
  if (h?.ap) (h.ap.eap ??= {})[key] = e;
}

/**
 * Startet das vereinfachte EAP-Verfahren: Der AP fragt als Authenticator den RADIUS-Server (Access-Request, UDP 1812)
 * mit den Zugangsdaten des Clients. Die Entscheidung trifft `eapDecision` (Access-Accept/-Reject/Timeout).
 */
function startEap(eng: Engine, client: Device, c: Cand): void {
  const key = eapKey(client, c.bss.ssid, c.bss.band);
  const user = c.profile.username ?? '';
  const base: EapEntry = {
    state: 'fail',
    sig: eapSig(c.profile),
    client: client.name,
    user,
  };
  eng.withCtx(c.ap, (ctx) => {
    ctx.log({
      kind: 'info',
      proto: 'WIFI',
      status: 'info',
      from: client.id,
      msg: {
        key: 'wifi.eapStart',
        params: { client: client.name, ssid: c.bss.ssid, ap: c.ap.name, user },
      },
    });
    const node: IpNode | undefined = ipNodeOf(ctx, c.ap);
    const radius = c.bss.radius;
    const sent =
      node && radius
        ? udpRequest(ctx, node, {
            dst: radius.host,
            proto: 'radius',
            op: 'access-request',
            args: {
              user,
              pass: c.profile.password ?? '',
              secret: radius.secret,
              method: 'EAP-PEAP',
              station: wifiMac(client),
            },
            timeoutUs: 3_000_000,
          })
        : undefined;
    if (!node || !sent?.ok) {
      setEap(c.ap, key, base);
      ctx.log({
        kind: 'error',
        proto: 'WIFI',
        status: 'error',
        msg: {
          key: 'wifi.eapTimeout',
          params: { client: client.name, ssid: c.bss.ssid, server: radius?.host ?? '–' },
        },
      });
      return;
    }
    (appcOf(node.cfg).eapWait ??= {})[sent.id] = key;
    setEap(c.ap, key, { ...base, state: 'pending', rid: sent.id });
  });
}

/**
 * RADIUS-Antwort (`accepted`) bzw. Timeout (`undefined`) für ein wartendes 802.1X-Verfahren;
 * `false`, wenn die Anfrage nicht zu einem Client gehört.
 */
export function eapDecision(
  ctx: DeviceCtx,
  node: IpNode,
  reqId: number,
  accepted: boolean | undefined,
): boolean {
  const wait = appcOf(node.cfg).eapWait;
  const key = wait?.[reqId];
  const ap = hostOf(ctx.device)?.ap;
  if (!wait || key === undefined) return false;
  delete wait[reqId];
  const e = ap?.eap?.[key];
  if (!ap || !e) return true;
  e.state = accepted === true ? 'ok' : 'fail';
  e.rid = undefined;
  const ssid = key.split('|')[1] ?? '';
  ctx.log({
    kind: 'info',
    proto: 'WIFI',
    status: accepted === true ? 'ok' : 'error',
    msg: {
      key:
        accepted === true
          ? 'wifi.eapSuccess'
          : accepted === false
            ? 'wifi.eapFailure'
            : 'wifi.eapTimeout',
      params: { client: e.client, ssid, user: e.user, server: '' },
    },
  });
  ctx.requestWifiSync();
  return true;
}

/** Fehlgeschlagene 802.1X-Verfahren vergessen (z. B. nach Änderung der Serverkonfiguration) und neu verbinden. */
export function retryEap(eng: Engine): void {
  for (const d of Object.values(eng.state.devices)) {
    const eap = hostOf(d)?.ap?.eap;
    if (!eap) continue;
    for (const [k, e] of Object.entries(eap)) if (e.state === 'fail') delete eap[k];
  }
  wirelessSync(eng);
}

/**
 * Assoziationen aller WLAN-Clients neu berechnen (nach Verschieben, Strom, Konfiguration …).
 * Deterministisch: Geräte in Einfügereihenfolge, bester Kandidat = kleinste Entfernung (5 GHz bevorzugt).
 */
export function wirelessSync(eng: Engine): void {
  for (const client of Object.values(eng.state.devices)) {
    const cfg = hostOf(client);
    const w = cfg?.wifi;
    if (!cfg || !w || cfg.ap) continue;
    const usable = client.powered && !client.crashed && w.enabled;
    if (!usable) {
      if (w.assoc)
        disassociate(eng, client, cfg, client.powered ? 'wifi.reason.off' : 'wifi.reason.power');
      w.status = w.enabled ? 'idle' : 'off';
      continue;
    }
    if (w.profiles.length === 0) {
      if (w.assoc) disassociate(eng, client, cfg, 'wifi.reason.config');
      w.status = 'idle';
      continue;
    }
    const cands = candidates(eng, client, cfg);
    const good = cands.filter((c) => c.authOk).sort((a, b) => score(a) - score(b));
    const fresh = cands.filter((c) => c.eap === 'new').sort((a, b) => score(a) - score(b));
    const pending = cands.filter((c) => c.eap === 'pending');
    const best = good[0];
    const cur = w.assoc;
    if (cur) {
      const curCand = good.find(
        (c) => c.ap.id === cur.apId && c.bss.ssid === cur.ssid && c.bss.band === cur.band,
      );
      if (curCand && (!best || best === curCand || score(best) >= 0.7 * score(curCand))) {
        // Roaming zu einem näheren, noch nicht authentifizierten Enterprise-AP vorbereiten
        const f = fresh[0];
        if (f && score(f) < 0.7 * score(curCand) && (!best || score(f) < score(best)))
          startEap(eng, client, f);
        w.status = 'connected';
        continue;
      }
      disassociate(eng, client, cfg, curCand ? 'wifi.reason.roam' : 'wifi.reason.range');
    }
    if (best && associate(eng, client, cfg, best)) {
      w.status = 'connected';
    } else if (fresh[0] && !pending.length) {
      startEap(eng, client, fresh[0]);
      w.status = 'authenticating';
    } else if (pending.length > 0) {
      w.status = 'authenticating';
    } else if (cands.length > 0 && good.length === 0) {
      setStatus(eng, client, cfg, 'auth-failed', cands[0]?.bss.ssid);
    } else {
      setStatus(eng, client, cfg, 'no-ap', w.profiles[0]?.ssid);
    }
  }
}
