import type { TFunction } from 'i18next';
import {
  Image as ImageIcon, Type, Columns2, LayoutGrid, FolderHeart, Quote, BadgeDollarSign, Mail, CalendarCheck,
  Instagram, MoveVertical, Minus, Code, CircleHelp, ListOrdered, Megaphone, Award, Share2, type LucideIcon,
} from 'lucide-react';
import type { Block, BlockType, ImageRef, WebsiteDocument, WebsitePage } from './types';

export function newId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const BLOCK_TYPES: BlockType[] = [
  'hero', 'text', 'imageText', 'gallery', 'featuredGalleries', 'testimonials',
  'pricing', 'contact', 'booking', 'instagram', 'faq', 'steps', 'cta', 'logos', 'social', 'spacer', 'divider', 'customHtml',
];

export const BLOCK_ICONS: Record<BlockType, LucideIcon> = {
  hero: ImageIcon,
  text: Type,
  imageText: Columns2,
  gallery: LayoutGrid,
  featuredGalleries: FolderHeart,
  testimonials: Quote,
  pricing: BadgeDollarSign,
  contact: Mail,
  booking: CalendarCheck,
  instagram: Instagram,
  spacer: MoveVertical,
  divider: Minus,
  faq: CircleHelp,
  steps: ListOrdered,
  cta: Megaphone,
  logos: Award,
  social: Share2,
  customHtml: Code,
};

/** Layout variants per block type; the first is the default. Mirrors the backend. */
export const BLOCK_VARIANTS: Record<BlockType, string[]> = {
  hero: ['overlay', 'split', 'minimal'],
  text: ['left', 'center', 'columns'],
  imageText: ['image-left', 'image-right'],
  gallery: ['grid', 'masonry'],
  featuredGalleries: ['cards', 'list'],
  testimonials: ['cards', 'quote'],
  pricing: ['cards', 'list'],
  contact: ['simple', 'split'],
  booking: ['button', 'banner'],
  instagram: ['strip', 'grid'],
  spacer: ['small', 'medium', 'large'],
  divider: ['thin', 'medium'],
  faq: ['list', 'boxed'],
  steps: ['numbers', 'icons'],
  cta: ['centered', 'split'],
  logos: ['strip', 'grid'],
  social: ['icons', 'buttons'],
  customHtml: ['default'],
};

export function blockLabel(t: TFunction, type: BlockType): string {
  const fallback: Record<BlockType, string> = {
    hero: 'Hero', text: 'Text', imageText: 'Image and text', gallery: 'Image grid',
    featuredGalleries: 'Featured galleries', testimonials: 'Testimonials', pricing: 'Pricing',
    contact: 'Contact form', booking: 'Booking button', instagram: 'Photo strip', spacer: 'Spacer', divider: 'Divider',
    faq: 'Questions and answers', steps: 'Steps', cta: 'Call to action', logos: 'Logos', social: 'Social links',
    customHtml: 'Custom HTML',
  };
  return t(`website.blocks.${type}.name`, fallback[type]);
}

export function variantLabel(t: TFunction, variant: string): string {
  const fallback: Record<string, string> = {
    overlay: 'Text on image', split: 'Side by side', minimal: 'Text only', left: 'Left', center: 'Centred',
    columns: 'Two columns', 'image-left': 'Image left', 'image-right': 'Image right', grid: 'Grid',
    masonry: 'Masonry', cards: 'Cards', list: 'List', quote: 'Large quote', simple: 'Simple',
    button: 'Button', banner: 'Banner', strip: 'Strip', small: 'Small', medium: 'Medium', large: 'Large',
    default: 'Default', thin: 'Thin line', boxed: 'Boxed', numbers: 'Numbers', icons: 'Icons', centered: 'Centred',
    buttons: 'With names',
  };
  return t(`website.variants.${variant}`, fallback[variant] || variant);
}

/** A new block of a type, with empty fields in the shape the backend stores. */
export function createBlock(type: BlockType, t: TFunction): Block {
  const base = { id: newId(), variant: BLOCK_VARIANTS[type][0], background: 'default' as const };
  switch (type) {
  case 'hero':
    return { ...base, type, heading: t('website.defaults.heroHeading', 'Your headline'), subheading: '', buttonLabel: '', buttonTarget: null, image: null, video: null };
  case 'text':
    return { ...base, type, heading: '', body: `<p>${t('website.defaults.textBody', 'Write something here.')}</p>`, bodyRight: '', format: 'html' };
  case 'imageText':
    return { ...base, type, heading: '', body: '', image: null, buttonLabel: '', buttonTarget: null };
  case 'gallery':
    return { ...base, type, heading: '', images: [], columns: 3 };
  case 'featuredGalleries':
    return { ...base, type, heading: t('website.defaults.featuredHeading', 'Recent work'), intro: '', galleries: [] };
  case 'testimonials':
    return { ...base, type, heading: t('website.defaults.testimonialsHeading', 'Kind words'), items: [] };
  case 'pricing':
    return { ...base, type, heading: t('website.defaults.pricingHeading', 'Packages'), intro: '', packageIds: [], showPrices: true, buttonLabel: '', buttonTarget: null };
  case 'contact':
    return { ...base, type, heading: t('website.defaults.contactHeading', 'Get in touch'), intro: '', showPhone: false, showDate: false, submitLabel: '', successMessage: '' };
  case 'booking':
    return { ...base, type, heading: t('website.defaults.bookingHeading', 'Book a session'), text: '', buttonLabel: '', serviceId: null };
  case 'instagram':
    return { ...base, type, heading: '', handle: '', profileUrl: '', images: [] };
  case 'spacer':
    return { ...base, type, variant: 'medium', divider: false };
  case 'divider':
    return { ...base, type, width: 'full', spacing: 'medium' };
  case 'faq':
    return { ...base, type, heading: t('website.defaults.faqHeading', 'Questions and answers'), items: [{ id: newId(), question: '', answer: '' }] };
  case 'steps':
    return {
      ...base, type, heading: t('website.defaults.stepsHeading', 'How it works'),
      items: [
        { id: newId(), title: t('website.defaults.step1', 'Get in touch'), text: '', icon: 'chat' },
        { id: newId(), title: t('website.defaults.step2', 'The shoot'), text: '', icon: 'camera' },
        { id: newId(), title: t('website.defaults.step3', 'Your gallery'), text: '', icon: 'image' },
      ],
    };
  case 'cta':
    return { ...base, type, heading: t('website.defaults.ctaHeading', 'Ready when you are'), text: '', buttons: [{ label: '', target: null }] };
  case 'logos':
    return { ...base, type, heading: '', grayscale: true, items: [] };
  case 'social':
    return { ...base, type, heading: '', links: [] };
  case 'customHtml':
    return { ...base, type, html: '' };
  default:
    throw new Error(`Unknown block type ${type as string}`);
  }
}

export function createPage(t: TFunction, existing: WebsitePage[]): WebsitePage {
  const title = t('website.pages.newTitle', 'New page');
  let slug = 'new-page';
  for (let n = 2; existing.some((p) => p.slug === slug); n += 1) slug = `new-page-${n}`;
  return {
    id: newId(), slug, title, navLabel: '', hidden: false, isHome: false,
    seo: { title: '', description: '', image: null }, blocks: [],
  };
}

/**
 * The backend's slug cleaning, minus trimming a trailing hyphen, so "about-us"
 * can be typed; the server trims it on save.
 */
export function slugWhileTyping(value: string): string {
  return value.toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 60);
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Every image a document uses, for one thumbnail lookup. */
export function collectImageRefs(doc: WebsiteDocument): ImageRef[] {
  const refs: ImageRef[] = [];
  const add = (ref: ImageRef | null | undefined) => { if (ref) refs.push(ref); };
  for (const page of doc.pages) {
    add(page.seo.image);
    for (const block of page.blocks) {
      if ('image' in block) add(block.image);
      if ('images' in block) block.images.forEach(add);
      if (block.type === 'testimonials' || block.type === 'logos') block.items.forEach((item) => add(item.image));
      if (block.type === 'hero' && block.video) add(block.video);
    }
  }
  return refs;
}
