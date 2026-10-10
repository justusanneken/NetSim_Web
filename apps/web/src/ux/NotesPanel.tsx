import { useTranslation } from 'react-i18next';
import { useDoc } from './uiDoc';
import { useUx } from './ux';

/** Notizen als Liste mit direkter Bearbeitung (Tastatur-/Screenreader-Alternative zur Arbeitsfläche). */
export function NotesPanel() {
  const { t } = useTranslation();
  const notes = useDoc((s) => s.notes);
  const selected = useUx((s) => s.selectedNote);
  if (notes.length === 0) return <p className="muted pad">{t('ux.notes.none')}</p>;
  return (
    <ul className="note-list" aria-label={t('ux.notes.title')}>
      {notes.map((n, i) => (
        <li key={n.id} className={selected === n.id ? 'active' : ''}>
          <textarea
            aria-label={`${t('ux.note.label')} ${i + 1}`}
            value={n.text}
            rows={2}
            onFocus={() => useUx.getState().setSelectedNote(n.id)}
            onChange={(e) => useDoc.getState().updateNote(n.id, { text: e.target.value })}
          />
          <button
            aria-label={`${t('ux.ctx.deleteNote')} ${i + 1}`}
            onClick={() => useDoc.getState().removeNote(n.id)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
