import { useTranslation } from 'react-i18next';
import { useStore, type Tool } from '../store';
import { useTeach } from '../teach/teachStore';

const TOOLS: { id: Tool; key: string; icon: string }[] = [
  { id: 'select', key: 'tool.select', icon: '↖' },
  { id: 'hand', key: 'tool.hand', icon: '✋' },
  { id: 'cable', key: 'tool.cable', icon: '⌇' },
  { id: 'pdu', key: 'tool.pdu', icon: '✉' },
  { id: 'delete', key: 'tool.delete', icon: '✕' },
];

export function Toolbar() {
  const { t } = useTranslation();
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const sv = useStore((s) => s.stageView);
  const setStageView = useStore((s) => s.setStageView);
  const hint = useStore((s) => {
    if (s.placing) return t('hint.placing');
    if (s.tool === 'cable')
      return s.cable === 'auto'
        ? s.cableStart
          ? t('hint.cableAutoB')
          : t('hint.cableAutoA')
        : s.cableStart?.port
          ? t('hint.cableB')
          : t('hint.cableA');
    if (s.tool === 'pdu') return s.pduSource ? t('hint.pduB') : t('hint.pduA');
    if (s.tool === 'delete') return t('hint.delete');
    return '';
  });
  const zoom = (f: number) =>
    setStageView({ ...sv, scale: Math.min(3, Math.max(0.25, sv.scale * f)) });
  return (
    <div className="toolbar" role="toolbar" aria-label={t('toolbar.aria')}>
      {TOOLS.map((x) => (
        <button
          key={x.id}
          className={`tool${tool === x.id ? ' active' : ''}`}
          aria-pressed={tool === x.id}
          title={t(x.key)}
          aria-label={t(x.key)}
          onClick={() => setTool(x.id)}
        >
          <span aria-hidden>{x.icon}</span>
          <span className="tool-label">{t(x.key)}</span>
        </button>
      ))}
      <button
        className="tool"
        title={t('pdu.complex')}
        aria-label={t('pdu.complex')}
        onClick={() => useTeach.getState().openPduDialog(true)}
      >
        <span aria-hidden>✉+</span>
        <span className="tool-label">{t('pdu.complexShort')}</span>
      </button>
      <span className="sep" />
      <button
        className="tool"
        aria-label={t('view.zoomOut')}
        title={t('view.zoomOut')}
        onClick={() => zoom(1 / 1.2)}
      >
        −
      </button>
      <span className="zoom-val" aria-live="polite">
        {Math.round(sv.scale * 100)}%
      </span>
      <button
        className="tool"
        aria-label={t('view.zoomIn')}
        title={t('view.zoomIn')}
        onClick={() => zoom(1.2)}
      >
        +
      </button>
      <button
        className="tool"
        title={t('view.zoomReset')}
        onClick={() => setStageView({ x: 0, y: 0, scale: 1 })}
      >
        1:1
      </button>
      {hint && (
        <span className="hint" role="status">
          {hint}
        </span>
      )}
    </div>
  );
}
