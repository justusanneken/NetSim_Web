import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { EXAMPLES } from '../scriptExamples';
import { runUserScript, stopScript } from '../scriptRunner';

interface ScriptState {
  open: boolean;
  code: string;
  output: string;
  running: boolean;
  setOpen(o: boolean): void;
  setCode(c: string): void;
  run(t: (k: string, p?: Record<string, string | number>) => string): Promise<void>;
}

/** Eigener kleiner Store, damit der globale Store unberührt bleibt. */
export const useScript = create<ScriptState>((set, get) => ({
  open: false,
  code: EXAMPLES[0]?.code ?? '',
  output: '',
  running: false,
  setOpen: (open) => set({ open }),
  setCode: (code) => set({ code }),
  async run(t) {
    if (get().running) return;
    set({ running: true, output: t('script.running') });
    try {
      const o = await runUserScript(get().code);
      if (o.kind === 'stopped') set({ output: t('script.stopped') });
      else if (o.kind === 'timeout') set({ output: t('script.timeout') });
      else if (o.kind === 'crash') set({ output: `${t('script.crash')}: ${o.message}` });
      else {
        const r = o.result;
        const lines = [...r.output];
        if (r.error)
          lines.push(
            `${t('script.error')}: ${r.error}${r.line ? ` (${t('script.line')} ${r.line})` : ''}`,
          );
        lines.push(
          '',
          t('script.summary', {
            steps: r.steps,
            events: r.events,
            sim: Math.round(r.simMs),
          }),
        );
        set({ output: lines.join('\n') });
      }
    } finally {
      set({ running: false });
    }
  },
}));

/** Extras → Skript-Konsole: Editor, Run/Stop, Ausgabe, Beispiele. */
export function ScriptConsole() {
  const { t } = useTranslation();
  const s = useScript();
  useEffect(() => {
    if (!s.open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && s.setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.open, s]);
  if (!s.open) return null;
  return (
    <div className="dialog-backdrop">
      <div className="dialog script-console" role="dialog" aria-label={t('script.title')}>
        <div className="dialog-head">
          <strong>{t('script.title')}</strong>
          <label className="script-ex">
            {t('script.examples')}
            <select
              aria-label={t('script.examples')}
              value=""
              disabled={s.running}
              onChange={(e) => {
                const ex = EXAMPLES.find((x) => x.id === e.target.value);
                if (ex) s.setCode(ex.code);
              }}
            >
              <option value="">{t('script.pick')}</option>
              {EXAMPLES.map((x) => (
                <option key={x.id} value={x.id}>
                  {t(x.label)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            disabled={s.running}
            onClick={() => void s.run(t)}
            aria-label={t('script.run')}
          >
            ▶ {t('script.run')}
          </button>
          <button disabled={!s.running} onClick={stopScript} aria-label={t('script.stop')}>
            ■ {t('script.stop')}
          </button>
          <button onClick={() => s.setOpen(false)} aria-label={t('script.close')}>
            ✕
          </button>
        </div>
        <div className="script-body">
          <textarea
            className="script-editor mono"
            aria-label={t('script.editor')}
            spellCheck={false}
            value={s.code}
            onChange={(e) => s.setCode(e.target.value)}
          />
          <pre className="script-output mono" role="log" aria-label={t('script.output')}>
            {s.output}
          </pre>
        </div>
        <p className="muted script-hint">{t('script.hint')}</p>
      </div>
    </div>
  );
}
