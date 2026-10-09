import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { translateMsg } from '../format';
import { useTeach } from './teachStore';

/** Schalter „Challenge Me“ im PDU-Inspektor samt Punktestand. */
export function ChallengeToggle() {
  const { t } = useTranslation();
  const on = useTeach((s) => s.challengeOn);
  const set = useTeach((s) => s.setChallenge);
  const score = useTeach((s) => s.score);
  const reset = useTeach((s) => s.resetScore);
  const pct = score.answered ? Math.round((score.correct / score.answered) * 100) : 0;
  return (
    <div className="challenge-bar">
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
        {t('challenge.toggle')}
      </label>
      {on && (
        <>
          <span className="score" data-testid="challenge-score" aria-live="polite">
            {t('challenge.score', { correct: score.correct, answered: score.answered, pct })}
          </span>
          <button onClick={reset} disabled={score.answered === 0}>
            {t('challenge.reset')}
          </button>
        </>
      )}
    </div>
  );
}

/** Fragen zum gewählten Ereignis: Nutzer wählt die Aktion des Geräts je Schicht; Prüfung gegen die Engine. */
export function ChallengeQuiz({ logId }: { logId: number }) {
  const { t } = useTranslation();
  const on = useTeach((s) => s.challengeOn);
  const questions = useTeach((s) => s.questions);
  const answers = useTeach((s) => s.answers);
  const load = useTeach((s) => s.loadQuestions);
  const answer = useTeach((s) => s.answer);

  useEffect(() => {
    void load(on ? logId : null);
  }, [on, logId, load]);

  if (!on) return null;
  if (questions.length === 0) return <p className="muted">{t('challenge.none')}</p>;
  return (
    <div className="challenge-quiz">
      <p className="muted">{t('challenge.intro')}</p>
      {questions.map((q) => {
        const given = answers[q.id];
        const done = given !== undefined;
        const right = given === q.correct;
        return (
          <fieldset key={q.id} className={`cq${done ? (right ? ' right' : ' wrong') : ''}`}>
            <legend>
              <span className="layer">L{q.layer}</span> {translateMsg(t, q.prompt)}
            </legend>
            {q.options.map((o) => (
              <label
                key={o.id}
                className={`cq-opt${done && o.id === q.correct ? ' is-correct' : ''}`}
              >
                <input
                  type="radio"
                  name={`q-${q.id}`}
                  checked={given === o.id}
                  disabled={done}
                  onChange={() => answer(q, o.id)}
                />
                {translateMsg(t, o.label)}
              </label>
            ))}
            {done && (
              <div className="cq-explain" role="status">
                <strong>{right ? `✓ ${t('challenge.right')}` : `✗ ${t('challenge.wrong')}`}</strong>{' '}
                {translateMsg(t, q.explain)}
              </div>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}
