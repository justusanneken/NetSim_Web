import type { Engine } from '../engine';
import { announce, hostDhcp, hostNode, resetIpRuntime } from '../devices/host';
import { dhcpReboot } from '../svc/dhcpclient';
import type { Bss, WifiBand, WifiProfile, WifiStatus } from '../p5types';
import type { Device, HostConfig } from '../types';
import { deviceDistance } from './physical';

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
            band: r.band,
            channel: r.channel,
          });
      }
    } else if (r.ssid) {
      out.push({
        ssid: r.ssid,
        security: r.security,
        key: r.key,
        band: r.band,
        channel: r.channel,
      });
    }
  }
  return out;
}

interface Cand {
  ap: Device;
  bss: Bss;
  dist: number;
  authOk: boolean;
  profile: WifiProfile;
}

const authOk = (b: Bss, p: WifiProfile): boolean =>
  b.security === 'open' || (p.key !== undefined && p.key !== '' && p.key === b.key);

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
        out.push({ ap, bss, dist, authOk: authOk(bss, profile), profile });
      }
    }
  }
  return out;
}

/** 5 GHz wird bei gleicher Eignung bevorzugt (kleinerer Wert = besser). */
const score = (c: Cand): number => c.dist - (c.bss.band === '5' ? 50 : 0);

function disassociate(
  eng: Engine,
  client: Device,
  cfg: HostConfig,
  reason: string,
  keepIp = false,
): void {
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
  if (!keepIp) resetIpRuntime(cfg);
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

/** `roamed`: Wechsel auf einen anderen AP derselben SSID – IP-Konfiguration/Lease bleiben erhalten. */
function associate(eng: Engine, client: Device, cfg: HostConfig, c: Cand, roamed = false): boolean {
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
  if (!roamed) resetIpRuntime(cfg);
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
    if (roamed && cfg.ip) {
      // Gratuitous ARP lässt den Switch den neuen Pfad lernen; DHCP bestätigt das Lease nur (INIT-REBOOT)
      announce(ctx, cfg);
      if (cfg.dhcpClient.enabled && !dhcpReboot(ctx, hostNode(ctx, cfg), cfg))
        hostDhcp(ctx, cfg, true);
    } else if (cfg.dhcpClient.enabled) hostDhcp(ctx, cfg, true);
    else announce(ctx, cfg);
  });
  return true;
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
    const best = good[0];
    const cur = w.assoc;
    let roamed = false;
    if (cur) {
      const curCand = good.find(
        (c) => c.ap.id === cur.apId && c.bss.ssid === cur.ssid && c.bss.band === cur.band,
      );
      if (curCand && (!best || best === curCand || score(best) >= 0.7 * score(curCand))) {
        w.status = 'connected';
        continue;
      }
      roamed = best !== undefined && best.bss.ssid === cur.ssid;
      disassociate(eng, client, cfg, curCand ? 'wifi.reason.roam' : 'wifi.reason.range', roamed);
    }
    if (best && associate(eng, client, cfg, best, roamed)) {
      w.status = 'connected';
    } else if (cands.length > 0 && good.length === 0) {
      setStatus(eng, client, cfg, 'auth-failed', cands[0]?.bss.ssid);
    } else {
      setStatus(eng, client, cfg, 'no-ap', w.profiles[0]?.ssid);
    }
  }
}
