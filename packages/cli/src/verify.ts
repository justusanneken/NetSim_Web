import { setImportVerifier, type Engine } from '@netsim/engine';
import { CliSession } from './session';

/**
 * Anzeigebefehle, die beim Import probeweise auf einer Kopie laufen. Sie lesen zusammen praktisch den
 * gesamten Konfigurationsbaum; eine Ausnahme (falscher Typ in einer feindlichen Datei) lehnt den Import ab.
 */
const PROBES = [
  'show running-config',
  'show interfaces',
  'show ip route',
  'show access-lists',
  'show ipv6 access-list',
  'show cdp neighbors detail',
  'show lldp neighbors',
  'show ip dhcp snooping',
  'show ip dhcp snooping binding',
  'show ip arp inspection',
  'show storm-control',
  'show errdisable recovery',
  'show policy-map interface',
  'show ip ospf interface',
  'show ntp associations',
  'show logging',
  'show snmp user',
];

/** Prüft jedes CLI-Gerät einer (Probe-)Engine; wirft bei internen Fehlern. */
export function verifyImport(e: Engine): void {
  for (const d of Object.values(e.state.devices)) {
    if (d.config.kind !== 'router' && d.config.kind !== 'switch') continue;
    const s = new CliSession(e, d.id);
    s.mode = 'priv';
    for (const c of PROBES) s.input(c);
  }
}

// Wer das CLI-Paket lädt (Worker, Tests, Werkzeuge), bekommt die Prüfung automatisch.
setImportVerifier(verifyImport);
