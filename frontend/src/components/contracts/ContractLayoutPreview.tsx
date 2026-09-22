/**
 * How a contract reads on the signing page, at desktop width or at a phone's
 * 390 px (#1445). Renders the same ContractBody the signing page does, so it
 * cannot drift from it — and says it is a layout preview: the PDF is the
 * document that is signed.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, Smartphone } from 'lucide-react';
import type { ContractBodyContent } from '../../services/contracts.service';
import { ContractBody } from './ContractBody';

export const ContractLayoutPreview: React.FC<{ content: ContractBodyContent; idPrefix: string }> = ({ content, idPrefix }) => {
  const { t } = useTranslation();
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const option = (value: 'desktop' | 'phone', icon: React.ReactNode, label: string) => (
    <button
      type="button"
      aria-pressed={device === value}
      onClick={() => setDevice(value)}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 ${device === value
        ? 'bg-primary-600 text-white border-primary-600'
        : 'border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300'}`}
    >
      {icon}{label}
    </button>
  );
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div role="group" aria-label={t('contracts.layoutPreview.device', 'Screen size') as string} className="flex gap-1">
          {option('desktop', <Monitor className="w-3.5 h-3.5" aria-hidden="true" />, t('contracts.layoutPreview.desktop', 'Desktop') as string)}
          {option('phone', <Smartphone className="w-3.5 h-3.5" aria-hidden="true" />, t('contracts.layoutPreview.phone', 'Phone') as string)}
        </div>
        <p id={`${idPrefix}-note`} className="text-xs text-neutral-600 dark:text-neutral-400">
          {t('contracts.layoutPreview.note', 'Layout preview of the signing page. The PDF is the document that is signed.')}
        </p>
      </div>
      <div className="rounded-lg border border-dashed border-neutral-300 dark:border-neutral-600 bg-neutral-100 dark:bg-neutral-950 p-3 overflow-x-auto">
        <div
          data-testid={`${idPrefix}-frame`}
          aria-describedby={`${idPrefix}-note`}
          className="mx-auto text-neutral-900 dark:text-neutral-100"
          style={{ width: device === 'phone' ? 390 : '100%', maxWidth: '100%' }}
        >
          <ContractBody contract={content} />
        </div>
      </div>
    </div>
  );
};
