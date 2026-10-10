import { describe, expect, it } from 'vitest';
import { iosDiff } from '../src/ux/iosDiff';

const base = `hostname R1
!
interface GigabitEthernet0/0
 no ip address
 shutdown
!
ip route 10.0.0.0 255.0.0.0 192.168.1.2
end`;

describe('iosDiff (Equivalent IOS Commands)', () => {
  it('gleiche Konfiguration ergibt keine Befehle', () => {
    expect(iosDiff(base, base)).toEqual([]);
  });
  it('neue Schnittstellenadresse: Kopfzeile + neue Zeilen, alte Adresse wird ersetzt', () => {
    const next = base
      .replace(' no ip address', ' ip address 192.168.1.1 255.255.255.0')
      .replace(' shutdown\n', '');
    expect(iosDiff(base, next)).toEqual([
      'interface GigabitEthernet0/0',
      ' no shutdown',
      ' ip address 192.168.1.1 255.255.255.0',
    ]);
  });
  it('hostname wird ersetzt, ohne `no hostname`', () => {
    expect(iosDiff(base, base.replace('hostname R1', 'hostname Core'))).toEqual(['hostname Core']);
  });
  it('entfernte Route ergibt `no ip route …`', () => {
    expect(iosDiff(base, base.replace('ip route 10.0.0.0 255.0.0.0 192.168.1.2\n', ''))).toEqual([
      'no ip route 10.0.0.0 255.0.0.0 192.168.1.2',
    ]);
  });
  it('neue Blöcke werden komplett ausgegeben', () => {
    expect(iosDiff(base, base + '\nrouter rip\n version 2\n network 10.0.0.0')).toEqual([
      'router rip',
      ' version 2',
      ' network 10.0.0.0',
    ]);
  });
});
