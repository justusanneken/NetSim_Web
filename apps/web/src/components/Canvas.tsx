import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type Konva from 'konva';
import {
  Circle,
  Group,
  Image as KImage,
  Layer,
  Line,
  Path,
  Rect,
  Shape,
  Stage,
  Text,
} from 'react-konva';
import { useTranslation } from 'react-i18next';
import type { DeviceType, DeviceView, LinkView } from '@netsim/engine';
import { api } from '../engine/client';
import { shortPort } from '../format';
import { deviceColor, ICON_FALLBACK, ICON_PATHS } from '../icons';
import { useStore } from '../store';
import { linkLightShape, readCanvasColors, type CanvasColors } from '../theme';
import {
  addNoteAt,
  moveDevices,
  nudgeSelection,
  selectOnly,
  selection as currentSelection,
} from '../ux/actions';
import { readUxColors } from '../ux/colors';
import {
  GRID_SIZE,
  boundsOf,
  idsInRect,
  rectFrom,
  snapValue,
  zoomAt,
  type Pt,
  type Rect as GRect,
} from '../ux/geometry';
import { MiniMap } from '../ux/MiniMap';
import { portIp, portVlan } from '../ux/NetworkInfo';
import { useDoc, type Group as DocGroup, type Note } from '../ux/uiDoc';
import { useUx, type CtxTarget } from '../ux/ux';

const GRID = GRID_SIZE;
const BLINK_US = 200_000;
const LONG_PRESS_MS = 600;
const NOTE_W = 170;

interface Hover {
  device: DeviceView;
  x: number;
  y: number;
}

const noteHeight = (text: string): number => {
  const lines = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 24)), 0);
  return 20 + Math.max(1, lines) * 15;
};

/** Hintergrundbild als `HTMLImageElement` laden. */
function useImage(src: string | undefined): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) {
      setImg(null);
      return;
    }
    const i = new window.Image();
    i.onload = () => setImg(i);
    i.src = src;
  }, [src]);
  return img;
}

export function Canvas() {
  const { t } = useTranslation();
  const view = useStore((s) => s.view);
  const tool = useStore((s) => s.tool);
  const placing = useStore((s) => s.placing);
  const selectedDevice = useStore((s) => s.selectedDevice);
  const selectedLink = useStore((s) => s.selectedLink);
  const cableStart = useStore((s) => s.cableStart);
  const pduSource = useStore((s) => s.pduSource);
  const showLabels = useStore((s) => s.showPortLabels);
  const colorblind = useStore((s) => s.colorblind);
  const theme = useStore((s) => s.theme);
  const stageView = useStore((s) => s.stageView);
  const selectedIds = useUx((s) => s.selectedIds);
  const selectedNote = useUx((s) => s.selectedNote);
  const snapOn = useUx((s) => s.snap);
  const gridVisible = useUx((s) => s.gridVisible);
  const notes = useDoc((s) => s.notes);
  const groups = useDoc((s) => s.groups);
  const background = useDoc((s) => s.background);
  const bgImage = useImage(background?.dataUrl);
  const colors = useMemo(() => readCanvasColors(theme, colorblind), [theme, colorblind]);
  const ux = useMemo(() => readUxColors(), [theme, colorblind]); // eslint-disable-line react-hooks/exhaustive-deps

  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [drag, setDrag] = useState<Record<string, Pt>>({});
  const [hover, setHover] = useState<Hover | null>(null);
  const [band, setBand] = useState<GRect | null>(null);
  const bandStart = useRef<(Pt & { additive: boolean }) | null>(null);
  const bandRect = useRef<GRect | null>(null);
  const banded = useRef(false);
  const dragStart = useRef<Record<string, Pt>>({});
  const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setSize({ width: el.clientWidth, height: el.clientHeight }),
    );
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const devices = useMemo(() => {
    const m = new Map<string, DeviceView>();
    view?.devices.forEach((d) => m.set(d.id, d));
    return m;
  }, [view]);

  const posOf = useCallback(
    (id: string): Pt => drag[id] ?? devices.get(id)?.pos ?? { x: 0, y: 0 },
    [drag, devices],
  );

  const selSet = useMemo(
    () => new Set(selectedIds.length > 0 ? selectedIds : selectedDevice ? [selectedDevice] : []),
    [selectedIds, selectedDevice],
  );

  const snap = useCallback((v: number): number => snapValue(v, snapOn), [snapOn]);

  const worldPointer = (): Pt | null => {
    const p = stageRef.current?.getRelativePointerPosition();
    return p ? { x: p.x, y: p.y } : null;
  };

  const openCtx = (clientX: number, clientY: number, target: CtxTarget) => {
    useUx.getState().openCtx({ x: clientX, y: clientY, target });
  };

  const onStageClick = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if ('button' in e.evt && e.evt.button !== 0) return;
    if (e.target !== e.target.getStage() && e.target.name() !== 'bg') return;
    if (banded.current) {
      banded.current = false;
      return;
    }
    useUx.getState().openCtx(null);
    const s = useStore.getState();
    const p = worldPointer();
    if (s.placing) {
      if (p) void s.addDevice(s.placing, snap(p.x), snap(p.y));
      return;
    }
    if (s.tool === 'note') {
      if (p) addNoteAt(snap(p.x), snap(p.y));
      return;
    }
    if (s.tool === 'select') {
      selectOnly(null);
      s.selectLink(null);
      useUx.getState().setSelectedNote(null);
    } else if (s.tool === 'cable' || s.tool === 'pdu') s.cancel();
  };

  // ---------------------------------------------------------------- Rubberband-Auswahl
  const beginBand = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (e.target !== e.target.getStage() && e.target.name() !== 'bg') return;
    const s = useStore.getState();
    if (s.tool !== 'select' || s.placing) return;
    if ('button' in e.evt && e.evt.button !== 0) return;
    if ('touches' in e.evt && e.evt.touches.length !== 1) return;
    const p = worldPointer();
    if (!p) return;
    bandStart.current = { ...p, additive: e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey };
    banded.current = false;
  };
  const moveBand = () => {
    const st = bandStart.current;
    const p = worldPointer();
    if (!st || !p) return;
    const r = rectFrom(st, p);
    if (r.w * stageView.scale > 4 || r.h * stageView.scale > 4) {
      bandRect.current = r;
      setBand(r);
    }
  };
  useEffect(() => {
    const finish = () => {
      const st = bandStart.current;
      bandStart.current = null;
      if (!st) return;
      const r = bandRect.current;
      bandRect.current = null;
      setBand(null);
      if (!r) return;
      banded.current = true;
      const pts: Record<string, Pt> = {};
      for (const d of useStore.getState().view?.devices ?? []) pts[d.id] = d.pos;
      const hit = idsInRect(pts, r);
      const ids = st.additive ? [...new Set([...currentSelection(), ...hit])] : hit;
      useStore.getState().selectDevice(ids[ids.length - 1] ?? null);
      useUx.getState().setSelected(ids);
      useUx.getState().setSelectedNote(null);
    };
    window.addEventListener('mouseup', finish);
    window.addEventListener('touchend', finish);
    return () => {
      window.removeEventListener('mouseup', finish);
      window.removeEventListener('touchend', finish);
    };
  }, []);

  // ---------------------------------------------------------------- Zoom / Pan
  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const st = stageRef.current;
    if (!st) return;
    const cur = useStore.getState().stageView;
    if (e.evt.ctrlKey || e.evt.metaKey) {
      const pointer = st.getPointerPosition();
      if (!pointer) return;
      useStore.getState().setStageView(zoomAt(cur, pointer, e.evt.deltaY < 0 ? 1.1 : 1 / 1.1));
    } else {
      useStore
        .getState()
        .setStageView({ ...cur, x: cur.x - e.evt.deltaX, y: cur.y - e.evt.deltaY });
    }
  };

  /** Zwei-Finger-Geste: Pinch-Zoom und Verschieben (Tablet). */
  const onTouchMove = (e: Konva.KonvaEventObject<TouchEvent>) => {
    const ts = e.evt.touches;
    if (ts.length === 1) {
      moveBand();
      return;
    }
    if (ts.length !== 2) return;
    e.evt.preventDefault();
    clearTimeout(press.current);
    bandStart.current = null;
    bandRect.current = null;
    setBand(null);
    stageRef.current?.stopDrag();
    const rect = wrapRef.current?.getBoundingClientRect();
    const [a, b] = [ts[0], ts[1]] as [Touch, Touch];
    const cx = (a.clientX + b.clientX) / 2 - (rect?.left ?? 0);
    const cy = (a.clientY + b.clientY) / 2 - (rect?.top ?? 0);
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const last = pinch.current;
    pinch.current = { dist, cx, cy };
    if (!last || last.dist === 0) return;
    const cur = useStore.getState().stageView;
    const zoomed = zoomAt(cur, { x: cx, y: cy }, dist / last.dist);
    useStore
      .getState()
      .setStageView({ ...zoomed, x: zoomed.x + (cx - last.cx), y: zoomed.y + (cy - last.cy) });
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/x-netsim-device') as DeviceType;
    const st = stageRef.current;
    if (!type || !st) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    const cur = useStore.getState().stageView;
    const x = snap((e.clientX - (rect?.left ?? 0) - cur.x) / cur.scale);
    const y = snap((e.clientY - (rect?.top ?? 0) - cur.y) / cur.scale);
    void useStore.getState().addDevice(type, x, y);
  };

  // ---------------------------------------------------------------- Tastatur
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    const step = e.shiftKey ? GRID * 2 : snapOn ? GRID / 2 : 1;
    const dir: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const d = dir[e.key];
    if (d) {
      e.preventDefault();
      if (currentSelection().length > 0) void nudgeSelection(d[0] * step, d[1] * step);
      else {
        const cur = useStore.getState().stageView;
        useStore.getState().setStageView({ ...cur, x: cur.x - d[0] * 40, y: cur.y - d[1] * 40 });
      }
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const id = currentSelection()[0];
      const r = wrapRef.current?.getBoundingClientRect();
      const pos = id ? devices.get(id)?.pos : undefined;
      const sv = useStore.getState().stageView;
      const x = (r?.left ?? 0) + (pos ? pos.x * sv.scale + sv.x : 40);
      const y = (r?.top ?? 0) + (pos ? pos.y * sv.scale + sv.y : 40);
      openCtx(
        x,
        y,
        id
          ? { kind: 'device', id }
          : { kind: 'canvas', wx: (40 - sv.x) / sv.scale, wy: (40 - sv.y) / sv.scale },
      );
    }
  };

  // ---------------------------------------------------------------- Ziehen (Geräte, Gruppen, Notizen)
  const startMove = (ids: string[]) => {
    dragStart.current = Object.fromEntries(ids.map((id) => [id, { ...posOf(id) }]));
  };
  const moveBy = (dx: number, dy: number) => {
    setDrag(
      Object.fromEntries(
        Object.entries(dragStart.current).map(([id, p]) => [id, { x: p.x + dx, y: p.y + dy }]),
      ),
    );
  };
  const endMove = (id: string, dx: number, dy: number) => {
    const base = dragStart.current[id] ?? { x: 0, y: 0 };
    const sx = snap(base.x + dx) - base.x;
    const sy = snap(base.y + dy) - base.y;
    const moves = Object.fromEntries(
      Object.entries(dragStart.current).map(([k, p]) => [k, { x: p.x + sx, y: p.y + sy }]),
    );
    setDrag({});
    void moveDevices(moves);
  };

  const now = view?.now ?? 0;
  const summary = t('ux.canvas.summary', {
    devices: view?.devices.length ?? 0,
    links: view?.links.length ?? 0,
  });

  return (
    <div
      ref={wrapRef}
      className={`canvas-wrap tool-${tool}${placing ? ' placing' : ''}`}
      role="application"
      aria-label={t('canvas.aria')}
      aria-describedby="canvas-summary"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <p id="canvas-summary" className="sr-only">
        {summary} {t('ux.canvas.keys')}
      </p>
      <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        x={stageView.x}
        y={stageView.y}
        scaleX={stageView.scale}
        scaleY={stageView.scale}
        draggable={tool === 'hand'}
        onDragEnd={(e) => {
          if (e.target === e.target.getStage()) {
            useStore.getState().setStageView({ ...stageView, x: e.target.x(), y: e.target.y() });
          }
        }}
        onWheel={onWheel}
        onClick={onStageClick}
        onTap={onStageClick}
        onMouseDown={beginBand}
        onTouchStart={(e) => {
          beginBand(e);
          if (e.target === e.target.getStage() || e.target.name() === 'bg') {
            const t0 = e.evt.touches[0];
            const p = worldPointer();
            if (e.evt.touches.length === 1 && t0 && p) {
              clearTimeout(press.current);
              press.current = setTimeout(
                () => openCtx(t0.clientX, t0.clientY, { kind: 'canvas', wx: p.x, wy: p.y }),
                LONG_PRESS_MS,
              );
            }
          }
        }}
        onMouseMove={moveBand}
        onTouchMove={(e) => {
          clearTimeout(press.current);
          onTouchMove(e);
        }}
        onTouchEnd={() => {
          clearTimeout(press.current);
          pinch.current = null;
        }}
        onContextMenu={(e) => {
          e.evt.preventDefault();
          if (e.target !== e.target.getStage() && e.target.name() !== 'bg') return;
          const p = worldPointer();
          if (p) openCtx(e.evt.clientX, e.evt.clientY, { kind: 'canvas', wx: p.x, wy: p.y });
        }}
      >
        <Layer listening={false}>
          {bgImage && background && (
            <KImage image={bgImage} x={0} y={0} opacity={background.opacity} listening={false} />
          )}
          {gridVisible && (
            <Shape
              sceneFunc={(ctx, shape) => {
                const sv = useStore.getState().stageView;
                const x0 = -sv.x / sv.scale;
                const y0 = -sv.y / sv.scale;
                const x1 = x0 + size.width / sv.scale;
                const y1 = y0 + size.height / sv.scale;
                ctx.beginPath();
                for (let x = Math.floor(x0 / GRID) * GRID; x < x1; x += GRID) {
                  ctx.moveTo(x, y0);
                  ctx.lineTo(x, y1);
                }
                for (let y = Math.floor(y0 / GRID) * GRID; y < y1; y += GRID) {
                  ctx.moveTo(x0, y);
                  ctx.lineTo(x1, y);
                }
                ctx.fillStrokeShape(shape);
              }}
              stroke={colors.grid}
              strokeWidth={1 / stageView.scale}
            />
          )}
        </Layer>
        <Layer>
          {/* Unsichtbare Fläche zum Fangen von Klicks im Leerraum */}
          <Rect name="bg" x={-50000} y={-50000} width={100000} height={100000} fill="transparent" />
          {groups.map((g) => (
            <GroupFrame
              key={g.id}
              group={g}
              posOf={posOf}
              color={ux.group}
              textColor={colors.text}
              onStart={startMove}
              onMove={moveBy}
              onEnd={(dx, dy) => endMove(g.deviceIds[0] as string, dx, dy)}
              onContext={(x, y) => openCtx(x, y, { kind: 'group', id: g.id })}
            />
          ))}
          {view?.devices
            .filter((d) => d.p5?.ap && d.powered && selectedDevice === d.id)
            .flatMap((d) => {
              const pos = posOf(d.id);
              return Object.entries(d.p5?.ap?.range ?? {}).map(([band, r]) => (
                <Group key={`${d.id}-${band}`} listening={false}>
                  <Circle
                    x={pos.x}
                    y={pos.y}
                    radius={r}
                    fill={band === '5' ? colors.wifi5 : colors.wifi24}
                    opacity={0.06}
                    listening={false}
                  />
                  <Circle
                    x={pos.x}
                    y={pos.y}
                    radius={r}
                    stroke={band === '5' ? colors.wifi5 : colors.wifi24}
                    strokeWidth={1.5}
                    dash={band === '5' ? [4, 6] : [10, 6]}
                    listening={false}
                  />
                </Group>
              ));
            })}
          {view?.links.map((l) => (
            <LinkShape
              key={l.id}
              link={l}
              posOf={posOf}
              devices={devices}
              now={now}
              selected={selectedLink === l.id}
              showLabels={showLabels}
              colorblind={colorblind}
              colors={colors}
              onContext={(x, y) => openCtx(x, y, { kind: 'link', id: l.id })}
            />
          ))}
          <Envelopes posOf={posOf} colors={colors} colorblind={colorblind} />
          {view?.devices.map((d) => {
            const pos = posOf(d.id);
            const color = deviceColor(d.type, theme);
            const active = cableStart?.deviceId === d.id || pduSource === d.id;
            const selected = selSet.has(d.id);
            return (
              <Group
                key={d.id}
                x={pos.x}
                y={pos.y}
                draggable={tool === 'select'}
                opacity={d.powered ? 1 : 0.55}
                onDragStart={() => {
                  clearTimeout(press.current);
                  const ids = selSet.has(d.id) && selSet.size > 1 ? [...selSet] : [d.id];
                  if (!selSet.has(d.id)) selectOnly(d.id);
                  startMove(ids);
                }}
                onDragMove={(e) => {
                  const st = dragStart.current[d.id];
                  if (st) moveBy(e.target.x() - st.x, e.target.y() - st.y);
                }}
                onDragEnd={(e) => {
                  const st = dragStart.current[d.id];
                  if (st) endMove(d.id, e.target.x() - st.x, e.target.y() - st.y);
                }}
                onClick={(e) => {
                  e.cancelBubble = true;
                  if (e.evt.button !== 0) return;
                  useUx.getState().openCtx(null);
                  const s = useStore.getState();
                  if (s.tool === 'select' && (e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey)) {
                    useUx.getState().toggleSelected(d.id);
                    const ids = useUx.getState().selectedIds;
                    s.selectDevice(ids.includes(d.id) ? d.id : (ids[ids.length - 1] ?? null));
                    useUx.getState().setSelected(ids);
                    return;
                  }
                  void s.deviceClicked(d.id, e.evt.clientX, e.evt.clientY);
                  if (s.tool === 'select' || s.tool === 'note') selectOnly(d.id);
                }}
                onTap={(e) => {
                  e.cancelBubble = true;
                  clearTimeout(press.current);
                  const t0 = (e.evt as unknown as TouchEvent).changedTouches?.[0];
                  void useStore.getState().deviceClicked(d.id, t0?.clientX ?? 0, t0?.clientY ?? 0);
                  if (useStore.getState().tool === 'select') selectOnly(d.id);
                }}
                onTouchStart={(e) => {
                  const t0 = e.evt.touches[0];
                  if (e.evt.touches.length !== 1 || !t0) return;
                  clearTimeout(press.current);
                  press.current = setTimeout(() => {
                    if (!selSet.has(d.id)) selectOnly(d.id);
                    openCtx(t0.clientX, t0.clientY, { kind: 'device', id: d.id });
                  }, LONG_PRESS_MS);
                }}
                onTouchEnd={() => clearTimeout(press.current)}
                onContextMenu={(e) => {
                  e.evt.preventDefault();
                  e.cancelBubble = true;
                  if (!selSet.has(d.id)) selectOnly(d.id);
                  useUx.getState().setSelectedNote(null);
                  openCtx(e.evt.clientX, e.evt.clientY, { kind: 'device', id: d.id });
                }}
                onDblClick={() => useStore.getState().openDialog(d.id)}
                onDblTap={() => useStore.getState().openDialog(d.id)}
                onMouseEnter={(e) => setHover({ device: d, x: e.evt.clientX, y: e.evt.clientY })}
                onMouseMove={(e) => setHover({ device: d, x: e.evt.clientX, y: e.evt.clientY })}
                onMouseLeave={() => setHover(null)}
              >
                <Rect
                  x={-30}
                  y={-30}
                  width={60}
                  height={60}
                  cornerRadius={10}
                  fill={colors.card}
                  stroke={selected ? colors.sel : active ? colors.active : color}
                  strokeWidth={selected || active ? 3 : 1.5}
                  shadowBlur={4}
                  shadowOpacity={0.15}
                />
                <Group x={-24} y={-24}>
                  {(ICON_PATHS[d.type] ?? ICON_FALLBACK).map((p, i) => (
                    <Path key={i} data={p} stroke={color} strokeWidth={2} lineJoin="round" />
                  ))}
                </Group>
                <Text
                  x={-70}
                  y={34}
                  width={140}
                  align="center"
                  text={d.name}
                  fontSize={13}
                  fill={colors.text}
                />
                {!d.powered && <Text x={-6} y={-8} text="⏻" fontSize={16} fill={colors.down} />}
                {d.crashed && <Text x={14} y={-30} text="⚠" fontSize={18} fill={colors.down} />}
              </Group>
            );
          })}
          {notes.map((n) => (
            <NoteShape
              key={n.id}
              note={n}
              selected={selectedNote === n.id}
              colors={ux}
              placeholder={t('ux.note.empty')}
              snap={snap}
              onContext={(x, y) => openCtx(x, y, { kind: 'note', id: n.id })}
            />
          ))}
          {band && (
            <Rect
              x={band.x}
              y={band.y}
              width={band.w}
              height={band.h}
              fill={ux.bandFill}
              stroke={ux.band}
              strokeWidth={1 / stageView.scale}
              dash={[4, 3]}
              listening={false}
            />
          )}
        </Layer>
      </Stage>
      {hover && !drag[hover.device.id] && <Tooltip hover={hover} wrap={wrapRef.current} />}
      <NoteEditor stageView={stageView} />
      <MiniMap width={size.width} height={size.height} />
    </div>
  );
}

/** Rahmen eines Clusters; Ziehen am Rahmen/Titel verschiebt alle Mitglieder. */
function GroupFrame(props: {
  group: DocGroup;
  posOf: (id: string) => Pt;
  color: string;
  textColor: string;
  onStart: (ids: string[]) => void;
  onMove: (dx: number, dy: number) => void;
  onEnd: (dx: number, dy: number) => void;
  onContext: (x: number, y: number) => void;
}) {
  const { group, posOf, color } = props;
  const b = boundsOf(group.deviceIds.map(posOf), 56);
  if (!b) return null;
  return (
    <Group
      draggable
      onDragStart={() => props.onStart(group.deviceIds)}
      onDragMove={(e) => props.onMove(e.target.x(), e.target.y())}
      onDragEnd={(e) => {
        const dx = e.target.x();
        const dy = e.target.y();
        e.target.position({ x: 0, y: 0 });
        props.onEnd(dx, dy);
      }}
      onContextMenu={(e) => {
        e.evt.preventDefault();
        e.cancelBubble = true;
        props.onContext(e.evt.clientX, e.evt.clientY);
      }}
    >
      <Rect
        x={b.x}
        y={b.y}
        width={b.w}
        height={b.h}
        cornerRadius={14}
        stroke={color}
        strokeWidth={2}
        dash={[10, 5]}
        hitStrokeWidth={14}
      />
      <Text
        x={b.x + 10}
        y={b.y - 18}
        text={`▣ ${group.name}`}
        fontSize={13}
        fontStyle="bold"
        fill={props.textColor}
      />
    </Group>
  );
}

/** Notiz (Annotation) auf der Arbeitsfläche. */
function NoteShape(props: {
  note: Note;
  selected: boolean;
  colors: ReturnType<typeof readUxColors>;
  placeholder: string;
  snap: (v: number) => number;
  onContext: (x: number, y: number) => void;
}) {
  const { note, colors } = props;
  const h = noteHeight(note.text || props.placeholder);
  return (
    <Group
      x={note.x}
      y={note.y}
      draggable={useStore.getState().tool === 'select' || useStore.getState().tool === 'note'}
      onDragEnd={(e) =>
        useDoc
          .getState()
          .updateNote(note.id, { x: props.snap(e.target.x()), y: props.snap(e.target.y()) })
      }
      onClick={(e) => {
        e.cancelBubble = true;
        if (e.evt.button !== 0) return;
        useUx.getState().setSelectedNote(note.id);
        useStore.getState().selectDevice(null);
      }}
      onTap={(e) => {
        e.cancelBubble = true;
        useUx.getState().setSelectedNote(note.id);
      }}
      onDblClick={() => useUx.getState().editNote(note.id)}
      onDblTap={() => useUx.getState().editNote(note.id)}
      onContextMenu={(e) => {
        e.evt.preventDefault();
        e.cancelBubble = true;
        props.onContext(e.evt.clientX, e.evt.clientY);
      }}
    >
      <Rect
        width={NOTE_W}
        height={h}
        cornerRadius={4}
        fill={colors.noteBg}
        stroke={props.selected ? colors.band : colors.noteBorder}
        strokeWidth={props.selected ? 3 : 1.5}
        shadowBlur={3}
        shadowOpacity={0.15}
      />
      <Text
        x={8}
        y={8}
        width={NOTE_W - 16}
        height={h - 12}
        text={note.text || props.placeholder}
        fontSize={12}
        lineHeight={1.25}
        fill={note.text ? colors.noteText : colors.muted}
      />
    </Group>
  );
}

/** Eingabefeld über der Notiz (Doppelklick bzw. frisch angelegt). */
function NoteEditor({ stageView }: { stageView: { x: number; y: number; scale: number } }) {
  const { t } = useTranslation();
  const id = useUx((s) => s.editingNote);
  const note = useDoc((s) => s.notes.find((n) => n.id === id));
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (id) ref.current?.focus();
  }, [id]);
  if (!id || !note) return null;
  const done = () => {
    const n = useDoc.getState().notes.find((x) => x.id === id);
    if (n && !n.text.trim()) useDoc.getState().removeNote(id);
    useUx.getState().editNote(null);
    document.querySelector<HTMLElement>('.canvas-wrap')?.focus({ preventScroll: true });
  };
  return (
    <textarea
      ref={ref}
      className="note-editor"
      aria-label={t('ux.note.label')}
      style={{
        left: note.x * stageView.scale + stageView.x,
        top: note.y * stageView.scale + stageView.y,
        width: NOTE_W * stageView.scale,
        minHeight: noteHeight(note.text) * stageView.scale,
        fontSize: 12 * stageView.scale,
      }}
      value={note.text}
      onChange={(e) => useDoc.getState().updateNote(id, { text: e.target.value })}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          e.stopPropagation();
          done();
        }
      }}
    />
  );
}

function LinkShape(props: {
  link: LinkView;
  posOf: (id: string) => { x: number; y: number };
  devices: Map<string, DeviceView>;
  now: number;
  selected: boolean;
  showLabels: boolean;
  colorblind: boolean;
  colors: CanvasColors;
  onContext: (x: number, y: number) => void;
}) {
  const { link, posOf, devices, now, selected, showLabels, colorblind, colors } = props;
  const a = posOf(link.a.deviceId);
  const b = posOf(link.b.deviceId);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const blinking = link.operUp && now - link.lastActivityT < BLINK_US && link.lastActivityT >= 0;
  const portName = (ref: { deviceId: string; portId: string }): string =>
    shortPort(devices.get(ref.deviceId)?.ports.find((p) => p.id === ref.portId)?.name ?? '');
  const cableDash =
    link.cable === 'crossover' ? [10, 5] : link.cable === 'rollover' ? [2, 4] : undefined;

  const select = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    e.cancelBubble = true;
    if ('button' in e.evt && e.evt.button !== 0) return;
    const s = useStore.getState();
    if (s.tool === 'delete') void api.disconnect(link.id);
    else {
      s.selectLink(link.id);
      useUx.getState().setSelectedNote(null);
    }
  };
  const context = (e: Konva.KonvaEventObject<MouseEvent>) => {
    e.evt.preventDefault();
    e.cancelBubble = true;
    useStore.getState().selectLink(link.id);
    props.onContext(e.evt.clientX, e.evt.clientY);
  };

  const light = (x: number, y: number) => {
    const fill = blinking
      ? colors.blink
      : link.stpBlocked
        ? colors.stp
        : link.operUp
          ? colors.up
          : colors.down;
    // Farbenblind-Modus: Form statt nur Farbe (Kreis = up, Raute = down, Quadrat = STP blockiert)
    const shape = linkLightShape(colorblind, link.operUp, !!link.stpBlocked);
    return shape !== 'circle' ? (
      <Rect
        x={x}
        y={y}
        width={9}
        height={9}
        offsetX={4.5}
        offsetY={4.5}
        rotation={shape === 'diamond' ? 45 : 0}
        fill={fill}
        stroke={colors.ring}
        strokeWidth={1.5}
        listening={false}
      />
    ) : (
      <Circle
        x={x}
        y={y}
        radius={blinking ? 6 : 5}
        fill={fill}
        stroke={colors.ring}
        strokeWidth={1.5}
        listening={false}
      />
    );
  };
  const off = 38;
  if (link.cable === 'wireless') {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    return (
      <Group>
        <Line
          points={[a.x, a.y, b.x, b.y]}
          stroke={selected ? colors.sel : colors.wifi24}
          strokeWidth={selected ? 3 : 2}
          hitStrokeWidth={14}
          dash={[7, 6]}
          onClick={select}
          onTap={select}
          onContextMenu={context}
        />
        <Text
          x={mx - 16}
          y={my - 10}
          text="((·))"
          fontSize={15}
          fill={blinking ? colors.blink : colors.wifi24}
          listening={false}
        />
      </Group>
    );
  }
  return (
    <Group>
      <Line
        points={[a.x, a.y, b.x, b.y]}
        stroke={selected ? colors.sel : colors.line}
        strokeWidth={selected ? 3.5 : 2.5}
        hitStrokeWidth={14}
        dash={link.operUp ? (link.stpBlocked ? [8, 4] : cableDash) : [3, 5]}
        onClick={select}
        onTap={select}
        onContextMenu={context}
      />
      {light(a.x + ux * off, a.y + uy * off)}
      {light(b.x - ux * off, b.y - uy * off)}
      {showLabels && (
        <>
          <Text
            x={a.x + ux * (off + 8) - 20}
            y={a.y + uy * (off + 8) - 14 - 6 * Math.abs(uy)}
            text={portName(link.a)}
            fontSize={10}
            fill={colors.text}
            listening={false}
          />
          <Text
            x={b.x - ux * (off + 8) - 20}
            y={b.y - uy * (off + 8) - 14 - 6 * Math.abs(uy)}
            text={portName(link.b)}
            fontSize={10}
            fill={colors.text}
            listening={false}
          />
        </>
      )}
    </Group>
  );
}

function Tooltip({ hover, wrap }: { hover: Hover; wrap: HTMLDivElement | null }) {
  const { t } = useTranslation();
  const rect = wrap?.getBoundingClientRect();
  const d = hover.device;
  const style = {
    left: hover.x - (rect?.left ?? 0) + 14,
    top: hover.y - (rect?.top ?? 0) + 14,
  };
  return (
    <div className="tooltip" style={style} role="tooltip">
      <strong>{d.name}</strong> <span className="muted">{d.model}</span>
      {d.ip && (
        <div>
          IP: {d.ip}/{d.mask}
        </div>
      )}
      {!d.powered && <div className="warn">{t('dev.powerOff')}</div>}
      {d.ports
        .filter((p) => p.linkId)
        .map((p) => {
          const ip = portIp(d, p.id, p.name);
          const vlan = portVlan(d, p.id);
          return (
            <div key={p.id}>
              <span className={p.operUp ? 'dot up' : 'dot down'} aria-hidden />
              {p.name}: {p.operUp ? t('port.up') : t('port.down')}
              {ip ? ` · ${ip}` : ''}
              {vlan ? ` · ${vlan}` : ''} · {p.mac}
            </div>
          );
        })}
    </div>
  );
}

const ANIM_MS = 700;
const PROTO_LETTER: Record<string, string> = { ARP: 'A', ICMP: 'I', CSMA: 'C', ETH: 'E' };

/** Umschläge, die entlang der Links zum Empfänger wandern (Simulationsmodus). */
function Envelopes({
  posOf,
  colors,
  colorblind,
}: {
  posOf: (id: string) => { x: number; y: number };
  colors: CanvasColors;
  colorblind: boolean;
}) {
  const anims = useStore((s) => s.animations);
  const selectLog = useStore((s) => s.selectLog);
  const [, setTick] = useState(0);
  const active = anims.length > 0;

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const loop = () => {
      setTick((n) => n + 1);
      const now = performance.now();
      const expired = useStore
        .getState()
        .animations.filter((a) => now - a.start > ANIM_MS)
        .map((a) => a.id);
      if (expired.length) useStore.getState().removeAnimations(expired);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  const now = performance.now();
  return (
    <>
      {anims.map((a) => {
        const p = Math.min(1, Math.max(0, (now - a.start) / ANIM_MS));
        const from = posOf(a.fromId);
        const to = posOf(a.toId);
        const x = from.x + (to.x - from.x) * p;
        const y = from.y + (to.y - from.y) * p;
        const color = a.ok ? (colors.proto[a.proto] ?? colors.protoDefault) : colors.down;
        return (
          <Group
            key={a.id}
            x={x}
            y={y}
            onClick={(e) => {
              e.cancelBubble = true;
              selectLog(a.logId);
            }}
            onTap={() => selectLog(a.logId)}
          >
            <Rect
              x={-11}
              y={-8}
              width={22}
              height={16}
              cornerRadius={2}
              fill={color}
              stroke={colors.ring}
              strokeWidth={1.5}
            />
            {/* Farbenblind-Modus: Buchstabe des Protokolls statt reiner Farbcodierung */}
            {colorblind && a.ok ? (
              <Text
                x={-11}
                y={-6}
                width={22}
                align="center"
                text={PROTO_LETTER[a.proto] ?? '•'}
                fontSize={12}
                fontStyle="bold"
                fill={colors.card}
                listening={false}
              />
            ) : (
              <Line
                points={[-11, -8, 0, 1, 11, -8]}
                stroke={colors.card}
                strokeWidth={1.5}
                listening={false}
              />
            )}
            {!a.ok && (
              <Text x={-5} y={-8} text="✗" fontSize={16} fill={colors.card} listening={false} />
            )}
          </Group>
        );
      })}
    </>
  );
}
