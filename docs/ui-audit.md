# UI-Lückenanalyse (Spec Abschnitt 5) und Barrierefreiheits-Audit

Stand: Phase 6, Arbeitspaket „ux“. Status: **ok** = vorhanden und per Test belegt, **neu** = in Phase 6 ergänzt, **andere** = gehört einem anderen Arbeitspaket (Phase 6), **offen** = bewusst nicht umgesetzt (siehe `simplifications.md`).

## Layout

| Spec-Punkt                                                                   | Status | Anmerkung / Test                                                               |
| ---------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| Menüleiste Datei, Bearbeiten, Optionen, Ansicht, Extras, Hilfe, Sprache      | ok     | `MenuBar.tsx`; neu: Menü „Anordnen“, Tastaturbedienung (Pfeile, Esc, Home/End) |
| Hauptsymbolleiste: Auswählen, Verschieben, Löschen, Zoom, Simple/Complex PDU | ok     | `Toolbar.tsx`                                                                  |
| Symbolleiste: Notiz                                                          | neu    | Werkzeug `note` (Taste N), `ux.spec.ts`                                        |
| Rechte Leiste: Szenarien                                                     | andere | teach                                                                          |
| Rechte Leiste: Netzwerkinformationen                                         | neu    | Fenster mit Tabellen (Interfaces, Routen, ARP, MAC)                            |
| Palette Kategorien → Geräte → Kabel                                          | ok     | `Palette.tsx`; neu: Enter platziert per Tastatur an freier Stelle              |
| Simulationspanel                                                             | ok     | `SimPanel.tsx` (Export PCAP/Hex: script)                                       |

## Arbeitsfläche

| Spec-Punkt                                    | Status            | Anmerkung                                                                                    |
| --------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| Logical View, frei positionierbar             | ok                |                                                                                              |
| Physical View (Stadt → Gebäude → Raum → Rack) | ok                | `PanelPhysical.tsx`                                                                          |
| Hintergrundbild                               | neu               | Dialog in „Ansicht“, auf 2000 px verkleinert, im UI-Dokument                                 |
| Raster / Snap                                 | neu               | Raster ein/aus, Snap ein/aus (Toolbar, Ansicht), vorher fest                                 |
| Zoom (Strg+Mausrad), Pan                      | ok / neu          | Wheel-Zoom um den Mauszeiger, Pan per Rad/Hand-Werkzeug/Pfeiltasten, Pinch + Zwei-Finger-Pan |
| Rubberband-Auswahl, Mehrfachverschieben       | neu               | Umschalt/Strg-Klick erweitert, Ziehen bewegt alle                                            |
| Gruppieren / Cluster                          | neu (vereinfacht) | gestrichelter Rahmen mit Namen, Rahmen ziehen bewegt Mitglieder; kein Einklappen             |
| Annotationen                                  | neu               | Notizen, Doppelklick bearbeitet, Liste in der Seitenleiste                                   |
| Ausrichten / Verteilen                        | neu               | 6 × Ausrichten, 2 × Verteilen (Menü „Anordnen“, Kontextmenü)                                 |
| Mini-Map                                      | neu               | Ansicht → Mini-Map; Klick/Ziehen verschiebt den Ausschnitt                                   |

## Kabel

| Spec-Punkt                         | Status | Anmerkung                         |
| ---------------------------------- | ------ | --------------------------------- |
| Port-Auswahl-Popup an beiden Enden | ok     | `PortPicker.tsx`; neu: Fokusfalle |
| „Automatisch wählen“               | ok     | `connectAuto`                     |
| Link-Lights                        | ok     | inkl. Farbenblind-Formen          |
| Port-Beschriftungen ein/aus        | ok     | Optionen-Menü                     |
| Kabel löschen per Klick/Entf       | ok     | neu: auch Kontextmenü             |

## Geräte-Dialog

| Spec-Punkt                                  | Status            | Anmerkung                                                                                                                                              |
| ------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tabs Physical, Config, CLI, Desktop         | ok                |                                                                                                                                                        |
| Tab Attributes (Seriennr., Lizenz, Notizen) | neu               | `ux/AttributesTab.tsx`, Werte im UI-Dokument                                                                                                           |
| GUI/CLI spiegeln denselben Zustand          | ok                |                                                                                                                                                        |
| „Equivalent IOS Commands“                   | neu (vollständig) | vorher nur Management-Formulare; jetzt für alle GUI-Formulare von Router/Switch als Diff der running-config (`ux/iosDiff.ts`, auch für CLI-Änderungen) |

## PDU-Werkzeuge, Animation, Simulation

| Spec-Punkt                                                  | Status | Anmerkung |
| ----------------------------------------------------------- | ------ | --------- |
| Simple PDU, Animation, Event-Liste, Filter, Play/Pause/Step | ok     |           |
| Complex PDU, PDU-Liste, Szenarien, Challenge Me             | andere | teach     |
| Export Event-Liste, PCAP, Hex                               | andere | script    |

## Dashboard-Hilfen und Allgemeines

| Spec-Punkt                                    | Status   | Anmerkung                                                                             |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| Tooltips Port-Status, IP, VLAN, MAC           | neu      | VLAN/Trunk und IP je Port ergänzt                                                     |
| Netzwerk-Info-Fenster mit Tabellen            | neu      |                                                                                       |
| Dark/Light, Farbenblind-Modus                 | ok       |                                                                                       |
| Leertaste = Play/Pause                        | ok       | Test `ux.spec.ts`                                                                     |
| Entf, Esc, Strg+A                             | ok / neu | Strg+A neu                                                                            |
| Strg+Z/Y/C/V/S/O, Autosave, Wiederherstellung | andere   | persist                                                                               |
| Kontextmenü                                   | neu      | Rechtsklick, Kontextmenü-Taste, Umschalt+F10, langer Druck (Touch)                    |
| Responsive ab 1280 px                         | ok       |                                                                                       |
| Touch-Grundbedienung                          | neu      | Tippen, langer Druck = Kontextmenü, Pinch-Zoom, Zwei-Finger-Pan, `touch-action: none` |

## Barrierefreiheit

- **axe-core** (`@axe-core/playwright`, Tags wcag2a/2aa/21a/21aa) über Hauptansicht, alle Menüs, Kontextmenü, Netzwerk-Info, Hintergrund-Dialog, Port-Popup und alle Tabs von Router- und PC-Dialog, in Hell, Dunkel und Farbenblind, plus Englisch (`e2e/a11y.spec.ts`). Ergebnis: keine serious/critical-Verstöße; `color-contrast` wird separat auf den statischen Oberflächen geprüft, die Token-Kontraste testet `test/theme.test.ts`.
- **Tastatur**: Gerät platzieren (Enter in der Palette), Kabel legen (Werkzeug-Taste C, Geräte in der Liste „Netzwerk-Info“ aktivieren), Dialog öffnen (Schaltfläche „Konfigurieren“), Menüs (Pfeile/Esc/Home/End), Fokusfalle in Geräte-Dialog, Port-Popup und Modals, Fokus-Rückgabe, Pfeiltasten verschieben die Auswahl, Entf löscht (`ux.spec.ts`).
- **Screenreader**: Die Arbeitsfläche (`role=application`) trägt eine Zusammenfassung (`aria-describedby`); alle Geräte stehen als Liste mit Schaltflächen (Name, IP, Ports) in der Seitenleiste; Notizen als Textfelder in der Liste „Notizen“; Mini-Map als Bild mit Beschriftung.
- **Fokusring**: sichtbarer 2 px-Ring für Schaltflächen, Eingaben, `tabindex`-Elemente und die Arbeitsfläche.

## i18n

- `test/i18nComplete.test.ts`: je Sprachdatei de/en gleiche Schlüssel und Platzhalter, jede Datei in `i18n/index.ts` registriert, keine widersprüchlichen Doppelschlüssel, Scan der Komponenten nach festen deutschen/englischen Anzeigetexten (Texte mit Umlauten bzw. typischen UI-Wörtern in JSX-Text und `aria-label`/`title`/`placeholder`). Technische Literale (IOS-Schlüsselwörter, Protokollnamen, Beispieladressen) sind bewusst unübersetzt.
- `e2e/i18n.spec.ts`: Umschalten auf Englisch (Menü, Werkzeuge, Dialog, Kontextmenü, Netzwerk-Info), Persistenz nach Neuladen, keine deutschen Reste.
