import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../engine/client';

/** xterm.js-Anbindung an die Terminal-Sitzung eines Geräts (läuft im Engine-Worker). */
export function TerminalView({ deviceId, label }: { deviceId: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      theme: { background: '#0b0f14', foreground: '#d6e2ee', cursor: '#9be9a8' },
      scrollback: 5000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const doFit = () => {
      try {
        fit.fit();
      } catch {
        /* Element noch nicht sichtbar */
      }
    };
    doFit();
    let disposed = false;
    void api.termOpen(deviceId).then((s) => {
      if (!disposed && s !== undefined) term.write(s);
    });
    const sub = term.onData((d) => {
      void api.termData(deviceId, d).then((o) => {
        if (!disposed && o) term.write(o);
      });
    });
    const ro = new ResizeObserver(doFit);
    ro.observe(el);
    term.focus();
    return () => {
      disposed = true;
      sub.dispose();
      ro.disconnect();
      term.dispose();
    };
  }, [deviceId]);

  return <div className="term" ref={ref} role="group" aria-label={label} />;
}
