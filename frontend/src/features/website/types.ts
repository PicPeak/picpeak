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
  buttonUrl: string;
  image: ImageRef | null;
  video: { source: 'asset'; id: string } | null;
}
export interface TextBlock extends BlockBase { type: 'text'; heading: string; body: string }
export interface ImageTextBlock extends BlockBase {
  type: 'imageText';
  heading: string;
  body: string;
  image: ImageRef | null;
  buttonLabel: string;
  buttonUrl: string;
}
export interface GalleryBlock extends BlockBase { type: 'gallery'; heading: string; images: ImageRef[]; columns: number }
export interface FeaturedGalleriesBlock extends BlockBase {
  type: 'featuredGalleries';
  heading: string;
  intro: string;
  galleries: { id: number; text: string }[];
}
export interface Testimonial { quote: string; author: string; role: string; image: ImageRef | null }
export interface TestimonialsBlock extends BlockBase { type: 'testimonials'; heading: string; items: Testimonial[] }
export interface PricingBlock extends BlockBase {
  type: 'pricing';
  heading: string;
  intro: string;
  packageIds: number[];
  showPrices: boolean;
  buttonLabel: string;
  buttonUrl: string;
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
export interface BookingBlock extends BlockBase { type: 'booking'; heading: string; text: string; buttonLabel: string }
export interface InstagramBlock extends BlockBase {
  type: 'instagram';
  heading: string;
  handle: string;
  profileUrl: string;
  images: ImageRef[];
}
export interface SpacerBlock extends BlockBase { type: 'spacer'; divider: boolean }
export interface DividerBlock extends BlockBase { type: 'divider'; width: 'full' | 'short'; spacing: 'none' | 'small' | 'medium' | 'large' }
// `legacy`: the imported single-page site, rendered in its old containers.
export interface CustomHtmlBlock extends BlockBase { type: 'customHtml'; html: string; legacy?: boolean }

export type Block =
  | HeroBlock | TextBlock | ImageTextBlock | GalleryBlock | FeaturedGalleriesBlock | TestimonialsBlock
  | PricingBlock | ContactBlock | BookingBlock | InstagramBlock | SpacerBlock | DividerBlock | CustomHtmlBlock;

export type BlockType = Block['type'];

export interface WebsitePage {
  id: string;
  slug: string;
  title: string;
  navLabel: string;
  hidden: boolean;
  inNav: boolean;
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

export interface WebsiteDocument {
  version: number;
  pages: WebsitePage[];
  theme: WebsiteTheme;
  customCss: string;
}

export interface RevisionInfo {
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

export interface ValidationProblem { code: string; pageId?: string; slug?: string }
