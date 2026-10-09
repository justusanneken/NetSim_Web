import { create } from 'zustand';
import type {
  ActivityPublic,
  Check,
  ChallengeQuestion,
  EvalSummary,
  PduSpecInput,
  ScenarioFile,
} from '@netsim/engine';
import { api } from '../engine/client';
import { useStore } from '../store';

/** Zustand der Lehr-Werkzeuge in der Oberfläche (Szenarien, Aufgabe, Challenge Me). */
interface TeachState {
  scen: ScenarioFile | null;
  pduDialog: boolean;
  /** Geladene Aufgabe (ohne Netzzustände). */
  activity: ActivityPublic | null;
  /** Ergebnis der letzten Prüfung (je Prüfung) – `null`, bis „Prüfen“ gedrückt wurde. */
  results: EvalSummary | null;
  /** Fortschritt aus der Live-Auswertung (Prozent). */
  live: number | null;
  checking: boolean;
  startedAt: number | null;
  expired: boolean;
  hintsShown: Record<string, boolean>;
  authorOpen: boolean;
  /** Challenge Me. */
  challengeOn: boolean;
  questions: ChallengeQuestion[];
  answers: Record<string, string>;
  /** Dauerhafter Punktestand (über Ereignisse hinweg). */
  score: { answered: number; correct: number };

  openPduDialog(open: boolean): void;
  refreshScenarios(): Promise<void>;
  addPdu(spec: PduSpecInput, send?: boolean): Promise<boolean>;
  rerunPdu(id: number): Promise<void>;
  deletePdu(id: number): Promise<void>;
  clearPdus(): Promise<void>;
  addScenario(): Promise<void>;
  selectScenario(i: number): Promise<void>;
  deleteScenario(i: number): Promise<void>;
  updateScenario(i: number, patch: { name?: string; description?: string }): Promise<void>;

  loadActivity(data: Uint8Array | ActivityPublic | unknown): Promise<boolean>;
  closeActivity(): Promise<void>;
  checkActivity(): Promise<void>;
  liveCheck(): Promise<void>;
  restartActivity(): Promise<void>;
  showAnswer(): Promise<void>;
  showHint(id: string): void;
  setAuthorOpen(open: boolean): void;
  expire(): Promise<void>;

  setChallenge(on: boolean): void;
  loadQuestions(logId: number | null): Promise<void>;
  answer(q: ChallengeQuestion, optionId: string): void;
  resetScore(): void;
}

export const useTeach = create<TeachState>((set, get) => ({
  scen: null,
  pduDialog: false,
  activity: null,
  results: null,
  live: null,
  checking: false,
  startedAt: null,
  expired: false,
  hintsShown: {},
  authorOpen: false,
  challengeOn: false,
  questions: [],
  answers: {},
  score: { answered: 0, correct: 0 },

  openPduDialog(open) {
    set({ pduDialog: open });
  },

  async refreshScenarios() {
    const f = await api.getScenarios();
    const cur = get().scen;
    if (!cur || JSON.stringify(cur) !== JSON.stringify(f)) set({ scen: f });
  },
  async addPdu(spec, send = true) {
    const r = await api.pduAdd(spec, send);
    if (!r.ok) {
      useStore.getState().showToast(r.error, r.params);
      return false;
    }
    await get().refreshScenarios();
    return true;
  },
  async rerunPdu(id) {
    const r = await api.pduRerun(id);
    if (!r.ok) useStore.getState().showToast(r.error, r.params);
    await get().refreshScenarios();
  },
  async deletePdu(id) {
    await api.pduDelete(id);
    await get().refreshScenarios();
  },
  async clearPdus() {
    await api.pduClear();
    await get().refreshScenarios();
  },
  async addScenario() {
    await api.scenarioAdd();
    await get().refreshScenarios();
  },
  async selectScenario(i) {
    await api.scenarioSelect(i);
    await get().refreshScenarios();
  },
  async deleteScenario(i) {
    const r = await api.scenarioDelete(i);
    if (!r.ok) useStore.getState().showToast(r.error, r.params);
    await get().refreshScenarios();
  },
  async updateScenario(i, patch) {
    await api.scenarioUpdate(i, patch);
    await get().refreshScenarios();
  },

  async loadActivity(data) {
    const r = await api.activityLoad(data);
    if (!r.ok) {
      useStore.getState().showToast(r.error, r.params);
      return false;
    }
    useStore.setState({ selectedDevice: null, selectedLink: null, selectedLog: null });
    set({
      activity: r.value,
      results: null,
      live: null,
      startedAt: Date.now(),
      expired: false,
      hintsShown: {},
    });
    await get().refreshScenarios();
    return true;
  },
  async closeActivity() {
    await api.activityClose();
    set({ activity: null, results: null, live: null, startedAt: null, expired: false });
  },
  async checkActivity() {
    set({ checking: true });
    try {
      const r = await api.activityCheck();
      if (r.ok) set({ results: r.value, live: r.value.percent });
      else useStore.getState().showToast(r.error, r.params);
    } finally {
      set({ checking: false });
    }
  },
  async liveCheck() {
    if (get().checking) return;
    const r = await api.activityCheck();
    if (r.ok) set({ live: r.value.percent });
  },
  async restartActivity() {
    const r = await api.activityRestart();
    if (!r.ok) useStore.getState().showToast(r.error, r.params);
    set({ results: null, live: null, startedAt: Date.now(), expired: false });
  },
  async showAnswer() {
    const r = await api.activityShowAnswer();
    if (!r.ok) useStore.getState().showToast(r.error, r.params);
  },
  showHint(id) {
    set((s) => ({ hintsShown: { ...s.hintsShown, [id]: true } }));
  },
  setAuthorOpen(open) {
    set({ authorOpen: open });
  },
  async expire() {
    if (get().expired) return;
    set({ expired: true });
    await get().checkActivity();
  },

  setChallenge(on) {
    set({ challengeOn: on, questions: [], answers: {} });
  },
  async loadQuestions(logId) {
    if (logId === null || !get().challengeOn) {
      set({ questions: [] });
      return;
    }
    const qs = (await api.challenge(logId)) as ChallengeQuestion[];
    set({ questions: qs });
  },
  answer(q, optionId) {
    const s = get();
    if (s.answers[q.id] !== undefined) return;
    set({
      answers: { ...s.answers, [q.id]: optionId },
      score: {
        answered: s.score.answered + 1,
        correct: s.score.correct + (q.correct === optionId ? 1 : 0),
      },
    });
  },
  resetScore() {
    set({ score: { answered: 0, correct: 0 }, answers: {} });
  },
}));

type Locks = { hideCli: boolean; hideGui: boolean; noAddDevices: boolean } | undefined;

/** Aufgaben-Sperren: CLI-Tab bzw. GUI-Tabs (Config, Desktop-Apps) ausblenden. */
export function lockTabs(tabs: string[], locks: Locks): string[] {
  if (!locks) return tabs;
  const out = tabs.filter(
    (t) => !(locks.hideCli && t === 'cli') && !(locks.hideGui && t === 'config'),
  );
  return out.length > 0 ? out : tabs.filter((t) => t === 'physical');
}

export function lockApps<T extends { id: string }>(apps: T[], locks: Locks): T[] {
  if (!locks) return apps;
  return apps.filter((a) => {
    if (locks.hideCli && a.id === 'cmd') return false;
    // GUI gesperrt: nur das Terminal des Hosts bleibt
    if (locks.hideGui && a.id !== 'cmd') return false;
    return true;
  });
}

export type { Check };
