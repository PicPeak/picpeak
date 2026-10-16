import React from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Droplets, Image, Monitor, MousePointer, Shield } from 'lucide-react';
import { Loading } from '../../../../components/common';
import { INHERIT, type DownloadsDraft } from './draft';
import type { DownloadResolutionsPayload } from './useEventSettingsDraft';
import { SectionCard, checkboxClass, inputClass, labelClass, type FieldsProps } from './sections';

const ORIGINAL = 'original';

export const DownloadsSection: React.FC<FieldsProps & {
  downloads: DownloadsDraft | null;
  setDownloads: (next: DownloadsDraft) => void;
  downloadsData: DownloadResolutionsPayload | undefined;
}> = ({ f, set, downloads, setDownloads, downloadsData }) => {
  const { t } = useTranslation();
  const onOff = (v: boolean) => (v ? t('common.on', 'on') : t('common.off', 'off'));

  return (
    <>
      <SectionCard>
        <div className="space-y-3">
          {([
            ['allow_downloads', Download, t('events.allowDownloads', 'Allow photo downloads')],
            ['disable_right_click', MousePointer, t('events.disableRightClick', 'Block right-click menu')],
            ['watermark_downloads', Droplets, t('events.watermarkDownloads', 'Add watermark to downloads')],
            ['enable_devtools_protection', Monitor, t('events.enableDevtoolsProtection', 'Detect developer tools')],
            ['use_canvas_rendering', Image, t('events.useCanvasRendering', 'Canvas rendering in the lightbox (advanced protection)')],
          ] as const).map(([key, Icon, label]) => (
            <label key={key} className="flex items-center">
              <input
                type="checkbox"
                checked={f[key]}
                onChange={(e) => set({ [key]: e.target.checked })}
                className={checkboxClass}
              />
              <Icon className="w-4 h-4 ml-2 mr-1 text-muted" />
              <span className="text-sm text-body">{label}</span>
            </label>
          ))}
          <div className="max-w-md">
            <label className={labelClass} htmlFor="event-watermark-text">{t('events.watermarkText', 'Watermark text')}</label>
            <input
              id="event-watermark-text"
              type="text"
              value={f.watermark_text}
              onChange={(e) => set({ watermark_text: e.target.value })}
              className={inputClass}
            />
            <p className="text-xs text-muted mt-1">{t('events.watermarkTextHelp', 'Replaces the company name in this gallery\'s text watermark. Leave empty to use the company name. Not shown when Branding has a watermark logo.')}</p>
          </div>
          <p className="text-xs text-muted flex items-center gap-1">
            <Shield className="w-3.5 h-3.5" />
            {t('events.protectionInfo', 'Protection features help prevent unauthorized downloads but cannot block all methods.')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t border-line">
          <div>
            <label className={labelClass} htmlFor="event-download-limit">{t('events.downloadLimit', 'Download Limit')}</label>
            <input
              id="event-download-limit"
              type="number"
              value={f.download_limit}
              onChange={(e) => set({ download_limit: parseInt(e.target.value) || 0 })}
              min={0}
              // events.download_limit is a signed 32-bit int (migration 231).
              max={2147483647}
              className={inputClass}
            />
            <p className="text-xs text-muted mt-1">{t('events.downloadLimitHelp', 'Maximum number of photos the client can download. 0 = unlimited')}</p>
          </div>
          <div>
            <label className={labelClass} htmlFor="event-photo-cap">{t('events.photoCap', 'Photo Limit')}</label>
            <input
              id="event-photo-cap"
              type="number"
              value={f.photo_cap}
              onChange={(e) => set({ photo_cap: parseInt(e.target.value) || 0 })}
              min={0}
              // events.photo_cap is a signed 32-bit int (migration 074).
              max={2147483647}
              className={inputClass}
            />
            <p className="text-xs text-muted mt-1">{t('events.photoCapHelp', 'Maximum number of photos allowed. 0 = unlimited')}</p>
          </div>
          <div>
            <label className={labelClass} htmlFor="event-default-sort">{t('photoSort.defaultSort', 'Default Photo Sort')}</label>
            <select
              id="event-default-sort"
              value={f.default_photo_sort}
              onChange={(e) => set({ default_photo_sort: e.target.value })}
              className={inputClass}
            >
              <option value="upload_date_desc">{t('photoSort.uploadDateNewest', 'Upload Date (Newest First)')}</option>
              <option value="upload_date_asc">{t('photoSort.uploadDateOldest', 'Upload Date (Oldest First)')}</option>
              <option value="capture_date_desc">{t('photoSort.captureDateNewest', 'Date Taken (Newest First)')}</option>
              <option value="capture_date_asc">{t('photoSort.captureDateOldest', 'Date Taken (Oldest First)')}</option>
              <option value="filename_asc">{t('photoSort.filenameAZ', 'Filename (A-Z)')}</option>
              <option value="filename_desc">{t('photoSort.filenameZA', 'Filename (Z-A)')}</option>
            </select>
          </div>
        </div>
      </SectionCard>

      {/* Per-gallery download resolution override (#858). Every field is
          tri-state: "Inherit" writes NULL and follows Settings → Download
          resolutions, whose current value the option shows. */}
      <SectionCard
        title={t('settings.downloads.eventTitle', 'Download resolution')}
        description={t('settings.downloads.eventIntro', 'Override the site-wide download settings for this gallery only. "Inherit" follows Settings → Download resolutions.')}
      >
        {!downloads || !downloadsData ? (
          <Loading />
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>{t('settings.downloads.standard', 'Standard resolution')}</label>
                <select className={inputClass} value={downloads.standard} onChange={(e) => setDownloads({ ...downloads, standard: e.target.value })}>
                  <option value={INHERIT}>
                    {t('settings.downloads.inheritWith', 'Inherit ({{value}})', {
                      value: downloadsData.globals.standard_resolution === ORIGINAL
                        ? t('settings.downloads.original', 'Original (full size)')
                        : downloadsData.globals.standard_resolution,
                    })}
                  </option>
                  <option value={ORIGINAL}>{t('settings.downloads.original', 'Original (full size)')}</option>
                  {downloadsData.globals.resolutions.map((r) => (
                    <option key={r.id} value={r.id}>{r.label} — {r.width} × {r.height}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>{t('settings.downloads.picker', 'Let guests choose a download size')}</label>
                <select className={inputClass} value={downloads.picker} onChange={(e) => setDownloads({ ...downloads, picker: e.target.value })}>
                  <option value={INHERIT}>{t('settings.downloads.inheritWith', 'Inherit ({{value}})', { value: onOff(downloadsData.globals.picker_enabled) })}</option>
                  <option value="true">{t('common.on', 'on')}</option>
                  <option value="false">{t('common.off', 'off')}</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>{t('settings.downloads.allowOriginal', 'Offer "Original" in the picker')}</label>
                <select className={inputClass} value={downloads.allowOriginal} onChange={(e) => setDownloads({ ...downloads, allowOriginal: e.target.value })}>
                  <option value={INHERIT}>{t('settings.downloads.inheritWith', 'Inherit ({{value}})', { value: onOff(downloadsData.globals.allow_original) })}</option>
                  <option value="true">{t('common.on', 'on')}</option>
                  <option value="false">{t('common.off', 'off')}</option>
                </select>
              </div>
            </div>
            <p className="text-xs text-muted">
              {t('settings.downloads.effective', 'Currently hands out: {{standard}}', {
                standard: downloadsData.effective.standard === ORIGINAL
                  ? t('settings.downloads.original', 'Original (full size)')
                  : downloadsData.effective.standard,
              })}
              {downloadsData.effective.picker_enabled ? ` · ${t('settings.downloads.pickerOn', 'guests may choose another size')}` : ''}
            </p>
          </>
        )}
      </SectionCard>
    </>
  );
};
