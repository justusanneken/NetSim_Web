/** Farben der UX-Elemente der Arbeitsfläche (Notizen, Gruppen, Rubberband) aus den CSS-Tokens von `ux.css`. */
export interface UxColors {
  noteBg: string;
  noteBorder: string;
  noteText: string;
  muted: string;
  group: string;
  band: string;
  bandFill: string;
}

export function readUxColors(): UxColors {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string): string => cs.getPropertyValue(n).trim() || 'currentColor';
  return {
    noteBg: v('--ux-note-bg'),
    noteBorder: v('--ux-note-border'),
    noteText: v('--text'),
    muted: v('--muted'),
    group: v('--ux-group'),
    band: v('--ux-band'),
    bandFill: v('--ux-band-fill'),
  };
}
