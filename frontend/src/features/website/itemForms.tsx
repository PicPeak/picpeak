/**
 * The item lists of the FAQ, steps, call-to-action, logos and social links
 * blocks (issue 2618). Limits mirror backend document.js.
 */
import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/common';
import { ImageField, LinkField, RichTextField, TextArea, TextField, labelClass } from './fields';
import { LinkTargetField } from './LinkTargetField';
import type { CtaBlock, FaqBlock, LogosBlock, SocialBlock, SocialNetwork, StepIcon, StepsBlock } from './types';

export const MAX_FAQ = 24;
export const MIN_STEPS = 2;
export const MAX_STEPS = 8;
export const MAX_CTA_BUTTONS = 2;
export const MAX_LOGOS = 24;
export const MAX_SOCIAL = 8;

const NETWORKS: SocialNetwork[] = ['instagram', 'facebook', 'tiktok', 'youtube', 'pinterest', 'linkedin', 'website', 'email'];
const NETWORK_NAMES: Record<SocialNetwork, string> = {
  instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', pinterest: 'Pinterest', linkedin: 'LinkedIn', website: 'Website', email: 'E-mail',
};
const STEP_ICONS: StepIcon[] = ['chat', 'calendar', 'camera', 'image', 'heart', 'star', 'gift', 'check', 'email'];

/** One item of a list: a title row with its remove button, then its fields. */
const ItemCard: React.FC<{ title: string; removeLabel: string; canRemove: boolean; onRemove: () => void; children: React.ReactNode }> = ({ title, removeLabel, canRemove, onRemove, children }) => (
  <div className="rounded-lg border border-line p-3 space-y-3">
    <div className="flex items-center justify-between">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</span>
      <Button size="icon-sm" variant="ghost" aria-label={removeLabel} disabled={!canRemove} onClick={onRemove}>
        <Trash2 className="w-4 h-4" />
      </Button>
    </div>
    {children}
  </div>
);

const AddButton: React.FC<{ label: string; disabled: boolean; onClick: () => void }> = ({ label, disabled, onClick }) => (
  <Button size="sm" variant="secondary" leftIcon={<Plus className="w-4 h-4" />} disabled={disabled} onClick={onClick}>{label}</Button>
);

function patchAt<T>(list: T[], index: number, patch: Partial<T>): T[] {
  return list.map((x, i) => (i === index ? { ...x, ...patch } : x));
}

export const FaqItemsField: React.FC<{ value: FaqBlock['items']; onChange: (value: FaqBlock['items'], field?: string) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      {value.map((item, index) => (
        <ItemCard key={index} title={t('website.fields.faqItem', 'Question {{n}}', { n: index + 1 })} canRemove
          removeLabel={t('website.fields.removeFaqItem', 'Remove question {{n}}', { n: index + 1 })} onRemove={() => onChange(value.filter((_, i) => i !== index))}>
          <TextField label={t('website.fields.question', 'Question')} value={item.question} maxLength={300}
            onChange={(question) => onChange(patchAt(value, index, { question }), `item${index}.question`)} />
          <RichTextField label={t('website.fields.answer', 'Answer')} value={item.answer}
            onChange={(answer) => onChange(patchAt(value, index, { answer }), `item${index}.answer`)} />
        </ItemCard>
      ))}
      <AddButton label={t('website.fields.addFaqItem', 'Add question')} disabled={value.length >= MAX_FAQ}
        onClick={() => onChange([...value, { question: '', answer: '' }])} />
    </div>
  );
};

export const StepsField: React.FC<{ value: StepsBlock['items']; withIcons: boolean; onChange: (value: StepsBlock['items'], field?: string) => void }> = ({ value, withIcons, onChange }) => {
  const { t } = useTranslation();
  const iconId = useId();
  const iconName: Record<StepIcon, string> = {
    chat: t('website.icons.chat', 'Speech bubble'), calendar: t('website.icons.calendar', 'Calendar'), camera: t('website.icons.camera', 'Camera'),
    image: t('website.icons.image', 'Picture'), heart: t('website.icons.heart', 'Heart'), star: t('website.icons.star', 'Star'),
    gift: t('website.icons.gift', 'Gift'), check: t('website.icons.check', 'Tick'), email: t('website.icons.email', 'Envelope'),
  };
  return (
    <div className="space-y-3">
      {value.map((item, index) => (
        <ItemCard key={index} title={t('website.fields.step', 'Step {{n}}', { n: index + 1 })} canRemove={value.length > MIN_STEPS}
          removeLabel={t('website.fields.removeStep', 'Remove step {{n}}', { n: index + 1 })} onRemove={() => onChange(value.filter((_, i) => i !== index))}>
          <TextField label={t('website.fields.stepTitle', 'Title')} value={item.title} maxLength={120}
            onChange={(title) => onChange(patchAt(value, index, { title }), `item${index}.title`)} />
          <TextArea label={t('website.fields.stepText', 'Short text')} value={item.text} rows={2} maxLength={400}
            onChange={(text) => onChange(patchAt(value, index, { text }), `item${index}.text`)} />
          {withIcons && (
            <div>
              <label htmlFor={`${iconId}-${index}`} className={labelClass}>{t('website.fields.icon', 'Icon')}</label>
              <select id={`${iconId}-${index}`} className="input" value={item.icon || ''}
                onChange={(e) => onChange(patchAt(value, index, { icon: (e.target.value || null) as StepIcon | null }))}>
                <option value="">{t('website.fields.iconNumber', 'The number')}</option>
                {STEP_ICONS.map((name) => <option key={name} value={name}>{iconName[name]}</option>)}
              </select>
            </div>
          )}
        </ItemCard>
      ))}
      <AddButton label={t('website.fields.addStep', 'Add step')} disabled={value.length >= MAX_STEPS}
        onClick={() => onChange([...value, { title: '', text: '', icon: null }])} />
      <p className="text-xs text-muted">{t('website.fields.stepsHint', 'Three to five steps read best; two to eight are possible.')}</p>
    </div>
  );
};

export const CtaButtonsField: React.FC<{ value: CtaBlock['buttons']; onChange: (value: CtaBlock['buttons'], field?: string) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      {value.map((button, index) => (
        <ItemCard key={index} title={t('website.fields.ctaButton', 'Button {{n}}', { n: index + 1 })} canRemove
          removeLabel={t('website.fields.removeCtaButton', 'Remove button {{n}}', { n: index + 1 })} onRemove={() => onChange(value.filter((_, i) => i !== index))}>
          <TextField label={t('website.fields.buttonLabel', 'Button text')} value={button.label} maxLength={60}
            onChange={(label) => onChange(patchAt(value, index, { label }), `button${index}.label`)} />
          <LinkTargetField value={button.target} onChange={(target) => onChange(patchAt(value, index, { target }))} />
        </ItemCard>
      ))}
      <AddButton label={t('website.fields.addCtaButton', 'Add button')} disabled={value.length >= MAX_CTA_BUTTONS}
        onClick={() => onChange([...value, { label: '', target: null }])} />
    </div>
  );
};

export const LogosField: React.FC<{ value: LogosBlock['items']; onChange: (value: LogosBlock['items'], field?: string) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      {value.map((item, index) => (
        <ItemCard key={index} title={t('website.fields.logo', 'Logo {{n}}', { n: index + 1 })} canRemove
          removeLabel={t('website.fields.removeLogo', 'Remove logo {{n}}', { n: index + 1 })} onRemove={() => onChange(value.filter((_, i) => i !== index))}>
          <ImageField label={t('website.fields.logoImage', 'Logo')} value={item.image} onChange={(image) => onChange(patchAt(value, index, { image }))} />
          <LinkField label={t('website.fields.logoLink', 'Link (optional)')} value={item.url} onChange={(url) => onChange(patchAt(value, index, { url }), `logo${index}.url`)} />
        </ItemCard>
      ))}
      <AddButton label={t('website.fields.addLogo', 'Add logo')} disabled={value.length >= MAX_LOGOS}
        onClick={() => onChange([...value, { image: null, url: '' }])} />
      <p className="text-xs text-muted">{t('website.fields.logosHint', 'Upload logos as PNG or WebP with a transparent background; they are shown at most 56 pixels high.')}</p>
    </div>
  );
};

/** As the backend keeps it (document.js socialUrl): http(s), or an e-mail address. */
export function socialUrlProblem(network: SocialNetwork, url: string): boolean {
  const value = url.trim();
  if (!value) return false;
  if (network === 'email') return !/^(mailto:)?[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,}$/i.test(value);
  try { return !/^https?:\/\//i.test(value) || !new URL(value).hostname; } catch { return true; }
}

export const SocialLinksField: React.FC<{ value: SocialBlock['links']; onChange: (value: SocialBlock['links'], field?: string) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  const id = useId();
  const unused = NETWORKS.find((n) => !value.some((link) => link.network === n)) || 'website';
  return (
    <div className="space-y-3">
      {value.map((link, index) => (
        <ItemCard key={index} title={NETWORK_NAMES[link.network]} canRemove
          removeLabel={t('website.fields.removeSocial', 'Remove {{name}}', { name: NETWORK_NAMES[link.network] })} onRemove={() => onChange(value.filter((_, i) => i !== index))}>
          <div>
            <label htmlFor={`${id}-${index}`} className={labelClass}>{t('website.fields.network', 'Network')}</label>
            <select id={`${id}-${index}`} className="input" value={link.network}
              onChange={(e) => onChange(patchAt(value, index, { network: e.target.value as SocialNetwork }))}>
              {NETWORKS.map((n) => <option key={n} value={n}>{NETWORK_NAMES[n]}</option>)}
            </select>
          </div>
          <TextField label={link.network === 'email' ? t('website.fields.socialEmail', 'E-mail address') : t('website.fields.socialUrl', 'Profile address')}
            value={link.url} maxLength={500} placeholder={link.network === 'email' ? 'hello@studio.com' : 'https://…'}
            error={socialUrlProblem(link.network, link.url)
              ? (link.network === 'email' ? t('website.fields.socialEmailBad', 'Enter an e-mail address') : t('website.fields.socialUrlBad', 'Start with https://'))
              : undefined}
            onChange={(url) => onChange(patchAt(value, index, { url }), `link${index}.url`)} />
        </ItemCard>
      ))}
      <AddButton label={t('website.fields.addSocial', 'Add link')} disabled={value.length >= MAX_SOCIAL}
        onClick={() => onChange([...value, { network: unused, url: '' }])} />
    </div>
  );
};
