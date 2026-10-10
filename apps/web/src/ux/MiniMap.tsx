import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store';
import { boundsOf } from './geometry';
import { useDoc } from './uiDoc';
import { useUx } from './ux';

const W = 180;
const H = 120;

/** Mini-Map: Übersicht aller Geräte mit Sichtfenster; Klick/Ziehen verschiebt die Ansicht. */
export function MiniMap({ width, height }: { width: number; height: number }) {
  const { t } = useTranslation();
  const on = useUx((s) => s.minimap);
  const devices = useStore((s) => s.view?.devices);
  const sv = useStore((s) => s.stageView);
  const notes = useDoc((s) => s.notes);
  const ref = useRef<SVGSVGElement>(null);
  if (!on) return null;

  const vp = {
    x: -sv.x / sv.scale,
    y: -sv.y / sv.scale,
    w: width / sv.scale,
    h: height / sv.scale,
  };
  const pts = [
    ...(devices ?? []).map((d) => d.pos),
    ...notes.map((n) => ({ x: n.x, y: n.y })),
    { x: vp.x, y: vp.y },
    { x: vp.x + vp.w, y: vp.y + vp.h },
  ];
  const b = boundsOf(pts, 40) ?? { x: 0, y: 0, w: 1, h: 1 };
  const k = Math.min(W / b.w, H / b.h);
  const ox = (W - b.w * k) / 2;
  const oy = (H - b.h * k) / 2;
  const tx = (x: number): number => ox + (x - b.x) * k;
  const ty = (y: number): number => oy + (y - b.y) * k;

  const panTo = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const wx = b.x + (e.clientX - r.left - ox) / k;
    const wy = b.y + (e.clientY - r.top - oy) / k;
    useStore.getState().setStageView({
      ...sv,
      x: width / 2 - wx * sv.scale,
      y: height / 2 - wy * sv.scale,
    });
  };

  return (
    <svg
      ref={ref}
      className="minimap"
      width={W}
      height={H}
      role="img"
      aria-label={t('ux.minimap.aria')}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        panTo(e);
      }}
      onPointerMove={(e) => e.buttons === 1 && panTo(e)}
    >
      {(devices ?? []).map((d) => (
        <circle key={d.id} cx={tx(d.pos.x)} cy={ty(d.pos.y)} r={3} className="mm-dev" />
      ))}
      {notes.map((n) => (
        <rect key={n.id} x={tx(n.x) - 2} y={ty(n.y) - 2} width={4} height={4} className="mm-note" />
      ))}
      <rect x={tx(vp.x)} y={ty(vp.y)} width={vp.w * k} height={vp.h * k} className="mm-view" />
    </svg>
  );
}
