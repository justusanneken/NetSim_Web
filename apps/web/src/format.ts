import type { TFunction } from 'i18next';
import type { LogEntry, Msg } from '@netsim/engine';

export function shortPort(name: string): string {
  return name
    .replace('FastEthernet', 'Fa')
    .replace('GigabitEthernet', 'Gi')
    .replace('TenGigabitEthernet', 'Te')
    .replace(/^Port/, 'P');
}

/** Virtuelle Zeit (µs) als lesbarer String. */
export function formatTime(us: number): string {
  if (us >= 1_000_000) return `${(us / 1_000_000).toFixed(3)} s`;
  return `${(us / 1000).toFixed(3)} ms`;
}

/** Übersetzt eine Engine-Nachricht (Schlüssel + Parameter). */
export function translateMsg(t: TFunction, msg: Msg): string {
  const params: Record<string, string | number> = { ...msg.params };
  if (typeof params.reason === 'string') params.reason = t(params.reason);
  if (typeof params.rttUs === 'number') {
    params.time = params.rttUs < 1000 ? '<1' : (params.rttUs / 1000).toFixed(0);
  }
  return t(msg.key, params);
}

export function logToCsv(t: TFunction, log: LogEntry[]): string {
  const esc = (v: string): string => `"${v.replace(/"/g, '""')}"`;
  const rows = log.map((l) =>
    [
      String(l.t),
      esc(l.lastDeviceName ?? ''),
      esc(l.atDeviceName),
      l.proto,
      l.status,
      esc(translateMsg(t, l.msg)),
      esc(l.summary ?? ''),
    ].join(','),
  );
  return ['time_us,last_device,at_device,type,status,message,info', ...rows].join('\n');
}

export function download(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
