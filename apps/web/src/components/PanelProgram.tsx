import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceView } from '@netsim/engine';
import { api } from '../engine/client';
import { useCall } from './util5';

const EXAMPLE = `// Thermostat: switch the actuator when it gets warm
let ticks = 0;
log('program started');
every(2000, () => {
  ticks++;
  const t = readSensor('self');
  setActuator('self', t > 25);
  log('tick', ticks, 'temperature', t);
});
onReport((name, value) => {
  log('report from', name, value);
});
`;

/** Programmier-Tab eines IoT-/SBC-Geräts: Editor, Run/Stop und Konsole. */
export function ProgramTab({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const call = useCall();
  const script = dev.p5?.iot?.script;
  const [code, setCode] = useState(script?.code ?? '');
  const [dirty, setDirty] = useState(false);
  const stored = script?.code;

  useEffect(() => {
    if (!dirty && stored !== undefined) setCode(stored);
  }, [stored, dirty]);

  const run = async (): Promise<void> => {
    if (!(await call(api.setIotScript(dev.id, code)))) return;
    setDirty(false);
    await call(api.runIotScript(dev.id, true));
  };
  const status = script?.error ? 'error' : script?.running ? 'running' : 'stopped';

  return (
    <div className="program">
      <div className="program-bar">
        <button onClick={() => void run()}>{t('prog.run')}</button>
        <button
          disabled={!script?.running}
          onClick={() => void call(api.runIotScript(dev.id, false))}
        >
          {t('prog.stop')}
        </button>
        <button
          onClick={() => {
            setCode(EXAMPLE);
            setDirty(true);
          }}
        >
          {t('prog.example')}
        </button>
        <span className={`prog-status ${status}`} role="status">
          {t(`prog.status.${status}`)}
        </span>
      </div>
      <textarea
        className="program-editor"
        aria-label={t('prog.editor')}
        spellCheck={false}
        value={code}
        placeholder={t('prog.placeholder')}
        onChange={(e) => {
          setCode(e.target.value);
          setDirty(true);
        }}
      />
      <p className="muted small">{t('prog.api')}</p>
      <div className="program-console-head">{t('prog.console')}</div>
      <pre className="program-console" aria-label={t('prog.console')} aria-live="polite">
        {(script?.out ?? []).join('\n')}
      </pre>
    </div>
  );
}
