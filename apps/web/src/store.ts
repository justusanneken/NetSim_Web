import { create } from 'zustand';
import type {
  CableType,
  DeviceType,
  DeviceView,
  LogEntry,
  PortRef,
  SimMode,
  ViewModel,
} from '@netsim/engine';
import { api, proxy } from './engine/client';

export type Tool = 'select' | 'hand' | 'cable' | 'delete' | 'pdu';
export type CableChoice = CableType | 'auto';
export type Theme = 'light' | 'dark';

export const ALL_PROTOS = ['ETH', 'ARP', 'ICMP', 'LINK', 'CSMA', 'SYS'] as const;
export type ProtoFilter = (typeof ALL_PROTOS)[number];

export interface PortPicker {
  deviceId: string;
  /** Bildschirmposition für das Popup. */
  x: number;
  y: number;
}

interface UiState {
  view: ViewModel | null;
  log: LogEntry[];
  tool: Tool;
  cable: CableChoice;
  placing: DeviceType | null;
  selectedDevice: string | null;
  selectedLink: string | null;
  selectedLog: number | null;
  cableStart: { deviceId: string; port?: PortRef } | null;
  pduSource: string | null;
  portPicker: PortPicker | null;
  filters: Record<ProtoFilter, boolean>;
  showPortLabels: boolean;
  colorblind: boolean;
  theme: Theme;
  toast: { key: string; params?: Record<string, string | number>; kind: 'ok' | 'error' } | null;
  stageView: { x: number; y: number; scale: number };

  setTool(t: Tool): void;
  setCable(c: CableChoice): void;
  setPlacing(t: DeviceType | null): void;
  selectDevice(id: string | null): void;
  selectLink(id: string | null): void;
  selectLog(id: number | null): void;
  setFilter(p: ProtoFilter, on: boolean): void;
  setAllFilters(on: boolean): void;
  togglePortLabels(): void;
  toggleColorblind(): void;
  setTheme(t: Theme): void;
  setStageView(v: { x: number; y: number; scale: number }): void;
  showToast(key: string, params?: Record<string, string | number>, kind?: 'ok' | 'error'): void;
  cancel(): void;

  addDevice(type: DeviceType, x: number, y: number): Promise<void>;
  deviceClicked(id: string, clientX: number, clientY: number): Promise<void>;
  pickPort(portId: string): Promise<void>;
  deleteSelected(): Promise<void>;
  ping(id: string, dst: string, count?: number): Promise<void>;
  newTopology(): Promise<void>;
}

function loadPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {
    /* ignorieren */
  }
  return fallback;
}
function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignorieren */
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let syncing = false;
let syncAgain = false;
let epoch = -1;

export const useStore = create<UiState>((set, get) => ({
  view: null,
  log: [],
  tool: 'select',
  cable: 'auto',
  placing: null,
  selectedDevice: null,
  selectedLink: null,
  selectedLog: null,
  cableStart: null,
  pduSource: null,
  portPicker: null,
  filters: { ETH: true, ARP: true, ICMP: true, LINK: true, CSMA: true, SYS: true },
  showPortLabels: false,
  colorblind: loadPref('netsim.cb', ['0', '1'], '0') === '1',
  theme: loadPref('netsim.theme', ['light', 'dark'], 'light'),
  toast: null,
  stageView: { x: 0, y: 0, scale: 1 },

  setTool(tool) {
    set({ tool, placing: null, cableStart: null, pduSource: null, portPicker: null });
  },
  setCable(cable) {
    set({ cable, cableStart: null, portPicker: null });
  },
  setPlacing(placing) {
    set({ placing, tool: 'select', cableStart: null, portPicker: null });
  },
  selectDevice(id) {
    set({ selectedDevice: id, selectedLink: null });
  },
  selectLink(id) {
    set({ selectedLink: id, selectedDevice: null });
  },
  selectLog(id) {
    set({ selectedLog: id });
  },
  setFilter(p, on) {
    set((s) => ({ filters: { ...s.filters, [p]: on } }));
  },
  setAllFilters(on) {
    set({
      filters: Object.fromEntries(ALL_PROTOS.map((p) => [p, on])) as Record<ProtoFilter, boolean>,
    });
  },
  togglePortLabels() {
    set((s) => ({ showPortLabels: !s.showPortLabels }));
  },
  toggleColorblind() {
    const v = !get().colorblind;
    savePref('netsim.cb', v ? '1' : '0');
    set({ colorblind: v });
  },
  setTheme(theme) {
    savePref('netsim.theme', theme);
    set({ theme });
  },
  setStageView(stageView) {
    set({ stageView });
  },
  showToast(key, params, kind = 'error') {
    set({ toast: { key, params, kind } });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 4000);
  },
  cancel() {
    set({ placing: null, cableStart: null, pduSource: null, portPicker: null });
  },

  async addDevice(type, x, y) {
    const id = await api.addDevice(type, { x, y });
    set({ placing: null, selectedDevice: id, selectedLink: null });
  },

  async deviceClicked(id, clientX, clientY) {
    const s = get();
    if (s.tool === 'delete') {
      await api.removeDevice(id);
      if (s.selectedDevice === id) set({ selectedDevice: null });
      return;
    }
    if (s.tool === 'pdu') {
      if (!s.pduSource) {
        set({ pduSource: id });
        return;
      }
      const src = s.pduSource;
      set({ pduSource: null });
      const dst = s.view?.devices.find((d) => d.id === id);
      if (!dst?.ip) {
        get().showToast('toast.noTargetIp');
        return;
      }
      await get().ping(src, dst.ip);
      return;
    }
    if (s.tool === 'cable') {
      if (s.cable === 'auto') {
        if (!s.cableStart) {
          set({ cableStart: { deviceId: id } });
          return;
        }
        const a = s.cableStart.deviceId;
        set({ cableStart: null });
        const r = await api.connectAuto(a, id);
        if (!r.ok) get().showToast(r.error);
        return;
      }
      set({ portPicker: { deviceId: id, x: clientX, y: clientY } });
      return;
    }
    set({ selectedDevice: id, selectedLink: null });
  },

  async pickPort(portId) {
    const s = get();
    const picker = s.portPicker;
    if (!picker || s.cable === 'auto') return;
    const ref: PortRef = { deviceId: picker.deviceId, portId };
    if (!s.cableStart?.port) {
      set({ cableStart: { deviceId: picker.deviceId, port: ref }, portPicker: null });
      return;
    }
    const a = s.cableStart.port;
    set({ cableStart: null, portPicker: null });
    const r = await api.connect(a, ref, s.cable);
    if (!r.ok) get().showToast(r.error);
  },

  async deleteSelected() {
    const s = get();
    if (s.selectedDevice) {
      await api.removeDevice(s.selectedDevice);
      set({ selectedDevice: null });
    } else if (s.selectedLink) {
      await api.disconnect(s.selectedLink);
      set({ selectedLink: null });
    }
  },

  async ping(id, dst, count = 1) {
    const r = await api.ping(id, dst, { count });
    if (!r.ok) get().showToast(r.error);
  },

  async newTopology() {
    await api.clear();
    set({ selectedDevice: null, selectedLink: null, selectedLog: null });
  },
}));

// ------------------------------------------------------------------ Engine-Anbindung

async function syncLog(): Promise<void> {
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    do {
      syncAgain = false;
      const v = useStore.getState().view;
      if (!v) break;
      let log = useStore.getState().log;
      if (v.logEpoch !== epoch || v.logLength < log.length) {
        epoch = v.logEpoch;
        log = [];
      }
      if (v.logLength > log.length) {
        const more = await api.getLog(log.length, v.logLength - log.length);
        log = log.concat(more);
      }
      useStore.setState({ log });
    } while (syncAgain);
  } finally {
    syncing = false;
  }
}

export async function connectEngine(): Promise<void> {
  await api.subscribe(
    proxy((view: ViewModel) => {
      const s = useStore.getState();
      const patch: Partial<UiState> = { view };
      if (s.selectedDevice && !view.devices.some((d) => d.id === s.selectedDevice)) {
        patch.selectedDevice = null;
      }
      if (s.selectedLink && !view.links.some((l) => l.id === s.selectedLink)) {
        patch.selectedLink = null;
      }
      useStore.setState(patch);
      void syncLog();
    }),
  );
}

export const sim = {
  setMode: (m: SimMode) => api.setMode(m),
  play: () => api.play(),
  pause: () => api.pause(),
  step: () => api.step(),
  stepBack: () => api.stepBack(),
  reset: () => api.reset(),
  setSpeed: (f: number) => api.setSpeed(f),
};

export function selectedDeviceView(s: UiState): DeviceView | undefined {
  return s.view?.devices.find((d) => d.id === s.selectedDevice);
}
