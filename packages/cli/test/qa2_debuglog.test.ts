import { describe, expect, it } from 'vitest';
import { SimController } from '@netsim/engine';
import { CliSession } from '../src';
import { diamond, sec } from './gapsLab';

function lab() {
  const L = diamond();
  for (const r of [L.r1, L.r2])
    r.run(
      'configure terminal',
      'router ospf 1',
      'network 10.0.12.0 0.0.0.255 area 0',
      'end',
      'debug ip ospf adj',
    );
  return L;
}

describe('QA2: begrenztes Log, Step Back und debug-Cursor', () => {
  it('nach einem Restore (Step Back) gibt poll() bereits gezeigte debug-Zeilen nicht erneut aus', () => {
    const { e, r1 } = lab();
    sec(e, 5);
    const snap = e.snapshot();
    sec(e, 60);
    const first = r1.s.poll();
    expect(first).toContain('OSPF-1 ADJ');
    e.restore(snap);
    expect(r1.s.poll()).toBe('');
    // danach erscheinen nur die neu erzeugten Zeilen (identisch zum ersten Lauf ab dem Snapshot)
    sec(e, 60);
    const again = r1.s.poll();
    expect(again).not.toBe('');
    expect(first.endsWith(again)).toBe(true);
  });

  it('Step Back im SimController und das begrenzte Log bleiben konsistent (Ids lückenlos)', () => {
    const { e, pc1 } = lab();
    sec(e, 40);
    e.state.config.maxLogEntries = 50;
    e.ping(pc1, '10.1.0.1', { count: 200 });
    const ctl = new SimController({ seed: 1 });
    // Engine des Labors übernehmen
    (ctl as unknown as { engine: typeof e }).engine = e;
    for (let i = 0; i < 200; i++) expect(ctl.step()).toBe(true);
    expect(e.logOffset).toBeGreaterThan(0);
    const v1 = ctl.view();
    expect(e.log.length).toBeLessThanOrEqual(50);
    expect(e.log[0]?.id).toBe(e.logOffset);
    for (let i = 0; i < 20; i++) expect(ctl.stepBack()).toBe(true);
    const v2 = ctl.view();
    expect(v2.logLength).toBeLessThan(v1.logLength);
    e.log.forEach((l, i) => expect(l.id).toBe(e.logOffset + i));
    for (let i = 0; i < 20; i++) ctl.step();
    e.log.forEach((l, i) => expect(l.id).toBe(e.logOffset + i));
    expect(ctl.view().logLength).toBe(v1.logLength);
  });

  it('eine neue CLI-Sitzung nach Trimmen zeigt keine alten Zeilen', () => {
    const { e, r1 } = lab();
    e.state.config.maxLogEntries = 30;
    sec(e, 60);
    const s = new CliSession(e, r1.id);
    expect(s.poll()).toBe('');
  });
});
