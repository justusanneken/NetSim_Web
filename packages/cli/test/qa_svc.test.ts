import { describe, expect, it } from 'vitest';
import { Engine, type RouterConfig } from '@netsim/engine';
import { router, sec } from './gapsLab';

describe('QA services: bounded state', () => {
  it('syslog to an unreachable host does not grow the request table unboundedly', () => {
    const e = new Engine({ seed: 1 });
    const r = router(e, 'R1');
    r.run(
      'enable',
      'configure terminal',
      'logging host 192.0.2.99',
      'logging trap debugging',
      'end',
    );
    for (let i = 0; i < 200; i++) r.run('configure terminal', 'end');
    sec(e, 1);
    const cfg = e.getDevice(r.id)?.config as RouterConfig;
    expect(Object.keys(cfg.appc?.reqs ?? {}).length).toBeLessThanOrEqual(60);
  });
});
