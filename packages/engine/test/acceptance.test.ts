import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src';
import { hubLab, keys, serializeLog, switchLab } from './helpers';

describe('Abnahme Phase 1 (a): 3 PCs an 1 Switch', () => {
  it('erster Ping flutet ARP, danach nur Unicast, MAC-Tabelle hat 3 Einträge', () => {
    const { e, ids, sw } = switchLab(3);
    const [pc0, pc1, pc2] = ids as [string, string, string];
    e.log.length = 0;

    expect(e.ping(pc0, '10.0.0.2').ok).toBe(true);
    e.runAll();

    // ARP-Request wurde am Switch geflutet (unbekanntes Ziel/Broadcast) …
    const floods = e.log.filter((l) => l.msg.key.startsWith('switch.flood'));
    expect(floods.length).toBeGreaterThanOrEqual(1);
    expect(floods[0]?.frame?.payload.kind).toBe('arp');
    // … PC2 hat ihn empfangen und verworfen, PC1 hat geantwortet.
    expect(e.log.some((l) => l.atDeviceName === 'PC2' && l.msg.key === 'host.arp.notMine')).toBe(
      true,
    );
    expect(e.log.some((l) => l.atDeviceName === 'PC1' && l.msg.key === 'host.arp.request')).toBe(
      true,
    );
    expect(e.getDevice(pc0)?.config).toMatchObject({ pings: [{ status: 'reply' }] });

    // Dritter PC meldet sich ebenfalls → 3 MAC-Einträge.
    e.ping(pc2, '10.0.0.1');
    e.runAll();
    expect(e.macTable(sw as string)).toHaveLength(3);

    // Zweiter Ping: kein Flooding mehr, nur Unicast.
    const mark = e.log.length;
    e.ping(pc0, '10.0.0.2');
    e.runAll();
    const second = e.log.slice(mark);
    expect(second.some((l) => l.msg.key.startsWith('switch.flood'))).toBe(false);
    expect(second.filter((l) => l.msg.key.startsWith('switch.unicast'))).toHaveLength(2);
    expect(second.some((l) => l.frame?.payload.kind === 'arp')).toBe(false);
    expect(e.getDevice(pc0)?.config).toMatchObject({
      pings: [{ status: 'reply' }, { status: 'reply' }],
    });
    void pc1;
  });
});

describe('Abnahme Phase 1 (b): Kabelvalidierung', () => {
  const twoPcs = (cable: 'straight' | 'crossover') => {
    const e = new Engine();
    const a = e.addDevice('pc');
    const b = e.addDevice('pc');
    const r = e.connect({ deviceId: a, portId: 'p0' }, { deviceId: b, portId: 'p0' }, cable);
    if (!r.ok) throw new Error(r.error);
    return { e, a, link: r.value };
  };

  it('PC↔PC mit Straight = down', () => {
    const { e, a, link } = twoPcs('straight');
    expect(link.operUp).toBe(false);
    expect(link.cableProblem).toBe('cable.problem.mdi');
    expect(e.getDevice(a)?.ports[0]?.operUp).toBe(false);
  });

  it('PC↔PC mit Crossover = up', () => {
    const { e, a, link } = twoPcs('crossover');
    expect(link.operUp).toBe(true);
    expect(e.getDevice(a)?.ports[0]?.operUp).toBe(true);
    expect(e.getDevice(a)?.ports[0]?.operSpeed).toBe(100);
  });
});

describe('Abnahme Phase 1 (c): Determinismus (Golden-File)', () => {
  const golden = fileURLToPath(new URL('./golden/switch-ping.json', import.meta.url));

  const scenario = (): string[] => {
    const { e, ids } = switchLab(3, 42);
    const [a, b, c] = ids as [string, string, string];
    e.ping(a, '10.0.0.2', { count: 2 });
    e.ping(c, '10.0.0.1');
    e.runAll();
    e.ping(b, '10.0.0.3');
    e.runAll();
    return serializeLog(e.log);
  };

  it('gleiche Topologie + Seed + Eingaben ⇒ identisches Event-Log', () => {
    expect(scenario()).toEqual(scenario());
  });

  it('entspricht dem Golden-File', () => {
    const actual = scenario();
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(golden)) {
      writeFileSync(golden, JSON.stringify(actual, null, 2) + '\n');
    }
    expect(actual).toEqual(JSON.parse(readFileSync(golden, 'utf8')));
  });

  it('Hub-Kollisionen sind mit gleichem Seed reproduzierbar', () => {
    const run = (seed: number): string[] => {
      const { e, ids } = hubLab(3, seed);
      e.ping(ids[0] as string, '10.0.0.3');
      e.ping(ids[1] as string, '10.0.0.3');
      e.runAll();
      return serializeLog(e.log);
    };
    expect(run(7)).toEqual(run(7));
    expect(keys(hubLab().e.log)).toBeDefined();
  });
});
