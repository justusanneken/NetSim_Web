import { debugStamp, formatClock, parseClockSet } from './clock';
import { K, P, type Registry } from './parser';
import { CliError, type CliSession } from './session';

/** Sonstiges: `clock set` (setzt die Systemuhr; `show clock` und `debug`-Zeitstempel folgen ihr). */
export function addMisc(r: Registry<CliSession>): void {
  r.add({
    modes: ['priv'],
    slots: [
      K('clock', 'Manage the system clock'),
      K('set', 'Set the time and date'),
      P('time', 'word', 'hh:mm:ss', 'Current Time'),
      P('a', 'word', '<1-31>|MONTH', 'Day of the month (or month name)'),
      P('b', 'word', 'MONTH|<1-31>', 'Month of the year (or day)'),
      P('year', 'int', '<1993-2035>', 'Year', [1993, 2035]),
    ],
    run: (s, a) => {
      const res = parseClockSet(a.time as string, a.a as string, a.b as string, a.year as string);
      if ('error' in res) throw new CliError(res.error);
      const old = formatClock(s.sys, s.engine.state.now).replace(/\.\d+/, '').replace(/^\*/, '');
      s.sys.clock = { baseMs: res.ms, atUs: s.engine.state.now };
      const now = formatClock(s.sys, s.engine.state.now).replace(/\.\d+/, '');
      s.out(
        `${debugStamp(s.sys, s.engine.state.now)}: %SYS-6-CLOCKUPDATE: System clock has been updated from ${old} to ${now}, configured from console by console.`,
      );
    },
  });
}
