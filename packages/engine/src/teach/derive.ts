import type { Engine } from '../engine';
import type { Device, L3Cfg } from '../types';
import { CheckSchema, evaluateChecks, SETTLE_US, type Check, type CheckInput } from './checks';
import { cloneEngine } from './clone';
import { deviceIp } from './pdu';

/**
 * Prueflisten aus einem Antwortnetz ableiten: Aus dem Antwortnetz werden alle plausiblen Behauptungen
 * (Kandidaten) erzeugt; behalten werden die, die im Antwortnetz gelten und im Startnetz noch nicht – also
 * genau das, was die Teilnehmer erst herstellen muessen.
 */

const MAX_PING_PAIRS = 24;

function l3(d: Device): L3Cfg | undefined {
  return d.config.kind === 'router' || d.config.kind === 'switch' ? (d.config as L3Cfg) : undefined;
}

function candidates(answer: Engine): CheckInput[] {
  const out: CheckInput[] = [];
  let n = 0;
  const add = (c: object): void => {
    out.push({ ...c, id: `d${++n}` } as CheckInput);
  };
  const devs = Object.values(answer.state.devices).sort((a, b) => a.name.localeCompare(b.name));
  const settled = cloneEngine(answer);
  settled.runUntil(settled.state.now + SETTLE_US);
  for (const d of devs) {
    const c = d.config;
    add({ type: 'deviceExists', device: d.name, deviceType: d.type });
    if (c.kind === 'host') {
      if (c.ip) add({ type: 'hostIp', device: d.name, ip: c.ip, mask: c.mask, gateway: c.gateway });
      if (c.dhcpClient.enabled) add({ type: 'dhcpLease', device: d.name });
      continue;
    }
    if (c.kind !== 'router' && c.kind !== 'switch') continue;
    const cfg = c as L3Cfg;
    for (const [id, i] of Object.entries(cfg.ifaces).sort(([a], [b]) => a.localeCompare(b))) {
      const port = d.ports.find((p) => p.id === id);
      const name = port?.name ?? id;
      if (i.ip) add({ type: 'ifaceIp', device: d.name, iface: name, ip: i.ip, mask: i.mask });
      if (i.ip && i.kind === 'phys')
        add({ type: 'ifaceState', device: d.name, iface: name, up: true });
      if (i.aclIn)
        add({
          type: 'config',
          device: d.name,
          spec: { item: 'ifaceAcl', iface: name, direction: 'in', acl: i.aclIn },
        });
      if (i.aclOut)
        add({
          type: 'config',
          device: d.name,
          spec: { item: 'ifaceAcl', iface: name, direction: 'out', acl: i.aclOut },
        });
      if (i.natSide)
        add({
          type: 'config',
          device: d.name,
          spec: { item: 'natRole', iface: name, side: i.natSide },
        });
      for (const h of i.helpers ?? [])
        add({
          type: 'config',
          device: d.name,
          spec: { item: 'helperAddress', iface: name, ip: h },
        });
    }
    const sysCfg = c.sys;
    if (sysCfg.hostname)
      add({ type: 'config', device: d.name, spec: { item: 'hostname', value: sysCfg.hostname } });
    if (sysCfg.domainName)
      add({
        type: 'config',
        device: d.name,
        spec: { item: 'domainName', value: sysCfg.domainName },
      });
    if (sysCfg.enableSecret)
      add({ type: 'config', device: d.name, spec: { item: 'enableSecret' } });
    for (const u of Object.keys(sysCfg.mgmt?.users ?? {}))
      add({ type: 'config', device: d.name, spec: { item: 'username', name: u } });
    for (const s of sysCfg.mgmt?.ntp.servers ?? [])
      add({ type: 'config', device: d.name, spec: { item: 'ntpServer', ip: s } });
    if (sysCfg.domainName && sysCfg.mgmt?.ssh.keyBits !== undefined)
      add({ type: 'config', device: d.name, spec: { item: 'ssh' } });
    for (const acl of Object.values(cfg.acls))
      for (const en of acl.entries) {
        const a = (m: typeof en.src | undefined): string | undefined => {
          if (!m) return undefined;
          if ('any' in m) return 'any';
          const wc = m.wildcard.split('.').map(Number);
          const bits = wc.reduce((s, x) => s + (8 - Math.log2(x + 1)), 0);
          return Number.isInteger(bits) ? `${m.ip}/${bits}` : undefined;
        };
        add({
          type: 'config',
          device: d.name,
          spec: {
            item: 'aclEntry',
            acl: acl.name,
            action: en.action,
            protocol:
              en.proto === 'ip' || en.proto === 'icmp' || en.proto === 'tcp' || en.proto === 'udp'
                ? en.proto
                : undefined,
            dstPort: en.dstPort?.op === 'eq' ? en.dstPort.a : undefined,
            src: a(en.src),
          },
        });
      }
    if (cfg.nat.rules.some((r) => (r.kind === 'dynamic' && r.overload) || r.kind === 'interface'))
      add({ type: 'config', device: d.name, spec: { item: 'natOverload' } });
    for (const r of cfg.nat.rules)
      if (r.kind === 'static')
        add({
          type: 'config',
          device: d.name,
          spec: { item: 'natStatic', local: r.local, global: r.global },
        });
    for (const p of cfg.dhcp.pools)
      add({
        type: 'config',
        device: d.name,
        spec: { item: 'dhcpPool', network: p.network, router: p.router },
      });
    for (const o of Object.values(cfg.routing.ospf))
      for (const nw of o.networks)
        add({
          type: 'config',
          device: d.name,
          spec: { item: 'ospfNetwork', pid: o.pid, network: nw.prefix, area: nw.area },
        });
    if (cfg.defaultGateway)
      add({
        type: 'config',
        device: d.name,
        spec: { item: 'defaultGateway', ip: cfg.defaultGateway },
      });
    for (const r of settled.routingTable(d.id)) {
      if (r.type === 'L' || r.type === 'C') continue;
      const source = ({ S: 'static', R: 'rip', O: 'ospf', D: 'eigrp', B: 'bgp' } as const)[r.type];
      add({
        type: 'route',
        device: d.name,
        prefix: r.prefix,
        plen: r.plen,
        source,
        via: r.type === 'S' ? r.nextHop : undefined,
      });
    }
    let nbrs = 0;
    const sc = settled.state.devices[d.id]?.config as L3Cfg | undefined;
    for (const o of Object.values(sc?.routing.ospf ?? {}))
      for (const ifs of Object.values(o.ifs ?? {}))
        for (const nb of Object.values(ifs.neighbors)) if (nb.state === 'full') nbrs++;
    if (nbrs > 0) add({ type: 'ospfNeighbors', device: d.name, min: nbrs });
    if (c.kind === 'switch') {
      for (const [vid, v] of Object.entries(c.vlans))
        if (Number(vid) !== 1 && !(Number(vid) >= 1002 && Number(vid) <= 1005))
          add({ type: 'vlanExists', device: d.name, vlan: Number(vid), name: v.name });
      for (const p of d.ports) {
        const pc = c.ports[p.id];
        if (!pc || pc.routed) continue;
        if (pc.mode === 'access' && pc.accessVlan !== 1)
          add({ type: 'vlanMember', device: d.name, port: p.name, vlan: pc.accessVlan });
        if (pc.mode === 'trunk')
          add({
            type: 'trunk',
            device: d.name,
            port: p.name,
            native: pc.nativeVlan !== 1 ? pc.nativeVlan : undefined,
          });
        if (pc.portfast)
          add({ type: 'config', device: d.name, spec: { item: 'portfast', port: p.name } });
        if (pc.psec.enabled)
          add({ type: 'config', device: d.name, spec: { item: 'portSecurity', port: p.name } });
      }
    }
  }
  return out;
}

/** Verkehrskandidaten: Pings zwischen Endgeraeten und HTTP-Zugriffe auf Webserver (begrenzt). */
function trafficCandidates(answer: Engine): CheckInput[] {
  const hosts = Object.values(answer.state.devices)
    .filter((d) => d.config.kind === 'host' && deviceIp(d))
    .sort((a, b) => a.name.localeCompare(b.name));
  const out: CheckInput[] = [];
  for (const a of hosts)
    for (const b of hosts) {
      if (a === b) continue;
      if (out.length < MAX_PING_PAIRS)
        out.push({ id: `t${out.length}`, type: 'ping', from: a.name, to: b.name });
      if (
        b.config.kind === 'host' &&
        b.config.services.http.enabled &&
        out.length < 2 * MAX_PING_PAIRS
      )
        out.push({
          id: `t${out.length}`,
          type: 'service',
          from: a.name,
          to: b.name,
          protocol: 'http',
        });
    }
  return out;
}

/**
 * Leitet Pruefungen ab. `start` ist das Startnetz, `answer` das Antwortnetz. Liefert nur Pruefungen, die im
 * Antwortnetz gelten und im Startnetz nicht – also das, was die Teilnehmer erst herstellen muessen. Verkehr,
 * der im Startnetz funktioniert und im Antwortnetz gesperrt ist (ACL), wird als Pruefung mit Erwartung
 * `fail` aufgenommen.
 */
export function deriveChecks(start: Engine, answer: Engine): Check[] {
  const cands = [...candidates(answer), ...trafficCandidates(answer)].map((c) =>
    CheckSchema.parse(c),
  );
  const onAnswer = evaluateChecks(answer, cands);
  const onStart = evaluateChecks(start, cands);
  const keep: Check[] = [];
  cands.forEach((c, i) => {
    const a = onAnswer.results[i]?.passed;
    const s = onStart.results[i]?.passed;
    if (a && !s) keep.push(c);
    else if (!a && s && (c.type === 'ping' || c.type === 'service'))
      keep.push(CheckSchema.parse({ ...c, expect: 'fail' }));
  });
  return keep.map((c, i) => ({ ...c, id: `c${i + 1}` }));
}
