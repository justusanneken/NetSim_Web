import { useTranslation } from 'react-i18next';
import { Modal } from './Modal';
import { useDoc } from './uiDoc';
import { useUx } from './ux';

const MAX_SIDE = 2000;

/** Liest ein Bild und verkleinert es auf höchstens 2000 px Kantenlänge (hält die `.nsim`-Datei klein). */
export async function imageToDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('image'));
    i.src = raw;
  });
  const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  if (k === 1 && raw.length < 1_500_000) return raw;
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
}

/** Hintergrundbild der Logical View laden, Deckkraft einstellen oder entfernen. */
export function BackgroundDialog() {
  const { t } = useTranslation();
  const open = useUx((s) => s.backgroundOpen);
  const bg = useDoc((s) => s.background);
  if (!open) return null;
  return (
    <Modal title={t('ux.bg.title')} onClose={() => useUx.getState().setBackgroundOpen(false)}>
      <div className="pad form">
        <label>
          {t('ux.bg.file')}
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              void imageToDataUrl(f)
                .then((dataUrl) =>
                  useDoc.getState().setBackground({ dataUrl, opacity: bg?.opacity ?? 0.5 }),
                )
                .catch(() => void 0);
            }}
          />
        </label>
        {bg && (
          <>
            <label>
              {t('ux.bg.opacity')}
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={bg.opacity}
                onChange={(e) =>
                  useDoc.getState().setBackground({ ...bg, opacity: Number(e.target.value) })
                }
              />
            </label>
            <button onClick={() => useDoc.getState().setBackground(null)}>
              {t('ux.bg.remove')}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
