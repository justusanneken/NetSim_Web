import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../engine/client';
import { useStore } from '../store';
import {
  CHECK_TYPES,
  DEFS,
  ITEMS,
  ITEM_DEFS,
  blank,
  blankItem,
  build,
  toRaw,
  type AuthorCheckType,
  type FieldDef,
  type Raw,
} from './authorDefs';
import { failReason } from './describe';
import { useTeach } from './teachStore';

interface Row {
  uid: number;
  raw: Raw;
}

let uidSeq = 0;

function Field({
  def,
  value,
  onChange,
  label,
  list,
}: {
  def: FieldDef;
  value: unknown;
  onChange: (v: string | boolean) => void;
  label: string;
  list?: string;
}) {
  if (def.kind === 'bool')
    return (
      <label className="fld check">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    );
  if (def.kind === 'select')
    return (
      <label className="fld">
        {label}
        <select value={String(value ?? def.def ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(def.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o || '–'}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <label className="fld">
      {label}
      <input
        type={def.kind === 'num' ? 'number' : 'text'}
        value={String(value ?? '')}
        list={def.device ? list : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Autorenmodus: Aufgabe aus dem aktuellen Netz erstellen (Start-/Antwortnetz, Prüfungen, Optionen, Export). */
export function AuthorDialog() {
  const { t } = useTranslation();
  const open = useTeach((s) => s.authorOpen);
  const setOpen = useTeach((s) => s.setAuthorOpen);
  const devices = useStore((s) => s.view?.devices ?? []);
  const showToast = useStore((s) => s.showToast);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [minutes, setMinutes] = useState('0');
  const [pass, setPass] = useState('100');
  const [liveProgress, setLive] = useState(false);
  const [hideCli, setHideCli] = useState(false);
  const [hideGui, setHideGui] = useState(false);
  const [noAdd, setNoAdd] = useState(false);
  const [includeAnswer, setIncludeAnswer] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [cap, setCap] = useState({ start: false, answer: false });
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<number, { ok: boolean; reason: string }>>({});
  const [percent, setPercent] = useState<number | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    void api.authorStatus().then(setCap);
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  const names = useMemo(() => devices.map((d) => d.name), [devices]);
  if (!open) return null;

  const setRow = (uid: number, fn: (r: Raw) => Raw): void =>
    setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, raw: fn(r.raw) } : r)));

  const draftChecks = (): Raw[] => rows.map((r, i) => build(r.raw, `c${i + 1}`));

  const capture = async (which: 'start' | 'answer'): Promise<void> => {
    await api.authorCapture(which);
    setCap(await api.authorStatus());
    setMsg(t(which === 'start' ? 'author.capturedStart' : 'author.capturedAnswer'));
  };

  const derive = async (): Promise<void> => {
    const r = await api.authorDerive();
    if (!r.ok) {
      setMsg(t(r.error));
      return;
    }
    setRows((rs) => [
      ...rs,
      ...r.value.map((c) => ({ uid: ++uidSeq, raw: toRaw(c as unknown as Raw) })),
    ]);
    setMsg(t('author.derived', { n: r.value.length }));
  };

  const runPreview = async (): Promise<void> => {
    const built = draftChecks();
    const out: Record<number, { ok: boolean; reason: string }> = {};
    for (let i = 0; i < built.length; i++) {
      const r = await api.evaluate([built[i]]);
      const row = rows[i] as Row;
      if (!r.ok) out[row.uid] = { ok: false, reason: t('author.invalidCheck') };
      else {
        const res = r.value.results[0];
        out[row.uid] = {
          ok: res?.passed === true,
          reason: res?.passed ? '' : failReason(t, res?.reason),
        };
      }
    }
    setPreview(out);
    const all = await api.evaluate(built);
    setPercent(all.ok ? all.value.percent : null);
  };

  const exportFile = async (): Promise<void> => {
    if (!title.trim()) return setMsg(t('author.needTitle'));
    if (rows.length === 0) return setMsg(t('author.needChecks'));
    const id =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'activity';
    const draft = {
      meta: {
        id,
        title: title.trim(),
        description: description.trim() || undefined,
        created: new Date().toISOString().slice(0, 10),
      },
      steps: steps
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((text) => ({ text })),
      timeLimitSec: Math.round(Number(minutes) * 60) || 0,
      passPercent: Number(pass) || 100,
      liveProgress,
      locks: { hideCli, hideGui, noAddDevices: noAdd },
      checks: draftChecks(),
      includeAnswer,
    };
    const r = await api.authorExport(draft);
    if (!r.ok) {
      showToast(r.error, r.params);
      setMsg(`${t(r.error)} ${r.params?.path ?? ''} ${r.params?.message ?? ''}`.trim());
      return;
    }
    const url = URL.createObjectURL(new Blob([r.value], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${id}.nsact`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg(t('author.exported', { name: `${id}.nsact` }));
  };

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <div
        className="dialog author-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('author.title')}
      >
        <div className="dialog-head">
          <strong>{t('author.title')}</strong>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('common.close')}
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
        <div className="dialog-body">
          <div className="scroll pad author-body">
            <datalist id="author-devices">
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <fieldset>
              <legend>{t('author.meta')}</legend>
              <label className="fld">
                {t('author.name')}
                <input ref={first} value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="fld">
                {t('author.description')}
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <label className="fld">
                {t('author.steps')}
                <textarea rows={4} value={steps} onChange={(e) => setSteps(e.target.value)} />
              </label>
            </fieldset>
            <fieldset>
              <legend>{t('author.networks')}</legend>
              <p className="muted">{t('author.networksHint')}</p>
              <div className="pdu-row">
                <button onClick={() => void capture('start')}>{t('author.captureStart')}</button>
                <span className={cap.start ? 'ok' : 'muted'}>
                  {cap.start ? t('author.have') : t('author.haveNot')}
                </span>
              </div>
              <div className="pdu-row">
                <button onClick={() => void capture('answer')}>{t('author.captureAnswer')}</button>
                <span className={cap.answer ? 'ok' : 'muted'}>
                  {cap.answer ? t('author.have') : t('author.haveNot')}
                </span>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={includeAnswer}
                    onChange={(e) => setIncludeAnswer(e.target.checked)}
                  />
                  {t('author.includeAnswer')}
                </label>
              </div>
            </fieldset>
            <fieldset>
              <legend>{t('author.checks')}</legend>
              <div className="pdu-row">
                <button onClick={() => void derive()} disabled={!cap.start || !cap.answer}>
                  {t('author.derive')}
                </button>
                <select aria-label={t('author.addType')} id="author-add-type" defaultValue="ping">
                  {CHECK_TYPES.map((c) => (
                    <option key={c} value={c}>
                      {t(`author.type.${c}`)}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    const sel = document.getElementById('author-add-type') as HTMLSelectElement;
                    setRows((rs) => [
                      ...rs,
                      { uid: ++uidSeq, raw: blank(sel.value as AuthorCheckType) },
                    ]);
                  }}
                >
                  {t('author.addCheck')}
                </button>
              </div>
              {rows.length === 0 && <p className="muted">{t('author.noChecks')}</p>}
              {rows.map((r, i) => {
                const type = r.raw.type as AuthorCheckType;
                const spec = (r.raw.spec ?? {}) as Raw;
                const p = preview[r.uid];
                return (
                  <div
                    key={r.uid}
                    className="author-check"
                    role="group"
                    aria-label={t('author.checkN', { n: i + 1 })}
                  >
                    <div className="author-check-head">
                      <strong>
                        {i + 1}. {t(`author.type.${type}`)}
                      </strong>
                      {p && (
                        <span className={p.ok ? 'ok' : 'warn'}>
                          {p.ok ? '✓' : '✗'} {p.reason}
                        </span>
                      )}
                      <button
                        className="icon-btn"
                        aria-label={t('author.removeCheck', { n: i + 1 })}
                        onClick={() => setRows((rs) => rs.filter((x) => x.uid !== r.uid))}
                      >
                        ✕
                      </button>
                    </div>
                    <div className="author-fields">
                      {DEFS[type].map((f) => (
                        <Field
                          key={f.name}
                          def={f}
                          list="author-devices"
                          label={t(`author.f.${f.name}`)}
                          value={r.raw[f.name]}
                          onChange={(v) => setRow(r.uid, (x) => ({ ...x, [f.name]: v }))}
                        />
                      ))}
                      {type === 'config' && (
                        <>
                          <label className="fld">
                            {t('author.f.item')}
                            <select
                              value={String(spec.item ?? 'hostname')}
                              onChange={(e) =>
                                setRow(r.uid, (x) => ({
                                  ...x,
                                  spec: blankItem(e.target.value as (typeof ITEMS)[number]),
                                }))
                              }
                            >
                              {ITEMS.map((it) => (
                                <option key={it} value={it}>
                                  {t(`author.item.${it}`)}
                                </option>
                              ))}
                            </select>
                          </label>
                          {(
                            ITEM_DEFS[(spec.item as (typeof ITEMS)[number]) ?? 'hostname'] ?? []
                          ).map((f) => (
                            <Field
                              key={f.name}
                              def={f}
                              label={t(`author.f.${f.name}`)}
                              value={spec[f.name]}
                              onChange={(v) =>
                                setRow(r.uid, (x) => ({
                                  ...x,
                                  spec: { ...(x.spec as Raw), [f.name]: v },
                                }))
                              }
                            />
                          ))}
                        </>
                      )}
                      <label className="fld">
                        {t('author.f.weight')}
                        <input
                          type="number"
                          min={0.1}
                          step={0.5}
                          value={String(r.raw.weight ?? '1')}
                          onChange={(e) => setRow(r.uid, (x) => ({ ...x, weight: e.target.value }))}
                        />
                      </label>
                      <label className="fld wide">
                        {t('author.f.hint')}
                        <input
                          value={String(r.raw.hint ?? '')}
                          onChange={(e) => setRow(r.uid, (x) => ({ ...x, hint: e.target.value }))}
                        />
                      </label>
                      <label className="fld wide">
                        {t('author.f.label')}
                        <input
                          value={String(r.raw.label ?? '')}
                          onChange={(e) => setRow(r.uid, (x) => ({ ...x, label: e.target.value }))}
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
              <div className="pdu-row">
                <button onClick={() => void runPreview()} disabled={rows.length === 0}>
                  {t('author.preview')}
                </button>
                {percent !== null && (
                  <span data-testid="author-percent">
                    {t('author.previewResult', { p: percent })}
                  </span>
                )}
              </div>
            </fieldset>
            <fieldset>
              <legend>{t('author.options')}</legend>
              <label className="fld">
                {t('author.timeLimit')}
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                />
              </label>
              <label className="fld">
                {t('author.passPercent')}
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={liveProgress}
                  onChange={(e) => setLive(e.target.checked)}
                />
                {t('author.live')}
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={hideCli}
                  onChange={(e) => setHideCli(e.target.checked)}
                />
                {t('author.hideCli')}
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={hideGui}
                  onChange={(e) => setHideGui(e.target.checked)}
                />
                {t('author.hideGui')}
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={noAdd}
                  onChange={(e) => setNoAdd(e.target.checked)}
                />
                {t('author.noAdd')}
              </label>
            </fieldset>
            {msg && (
              <p role="status" className="author-msg">
                {msg}
              </p>
            )}
          </div>
          <div className="pdu-actions">
            <button className="primary" onClick={() => void exportFile()}>
              {t('author.export')}
            </button>
            <button onClick={() => setOpen(false)}>{t('common.close')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
