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
import { isEndDevice } from './deviceKinds';
import { syncLogWindow } from './logSync';
import { useTeach } from './teach/teachStore';

export type Tool = 'select' | 'hand' | 'cable' | 'delete' | 'pdu';
export type CableChoice = CableType | 'auto';
export type Theme = 'light' | 'dark';
export type ViewMode = 'logical' | 'physical';

export const ALL_PROTOS = [
  'ETH',
  'ARP',
  'ICMP',
  'UDP',
  'TCP',
  'DHCP',
  'DNS',
  'HTTP',
  'STP',
  'VTP',
  'NAT',
  'ACL',
  'RIP',
  'OSPF',
  'EIGRP',
  'BGP',
  'HSRP',
  'GRE',
  'ICMP6',
  'ND',
  'LINK',
  'CSMA',
  'SYS',
  'TFTP',
  'FTP',
  'SMTP',
  'POP3',
  'NTP',
  'SYSLOG',
  'SNMP',
  'RADIUS',
  'TELNET',
  'SSH',
  'IOT',
  'WIFI',
  'FW',
  'CAPWAP',
  'TACACS',
  'PPPOE',
  'PPP',
  'IKE',
  'ESP',
] as const;
export type ProtoFilter = (typeof ALL_PROTOS)[number];

export interface Anim {
  id: number;
  logId: number;
  fromId: string;
  toId: string;
  ok: boolean;
  proto: string;
  start: number;
}

export interface PortPicker {
  deviceId: string;
  /** Bildschirmposition für das Popup. */
  x: number;
  y: number;
}

interface UiState {
  view: ViewModel | null;
  log: LogEntry[];
  /** Id des ersten Eintrags in `log` (die Engine trimmt das Log; `log[i].id === logBase + i`). */
  logBase: number;
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
  viewMode: ViewMode;
  toast: { key: string; params?: Record<string, string | number>; kind: 'ok' | 'error' } | null;
  stageView: { x: number; y: number; scale: number };
  dialog: { deviceId: string; tab: string } | null;
  animations: Anim[];

  openDialog(deviceId: string, tab?: string): void;
  setDialogTab(tab: string): void;
  closeDialog(): void;
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
  setViewMode(m: ViewMode): void;
  setStageView(v: { x: number; y: number; scale: number }): void;
  showToast(key: string, params?: Record<string, string | number>, kind?: 'ok' | 'error'): void;
  removeAnimations(ids: number[]): void;
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
  logBase: 0,
  tool: 'select',
  cable: 'auto',
  placing: null,
  selectedDevice: null,
  selectedLink: null,
  selectedLog: null,
  cableStart: null,
  pduSource: null,
  portPicker: null,
  // Periodische Routing-Protokolle (Hello/Updates) standardmäßig ausgeblendet – sonst flutet das die Liste
  filters: Object.fromEntries(
    ALL_PROTOS.map((p) => [
      p,
      !['RIP', 'OSPF', 'EIGRP', 'BGP', 'HSRP', 'IOT', 'CAPWAP'].includes(p),
    ]),
  ) as Record<ProtoFilter, boolean>,
  showPortLabels: false,
  colorblind: loadPref('netsim.cb', ['0', '1'], '0') === '1',
  theme: loadPref('netsim.theme', ['light', 'dark'], 'light'),
  viewMode: 'logical',
  toast: null,
  stageView: { x: 0, y: 0, scale: 1 },
  dialog: null,
  animations: [],

  openDialog(deviceId, tab) {
    const dev = get().view?.devices.find((d) => d.id === deviceId);
    if (!dev || dev.type === 'hub') return;
    const host = isEndDevice(dev);
    set({
      dialog: { deviceId, tab: tab ?? (host ? 'desktop' : 'config') },
      selectedDevice: deviceId,
    });
  },
  setDialogTab(tab) {
    set((s) => (s.dialog ? { dialog: { ...s.dialog, tab } } : {}));
  },
  closeDialog() {
    set({ dialog: null });
  },

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
  setViewMode(viewMode) {
    set({ viewMode });
  },
  setStageView(stageView) {
    set({ stageView });
  },
  showToast(key, params, kind = 'error') {
    set({ toast: { key, params, kind } });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 4000);
  },
  removeAnimations(ids) {
    set((s) => ({ animations: s.animations.filter((a) => !ids.includes(a.id)) }));
  },
  cancel() {
    set({ placing: null, cableStart: null, pduSource: null, portPicker: null });
  },

  async addDevice(type, x, y) {
    if (useTeach.getState().activity?.locks.noAddDevices) {
      get().showToast('activity.locked.add');
      set({ placing: null });
      return;
    }
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
      // Simple PDU: ICMP-Echo, erscheint mit Status in der PDU-Liste des aktiven Szenarios
      await useTeach.getState().addPdu({ protocol: 'icmp', src, dst: dst.ip });
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
        if (!r.ok) get().showToast(r.error, r.params);
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
    if (!r.ok) get().showToast(r.error, r.params);
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
    if (!r.ok) get().showToast(r.error, r.params);
  },

  async newTopology() {
    await api.clear();
    set({ selectedDevice: null, selectedLink: null, selectedLog: null });
  },
}));

// ------------------------------------------------------------------ Engine-Anbindung

let animSeq = 0;
function addAnimations(entries: LogEntry[]): void {
  const fresh: Anim[] = [];
  for (const e of entries.slice(-6)) {
    if (!e.frame || !e.lastDeviceId || e.lastDeviceId === e.atDeviceId) continue;
    if (e.kind !== 'rx' && e.kind !== 'drop') continue;
    fresh.push({
      id: ++animSeq,
      logId: e.id,
      fromId: e.lastDeviceId,
      toId: e.atDeviceId,
      ok: e.status !== 'drop' && e.status !== 'error',
      proto: e.proto,
      start: performance.now(),
    });
  }
  if (fresh.length)
    useStore.setState((s) => ({ animations: [...s.animations, ...fresh].slice(-30) }));
}

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
      const cur = useStore.getState();
      const reset = v.logEpoch !== epoch;
      epoch = v.logEpoch;
      const curEnd = cur.logBase + cur.log.length;
      const next = await syncLogWindow(
        { log: cur.log, base: cur.logBase },
        v,
        reset,
        (from, limit) => api.getLog(from, limit),
      );
      useStore.setState({ log: next.log, logBase: next.base });
      if (v.mode === 'simulation' && !reset) {
        const fresh = next.log.filter((l) => l.id >= curEnd);
        if (fresh.length > 0) addAnimations(fresh);
      }
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
