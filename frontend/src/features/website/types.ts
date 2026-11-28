/**
 * The website builder's document (issue 2618). Mirrors
 * backend/src/services/website/document.js, which validates every save; the
 * editor only has to produce this shape.
 */

export type ImageRef =
  | { source: 'photo'; id: number; alt?: string }
  | { source: 'asset'; id: string; alt?: string };

export type Background = 'default' | 'light' | 'dark' | 'custom';

interface BlockBase {
  id: string;
  variant: string;
  background: Background;
  /** With background 'custom': an opaque hex colour, and the text colour (null: automatic). */
  backgroundColor?: string;
  textColor?: string | null;
}

export interface HeroBlock extends BlockBase {
  type: 'hero';
  heading: string;
  subheading: string;
  buttonLabel: string;
  buttonTarget: LinkTarget | null;
  image: ImageRef | null;
  video: { source: 'asset'; id: string } | null;
}
// `body` (and `bodyRight`, two columns): sanitised HTML from the rich text editor.
export interface TextBlock extends BlockBase { type: 'text'; heading: string; body: string; bodyRight?: string; format?: 'html' }
export interface ImageTextBlock extends BlockBase {
  type: 'imageText';
  heading: string;
  // Sanitised HTML from the rich text editor, as the text block's.
  body: string;
  format?: 'html';
  image: ImageRef | null;
  buttonLabel: string;
  buttonTarget: LinkTarget | null;
}
export interface GalleryBlock extends BlockBase { type: 'gallery'; heading: string; images: ImageRef[]; columns: number }
export interface FeaturedGalleriesBlock extends BlockBase {
  type: 'featuredGalleries';
  heading: string;
  intro: string;
  galleries: { id: number; text: string }[];
}
/** `id` (questions, steps, testimonials): unique within the block, so a removed item never hands its editor to the next. */
export interface Testimonial { id: string; quote: string; author: string; role: string; image: ImageRef | null }
export interface TestimonialsBlock extends BlockBase { type: 'testimonials'; heading: string; items: Testimonial[] }
export interface PricingBlock extends BlockBase {
  type: 'pricing';
  heading: string;
  intro: string;
  packageIds: number[];
  showPrices: boolean;
  buttonLabel: string;
  buttonTarget: LinkTarget | null;
}
export interface ContactBlock extends BlockBase {
  type: 'contact';
  heading: string;
  intro: string;
  showPhone: boolean;
  showDate: boolean;
  submitLabel: string;
  successMessage: string;
}
export interface BookingBlock extends BlockBase { type: 'booking'; heading: string; text: string; buttonLabel: string; serviceId: number | null }
export interface InstagramBlock extends BlockBase {
  type: 'instagram';
  heading: string;
  handle: string;
  profileUrl: string;
  images: ImageRef[];
}
export interface SpacerBlock extends BlockBase { type: 'spacer'; divider: boolean }
export interface DividerBlock extends BlockBase { type: 'divider'; width: 'full' | 'short'; spacing: 'none' | 'small' | 'medium' | 'large' }
/** Where a button or menu item leads (backend document.js linkTarget). */
export type LinkTarget =
  | { kind: 'page'; pageId: string }
  | { kind: 'anchor'; pageId: string; blockId: string }
  | { kind: 'booking' }
  | { kind: 'legal'; slug: 'impressum' | 'datenschutz' | 'agb' }
  | { kind: 'url'; url: string };
// `answer`: sanitised HTML from the rich text editor.
export interface FaqBlock extends BlockBase { type: 'faq'; heading: string; items: { id: string; question: string; answer: string }[] }
export type StepIcon = 'camera' | 'calendar' | 'chat' | 'heart' | 'image' | 'star' | 'gift' | 'check' | 'email';
export interface StepsBlock extends BlockBase { type: 'steps'; heading: string; items: { id: string; title: string; text: string; icon: StepIcon | null }[] }
export interface CtaBlock extends BlockBase { type: 'cta'; heading: string; text: string; buttons: { label: string; target: LinkTarget | null }[] }
export interface LogosBlock extends BlockBase { type: 'logos'; heading: string; grayscale: boolean; items: { image: ImageRef | null; url: string }[] }
export type SocialNetwork = 'instagram' | 'facebook' | 'tiktok' | 'youtube' | 'pinterest' | 'linkedin' | 'website' | 'email';
export interface SocialBlock extends BlockBase { type: 'social'; heading: string; links: { network: SocialNetwork; url: string }[] }
// `legacy`: the imported single-page site, rendered in its old containers.
export interface CustomHtmlBlock extends BlockBase { type: 'customHtml'; html: string; legacy?: boolean }

export type Block =
  | HeroBlock | TextBlock | ImageTextBlock | GalleryBlock | FeaturedGalleriesBlock | TestimonialsBlock
  | PricingBlock | ContactBlock | BookingBlock | InstagramBlock | SpacerBlock | DividerBlock
  | FaqBlock | StepsBlock | CtaBlock | LogosBlock | SocialBlock | CustomHtmlBlock;

export type BlockType = Block['type'];

export interface WebsitePage {
  id: string;
  slug: string;
  title: string;
  navLabel: string;
  hidden: boolean;
  isHome: boolean;
  seo: { title: string; description: string; image: ImageRef | null };
  blocks: Block[];
}

export interface WebsiteTheme {
  headingFont: string | null;
  bodyFont: string | null;
  buttonStyle: 'solid' | 'outline' | 'pill' | null;
  accent: string | null;
  background: string | null;
  text: string | null;
}

/** One menu entry: its own label ('' = the page's), shown or hidden, and where it leads. */
export interface MenuItem { id: string; label: string; hidden: boolean; target: LinkTarget }
export interface WebsiteMenu {
  layout: 'left' | 'center';
  style: 'plain' | 'underline' | 'pill';
  sticky: boolean;
  /** Over the picture of a page that starts with a full-picture hero. */
  transparent: boolean;
  mobile: 'dropdown' | 'panel';
  background: string | null;
  text: string | null;
  items: MenuItem[];
}

export type FooterColumn =
  | { id: string; kind: 'brand' | 'pages'; heading: string }
  | { id: string; kind: 'links'; heading: string; links: { label: string; target: LinkTarget }[] }
  | { id: string; kind: 'text'; heading: string; text: string }
  | { id: string; kind: 'contact'; heading: string; email: string; phone: string; address: string }
  | { id: string; kind: 'social'; heading: string; social: SocialBlock['links'] };
export type FooterColumnKind = FooterColumn['kind'];
export interface WebsiteFooter {
  columns: FooterColumn[];
  /** The legal links (and the support address): a column, the copyright row, or not at all. */
  legal: 'column' | 'bottom' | 'off';
  /** '' = "© {year} {company}"; {year} is replaced. */
  copyright: string;
  background: 'default' | 'dark' | 'custom';
  backgroundColor?: string;
  textColor?: string | null;
}

export interface WebsiteDocument {
  version: number;
  pages: WebsitePage[];
  menu: WebsiteMenu;
  footer: WebsiteFooter;
  theme: WebsiteTheme;
  customCss: string;
}

interface RevisionInfo {
  revision: number;
  updatedAt: string;
  publishedAt: string | null;
}

export interface EditorState {
  document: WebsiteDocument;
  draft: RevisionInfo;
  published: RevisionInfo | null;
  hasUnpublishedChanges: boolean;
  publicSiteEnabled: boolean;
  /** The landing page migration 381 imported is still what `/` serves. */
  legacyLandingLive?: boolean;
  /** The branding's colours, offered as swatches for a custom block background. */
  brandColors?: string[];
  /** The configured public origin (sitemap, canonical links); '' when none. */
  publicUrl?: string;
  /** The landing page was too long to import; it stays live until a publish. */
  legacyImportRefused?: { length: number; max: number } | null;
}

export interface WebsiteGallery {
  id: number;
  name: string;
  slug: string;
  date: string | null;
  showOnWebsite: boolean;
  eligible: boolean;
  hasPassword: boolean;
  reason: 'not_opted_in' | 'unavailable' | 'hidden' | 'payment_lock' | 'missing' | null;
  canChange: boolean;
}

export interface WebsitePhoto {
  id: number;
  width: number | null;
  height: number | null;
  filename: string;
  /** The website's own 640 URL (as the website shows it, watermark included). */
  thumbnailUrl: string | null;
}

export interface WebsiteAsset {
  id: string;
  kind: 'image' | 'video';
  width: number | null;
  height: number | null;
  originalFilename: string;
  sizeBytes: number | null;
  createdAt: string;
  previewUrl: string | null;
  videoUrl: string | null;
}

export interface WebsitePackage {
  id: number;
  name: string;
  description: string;
  currency: string;
  /** Why a quote could not be made from it (and the page leaves it out). */
  unavailable?: 'archived_items' | 'empty' | 'archived' | null;
}

export interface ValidationProblem { code: string; pageId?: string; slug?: string; blockId?: string }
