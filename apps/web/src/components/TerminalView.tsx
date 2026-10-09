import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../engine/client';

const token = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

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
      theme: {
        background: token('--term-bg'),
        foreground: token('--term-fg'),
        cursor: token('--term-cursor'),
      },
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
    // debug-Ausgaben kommen asynchron
    const poll = window.setInterval(() => {
      void api.termPoll(deviceId).then((o) => {
        if (!disposed && o) term.write(o);
      });
    }, 300);
    const ro = new ResizeObserver(doFit);
    ro.observe(el);
    term.focus();
    return () => {
      disposed = true;
      window.clearInterval(poll);
      sub.dispose();
      ro.disconnect();
      term.dispose();
    };
  }, [deviceId]);

  return <div className="term" ref={ref} role="group" aria-label={label} />;
}
