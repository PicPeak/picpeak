/**
 * Server-side renderer of the website builder (issue 2618).
 *
 * Pure: renderPage(context) takes the normalised document plus everything the
 * data layer resolved (eligible photos, assets, galleries, packages, branding)
 * and returns one HTML document. No database access here, so every security
 * rule of the output is testable without one:
 *   - every text field is HTML-escaped; only the custom-HTML block carries
 *     markup, and it went through the public-site sanitiser before it got here;
 *   - every link went through safeUrl (http(s), mailto, tel, same-site paths);
 *   - every colour went through sanitizeCssColor, font names through a
 *     whitelist of installed families;
 *   - an image is rendered only when the data layer found it eligible, and
 *     only as /site-media rendition URLs.
 *
 * The page ships no JavaScript. Navigation on a phone is a <details> menu, the
 * contact form posts natively and reports back through a :target anchor.
 */
const { escapeHtml } = require('../../utils/formatters');
const { toDateOnly } = require('../../utils/dateOnly');
const { escapeCssForStyleElement } = require('../../utils/cssSanitizer');
const { relativeLuminance, readableTextOn } = require('../../utils/colorContrast');
const { safeUrl } = require('./document');
const { brandCssVariables } = require('../../utils/brandCssVariables');
const { MEDIA_WIDTHS, mediaBase, parseRenditionKeys, photoVersion } = require('./media');

const esc = escapeHtml;

const STRINGS = {
  en: {
    menu: 'Menu',
    home: 'Home',
    viewGallery: 'View gallery',
    name: 'Name',
    email: 'Email',
    phone: 'Phone',
    date: 'Event date',
    message: 'Message',
    send: 'Send message',
    sent: 'Thank you! Your message has been sent.',
    failed: 'Your message could not be sent. Please try again later.',
    book: 'Book now',
    leaveEmpty: 'Leave this field empty',
    from: 'from',
    support: 'Contact',
    privacy: 'Privacy Policy',
    imprint: 'Impressum',
    terms: 'Terms & Conditions',
    previewForm: 'The form is disabled in the preview.',
    follow: 'Follow',
    videoInPreview: 'Video plays on the published page',
  },
  de: {
    menu: 'Menü',
    home: 'Start',
    viewGallery: 'Galerie ansehen',
    name: 'Name',
    email: 'E-Mail',
    phone: 'Telefon',
    date: 'Datum des Anlasses',
    message: 'Nachricht',
    send: 'Nachricht senden',
    sent: 'Vielen Dank! Ihre Nachricht wurde gesendet.',
    failed: 'Ihre Nachricht konnte nicht gesendet werden. Bitte versuchen Sie es später erneut.',
    book: 'Jetzt buchen',
    leaveEmpty: 'Dieses Feld leer lassen',
    from: 'ab',
    support: 'Kontakt',
    privacy: 'Datenschutz',
    imprint: 'Impressum',
    terms: 'AGB',
    previewForm: 'Das Formular ist in der Vorschau deaktiviert.',
    follow: 'Folgen',
    videoInPreview: 'Das Video läuft auf der veröffentlichten Seite',
  },
};

function strings(locale) {
  return STRINGS[locale] || STRINGS.en;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

// Runs on already-escaped text, which contains no `<`, so the only tags in
// the result are the two inserted here.
function emphasis(escaped) {
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
}

function linkAttrs(url) {
  return /^https?:/i.test(url) ? ' rel="noopener noreferrer"' : '';
}

/** One paragraph: escaped text with **bold**, *italic* and [label](url). */
function inline(text) {
  const linkPattern = /\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g;
  let out = '';
  let last = 0;
  for (const match of text.matchAll(linkPattern)) {
    out += emphasis(esc(text.slice(last, match.index)));
    const url = safeUrl(match[2]);
    out += url
      ? `<a href="${esc(url)}"${linkAttrs(url)}>${emphasis(esc(match[1]))}</a>`
      : emphasis(esc(match[0]));
    last = match.index + match[0].length;
  }
  return out + emphasis(esc(text.slice(last)));
}

/** Multi-paragraph text: a blank line starts a paragraph, a newline is a <br>. */
function richText(text) {
  if (!text) return '';
  return text.split(/\n\s*\n/).map((para) => para.trim()).filter(Boolean)
    .map((para) => `<p>${para.split('\n').map(inline).join('<br>')}</p>`).join('');
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Resolve an image reference against what the data layer found eligible.
 * Returns { base, width, height, tiers } or null (not eligible / unknown).
 */
function resolveImage(ref, ctx) {
  if (!ref) return null;
  if (ref.source === 'photo') {
    const photo = ctx.photos.get(ref.id);
    if (!photo) return null;
    return { base: mediaBase(ref, photoVersion(photo)), width: Number(photo.width) || null, height: Number(photo.height) || null, tiers: MEDIA_WIDTHS };
  }
  const asset = ctx.assets.get(ref.id);
  if (!asset || asset.kind !== 'image') return null;
  const keys = parseRenditionKeys(asset);
  const tiers = MEDIA_WIDTHS.filter((w) => keys[w]);
  if (!tiers.length) return null;
  return { base: mediaBase(ref), width: Number(asset.width) || null, height: Number(asset.height) || null, tiers };
}

/**
 * srcset over the preview tiers. A tier is the image fitted inside
 * tier x tier without enlargement, so its real width is computed from the
 * stored dimensions; tiers that would come out the same size are dropped.
 */
function srcsetFor(image) {
  const entries = [];
  const seen = new Set();
  for (const tier of image.tiers) {
    let w = tier;
    if (image.width && image.height) {
      const longEdge = Math.max(image.width, image.height);
      w = Math.round(image.width * Math.min(1, tier / longEdge));
    }
    if (seen.has(w)) continue;
    seen.add(w);
    entries.push(`${image.base}/${tier} ${w}w`);
  }
  return entries.join(', ');
}

function defaultSrc(image) {
  const tier = image.tiers.includes(1280) ? 1280 : image.tiers[image.tiers.length - 1];
  return `${image.base}/${tier}`;
}

function imgTag(image, { alt = '', sizes = '100vw', eager = false, className = '' } = {}) {
  const dims = image.width && image.height ? ` width="${image.width}" height="${image.height}"` : '';
  const loading = eager ? ' fetchpriority="high"' : ' loading="lazy"';
  const cls = className ? ` class="${className}"` : '';
  return `<img${cls} src="${esc(defaultSrc(image))}" srcset="${esc(srcsetFor(image))}" sizes="${esc(sizes)}"${dims} alt="${esc(alt)}"${loading} decoding="async">`;
}

function aspect(image, fallback = '3 / 2') {
  return image.width && image.height ? `${image.width} / ${image.height}` : fallback;
}

// ---------------------------------------------------------------------------
// Buttons and section shell
// ---------------------------------------------------------------------------

function button(label, url, { secondary = false } = {}) {
  if (!label || !url) return '';
  return `<a class="pp-btn${secondary ? ' pp-btn--ghost' : ''}" href="${esc(url)}"${linkAttrs(url)}>${esc(label)}</a>`;
}

function heading(text, level = 2) {
  return text ? `<h${level} class="pp-h">${esc(text)}</h${level}>` : '';
}

function section(block, inner, ctx, extraClass = '') {
  const bg = block.background === 'default' ? '' : ` pp-${block.background}`;
  const previewAttr = ctx.preview ? ` data-block-id="${esc(block.id)}"` : '';
  return `<section id="b-${esc(block.id)}" class="pp-block pp-${esc(block.type)} pp-v-${esc(block.variant)}${bg}${extraClass ? ` ${extraClass}` : ''}"${previewAttr}>${inner}</section>`;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function renderHero(block, ctx) {
  const image = resolveImage(block.image, ctx);
  const video = block.video ? ctx.assets.get(block.video.id) : null;
  const isFirst = ctx.firstHeroId === block.id;
  const media = [];
  if (video && video.kind === 'video' && ctx.preview && ctx.videoAsPoster) {
    // The editor runs on another origin than the media, and its policy lets
    // a frame load no video from there: the poster, or a placeholder, and
    // where the video does play.
    media.push(image
      ? imgTag(image, { alt: block.image.alt, eager: true, className: 'pp-hero__media' })
      : '<div class="pp-hero__media pp-hero__placeholder"></div>');
    media.push(`<span class="pp-video-note">${esc(strings(ctx.locale).videoInPreview)}</span>`);
  } else if (video && video.kind === 'video') {
    const poster = image ? ` poster="${esc(defaultSrc(image))}"` : '';
    media.push(`<video class="pp-hero__media" autoplay muted loop playsinline preload="metadata"${poster}><source src="${esc(mediaBase(block.video))}/video" type="${esc(video.mime_type || 'video/mp4')}"></video>`);
  } else if (image) {
    media.push(imgTag(image, {
      alt: block.image.alt, eager: isFirst, className: 'pp-hero__media',
      sizes: block.variant === 'split' ? '(min-width: 900px) 50vw, 100vw' : '100vw',
    }));
  }
  const text = `<div class="pp-hero__text">${block.heading ? `<h1 class="pp-h pp-display">${esc(block.heading)}</h1>` : ''}${block.subheading ? `<p class="pp-lead">${inline(block.subheading)}</p>` : ''}${button(block.buttonLabel, block.buttonUrl)}</div>`;
  if (block.variant === 'split') {
    return section(block, `<div class="pp-wrap pp-split">${text}${media.length ? `<div class="pp-hero__frame">${media.join('')}</div>` : ''}</div>`, ctx);
  }
  if (block.variant === 'minimal' || !media.length) {
    // An overlay hero without a picture falls back to the minimal layout.
    return section({ ...block, variant: 'minimal' }, `<div class="pp-wrap pp-narrow pp-center">${text}</div>`, ctx);
  }
  return section(block, `${media.join('')}<div class="pp-hero__shade"></div><div class="pp-wrap pp-hero__over">${text}</div>`, ctx);
}

function renderText(block, ctx) {
  const center = block.variant === 'center' ? ' pp-center' : '';
  const cols = block.variant === 'columns' ? ' pp-columns' : '';
  return section(block, `<div class="pp-wrap pp-narrow${center}">${heading(block.heading)}<div class="pp-prose${cols}">${richText(block.body)}</div></div>`, ctx);
}

function renderImageText(block, ctx) {
  const image = resolveImage(block.image, ctx);
  const figure = image
    ? `<div class="pp-frame" style="aspect-ratio:${aspect(image)}">${imgTag(image, { alt: block.image.alt, sizes: '(min-width: 900px) 50vw, 100vw' })}</div>`
    : '';
  const text = `<div>${heading(block.heading)}<div class="pp-prose">${richText(block.body)}</div>${button(block.buttonLabel, block.buttonUrl)}</div>`;
  const reverse = block.variant === 'image-right' ? ' pp-split--reverse' : '';
  return section(block, `<div class="pp-wrap pp-split${reverse}">${figure}${text}</div>`, ctx);
}

function renderGallery(block, ctx) {
  const images = block.images.map((ref) => [ref, resolveImage(ref, ctx)]).filter(([, image]) => image);
  if (!images.length && !ctx.preview) return '';
  const sizes = `(min-width: 900px) ${Math.round(100 / block.columns)}vw, 50vw`;
  const tiles = images.map(([ref, image]) => (block.variant === 'masonry'
    ? `<figure class="pp-tile">${imgTag(image, { alt: ref.alt, sizes })}</figure>`
    : `<figure class="pp-tile pp-tile--crop">${imgTag(image, { alt: ref.alt, sizes })}</figure>`)).join('');
  return section(block, `<div class="pp-wrap">${heading(block.heading)}<div class="pp-grid pp-cols-${block.columns}${block.variant === 'masonry' ? ' pp-masonry' : ''}">${tiles}</div></div>`, ctx);
}

// event_date is a calendar date. On PostgreSQL it arrives as a Date at local
// midnight, which east of UTC is the day before in UTC: reduce it to its
// calendar day first (toDateOnly, as the OG preview does), then format that.
function formatDate(value, locale) {
  const day = toDateOnly(value);
  if (!day) return '';
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T12:00:00Z` : day);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale === 'de' ? 'de-CH' : 'en-GB', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(date);
  } catch {
    return '';
  }
}

function renderFeaturedGalleries(block, ctx) {
  const s = strings(ctx.locale);
  const cards = block.galleries.map((entry) => {
    const event = ctx.events.get(entry.id);
    if (!event) return '';
    const cover = ctx.covers.get(event.id);
    const image = cover ? resolveImage({ source: 'photo', id: cover.id }, { ...ctx, photos: new Map([[cover.id, cover]]) }) : null;
    const href = `/gallery/${encodeURIComponent(event.slug)}`;
    const media = image
      ? `<div class="pp-frame pp-frame--card">${imgTag(image, { alt: event.event_name, sizes: '(min-width: 900px) 33vw, 100vw' })}</div>`
      : '<div class="pp-frame pp-frame--card pp-frame--empty"></div>';
    const date = formatDate(event.event_date, ctx.locale);
    return `<a class="pp-card" href="${esc(href)}">${media}<div class="pp-card__body"><h3 class="pp-h">${esc(event.event_name)}</h3>${date ? `<p class="pp-muted">${esc(date)}</p>` : ''}${entry.text ? `<p>${esc(entry.text)}</p>` : ''}<span class="pp-link">${esc(s.viewGallery)} →</span></div></a>`;
  }).join('');
  if (!cards && !ctx.preview) return '';
  const list = block.variant === 'list' ? ' pp-card-list' : '';
  return section(block, `<div class="pp-wrap">${heading(block.heading)}${block.intro ? `<div class="pp-prose pp-intro">${richText(block.intro)}</div>` : ''}<div class="pp-cards${list}">${cards}</div></div>`, ctx);
}

function renderTestimonials(block, ctx) {
  // A draft keeps an unfinished testimonial; the page shows only quoted ones.
  const items = block.items.filter((item) => item.quote).map((item) => {
    const image = resolveImage(item.image, ctx);
    const avatar = image ? `<span class="pp-avatar">${imgTag(image, { alt: item.author, sizes: '64px' })}</span>` : '';
    return `<figure class="pp-quote"><blockquote>${richText(item.quote)}</blockquote><figcaption>${avatar}<span><strong>${esc(item.author)}</strong>${item.role ? `<span class="pp-muted">${esc(item.role)}</span>` : ''}</span></figcaption></figure>`;
  }).join('');
  if (!items && !ctx.preview) return '';
  return section(block, `<div class="pp-wrap${block.variant === 'quote' ? ' pp-narrow' : ''}">${heading(block.heading)}<div class="pp-quotes">${items}</div></div>`, ctx);
}

function formatMoney(minor, currency, locale) {
  try {
    return new Intl.NumberFormat(locale === 'de' ? 'de-CH' : 'en-GB', { style: 'currency', currency: currency || 'CHF', maximumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency || ''}`.trim();
  }
}

function renderPricing(block, ctx) {
  const s = strings(ctx.locale);
  const cards = block.packageIds.map((id) => {
    const pkg = ctx.packages.get(id);
    if (!pkg) return '';
    const price = block.showPrices && pkg.totalMinor > 0
      ? `<p class="pp-price"><span class="pp-muted">${esc(s.from)}</span> ${esc(formatMoney(pkg.totalMinor, pkg.currency, ctx.locale))}</p>` : '';
    const items = pkg.items.length ? `<ul class="pp-ticks">${pkg.items.map((name) => `<li>${esc(name)}</li>`).join('')}</ul>` : '';
    return `<div class="pp-plan"><h3 class="pp-h">${esc(pkg.name)}</h3>${price}${pkg.description ? `<p>${esc(pkg.description)}</p>` : ''}${items}${button(block.buttonLabel, block.buttonUrl, { secondary: true })}</div>`;
  }).join('');
  if (!cards && !ctx.preview) return '';
  return section(block, `<div class="pp-wrap">${heading(block.heading)}${block.intro ? `<div class="pp-prose pp-intro">${richText(block.intro)}</div>` : ''}<div class="pp-plans${block.variant === 'list' ? ' pp-plans--list' : ''}">${cards}</div></div>`, ctx);
}

function renderContact(block, ctx) {
  const s = strings(ctx.locale);
  const fid = (name) => `c-${esc(block.id)}-${name}`;
  const field = (name, label, input) => `<label class="pp-field" for="${fid(name)}"><span>${esc(label)}</span>${input}</label>`;
  const disabled = ctx.preview ? ' disabled' : '';
  const form = `<form class="pp-form" method="post" enctype="multipart/form-data" action="/api/public/website/contact">
<input type="hidden" name="page" value="${esc(ctx.page.id)}"><input type="hidden" name="block" value="${esc(block.id)}">
<div class="pp-hp" aria-hidden="true"><label>${esc(s.leaveEmpty)}<input type="text" name="company_website" tabindex="-1" autocomplete="off"></label></div>
${field('name', s.name, `<input id="${fid('name')}" name="name" type="text" required maxlength="160" autocomplete="name"${disabled}>`)}
${field('email', s.email, `<input id="${fid('email')}" name="email" type="email" required maxlength="255" autocomplete="email"${disabled}>`)}
${block.showPhone ? field('phone', s.phone, `<input id="${fid('phone')}" name="phone" type="tel" maxlength="40" autocomplete="tel"${disabled}>`) : ''}
${block.showDate ? field('date', s.date, `<input id="${fid('date')}" name="date" type="date"${disabled}>`) : ''}
${field('message', s.message, `<textarea id="${fid('message')}" name="message" required maxlength="5000" rows="5"${disabled}></textarea>`)}
<button class="pp-btn" type="submit"${disabled}>${esc(block.submitLabel || s.send)}</button>
${ctx.preview ? `<p class="pp-muted">${esc(s.previewForm)}</p>` : ''}</form>`;
  const notes = `<p id="contact-sent-${esc(block.id)}" class="pp-note pp-note--ok" role="status">${esc(block.successMessage || s.sent)}</p><p id="contact-error-${esc(block.id)}" class="pp-note pp-note--err" role="alert">${esc(s.failed)}</p>`;
  const intro = `<div>${heading(block.heading)}${block.intro ? `<div class="pp-prose">${richText(block.intro)}</div>` : ''}</div>`;
  if (block.variant === 'split') {
    return section(block, `<div class="pp-wrap pp-split pp-split--top">${intro}<div>${notes}${form}</div></div>`, ctx);
  }
  return section(block, `<div class="pp-wrap pp-narrow">${intro}${notes}${form}</div>`, ctx);
}

function renderBooking(block, ctx) {
  const s = strings(ctx.locale);
  if (!ctx.booking || !ctx.booking.enabled) {
    // Hidden on the live site while booking is off; the editor still shows
    // where it would be.
    return ctx.preview ? section(block, `<div class="pp-wrap pp-narrow pp-center pp-muted">${heading(block.heading)}<p>${esc(s.book)} (off)</p></div>`, ctx) : '';
  }
  const inner = `<div class="pp-wrap pp-narrow pp-center">${heading(block.heading)}${block.text ? `<div class="pp-prose">${richText(block.text)}</div>` : ''}${button(block.buttonLabel || s.book, ctx.booking.url)}</div>`;
  return section(block, inner, ctx, block.variant === 'banner' ? 'pp-band' : '');
}

function renderInstagram(block, ctx) {
  const images = block.images.map((ref) => [ref, resolveImage(ref, ctx)]).filter(([, image]) => image);
  if (!images.length && !ctx.preview) return '';
  const s = strings(ctx.locale);
  const handle = block.handle ? `@${block.handle}` : '';
  const title = block.heading || handle;
  // The handle is the title when there is no heading; the link then says
  // "Follow" rather than repeating it.
  const linkText = block.heading ? handle : s.follow;
  const profile = block.profileUrl && linkText
    ? `<a class="pp-link" href="${esc(block.profileUrl)}"${linkAttrs(block.profileUrl)}>${esc(linkText)} →</a>`
    : (handle && block.heading ? `<span class="pp-muted">${esc(handle)}</span>` : '');
  const tiles = images.map(([ref, image]) => `<figure class="pp-tile pp-tile--crop">${imgTag(image, { alt: ref.alt, sizes: block.variant === 'grid' ? '33vw' : '(min-width: 900px) 17vw, 40vw' })}</figure>`).join('');
  return section(block, `<div class="pp-wrap"><div class="pp-insta-head">${heading(title)}${profile}</div><div class="${block.variant === 'grid' ? 'pp-grid pp-cols-3' : 'pp-strip'}">${tiles}</div></div>`, ctx);
}

function renderSpacer(block, ctx) {
  return section(block, block.divider ? '<div class="pp-wrap"><hr class="pp-rule"></div>' : '', ctx);
}

function renderCustomHtml(block, ctx) {
  const html = ctx.sanitizeCustomHtml(block.html);
  if (!html && !ctx.preview) return '';
  return section(block, `<div class="pp-custom">${html}</div>`, ctx);
}

const RENDERERS = {
  hero: renderHero,
  text: renderText,
  imageText: renderImageText,
  gallery: renderGallery,
  featuredGalleries: renderFeaturedGalleries,
  testimonials: renderTestimonials,
  pricing: renderPricing,
  contact: renderContact,
  booking: renderBooking,
  instagram: renderInstagram,
  spacer: renderSpacer,
  customHtml: renderCustomHtml,
};

// ---------------------------------------------------------------------------
// Theme and document
// ---------------------------------------------------------------------------

const FALLBACK_SANS = 'system-ui, -apple-system, \'Segoe UI\', Roboto, sans-serif';

function fontStack(font) {
  if (!font) return FALLBACK_SANS;
  return `'${font.family}', ${font.generic === 'serif' ? 'Georgia, serif' : FALLBACK_SANS}`;
}

function fontFaces(fonts) {
  const faces = [];
  const seen = new Set();
  for (const [font, wanted] of [[fonts.body, [400, 600]], [fonts.heading, [600]]]) {
    if (!font) continue;
    for (const w of wanted) {
      // The closest installed weight; a family with only 400 serves it for 600.
      const weight = font.weights.reduce((best, x) => (Math.abs(x - w) < Math.abs(best - w) ? x : best), font.weights[0]);
      const key = `${font.family}:${weight}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const folder = font.family.replace(/ /g, '-');
      faces.push(`@font-face{font-family:'${font.family}';font-style:normal;font-weight:${weight};font-display:swap;src:url('/fonts/${encodeURIComponent(folder)}/${weight}.woff2') format('woff2')}`);
    }
  }
  return faces.join('');
}

function palette(theme) {
  const bg = theme.background;
  const text = theme.text;
  // "Dark" sections take the darker of the two page colours as their floor,
  // "light" ones the surface: both stay inside the studio's palette.
  const bgDarker = (relativeLuminance(bg) ?? 1) < (relativeLuminance(text) ?? 0);
  const darkBg = bgDarker ? bg : text;
  const darkText = bgDarker ? text : bg;
  return {
    bg,
    text,
    muted: theme.muted,
    surface: theme.surface,
    border: theme.border,
    accent: theme.accent,
    accentFg: readableTextOn(theme.accent, '#ffffff'),
    link: readableTextOn(bg, theme.accent, 3),
    darkBg,
    darkText,
    darkMuted: readableTextOn(darkBg, theme.muted, 3),
    darkLink: readableTextOn(darkBg, theme.accent, 3),
  };
}

const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:400 1.0625rem/1.65 var(--font-body);-webkit-font-smoothing:antialiased}
img,video{display:block;max-width:100%}
a{color:var(--link)}
.pp-h{font-family:var(--font-heading);font-weight:600;line-height:1.15;letter-spacing:-.01em;margin:0 0 .6em;color:var(--text)}
h2.pp-h{font-size:clamp(1.6rem,1.2rem + 1.6vw,2.4rem)}
h3.pp-h{font-size:1.2rem;margin-bottom:.35em}
.pp-display{font-size:clamp(2.2rem,1.4rem + 3.6vw,4.2rem)}
.pp-lead{font-size:clamp(1.05rem,1rem + .4vw,1.3rem);max-width:40ch;margin:0 0 1.6em;color:var(--muted)}
.pp-center .pp-lead{margin-left:auto;margin-right:auto}
.pp-muted{color:var(--muted)}
.pp-wrap{width:min(1160px,100% - 2.5rem);margin:0 auto}
.pp-narrow{width:min(760px,100% - 2.5rem)}
.pp-center{text-align:center}
.pp-block{background:var(--bg);color:var(--text);padding:clamp(3rem,2rem + 4vw,6rem) 0}
.pp-light{--bg:var(--surface)}
.pp-dark{--bg:var(--dark-bg);--text:var(--dark-text);--muted:var(--dark-muted);--link:var(--dark-link);--border:color-mix(in srgb,var(--dark-text) 18%,transparent);--surface:color-mix(in srgb,var(--dark-text) 6%,var(--dark-bg))}
.pp-prose p{margin:0 0 1em}.pp-prose p:last-child{margin-bottom:0}
.pp-prose+.pp-btn{margin-top:1.5rem}
.pp-intro{margin:-.2em 0 2rem;color:var(--muted);max-width:60ch}
.pp-columns{columns:2 22rem;column-gap:3rem}
.pp-btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:.7rem 1.6rem;border:2px solid var(--accent);border-radius:var(--btn-radius);background:var(--accent);color:var(--accent-fg);font:600 1rem/1.2 var(--font-body);text-decoration:none;cursor:pointer}
.pp-btn:hover{filter:brightness(1.08)}
.pp-btn:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.pp-btn--ghost{background:transparent;color:var(--text);border-color:var(--border)}
.pp-btn-outline .pp-btn{background:transparent;color:var(--text)}
.pp-link{color:var(--link);font-weight:600;text-decoration:none}
.pp-header{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--border)}
.pp-header__in{display:flex;align-items:center;justify-content:space-between;gap:1rem;min-height:68px}
.pp-brand{display:flex;align-items:center;gap:.7rem;color:var(--text);text-decoration:none;font:600 1.1rem/1.2 var(--font-heading);min-width:0}
.pp-brand img{height:40px;width:auto}
.pp-nav ul,.pp-menu ul,.pp-footer ul{list-style:none;margin:0;padding:0}
.pp-nav ul{display:flex;gap:1.6rem}
.pp-nav a,.pp-menu a{color:var(--text);text-decoration:none;font-weight:500}
.pp-nav a[aria-current],.pp-menu a[aria-current]{color:var(--link)}
.pp-menu{display:none;position:relative}
.pp-menu summary{list-style:none;cursor:pointer;padding:.6rem .9rem;border:1px solid var(--border);border-radius:999px;font-weight:600}
.pp-menu summary::-webkit-details-marker{display:none}
.pp-menu ul{position:absolute;right:0;top:calc(100% + .5rem);min-width:12rem;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:.5rem;box-shadow:0 12px 32px rgba(0,0,0,.12)}
.pp-menu li a{display:block;padding:.65rem .8rem;border-radius:8px}
@media (max-width:760px){.pp-nav{display:none}.pp-menu{display:block}}
.pp-hero{position:relative;overflow:hidden}
.pp-hero.pp-v-overlay{padding:0;min-height:min(88vh,860px);display:grid;align-items:end;color:#fff}
.pp-hero.pp-v-overlay .pp-hero__media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.pp-hero__shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.05) 30%,rgba(0,0,0,.62))}
.pp-hero__over{position:relative;padding:clamp(3rem,2rem + 6vw,7rem) 0}
.pp-hero.pp-v-overlay .pp-h,.pp-hero.pp-v-overlay .pp-lead{color:#fff}
.pp-hero.pp-v-overlay .pp-lead{color:rgba(255,255,255,.88)}
.pp-hero__frame{border-radius:var(--radius);overflow:hidden}
.pp-hero__frame .pp-hero__media{width:100%;height:auto}
.pp-split{display:grid;gap:clamp(2rem,1rem + 4vw,5rem);align-items:center}
@media (min-width:900px){.pp-split{grid-template-columns:1fr 1fr}.pp-split--reverse>:first-child{order:2}.pp-split--top{align-items:start}}
.pp-frame{border-radius:var(--radius);overflow:hidden;background:var(--surface)}
.pp-frame img{width:100%;height:100%;object-fit:cover}
.pp-grid{display:grid;gap:clamp(.5rem,.3rem + 1vw,1rem);grid-template-columns:repeat(2,1fr)}
@media (min-width:900px){.pp-cols-3{grid-template-columns:repeat(3,1fr)}.pp-cols-4{grid-template-columns:repeat(4,1fr)}}
.pp-tile{margin:0;border-radius:calc(var(--radius) / 2);overflow:hidden;background:var(--surface)}
.pp-tile img{width:100%;height:auto}
.pp-tile--crop{aspect-ratio:1}
.pp-tile--crop img{height:100%;object-fit:cover}
.pp-masonry{display:block;columns:2;column-gap:clamp(.5rem,.3rem + 1vw,1rem)}
@media (min-width:900px){.pp-masonry.pp-cols-3{columns:3}.pp-masonry.pp-cols-4{columns:4}}
.pp-masonry .pp-tile{break-inside:avoid;margin-bottom:clamp(.5rem,.3rem + 1vw,1rem)}
.pp-cards{display:grid;gap:1.5rem;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))}
.pp-card{display:flex;flex-direction:column;color:inherit;text-decoration:none;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.pp-card:hover .pp-frame img{transform:scale(1.03)}
.pp-frame--card{aspect-ratio:4/3;border-radius:0}
.pp-frame--card img{transition:transform .4s ease}
.pp-card__body{padding:1.2rem 1.3rem 1.4rem}
.pp-card__body p{margin:0 0 .6rem}
.pp-card-list{grid-template-columns:1fr}
@media (min-width:700px){.pp-card-list .pp-card{flex-direction:row}.pp-card-list .pp-frame--card{width:40%;flex:none}}
.pp-quotes{display:grid;gap:1.5rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}
.pp-quote{margin:0;padding:1.8rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);display:flex;flex-direction:column;justify-content:space-between;gap:1.2rem}
.pp-quote blockquote{margin:0;font-size:1.08rem}
.pp-v-quote .pp-quotes{grid-template-columns:1fr}
.pp-v-quote .pp-quote{background:none;border:0;padding:0;text-align:center;align-items:center}
.pp-v-quote .pp-quote blockquote{font:400 clamp(1.3rem,1rem + 1.4vw,2rem)/1.4 var(--font-heading)}
.pp-quote figcaption{display:flex;align-items:center;gap:.8rem}
.pp-quote figcaption>span{display:flex;flex-direction:column;line-height:1.3}
.pp-avatar{width:48px;height:48px;border-radius:50%;overflow:hidden;flex:none}
.pp-avatar img{width:100%;height:100%;object-fit:cover}
.pp-plans{display:grid;gap:1.5rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))}
.pp-plan{padding:2rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);display:flex;flex-direction:column;gap:.4rem}
.pp-plan .pp-btn{margin-top:auto;align-self:flex-start}
.pp-plans--list{grid-template-columns:1fr}
.pp-price{font:600 1.6rem/1.2 var(--font-heading);margin:.2rem 0 .6rem}
.pp-price .pp-muted{font-size:1rem;font-weight:400}
.pp-ticks{margin:.4rem 0 1.4rem;padding:0;list-style:none}
.pp-ticks li{padding:.3rem 0 .3rem 1.6rem;position:relative}
.pp-ticks li::before{content:"";position:absolute;left:.2rem;top:.85rem;width:.6rem;height:.35rem;border:solid var(--link);border-width:0 0 2px 2px;transform:rotate(-45deg)}
.pp-form{display:grid;gap:1rem;margin-top:1.5rem}
.pp-field{display:grid;gap:.35rem;font-weight:600;font-size:.95rem}
.pp-field input,.pp-field textarea{width:100%;font:inherit;font-weight:400;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:calc(var(--radius) / 2);padding:.75rem .9rem;min-height:48px}
.pp-form .pp-btn{justify-self:start}
.pp-hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.pp-note{display:none;padding:1rem 1.2rem;border-radius:calc(var(--radius) / 2);margin:1rem 0 0;font-weight:600}
.pp-note:target{display:block}
.pp-note--ok{background:color-mix(in srgb,#16a34a 14%,var(--bg));color:var(--text)}
.pp-note--err{background:color-mix(in srgb,#dc2626 14%,var(--bg));color:var(--text)}
.pp-band{--bg:var(--accent);--text:var(--accent-fg);--muted:var(--accent-fg)}
.pp-band .pp-btn{background:var(--accent-fg);color:var(--accent);border-color:var(--accent-fg)}
.pp-insta-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.5rem 1rem;margin-bottom:1.2rem}
.pp-insta-head .pp-h{margin:0}
.pp-strip{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(40%,1fr);gap:.5rem;overflow-x:auto;scroll-snap-type:x mandatory}
.pp-strip .pp-tile{scroll-snap-align:start}
@media (min-width:900px){.pp-strip{grid-auto-columns:1fr;overflow:visible}}
.pp-spacer{padding:0}
.pp-spacer.pp-v-small{padding:1.5rem 0}.pp-spacer.pp-v-medium{padding:3rem 0}.pp-spacer.pp-v-large{padding:6rem 0}
.pp-rule{border:0;border-top:1px solid var(--border);margin:0}
.pp-customHtml{padding:0}
.pp-footer{background:var(--surface);border-top:1px solid var(--border);padding:3.5rem 0 2rem;font-size:.95rem}
.pp-footer__in{display:grid;gap:2rem}
@media (min-width:760px){.pp-footer__in{grid-template-columns:2fr 1fr 1fr}}
.pp-footer a{color:var(--text);text-decoration:none}
.pp-footer li{margin:0 0 .5rem}
.pp-footer p{margin:.4rem 0 0;color:var(--muted)}
.pp-copy{grid-column:1/-1;border-top:1px solid var(--border);padding-top:1.5rem;font-size:.85rem}
.pp-skip{position:absolute;left:-10000px}.pp-skip:focus{left:1rem;top:1rem;z-index:20;background:var(--surface);padding:.6rem 1rem}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}`;

// The marker is a pseudo-element above the section's children: an outline
// would be painted under a positioned full-bleed hero picture.
const PREVIEW_CSS = `.pp-hero__placeholder{background:linear-gradient(135deg,#3a3a3a,#1c1c1c);min-height:100%}
.pp-video-note{position:absolute;z-index:2;top:1rem;right:1rem;padding:.35rem .7rem;border-radius:999px;background:rgba(0,0,0,.6);color:#fff;font:600 .8rem/1.2 var(--font-body)}
[data-block-id]{position:relative;cursor:pointer}
[data-block-id]::after{content:"";position:absolute;inset:0;z-index:5;pointer-events:none;border:2px dashed transparent}
[data-block-id]:hover::after{border-color:color-mix(in srgb,var(--accent) 60%,transparent)}
[data-block-id].pp-selected::after{border:3px solid var(--accent)}
.pp-header{position:relative}`;

const RADII = { none: '0px', sm: '4px', md: '10px', lg: '18px' };

function themeCss(ctx) {
  const p = palette(ctx.theme);
  const radius = RADII[ctx.theme.radius] || RADII.md;
  const btnRadius = ctx.theme.buttonStyle === 'pill' ? '999px' : radius;
  return `:root{--bg:${p.bg};--text:${p.text};--muted:${p.muted};--surface:${p.surface};--border:${p.border};--accent:${p.accent};--accent-fg:${p.accentFg};--link:${p.link};--dark-bg:${p.darkBg};--dark-text:${p.darkText};--dark-muted:${p.darkMuted};--dark-link:${p.darkLink};--radius:${radius};--btn-radius:${btnRadius};--font-body:${fontStack(ctx.fonts.body)};--font-heading:${fontStack(ctx.fonts.heading || ctx.fonts.body)}}`;
}

function pageHref(page) {
  return page.isHome ? '/' : `/${page.slug}`;
}

function navLinks(ctx) {
  const s = strings(ctx.locale);
  return ctx.document.pages.filter((p) => !p.hidden && p.inNav).map((p) => {
    const current = p.id === ctx.page.id ? ' aria-current="page"' : '';
    return `<li><a href="${esc(pageHref(p))}"${current}>${esc(p.navLabel || p.title || s.home)}</a></li>`;
  }).join('');
}

function renderHeader(ctx) {
  const { branding } = ctx;
  const s = strings(ctx.locale);
  const name = branding.companyName || 'PicPeak';
  const logo = branding.logoUrl ? `<img src="${esc(branding.logoUrl)}" alt="" height="40">` : '';
  const links = navLinks(ctx);
  const nav = links
    ? `<nav class="pp-nav" aria-label="Main"><ul>${links}</ul></nav><details class="pp-menu"><summary>${esc(s.menu)}</summary><nav aria-label="Main"><ul>${links}</ul></nav></details>`
    : '';
  return `<header class="pp-header"><div class="pp-wrap pp-header__in"><a class="pp-brand" href="/">${logo}<span>${esc(name)}</span></a>${nav}</div></header>`;
}

function renderFooter(ctx) {
  const { branding } = ctx;
  const s = strings(ctx.locale);
  const name = branding.companyName || 'PicPeak';
  const pages = ctx.document.pages.filter((p) => !p.hidden)
    .map((p) => `<li><a href="${esc(pageHref(p))}">${esc(p.navLabel || p.title)}</a></li>`).join('');
  const legal = (ctx.legalLinks || []).map((l) => `<li><a href="${esc(l.href)}">${esc(l.label)}</a></li>`);
  if (branding.supportEmail) legal.push(`<li><a href="mailto:${esc(branding.supportEmail)}">${esc(s.support)}</a></li>`);
  const year = (ctx.now || new Date()).getUTCFullYear();
  return `<footer class="pp-footer"><div class="pp-wrap pp-footer__in"><div><strong>${esc(name)}</strong>${branding.companyTagline ? `<p>${esc(branding.companyTagline)}</p>` : ''}${branding.footerText ? `<p>${esc(branding.footerText)}</p>` : ''}</div><nav aria-label="Pages"><ul>${pages}</ul></nav><ul>${legal.join('')}</ul><p class="pp-copy">© ${year} ${esc(name)}</p></div></footer>`;
}

function absolute(base, path) {
  return base ? `${base}${path}` : '';
}

function renderHead(ctx, body) {
  const { page, branding } = ctx;
  const siteName = branding.companyName || 'PicPeak';
  const title = page.seo.title || (page.isHome ? siteName : `${page.title} · ${siteName}`);
  const description = page.seo.description || branding.companyTagline || '';
  const canonical = absolute(ctx.baseUrl, pageHref(page));
  const tags = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
  ];
  if (description) tags.push(`<meta name="description" content="${esc(description)}">`);
  // A relative canonical is still a canonical; the Host header is never used
  // for it, because the page is cached and shared between requests.
  tags.push(`<link rel="canonical" href="${esc(canonical || pageHref(page))}">`);
  if (ctx.robots) tags.push(`<meta name="robots" content="${esc(ctx.robots)}">`);
  tags.push(`<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:site_name" content="${esc(siteName)}">`);
  if (description) tags.push(`<meta property="og:description" content="${esc(description)}">`);
  if (canonical) tags.push(`<meta property="og:url" content="${esc(canonical)}">`);
  const ogImage = resolveImage(page.seo.image, ctx) || ctx.firstImage;
  if (ogImage && ctx.baseUrl) {
    tags.push(`<meta property="og:image" content="${esc(absolute(ctx.baseUrl, `${ogImage.base}/1280`))}"><meta name="twitter:card" content="summary_large_image">`);
  }
  if (ctx.heroPreload) {
    tags.push(`<link rel="preload" as="image" imagesrcset="${esc(srcsetFor(ctx.heroPreload.image))}" imagesizes="${esc(ctx.heroPreload.sizes)}" fetchpriority="high">`);
  }
  // The --brand-* variables of the single-page site come first: a landing
  // page imported as custom HTML, and its CSS, still read them.
  const css = [fontFaces(ctx.fonts), brandCssVariables(ctx.branding.colors || {}), themeCss(ctx), BASE_CSS,
    ctx.preview ? PREVIEW_CSS : '', ctx.customCss || ''].join('\n');
  return `<!DOCTYPE html>
<html lang="${esc(ctx.locale === 'de' ? 'de' : 'en')}">
<head>
${tags.join('\n')}
<style>${escapeCssForStyleElement(css)}</style>
</head>
<body class="${ctx.theme.buttonStyle === 'outline' ? 'pp-btn-outline' : ''}">
${body}
</body>
</html>`;
}

/**
 * Render one page of the document. `ctx`:
 *   document, page, preview, locale, branding, theme (resolved palette),
 *   fonts { body, heading }, photos, assets, events, covers, packages,
 *   booking { enabled, url }, legalLinks, baseUrl, robots, customCss,
 *   sanitizeCustomHtml(html) -> html
 */
function renderPage(input) {
  const ctx = { ...input };
  const firstHero = ctx.page.blocks.find((b) => b.type === 'hero');
  ctx.firstHeroId = ctx.page.blocks[0] && ctx.page.blocks[0].type === 'hero' ? ctx.page.blocks[0].id : null;
  if (ctx.firstHeroId && !(firstHero.video && ctx.assets.get(firstHero.video.id))) {
    const image = resolveImage(firstHero.image, ctx);
    if (image) ctx.heroPreload = { image, sizes: firstHero.variant === 'split' ? '(min-width: 900px) 50vw, 100vw' : '100vw' };
  }
  // The first image on the page stands in for a missing OG image.
  for (const block of ctx.page.blocks) {
    const ref = block.image || (block.images && block.images[0]);
    const image = resolveImage(ref, ctx);
    if (image) { ctx.firstImage = image; break; }
  }
  const blocks = ctx.page.blocks.map((block) => RENDERERS[block.type](block, ctx)).join('\n');
  const body = `<a class="pp-skip" href="#main">Skip to content</a>
${renderHeader(ctx)}
<main id="main">
${blocks}
</main>
${renderFooter(ctx)}`;
  return renderHead(ctx, body);
}

module.exports = {
  renderPage,
  richText,
  inline,
  srcsetFor,
  pageHref,
  _internal: { palette, fontFaces, resolveImage },
};
