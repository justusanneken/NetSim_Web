import { useTranslation } from 'react-i18next';
import type { DeviceView } from '@netsim/engine';
import { attrsOf, defaultLicense, defaultSerial, useDoc } from './uiDoc';

const LICENSES = ['ipbasek9', 'securityk9', 'datak9', 'uck9', 'lanbasek9', 'lanlite', 'base'];

/** Tab „Attributes“: Seriennummer, Lizenz, Notizen (gespeichert im UI-Dokument, siehe `uiDoc.ts`). */
export function AttributesTab({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const attrs = useDoc((s) => s.attrs);
  const set = useDoc((s) => s.setAttrs);
  const a = attrsOf(dev.id, dev.type, attrs);
  const licenses = [...new Set([defaultLicense(dev.type), ...LICENSES, a.license])].filter(
    (l) => l !== '–',
  );
  const hasLicense = defaultLicense(dev.type) !== '–';
  return (
    <div className="scroll pad attributes">
      <div className="form">
        <label>
          {t('panel.name')}
          <input value={dev.name} readOnly />
        </label>
        <label>
          {t('ux.attr.model')}
          <input value={dev.model} readOnly />
        </label>
        <label>
          {t('ux.attr.serial')}
          <input
            className="mono"
            value={a.serial}
            onChange={(e) => set(dev.id, { serial: e.target.value })}
          />
        </label>
        <button
          className="small"
          onClick={() => set(dev.id, { serial: defaultSerial(dev.id) })}
          disabled={a.serial === defaultSerial(dev.id)}
        >
          {t('ux.attr.resetSerial')}
        </button>
        <label>
          {t('ux.attr.license')}
          {hasLicense ? (
            <select value={a.license} onChange={(e) => set(dev.id, { license: e.target.value })}>
              {licenses.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          ) : (
            <input value={t('ux.attr.noLicense')} readOnly />
          )}
        </label>
        <label>
          {t('ux.attr.notes')}
          <textarea
            rows={6}
            value={a.notes}
            onChange={(e) => set(dev.id, { notes: e.target.value })}
          />
        </label>
      </div>
    </div>
  );
}
