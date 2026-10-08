import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_TYPES, type DeviceType } from '@netsim/engine';
import { DEVICE_COLORS, ICON_PATHS } from '../icons';
import { useStore, type CableChoice } from '../store';

const CATEGORIES: { id: string; devices: DeviceType[] }[] = [
  { id: 'end', devices: ['pc', 'laptop', 'server'] },
  { id: 'network', devices: ['router', 'switch-l2', 'switch-l3', 'hub'] },
];
const CABLES: CableChoice[] = ['auto', 'straight', 'crossover'];

export function DeviceIcon({ type, size = 40 }: { type: DeviceType; size?: number }) {
  const color = DEVICE_COLORS[type] ?? '#6e7781';
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden fill="none">
      {(ICON_PATHS[type] ?? []).map((p, i) => (
        <path key={i} d={p} stroke={color} strokeWidth={2} strokeLinejoin="round" />
      ))}
    </svg>
  );
}

export function Palette() {
  const { t } = useTranslation();
  const [cat, setCat] = useState('end');
  const placing = useStore((s) => s.placing);
  const tool = useStore((s) => s.tool);
  const cable = useStore((s) => s.cable);
  const setPlacing = useStore((s) => s.setPlacing);
  const setTool = useStore((s) => s.setTool);
  const setCable = useStore((s) => s.setCable);
  const devs = CATEGORIES.find((c) => c.id === cat)?.devices ?? [];

  return (
    <section className="palette" aria-label={t('palette.title')}>
      <div className="tabs" role="tablist">
        {[...CATEGORIES.map((c) => c.id), 'cables'].map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={cat === id}
            className={cat === id ? 'active' : ''}
            onClick={() => setCat(id)}
          >
            {t(`palette.cat.${id}`)}
          </button>
        ))}
      </div>
      <div className="palette-items">
        {cat !== 'cables' &&
          devs
            .filter((d) => SUPPORTED_TYPES.includes(d))
            .map((d) => (
              <button
                key={d}
                className={`palette-item${placing === d ? ' active' : ''}`}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('application/x-netsim-device', d)}
                onClick={() => setPlacing(placing === d ? null : d)}
                title={t('palette.placeHint')}
              >
                <DeviceIcon type={d} />
                <span>{t(`device.${d}`)}</span>
              </button>
            ))}
        {cat === 'cables' &&
          CABLES.map((c) => (
            <button
              key={c}
              className={`palette-item${tool === 'cable' && cable === c ? ' active' : ''}`}
              onClick={() => {
                setTool('cable');
                setCable(c);
              }}
            >
              <svg width={40} height={40} viewBox="0 0 48 48" aria-hidden fill="none">
                <path
                  d="M6 38C16 38 14 10 24 10S32 38 42 38"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  strokeDasharray={c === 'crossover' ? '6 3' : c === 'auto' ? '2 4' : undefined}
                />
              </svg>
              <span>{t(`cable.${c}`)}</span>
            </button>
          ))}
      </div>
    </section>
  );
}
