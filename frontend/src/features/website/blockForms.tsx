/**
 * The forms of the website builder's blocks (issue 2618): one per block
 * type, with the fields of that block.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Notice, Switch } from '../../components/common';
import { variantLabel } from './blocks';
import {
  ChoiceField, ImageField, ImageListField, LinkField, RichTextField, TextArea, TextField, VideoField,
} from './fields';
import { CtaButtonsField, FaqItemsField, LogosField, SocialLinksField, StepsField, TestimonialsField } from './itemForms';
import { LinkTargetField } from './LinkTargetField';
import { BookingTarget, ContactNotice, FeaturedGalleriesField, PackagesField } from './serverFields';
import type { Block, LinkTarget } from './types';

/** Every field edit goes through here, typed per block so a field name is checked. */
export type SetBlock = <B extends Block>(b: B, patch: Partial<B>, field?: string) => void;

type BlockForm<T extends Block['type']> = React.FC<{ block: Extract<Block, { type: T }>; set: SetBlock }>;

// As many pictures as the backend takes in a photo strip (document.js).
const MAX_STRIP_IMAGES = 12;

/** The heading most blocks have. */
const HeadingField = <B extends Extract<Block, { heading: string }>>({ block, set, optional = false }: { block: B; set: SetBlock; optional?: boolean }) => {
  const { t } = useTranslation();
  return (
    <TextField label={optional ? t('website.fields.headingOptional', 'Heading (optional)') : t('website.fields.heading', 'Heading')}
      value={block.heading} maxLength={200} onChange={(heading) => set(block, { heading } as Partial<B>, 'heading')} />
  );
};

/** A block's button: its text and where it leads. Without a text the page shows no button. */
const ButtonFields: React.FC<{
  label: string;
  target: LinkTarget | null | undefined;
  onLabel: (label: string) => void;
  onTarget: (target: LinkTarget | null) => void;
}> = ({ label, target, onLabel, onTarget }) => {
  const { t } = useTranslation();
  return (
    <>
      <TextField label={t('website.fields.buttonLabel', 'Button text')} value={label} maxLength={60}
        helperText={t('website.fields.buttonLabelHint', 'Without a text, no button is shown.')} onChange={onLabel} />
      <LinkTargetField label={t('website.fields.buttonUrl', 'Button link')} value={target ?? null} onChange={onTarget} />
    </>
  );
};

const HeroForm: BlockForm<'hero'> = ({ block, set }) => {
  const { t } = useTranslation();
  return (
    <>
      <HeadingField block={block} set={set} />
      <TextArea label={t('website.fields.subheading', 'Text')} value={block.subheading} rows={3} maxLength={600} onChange={(subheading) => set(block, { subheading }, 'subheading')} />
      {block.variant === 'minimal' ? (
        // The page shows a minimal hero without a picture or video.
        <p className="text-xs text-muted">{t('website.fields.minimalNoImage', 'The “Text only” style shows no picture or video. Choose another style to add one.')}</p>
      ) : (
        <>
          <ImageField label={t('website.fields.image', 'Image')} value={block.image} onChange={(image) => set(block, { image })} />
          <VideoField value={block.video} onChange={(video) => set(block, { video })} />
        </>
      )}
      <ButtonFields label={block.buttonLabel} target={block.buttonTarget} onLabel={(buttonLabel) => set(block, { buttonLabel }, 'buttonLabel')} onTarget={(buttonTarget) => set(block, { buttonTarget }, 'buttonTarget')} />
    </>
  );
};

const TextForm: BlockForm<'text'> = ({ block, set }) => {
  const { t } = useTranslation();
  return (
    <>
      <HeadingField block={block} set={set} />
      {block.variant === 'columns' ? (
        <>
          <RichTextField key="body" label={t('website.fields.leftColumn', 'Left column')} value={block.body} onChange={(body) => set(block, { body }, 'body')} />
          <RichTextField key="bodyRight" label={t('website.fields.rightColumn', 'Right column')} value={block.bodyRight || ''}
            helperText={t('website.fields.rightColumnHint', 'Leave it empty and the left text flows over both columns.')}
            onChange={(bodyRight) => set(block, { bodyRight }, 'bodyRight')} />
        </>
      ) : (
        <RichTextField key="body" label={t('website.fields.body', 'Text')} value={block.body} onChange={(body) => set(block, { body }, 'body')} />
      )}
    </>
  );
};

const ImageTextForm: BlockForm<'imageText'> = ({ block, set }) => {
  const { t } = useTranslation();
  return (
    <>
      <ImageField label={t('website.fields.image', 'Image')} value={block.image} onChange={(image) => set(block, { image })} />
      <HeadingField block={block} set={set} />
      <RichTextField label={t('website.fields.body', 'Text')} value={block.body} onChange={(body) => set(block, { body }, 'body')} />
      <ButtonFields label={block.buttonLabel} target={block.buttonTarget} onLabel={(buttonLabel) => set(block, { buttonLabel }, 'buttonLabel')} onTarget={(buttonTarget) => set(block, { buttonTarget }, 'buttonTarget')} />
    </>
  );
};

const GalleryForm: BlockForm<'gallery'> = ({ block, set }) => {
  const { t } = useTranslation();
  return (
    <>
      <HeadingField block={block} set={set} />
      <ChoiceField
        label={t('website.fields.columns', 'Columns on a computer')}
        value={String(block.columns)}
        options={[2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
        onChange={(columns) => set(block, { columns: Number(columns) })}
      />
      <ImageListField label={t('website.fields.images', 'Images')} value={block.images} onChange={(images) => set(block, { images })} />
    </>
  );
};

const InstagramForm: BlockForm<'instagram'> = ({ block, set }) => {
  const { t } = useTranslation();
  return (
    <>
      <HeadingField block={block} set={set} />
      <TextField label={t('website.fields.handle', 'Account name')} value={block.handle} maxLength={60} placeholder="@studio" onChange={(handle) => set(block, { handle }, 'handle')} />
      <LinkField label={t('website.fields.profileUrl', 'Profile link')} value={block.profileUrl} placeholder="https://www.instagram.com/…"
        hint={t('website.fields.profileUrlHint', 'The address of your profile, which the block links to.')}
        onChange={(profileUrl) => set(block, { profileUrl }, 'profileUrl')} />
      <ImageListField label={t('website.fields.images', 'Images')} value={block.images} max={MAX_STRIP_IMAGES} onChange={(images) => set(block, { images })} />
      <p className="text-xs text-muted">{t('website.fields.instagramHint', 'Pick the photos yourself; nothing is loaded from Instagram.')}</p>
    </>
  );
};

const FeaturedGalleriesForm: BlockForm<'featuredGalleries'> = ({ block, set }) => {
  const { t } = useTranslation();
  return (
    <>
      <HeadingField block={block} set={set} />
      <TextArea label={t('website.fields.intro', 'Introduction')} value={block.intro} rows={2} maxLength={1000} onChange={(intro) => set(block, { intro }, 'intro')} />
      <FeaturedGalleriesField value={block.galleries} onChange={(galleries) => set(block, { galleries })} />
    </>
  );
};

const TestimonialsForm: BlockForm<'testimonials'> = ({ block, set }) => {
  return (
    <>
      <HeadingField block={block} set={set} />
      <TestimonialsField value={block.items} onChange={(items, field) => set(block, { items }, field)} />
    </>
  );
};

const PricingForm: BlockForm<'pricing'> = ({ block, set }) => {
  const { t } = useTranslation();
  return (
    <>
      <HeadingField block={block} set={set} />
      <TextArea label={t('website.fields.intro', 'Introduction')} value={block.intro} rows={2} maxLength={1000} onChange={(intro) => set(block, { intro }, 'intro')} />
      <PackagesField value={block.packageIds} onChange={(packageIds) => set(block, { packageIds })} />
      <Switch checked={block.showPrices} onChange={(showPrices) => set(block, { showPrices })} label={t('website.fields.showPrices', 'Show prices')} />
      <ButtonFields label={block.buttonLabel} target={block.buttonTarget} onLabel={(buttonLabel) => set(block, { buttonLabel }, 'buttonLabel')} onTarget={(buttonTarget) => set(block, { buttonTarget }, 'buttonTarget')} />
    </>
  );
};

const ContactForm: BlockForm<'contact'> = ({ block, set }) => {
  const { t } = useTranslation();
  return (
    <>
      <ContactNotice />
      <HeadingField block={block} set={set} />
      <TextArea label={t('website.fields.intro', 'Introduction')} value={block.intro} rows={3} maxLength={1000} onChange={(intro) => set(block, { intro }, 'intro')} />
      <Switch checked={block.showPhone} onChange={(showPhone) => set(block, { showPhone })} label={t('website.fields.showPhone', 'Ask for a phone number')} />
      <Switch checked={block.showDate} onChange={(showDate) => set(block, { showDate })} label={t('website.fields.showDate', 'Ask for the event date')} />
      <TextField label={t('website.fields.submitLabel', 'Button text')} value={block.submitLabel} maxLength={60} placeholder={t('website.fields.submitDefault', 'Send message') as string} onChange={(submitLabel) => set(block, { submitLabel }, 'submitLabel')} />
      <TextField label={t('website.fields.successMessage', 'Thank-you message')} value={block.successMessage} maxLength={300} placeholder={t('website.fields.successDefault', 'Thank you! Your message has been sent.') as string} onChange={(successMessage) => set(block, { successMessage }, 'successMessage')} />
    </>
  );
};

const BookingForm: BlockForm<'booking'> = ({ block, set }) => {
  const { t } = useTranslation();
  return (
    <>
      <BookingTarget serviceId={block.serviceId} onChange={(serviceId) => set(block, { serviceId })} />
      <HeadingField block={block} set={set} />
      <TextArea label={t('website.fields.body', 'Text')} value={block.text} rows={3} maxLength={1000} onChange={(text) => set(block, { text }, 'text')} />
      <TextField label={t('website.fields.buttonLabel', 'Button text')} value={block.buttonLabel} maxLength={60} placeholder={t('website.fields.bookDefault', 'Book now') as string} onChange={(buttonLabel) => set(block, { buttonLabel }, 'buttonLabel')} />
    </>
  );
};

const SpacerForm: BlockForm<'spacer'> = ({ block, set }) => {
  const { t } = useTranslation();
  return <Switch checked={block.divider} onChange={(divider) => set(block, { divider })} label={t('website.fields.divider', 'Show a line')} />;
};

const FaqForm: BlockForm<'faq'> = ({ block, set }) => {
  return (
    <>
      <HeadingField block={block} set={set} optional />
      <FaqItemsField value={block.items} onChange={(items, field) => set(block, { items }, field)} />
    </>
  );
};

const StepsForm: BlockForm<'steps'> = ({ block, set }) => {
  return (
    <>
      <HeadingField block={block} set={set} />
      <StepsField value={block.items} withIcons={block.variant === 'icons'} onChange={(items, field) => set(block, { items }, field)} />
    </>
  );
};

const CtaForm: BlockForm<'cta'> = ({ block, set }) => {
  const { t } = useTranslation();
  return (
    <>
      <HeadingField block={block} set={set} />
      <RichTextField label={t('website.fields.body', 'Text')} value={block.text} onChange={(text) => set(block, { text }, 'text')} />
      <CtaButtonsField value={block.buttons} onChange={(buttons, field) => set(block, { buttons }, field)} />
    </>
  );
};

const LogosForm: BlockForm<'logos'> = ({ block, set }) => {
  const { t } = useTranslation();
  return (
    <>
      <HeadingField block={block} set={set} optional />
      <Switch checked={block.grayscale} onChange={(grayscale) => set(block, { grayscale })} label={t('website.fields.grayscale', 'Show logos in grey, in colour on hover')} />
      <LogosField value={block.items} onChange={(items, field) => set(block, { items }, field)} />
    </>
  );
};

const SocialForm: BlockForm<'social'> = ({ block, set }) => {
  return (
    <>
      <HeadingField block={block} set={set} optional />
      <SocialLinksField value={block.links} onChange={(links, field) => set(block, { links }, field)} />
    </>
  );
};

const DividerForm: BlockForm<'divider'> = ({ block, set }) => {
  const { t } = useTranslation();
  return (
    <>
      <ChoiceField label={t('website.fields.lineWidth', 'Width')} value={block.width}
        options={[{ value: 'full', label: t('website.fields.widthFull', 'Full') }, { value: 'short', label: t('website.fields.widthShort', 'Short') }]}
        onChange={(width) => set(block, { width: width as typeof block.width })} />
      <ChoiceField label={t('website.fields.spacing', 'Space around it')} value={block.spacing}
        options={(['none', 'small', 'medium', 'large'] as const).map((v) => ({ value: v, label: v === 'none' ? t('website.fields.spacingNone', 'None') : variantLabel(t, v) }))}
        onChange={(spacing) => set(block, { spacing: spacing as typeof block.spacing })} />
    </>
  );
};

const CustomHtmlForm: BlockForm<'customHtml'> = ({ block, set }) => {
  const { t } = useTranslation();
  return (
    <>
      <Notice tone="neutral" size="sm">
        {t('website.fields.customHtmlNotice', 'For advanced use. Scripts, frames, forms and event handlers are removed when the page is shown; style it with the site’s custom CSS.')}
      </Notice>
      <TextArea label={t('website.fields.html', 'HTML')} value={block.html} rows={14} mono onChange={(html) => set(block, { html }, 'html')} />
    </>
  );
};

export const BLOCK_FORMS: { [T in Block['type']]: BlockForm<T> } = {
  hero: HeroForm,
  text: TextForm,
  imageText: ImageTextForm,
  gallery: GalleryForm,
  instagram: InstagramForm,
  featuredGalleries: FeaturedGalleriesForm,
  testimonials: TestimonialsForm,
  pricing: PricingForm,
  contact: ContactForm,
  booking: BookingForm,
  spacer: SpacerForm,
  faq: FaqForm,
  steps: StepsForm,
  cta: CtaForm,
  logos: LogosForm,
  social: SocialForm,
  divider: DividerForm,
  customHtml: CustomHtmlForm,
};
