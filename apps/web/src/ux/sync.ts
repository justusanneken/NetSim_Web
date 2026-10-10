import { useStore } from '../store';
import { useDoc } from './uiDoc';
import { useUx } from './ux';

/**
 * Hält Mehrfachauswahl, `store.selectedDevice` und das UI-Dokument konsistent:
 * - einzelne Auswahl im Store (Geräteliste, Klick) ⇒ Mehrfachauswahl = dieses Gerät,
 * - gelöschte Geräte verschwinden aus Auswahl, Gruppen und Attributen.
 */
let started = false;
export function startUxSync(): void {
  if (started) return;
  started = true;
  let known = new Set<string>();
  useStore.subscribe((s, prev) => {
    if (s.selectedDevice !== prev.selectedDevice) {
      const ux = useUx.getState();
      if (!s.selectedDevice) {
        if (ux.selectedIds.length > 0) ux.setSelected([]);
      } else if (!ux.selectedIds.includes(s.selectedDevice)) ux.setSelected([s.selectedDevice]);
      if (s.selectedDevice) ux.setSelectedNote(null);
    }
    if (s.view !== prev.view && s.view) {
      const ids = new Set(s.view.devices.map((d) => d.id));
      const removed = [...known].filter((id) => !ids.has(id));
      known = ids;
      if (removed.length > 0) {
        const ux = useUx.getState();
        ux.setSelected(ux.selectedIds.filter((id) => ids.has(id)));
        // nur tatsächlich entfernte Geräte bereinigen (ein noch ladender Zustand soll Gruppen nicht löschen)
        useDoc.getState().removeDevices(removed);
      }
    }
  });
}
