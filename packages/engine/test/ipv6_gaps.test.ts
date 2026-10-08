import { describe, expect, it } from 'vitest';
import { must, sec } from './labs4';
import { switchLab } from './helpers';

const dadOf = (e: ReturnType<typeof switchLab>['e'], id: string, addr: string) => {
  const d = e.getDevice(id);
  if (d?.config.kind !== 'host') throw new Error('host');
  return d.config.dad?.[addr]?.state;
};

describe('IPv6 Duplicate Address Detection', () => {
  it('gleichzeitige Konfiguration derselben Adresse: beide erkennen das Duplikat', () => {
    const { e, ids } = switchLab(2);
    const [a, b] = ids as [string, string];
    must(e.setHostIpv6(a, { addr: '2001:db8::5', plen: 64 }));
    must(e.setHostIpv6(b, { addr: '2001:db8::5', plen: 64 }));
    sec(e, 3);
    expect(dadOf(e, a, '2001:db8::5')).toBe('dup');
    expect(dadOf(e, b, '2001:db8::5')).toBe('dup');
    expect(e.log.filter((l) => l.msg.key === 'nd.dad.dup')).toHaveLength(2);
    // Die Adresse ist nicht nutzbar: kein Eintrag in der Adressliste des Interfaces
    e.ping(a, '2001:db8::5', { count: 1 });
    e.runAll();
    const cfg = e.getDevice(a)?.config;
    expect(cfg?.kind === 'host' && cfg.pings.at(-1)?.status).not.toBe('reply');
  });

  it('später hinzukommender Knoten mit bereits genutzter Adresse scheitert, der Besitzer bleibt nutzbar', () => {
    const { e, ids } = switchLab(3);
    const [a, b, c] = ids as [string, string, string];
    must(e.setHostIpv6(a, { addr: '2001:db8::5', plen: 64 }));
    must(e.setHostIpv6(c, { addr: '2001:db8::7', plen: 64 }));
    sec(e, 3);
    expect(dadOf(e, a, '2001:db8::5')).toBe('ok');
    expect(e.log.some((l) => l.msg.key === 'nd.dad.ok')).toBe(true);
    must(e.setHostIpv6(b, { addr: '2001:db8::5', plen: 64 }));
    sec(e, 3);
    expect(dadOf(e, b, '2001:db8::5')).toBe('dup');
    expect(dadOf(e, a, '2001:db8::5')).toBe('ok');
    e.ping(c, '2001:db8::5', { count: 1 });
    e.runAll();
    const cfg = e.getDevice(c)?.config;
    expect(cfg?.kind === 'host' && cfg.pings.at(-1)?.status).toBe('reply');
  });

  it('Adresse entfernen und neu setzen startet DAD erneut', () => {
    const { e, ids } = switchLab(1);
    const [a] = ids as [string];
    must(e.setHostIpv6(a, { addr: '2001:db8::5', plen: 64 }));
    sec(e, 3);
    expect(dadOf(e, a, '2001:db8::5')).toBe('ok');
    must(e.setHostIpv6(a, { addr: '2001:db8::6', plen: 64 }));
    sec(e, 3);
    expect(dadOf(e, a, '2001:db8::5')).toBeUndefined();
    expect(dadOf(e, a, '2001:db8::6')).toBe('ok');
  });
});
