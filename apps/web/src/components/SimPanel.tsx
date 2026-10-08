import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FixedSizeList, type ListChildComponentProps } from 'react-window';
import type { LogEntry } from '@netsim/engine';
import { formatTime, translateMsg } from '../format';
import { ALL_PROTOS, sim, useStore, type ProtoFilter } from '../store';

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20];
const ROW_H = 26;
const STATUS_SYMBOL: Record<LogEntry['status'], string> = {
  ok: '✓',
  drop: '✗',
  info: 'ℹ',
  error: '⚠',
};

function useSize(ref: React.RefObject<HTMLElement>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 600, height: 150 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setSize({ width: el.clientWidth, height: el.clientHeight }),
    );
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export function SimPanel() {
  const { t } = useTranslation();
  const view = useStore((s) => s.view);
  const log = useStore((s) => s.log);
  const filters = useStore((s) => s.filters);
  const selected = useStore((s) => s.selectedLog);
  const selectLog = useStore((s) => s.selectLog);
  const setFilter = useStore((s) => s.setFilter);
  const setAll = useStore((s) => s.setAllFilters);
  const [follow, setFollow] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<FixedSizeList>(null);
  const size = useSize(bodyRef);

  const rows = useMemo(
    () => log.filter((l) => filters[l.proto as ProtoFilter] !== false),
    [log, filters],
  );

  useEffect(() => {
    if (follow && rows.length > 0) listRef.current?.scrollToItem(rows.length - 1);
  }, [rows.length, follow]);

  const mode = view?.mode ?? 'realtime';
  const running = mode === 'realtime' || (mode === 'simulation' && view?.autoCapture);

  return (
    <section className="sim-panel" aria-label={t('sim.title')}>
      <div className="sim-controls">
        <div className="seg" role="group" aria-label={t('sim.mode')}>
          <button
            className={mode !== 'simulation' ? 'active' : ''}
            aria-pressed={mode !== 'simulation'}
            onClick={() => void sim.setMode('realtime')}
          >
            {t('sim.realtime')}
          </button>
          <button
            className={mode === 'simulation' ? 'active' : ''}
            aria-pressed={mode === 'simulation'}
            onClick={() => void sim.setMode('simulation')}
          >
            {t('sim.simulation')}
          </button>
        </div>
        <button
          onClick={() => void (running ? sim.pause() : sim.play())}
          aria-label={running ? t('sim.pause') : t('sim.play')}
          title={`${running ? t('sim.pause') : t('sim.play')} (␣)`}
        >
          {running ? '⏸' : '▶'}
        </button>
        <button
          disabled={!view?.canStepBack}
          onClick={() => void sim.stepBack()}
          title={t('sim.stepBack')}
          aria-label={t('sim.stepBack')}
        >
          ⏮
        </button>
        <button
          disabled={mode !== 'simulation' || !view?.queueLength}
          onClick={() => void sim.step()}
          title={t('sim.step')}
          aria-label={t('sim.step')}
        >
          ⏭
        </button>
        <button onClick={() => void sim.reset()} title={t('sim.reset')}>
          ↺ {t('sim.reset')}
        </button>
        <label className="speed">
          {mode === 'simulation' ? t('sim.captureSpeed') : t('sim.speed')}
          <select
            value={view?.speed ?? 1}
            onChange={(e) => void sim.setSpeed(Number(e.target.value))}
            disabled={mode === 'simulation'}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <span className="clock" aria-live="off">
          t = {formatTime(view?.now ?? 0)}
        </span>
        <span className="muted">
          {t('sim.queue')}: {view?.queueLength ?? 0}
        </span>
        <label className="follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          {t('sim.follow')}
        </label>
      </div>
      <div className="filters" role="group" aria-label={t('sim.filters')}>
        <button className="link" onClick={() => setAll(true)}>
          {t('sim.showAll')}
        </button>
        <button className="link" onClick={() => setAll(false)}>
          {t('sim.showNone')}
        </button>
        {ALL_PROTOS.map((p) => (
          <label key={p} className={`chip proto-${p}`}>
            <input
              type="checkbox"
              checked={filters[p]}
              onChange={(e) => setFilter(p, e.target.checked)}
            />
            {p}
          </label>
        ))}
        <span className="muted">
          {rows.length}/{log.length}
        </span>
      </div>
      <div className="event-head row-grid" aria-hidden>
        <span>{t('sim.col.time')}</span>
        <span>{t('sim.col.last')}</span>
        <span>{t('sim.col.at')}</span>
        <span>{t('sim.col.type')}</span>
        <span>{t('sim.col.info')}</span>
      </div>
      <div className="event-body" ref={bodyRef}>
        {rows.length === 0 ? (
          <p className="muted pad">{t('sim.empty')}</p>
        ) : (
          <FixedSizeList
            ref={listRef}
            height={Math.max(size.height, ROW_H)}
            width={size.width}
            itemCount={rows.length}
            itemSize={ROW_H}
            itemData={{ rows, selected, select: selectLog }}
            onScroll={({ scrollOffset, scrollUpdateWasRequested }) => {
              if (!scrollUpdateWasRequested) {
                const atEnd = scrollOffset + size.height >= rows.length * ROW_H - ROW_H;
                setFollow(atEnd);
              }
            }}
          >
            {Row}
          </FixedSizeList>
        )}
      </div>
    </section>
  );
}

interface RowData {
  rows: LogEntry[];
  selected: number | null;
  select: (id: number | null) => void;
}

function Row({ index, style, data }: ListChildComponentProps<RowData>) {
  const { t } = useTranslation();
  const l = data.rows[index];
  if (!l) return null;
  const text = translateMsg(t, l.msg);
  return (
    <div
      style={style}
      role="row"
      tabIndex={0}
      className={`event row-grid proto-${l.proto} st-${l.status}${data.selected === l.id ? ' selected' : ''}`}
      onClick={() => data.select(l.id)}
      onKeyDown={(e) =>
        (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), data.select(l.id))
      }
      title={`${text}${l.summary ? ` – ${l.summary}` : ''}`}
    >
      <span>{formatTime(l.t)}</span>
      <span>{l.lastDeviceName ?? '–'}</span>
      <span>{l.atDeviceName}</span>
      <span className="proto-cell">
        <span className="status" aria-label={l.status}>
          {STATUS_SYMBOL[l.status]}
        </span>
        {l.proto}
      </span>
      <span className="info">
        {text}
        {l.summary && <span className="muted"> · {l.summary}</span>}
      </span>
    </div>
  );
}
