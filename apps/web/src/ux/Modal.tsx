import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from './useFocusTrap';

/** Allgemeiner modaler Dialog: Fokusfalle, Esc schließt, Klick auf den Hintergrund schließt. */
export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, true);
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div
        ref={ref}
        className={`dialog ux-modal ${props.className ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="dialog-head">
          <strong id={titleId}>{props.title}</strong>
          <button
            className="icon-btn"
            style={{ marginLeft: 'auto' }}
            aria-label={t('common.close')}
            onClick={props.onClose}
          >
            ×
          </button>
        </div>
        <div className="dialog-body">{props.children}</div>
      </div>
    </div>
  );
}
