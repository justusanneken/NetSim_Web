import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import {
  Engine,
  MIGRATIONS,
  NSIM_SCHEMA,
  decodeNsim,
  encodeNsim,
  exportNsim,
  importNsim,
  inflateLimited,
  migrate,
  openNsim,
  parseNsimJson,
  type NsimDoc,
} from '../src';
import { switchLab, converge } from './helpers';
import { diamond } from './labs4';

const enc = (o: unknown): Uint8Array => zlibSync(new TextEncoder().encode(JSON.stringify(o)));
function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function sample(): { e: Engine; ids: string[]; doc: NsimDoc } {
  const { e, ids } = switchLab(3);
  return { e, ids, doc: exportNsim(e, { name: 'T', scenarios: { list: [1, 2] } }) };
}

describe('nsim: round-trip', () => {
  it('exports -> zlib -> decodes to an identical document', () => {
    const { doc } = sample();
    const back = must(decodeNsim(encodeNsim(doc)));
    expect(back).toEqual(doc);
    expect(back.schema).toBe(NSIM_SCHEMA);
    expect(back.scenarios).toEqual({ list: [1, 2] });
  });

  it('is deterministic (same state -> same bytes)', () => {
    const { doc } = sample();
    expect(encodeNsim(doc)).toEqual(encodeNsim(doc));
  });

  it('re-export after import equals the original (config, ports, MACs)', () => {
    const { e } = sample();
    const doc = exportNsim(e);
    const e2 = new Engine({ seed: 99 });
    must(importNsim(e2, doc));
    const again = exportNsim(e2);
    expect(again.topology).toEqual(doc.topology);
    expect(again.meta).toEqual(doc.meta);
    expect(again.physical).toEqual(doc.physical);
    // Laufzeit (ARP, MAC-Tabellen, STP) wird neu aufgebaut; ab dem zweiten Speichern ist alles stabil
    const e3 = new Engine();
    must(importNsim(e3, again));
    expect(exportNsim(e3)).toEqual(again);
  });

  it('the imported network keeps working: ping after load', () => {
    const { e, ids } = sample();
    const e2 = new Engine();
    must(openNsim(e2, encodeNsim(exportNsim(e))));
    converge(e2);
    const r = e2.ping(ids[0] as string, '10.0.0.2');
    expect(r.ok).toBe(true);
    e2.runUntil(e2.state.now + 3_000_000);
    const cfg = e2.getDevice(ids[0] as string)?.config;
    expect(cfg?.kind === 'host' && cfg.pings.at(-1)?.status).toBe('reply');
  });

  it('round-trips a routing lab with dynamic protocols and physical view', () => {
    const { e } = diamond();
    must(e.p5.addLocation('Berlin/HQ/R1'));
    const doc = exportNsim(e);
    const e2 = new Engine();
    must(importNsim(e2, must(decodeNsim(encodeNsim(doc)))));
    const again = exportNsim(e2);
    expect(again.topology).toEqual(doc.topology);
    expect(again.meta).toEqual(doc.meta);
    expect(again.physical).toEqual(doc.physical);
    // Laufzeit (ARP, MAC-Tabellen, STP) wird neu aufgebaut; ab dem zweiten Speichern ist alles stabil
    const e3 = new Engine();
    must(importNsim(e3, again));
    expect(exportNsim(e3)).toEqual(again);
    expect(e2.state.physical?.cities[0]?.name).toBe('Berlin');
  });

  it('keeps IoT scripts', () => {
    const e = new Engine();
    const note = e.addDevice('printer');
    const iot = e.addDevice('iot-sensor');
    e.p5.setIotScript(iot, 'return 42');
    const e2 = new Engine();
    must(importNsim(e2, must(decodeNsim(encodeNsim(exportNsim(e))))));
    expect(e2.getDevice(note)?.type).toBe('printer');
    expect(JSON.stringify(e2.getDevice(iot)?.config)).toContain('return 42');
  });
});

describe('nsim: migration', () => {
  it('walks the chain from an old schema to the current one', () => {
    const calls: number[] = [];
    const r = migrate(
      { schema: 1, x: 1 },
      {
        1: (d) => (calls.push(1), { ...d, y: 2 }),
        2: (d) => (calls.push(2), { ...d, z: 3 }),
      },
      3,
    );
    expect(r.ok && r.value).toEqual({ schema: 3, x: 1, y: 2, z: 3 });
    expect(calls).toEqual([1, 2]);
  });
  it('rejects newer, missing and broken migrations', () => {
    expect(migrate({ schema: 7 })).toMatchObject({ ok: false, error: 'nsim.newer' });
    expect(migrate({})).toMatchObject({ ok: false, error: 'nsim.noSchema' });
    expect(migrate({ schema: 0 })).toMatchObject({ ok: false, error: 'nsim.noSchema' });
    expect(migrate([])).toMatchObject({ ok: false, error: 'nsim.notObject' });
    expect(migrate({ schema: 1 }, {}, 2)).toMatchObject({ ok: false, error: 'nsim.noMigration' });
    expect(
      migrate(
        { schema: 1 },
        {
          1: () => {
            throw new Error('x');
          },
        },
        2,
      ),
    ).toMatchObject({ ok: false, error: 'nsim.migrationFailed' });
  });
  it('current schema has no pending migrations', () => {
    expect(Object.keys(MIGRATIONS)).toEqual([]);
  });
});

describe('nsim: rejects bad input without throwing', () => {
  const bad = (bytes: Uint8Array, error: string): void => {
    expect(decodeNsim(bytes)).toMatchObject({ ok: false, error });
  };

  it('garbage, empty, truncated and non-JSON', () => {
    bad(new Uint8Array(0), 'nsim.notNsim');
    bad(new TextEncoder().encode('{"schema":1}'), 'nsim.notNsim');
    const good = encodeNsim(sample().doc);
    bad(good.subarray(0, Math.floor(good.length / 2)), 'nsim.notNsim');
    bad(zlibSync(new TextEncoder().encode('not json')), 'nsim.badJson');
    bad(zlibSync(new Uint8Array([0xff, 0xfe, 0xfd])), 'nsim.badJson');
  });

  it('size limits: zip bomb and oversize input', () => {
    const bomb = zlibSync(new Uint8Array(3_000_000).fill(32));
    expect(inflateLimited(bomb, 1_000_000)).toMatchObject({ ok: false, error: 'nsim.tooLarge' });
    expect(inflateLimited(new Uint8Array(17 * 1024 * 1024))).toMatchObject({
      ok: false,
      error: 'nsim.tooLarge',
    });
  });

  it('structure violations', () => {
    const d = sample().doc;
    const firstId = d.topology.devices[0]!.id;
    const c = (f: (x: NsimDoc) => void): unknown => {
      const x = structuredClone(d);
      f(x);
      return x;
    };
    const cases: [string, unknown][] = [
      ['array root', []],
      ['wrong schema type', { ...d, schema: '1' }],
      [
        'unknown device type',
        c((x) => ((x.topology.devices[0] as { type: string }).type = 'toaster')),
      ],
      ['bad mac', c((x) => (x.topology.devices[0]!.ports[0]!.mac = 'zz'))],
      ['huge coordinate', c((x) => (x.topology.devices[0]!.pos.x = 1e12))],
      ['link to unknown device', c((x) => (x.topology.links[0]!.a.deviceId = 'nope'))],
      [
        'duplicate device id',
        c((x) => x.topology.devices.push(structuredClone(x.topology.devices[0]!))),
      ],
      [
        'port used twice',
        c((x) => x.topology.links.push({ ...structuredClone(x.topology.links[0]!), id: 'lx' })),
      ],
      ['config missing', c((x) => delete x.deviceStates[firstId])],
      ['config of unknown device', c((x) => (x.deviceStates['ghost'] = { kind: 'host' }))],
      ['config kind mismatch', c((x) => (x.deviceStates[firstId] = { kind: 'router' }))],
      [
        'config field of wrong type',
        c((x) => ((x.deviceStates[firstId] as Record<string, unknown>).arpCache = 5)),
      ],
      [
        'wrong cable for ports',
        c((x) => ((x.topology.links[0] as { cable: string }).cable = 'serial-dce')),
      ],
    ];
    for (const [name, doc] of cases) {
      const r = decodeNsim(enc(doc));
      const eng = new Engine();
      // Das Laden darf nie werfen und liefert immer einen nsim.*-Fehler
      expect(() => openNsim(eng, enc(doc)), name).not.toThrow();
      const o = openNsim(eng, enc(doc));
      expect(o.ok, name).toBe(false);
      if (!o.ok) expect(o.error, name).toMatch(/^nsim\./);
      void r;
    }
  });

  it('prototype pollution keys and deep nesting', () => {
    const raw = JSON.stringify(sample().doc).replace(
      '"meta":{',
      '"meta":{"__proto__":{"polluted":1},',
    );
    expect(parseNsimJson(raw)).toMatchObject({ ok: false, error: 'nsim.invalid' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = { a: deep };
    const d = { ...sample().doc, scenarios: deep };
    expect(parseNsimJson(JSON.stringify(d))).toMatchObject({ ok: false, error: 'nsim.invalid' });
  });

  it('scenarios are optional', () => {
    const d = sample().doc;
    delete d.scenarios;
    expect(must(decodeNsim(enc(d))).scenarios).toBeUndefined();
  });

  it('a failed import leaves the engine untouched', () => {
    const { e } = sample();
    const before = JSON.stringify(exportNsim(e));
    const r = openNsim(e, enc({ schema: 1 }));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(exportNsim(e))).toBe(before);
  });
});
