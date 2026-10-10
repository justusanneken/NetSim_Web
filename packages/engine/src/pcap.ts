import { writePcap, type Frame, type PcapRecord } from '@netsim/protocols';
import type { LogEntry } from './types';

/**
 * Event-Log → PCAP-Datensätze. Ein Datensatz je Frame-Ankunft an einem Gerät (Einträge der Arten `rx` und `drop`
 * mit Frame); mehrfach geloggte Ankünfte desselben Frames am selben Gerät/Zeitpunkt werden zusammengefasst.
 * `deviceId`: nur Frames, die an diesem Gerät angekommen sind (Capture „am Gerät“).
 */
export function pcapRecords(log: readonly LogEntry[], deviceId?: string): PcapRecord[] {
  const seen = new Map<Frame, Set<string>>();
  const out: PcapRecord[] = [];
  for (const l of log) {
    if (!l.frame || (l.kind !== 'rx' && l.kind !== 'drop')) continue;
    if (deviceId !== undefined && l.atDeviceId !== deviceId) continue;
    const key = `${l.atDeviceId}|${l.t}`;
    let keys = seen.get(l.frame);
    if (!keys) seen.set(l.frame, (keys = new Set()));
    if (keys.has(key)) continue;
    keys.add(key);
    out.push({ t: l.t, frame: l.frame });
  }
  return out;
}

/** Komplette libpcap-Datei (LINKTYPE_ETHERNET) aus dem Event-Log. */
export function logToPcap(log: readonly LogEntry[], deviceId?: string): Uint8Array {
  return writePcap(pcapRecords(log, deviceId));
}
