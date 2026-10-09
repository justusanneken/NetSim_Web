import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceView } from '@netsim/engine';
import { api } from '../engine/client';
import { hasCli } from '../deviceKinds';
import { useStore } from '../store';
import { iosDiff } from './iosDiff';

/**
 * „Equivalent IOS Commands“ für alle GUI-Formulare eines Routers/Switches: zeigt die IOS-Befehle, die
 * der letzten Änderung (GUI oder CLI) entsprechen – abgeleitet aus der Differenz der running-config.
 */
export function EquivalentIos({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const view = useStore((s) => s.view);
  const [lines, setLines] = useState<string[]>([]);
  const prev = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cli = hasCli(dev);

  useEffect(() => {
    if (!cli || timer.current) return;
    timer.current = setTimeout(
      () => {
        timer.current = undefined;
        void api.runningConfig(dev.id).then((cfg) => {
          if (prev.current !== null && prev.current !== cfg) {
            const d = iosDiff(prev.current, cfg);
            if (d.length > 0) setLines(d);
          }
          prev.current = cfg;
        });
      },
      prev.current === null ? 0 : 400,
    );
  }, [view, cli, dev.id]);

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!cli) return null;
  return (
    <details open className="equiv equiv-auto">
      <summary>{t('mgmt.equivalent')}</summary>
      {lines.length === 0 ? (
        <p className="muted small">{t('ux.equiv.none')}</p>
      ) : (
        <pre className="mono">{lines.join('\n')}</pre>
      )}
    </details>
  );
}
