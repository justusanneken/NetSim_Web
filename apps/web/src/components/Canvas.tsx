import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type Konva from 'konva';
import { Circle, Group, Layer, Line, Path, Rect, Shape, Stage, Text } from 'react-konva';
import { useTranslation } from 'react-i18next';
import type { DeviceType, DeviceView, LinkView } from '@netsim/engine';
import { api } from '../engine/client';
import { shortPort } from '../format';
import { deviceColor, ICON_FALLBACK, ICON_PATHS } from '../icons';
import { useStore } from '../store';
import { linkLightShape, readCanvasColors, type CanvasColors } from '../theme';

const GRID = 20;
const BLINK_US = 200_000;

const snap = (v: number): number => Math.round(v / (GRID / 2)) * (GRID / 2);

interface Hover {
  device: DeviceView;
  x: number;
  y: number;
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
  const colors = useMemo(() => readCanvasColors(theme, colorblind), [theme, colorblind]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [drag, setDrag] = useState<Record<string, { x: number; y: number }>>({});
  const [hover, setHover] = useState<Hover | null>(null);

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
    (id: string): { x: number; y: number } => drag[id] ?? devices.get(id)?.pos ?? { x: 0, y: 0 },
    [drag, devices],
  );

  const worldPointer = (): { x: number; y: number } | null => {
    const st = stageRef.current;
    const p = st?.getRelativePointerPosition();
    return p ? { x: snap(p.x), y: snap(p.y) } : null;
  };

  const onStageClick = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (e.target !== e.target.getStage() && e.target.name() !== 'bg') return;
    const s = useStore.getState();
    if (s.placing) {
      const p = worldPointer();
      if (p) void s.addDevice(s.placing, p.x, p.y);
      return;
    }
    if (s.tool === 'select') {
      s.selectDevice(null);
      s.selectLink(null);
    } else if (s.tool === 'cable' || s.tool === 'pdu') s.cancel();
  };

  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const st = stageRef.current;
    if (!st) return;
    const cur = useStore.getState().stageView;
    if (e.evt.ctrlKey || e.evt.metaKey) {
      const pointer = st.getPointerPosition();
      if (!pointer) return;
      const factor = e.evt.deltaY < 0 ? 1.1 : 1 / 1.1;
      const scale = Math.min(3, Math.max(0.25, cur.scale * factor));
      const wx = (pointer.x - cur.x) / cur.scale;
      const wy = (pointer.y - cur.y) / cur.scale;
      useStore.getState().setStageView({
        scale,
        x: pointer.x - wx * scale,
        y: pointer.y - wy * scale,
      });
    } else {
      useStore
        .getState()
        .setStageView({ ...cur, x: cur.x - e.evt.deltaX, y: cur.y - e.evt.deltaY });
    }
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

  const now = view?.now ?? 0;

  return (
    <div
      ref={wrapRef}
      className={`canvas-wrap tool-${tool}${placing ? ' placing' : ''}`}
      role="application"
      aria-label={t('canvas.aria')}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
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
      >
        <Layer listening={false}>
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
        </Layer>
        <Layer>
          {/* Unsichtbare Fläche zum Fangen von Klicks im Leerraum */}
          <Rect name="bg" x={-50000} y={-50000} width={100000} height={100000} fill="transparent" />
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
            />
          ))}
          <Envelopes posOf={posOf} colors={colors} colorblind={colorblind} />
          {view?.devices.map((d) => {
            const pos = posOf(d.id);
            const color = deviceColor(d.type, theme);
            const active = cableStart?.deviceId === d.id || pduSource === d.id;
            return (
              <Group
                key={d.id}
                x={pos.x}
                y={pos.y}
                draggable={tool === 'select'}
                opacity={d.powered ? 1 : 0.55}
                onDragMove={(e) =>
                  setDrag((m) => ({ ...m, [d.id]: { x: e.target.x(), y: e.target.y() } }))
                }
                onDragEnd={(e) => {
                  const p = { x: snap(e.target.x()), y: snap(e.target.y()) };
                  e.target.position(p);
                  setDrag((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== d.id)));
                  void api.moveDevice(d.id, p);
                }}
                onClick={(e) => {
                  e.cancelBubble = true;
                  void useStore.getState().deviceClicked(d.id, e.evt.clientX, e.evt.clientY);
                }}
                onTap={(e) => {
                  e.cancelBubble = true;
                  const t0 = (e.evt as unknown as TouchEvent).changedTouches?.[0];
                  void useStore.getState().deviceClicked(d.id, t0?.clientX ?? 0, t0?.clientY ?? 0);
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
                  stroke={selectedDevice === d.id ? colors.sel : active ? colors.active : color}
                  strokeWidth={selectedDevice === d.id || active ? 3 : 1.5}
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
        </Layer>
      </Stage>
      {hover && !drag[hover.device.id] && <Tooltip hover={hover} wrap={wrapRef.current} />}
    </div>
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
    const s = useStore.getState();
    if (s.tool === 'delete') void api.disconnect(link.id);
    else s.selectLink(link.id);
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
        .map((p) => (
          <div key={p.id}>
            <span className={p.operUp ? 'dot up' : 'dot down'} aria-hidden />
            {p.name}: {p.operUp ? t('port.up') : t('port.down')} · {p.mac}
          </div>
        ))}
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
