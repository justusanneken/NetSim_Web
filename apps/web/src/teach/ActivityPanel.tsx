import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../engine/client';
import { checkLabel, failReason, pickText } from './describe';
import { useTeach } from './teachStore';

interface Example {
  id: string;
  title: unknown;
  description: unknown;
  difficulty?: number;
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Aufgabenmodus (Teilnehmer): laden, Schrittanleitung, Prüfen, Fortschritt je Prüfung. */
export function ActivityPanel() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const act = useTeach((s) => s.activity);
  const results = useTeach((s) => s.results);
  const live = useTeach((s) => s.live);
  const checking = useTeach((s) => s.checking);
  const startedAt = useTeach((s) => s.startedAt);
  const expired = useTeach((s) => s.expired);
  const hints = useTeach((s) => s.hintsShown);
  const load = useTeach((s) => s.loadActivity);
  const close = useTeach((s) => s.closeActivity);
  const check = useTeach((s) => s.checkActivity);
  const liveCheck = useTeach((s) => s.liveCheck);
  const restart = useTeach((s) => s.restartActivity);
  const showAnswer = useTeach((s) => s.showAnswer);
  const showHint = useTeach((s) => s.showHint);
  const expire = useTeach((s) => s.expire);
  const setAuthor = useTeach((s) => s.setAuthorOpen);
  const [examples, setExamples] = useState<Example[]>([]);
  const [exId, setExId] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api.exampleList().then((l) => {
      setExamples(l as Example[]);
      setExId((cur) => cur || (l[0]?.id ?? ''));
    });
  }, []);

  // Zeitlimit
  const limit = act?.timeLimitSec ?? 0;
  useEffect(() => {
    if (!act || limit <= 0 || startedAt === null || expired) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [act, limit, startedAt, expired]);
  const remaining = limit > 0 && startedAt !== null ? limit - (now - startedAt) / 1000 : null;
  useEffect(() => {
    if (remaining !== null && remaining <= 0) void expire();
  }, [remaining, expire]);

  // Live-Fortschritt (optional, vom Autor eingeschaltet)
  const liveOn = act?.liveProgress === true && !expired;
  useEffect(() => {
    if (!liveOn) return;
    void liveCheck();
    const id = setInterval(() => void liveCheck(), 3000);
    return () => clearInterval(id);
  }, [liveOn, liveCheck]);

  const onFile = async (f: File | undefined): Promise<void> => {
    if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    await load(buf);
    if (file.current) file.current.value = '';
  };

  if (!act) {
    return (
      <div className="activity-panel">
        <p className="muted">{t('activity.intro')}</p>
        <div className="pdu-row">
          <label htmlFor="act-example">{t('activity.example')}</label>
          <select id="act-example" value={exId} onChange={(e) => setExId(e.target.value)}>
            {examples.map((x) => (
              <option key={x.id} value={x.id}>
                {pickText(x.title as string, lang)}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              void api.exampleLoad(exId).then(async (r) => {
                if (r.ok) await load(r.value);
              });
            }}
            disabled={!exId}
          >
            {t('activity.loadExample')}
          </button>
        </div>
        <div className="pdu-row">
          <label htmlFor="act-file">{t('activity.openFile')}</label>
          <input
            id="act-file"
            ref={file}
            type="file"
            accept=".nsact"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </div>
        <div className="pdu-row">
          <button onClick={() => setAuthor(true)}>{t('activity.author')}</button>
        </div>
      </div>
    );
  }

  const percent = results?.percent ?? live;
  const passed = results !== null && results.percent >= act.passPercent;
  return (
    <div className="activity-panel">
      <h3 className="act-title">{pickText(act.meta.title, lang)}</h3>
      {act.meta.description && <p>{pickText(act.meta.description, lang)}</p>}
      <div className="act-progress">
        <div
          role="progressbar"
          aria-label={t('activity.progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? 0}
          className="bar"
        >
          <div className="fill" style={{ width: `${percent ?? 0}%` }} />
        </div>
        <span className="pct" aria-live="polite" data-testid="act-percent">
          {percent === null ? t('activity.notChecked') : `${percent} %`}
        </span>
        {remaining !== null && (
          <span className={`timer${remaining < 60 ? ' low' : ''}`} role="timer">
            {t('activity.timeLeft', { time: fmtTime(remaining) })}
          </span>
        )}
      </div>
      {expired && (
        <p className="warn" role="alert">
          {t('activity.expired')}
        </p>
      )}
      {passed && (
        <p className="ok" role="status">
          {t('activity.passed')}
        </p>
      )}
      <div className="pdu-row">
        <button className="primary" onClick={() => void check()} disabled={checking}>
          {t('activity.check')}
        </button>
        <button onClick={() => void restart()}>{t('activity.restart')}</button>
        {act.hasAnswer && <button onClick={() => void showAnswer()}>{t('activity.answer')}</button>}
        <button onClick={() => void close()}>{t('activity.close')}</button>
      </div>
      {act.steps.length > 0 && (
        <details open>
          <summary>{t('activity.steps')}</summary>
          <ol className="act-steps">
            {act.steps.map((s, i) => (
              <li key={i}>
                {s.title && <strong>{pickText(s.title, lang)}: </strong>}
                {pickText(s.text, lang)}
              </li>
            ))}
          </ol>
        </details>
      )}
      <ul className="act-checks" aria-label={t('activity.checks')}>
        {act.checks.map((c) => {
          const r = results?.results.find((x) => x.id === c.id);
          const state = r === undefined ? 'open' : r.passed ? 'pass' : 'fail';
          const hint = pickText(c.hint, lang);
          return (
            <li key={c.id} className={`act-check ${state}`} data-state={state}>
              <span className="mark" aria-hidden>
                {state === 'pass' ? '✓' : state === 'fail' ? '✗' : '○'}
              </span>
              <span className="sr-only">{t(`activity.state.${state}`)}</span>
              <span className="lbl">{checkLabel(t, lang, c)}</span>
              {c.weight !== 1 && <span className="muted small"> ×{c.weight}</span>}
              {state === 'fail' && r?.reason && (
                <div className="muted small">{failReason(t, r.reason)}</div>
              )}
              {hint && state !== 'pass' && (
                <div className="small">
                  {hints[c.id] ? (
                    <em>{hint}</em>
                  ) : (
                    <button className="link" onClick={() => showHint(c.id)}>
                      {t('activity.hint')}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
