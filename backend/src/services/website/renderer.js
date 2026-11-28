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
const { inline, richText, linkAttrs, isEmptyRichText } = require('./richText');
const { icon, NETWORK_LABELS } = require('./icons');
const { widgetHtml } = require('./captcha');
const { brandCssVariables } = require('../../utils/brandCssVariables');
const { MEDIA_WIDTHS, mediaBase, editorBase, parseRenditionKeys, photoVersion } = require('./media');

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
    bookingHidden: 'Hidden on the website: client booking is off or nothing can be booked yet.',
    captchaFailed: 'The spam check did not go through. Please complete it and send the message again.',
    secondContactForm: 'Only one contact form per page is shown. Remove this one, or move it to another page.',
    reloadForm: 'This form was just updated. Please reload the page and send your message again.',
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
    bookingHidden: 'Auf der Website ausgeblendet: Die Online-Buchung ist aus oder es ist noch nichts buchbar.',
    captchaFailed: 'Die Spam-Prüfung hat nicht geklappt. Bitte schliessen Sie sie ab und senden Sie die Nachricht erneut.',
    secondContactForm: 'Pro Seite wird nur ein Kontaktformular gezeigt. Entfernen Sie dieses oder verschieben Sie es auf eine andere Seite.',
    reloadForm: 'Dieses Formular wurde soeben aktualisiert. Bitte laden Sie die Seite neu und senden Sie Ihre Nachricht erneut.',
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

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Where a photo or upload is served from: the public URL on the website,
 * the short-lived editor URL in the preview (a draft's picks have no public
 * URL until they are published).
 */
function urlBase(ref, ctx, version) {
  return ctx.preview ? editorBase(ref) : mediaBase(ref, version);
}

/**
 * Resolve an image reference against what the data layer found eligible.
 * Returns { base, width, height, tiers } or null (not eligible / unknown).
 * Call it only for an image the page then shows: every image resolved is
 * recorded in ctx.resolved, in page order, and that list is what the page
 * shows (renderedImages, the published set of public photo URLs).
 */
function resolveImage(ref, ctx) {
  const image = lookUpImage(ref, ctx);
  if (image) ctx.resolved.push({ ref, image });
  return image;
}

function lookUpImage(ref, ctx) {
  if (!ref) return null;
  if (ref.source === 'photo') {
    const photo = ctx.photos.get(ref.id);
    if (!photo) return null;
    return { base: urlBase(ref, ctx, photoVersion(photo)), width: Number(photo.width) || null, height: Number(photo.height) || null, tiers: MEDIA_WIDTHS };
  }
  const asset = ctx.assets.get(ref.id);
  if (!asset || asset.kind !== 'image') return null;
  const keys = parseRenditionKeys(asset);
  const tiers = MEDIA_WIDTHS.filter((w) => keys[w]);
  if (!tiers.length) return null;
  return { base: urlBase(ref, ctx), width: Number(asset.width) || null, height: Number(asset.height) || null, tiers };
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

// A block's heading: an h2, or the page's h1 when no hero carries it. The
// first heading that is rendered takes it (renderPage sets ctx.needsH1), so
// a block that is not shown never does.
function blockHeading(block, ctx, text = block.heading) {
  if (!text) return '';
  const level = ctx.needsH1 ? 1 : 2;
  ctx.needsH1 = false;
  return heading(text, level);
}

/**
 * A custom background's colours as section variables: the text colour set
 * for the block, or the page's text colour when it reads on the background,
 * else a neutral that does (the same rule as the dark sections).
 */
function customBackgroundStyle(block, ctx) {
  const p = palette(ctx.theme);
  const bg = block.backgroundColor;
  const text = block.textColor || readableTextOn(bg, p.text);
  return [
    `--bg:${bg}`, `--text:${text}`, `--muted:${readableTextOn(bg, p.muted, 3)}`, `--link:${readableTextOn(bg, p.accent, 3)}`,
    `--border:color-mix(in srgb,${text} 18%,transparent)`, `--surface:color-mix(in srgb,${text} 6%,${bg})`,
  ].join(';');
}

function section(block, inner, ctx, extraClass = '') {
  const custom = block.background === 'custom' && block.backgroundColor;
  let bg = block.background === 'default' ? '' : ` pp-${block.background}`;
  if (custom) bg = ' pp-custom-bg';
  // Hex colours only (document.js): safe inside the attribute.
  const style = custom ? ` style="${customBackgroundStyle(block, ctx)}"` : '';
  const previewAttr = ctx.preview ? ` data-block-id="${esc(block.id)}"` : '';
  return `<section id="b-${esc(block.id)}" class="pp-block pp-${esc(block.type)} pp-v-${esc(block.variant)}${bg}${extraClass ? ` ${extraClass}` : ''}"${style}${previewAttr}>${inner}</section>`;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * The layout a hero is shown in: its variant, except an overlay hero with no
 * picture or video available (gone, or its gallery left the website), which
 * is shown text only. The menu's "transparent over the hero" asks the same.
 */
function heroLayout(block, ctx) {
  if (block.variant !== 'overlay') return block.variant;
  const video = block.video ? ctx.assets.get(block.video.id) : null;
  return (video && video.kind === 'video') || lookUpImage(block.image, ctx) ? 'overlay' : 'minimal';
}

function renderHero(block, ctx) {
  // A minimal hero shows no picture: its image is not resolved at all.
  const image = block.variant === 'minimal' ? null : resolveImage(block.image, ctx);
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
    media.push(`<video class="pp-hero__media" autoplay muted loop playsinline preload="metadata"${poster}><source src="${esc(urlBase(block.video, ctx))}/video" type="${esc(video.mime_type || 'video/mp4')}"></video>`);
  } else if (image) {
    const sizes = block.variant === 'split' ? '(min-width: 900px) 50vw, 100vw' : '100vw';
    media.push(imgTag(image, { alt: block.image.alt, eager: isFirst, className: 'pp-hero__media', sizes }));
    // The page's first hero picture is preloaded (renderHead).
    if (isFirst) ctx.heroPreload = { image, sizes };
  }
  const text = `<div class="pp-hero__text">${block.heading ? `<h1 class="pp-h pp-display">${esc(block.heading)}</h1>` : ''}${block.subheading ? `<p class="pp-lead">${inline(block.subheading)}</p>` : ''}${button(block.buttonLabel, targetHref(block.buttonTarget, ctx))}</div>`;
  if (block.variant === 'split') {
    return section(block, `<div class="pp-wrap pp-split">${text}${media.length ? `<div class="pp-hero__frame">${media.join('')}</div>` : ''}</div>`, ctx);
  }
  if (heroLayout(block, ctx) === 'minimal') {
    // An overlay hero without a picture falls back to the minimal layout.
    return section({ ...block, variant: 'minimal' }, `<div class="pp-wrap pp-narrow pp-center">${text}</div>`, ctx);
  }
  return section(block, `${media.join('')}<div class="pp-hero__shade"></div><div class="pp-wrap pp-hero__over">${text}</div>`, ctx);
}

// The body is the sanitised HTML document.js stores. Two columns: one text
// flowing over both (as before), or, once the right one is filled, each its own.
function renderText(block, ctx) {
  const center = block.variant === 'center' ? ' pp-center' : '';
  const body = block.variant === 'columns' && !isEmptyRichText(block.bodyRight)
    ? `<div class="pp-two-cols"><div class="pp-prose">${block.body}</div><div class="pp-prose">${block.bodyRight}</div></div>`
    : `<div class="pp-prose${block.variant === 'columns' ? ' pp-columns' : ''}">${block.body}</div>`;
  return section(block, `<div class="pp-wrap pp-narrow${center}">${blockHeading(block, ctx)}${body}</div>`, ctx);
}

function renderImageText(block, ctx) {
  const image = resolveImage(block.image, ctx);
  const figure = image
    ? `<div class="pp-frame" style="aspect-ratio:${aspect(image)}">${imgTag(image, { alt: block.image.alt, sizes: '(min-width: 900px) 50vw, 100vw' })}</div>`
    : '';
  const text = `<div>${blockHeading(block, ctx)}<div class="pp-prose">${block.body}</div>${button(block.buttonLabel, targetHref(block.buttonTarget, ctx))}</div>`;
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
  return section(block, `<div class="pp-wrap">${blockHeading(block, ctx)}<div class="pp-grid pp-cols-${block.columns}${block.variant === 'masonry' ? ' pp-masonry' : ''}">${tiles}</div></div>`, ctx);
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
  return section(block, `<div class="pp-wrap">${blockHeading(block, ctx)}${block.intro ? `<div class="pp-prose pp-intro">${richText(block.intro)}</div>` : ''}<div class="pp-cards${list}">${cards}</div></div>`, ctx);
}

function renderTestimonials(block, ctx) {
  // A draft keeps an unfinished testimonial; the page shows only quoted ones.
  const items = block.items.filter((item) => item.quote).map((item) => {
    const image = resolveImage(item.image, ctx);
    const avatar = image ? `<span class="pp-avatar">${imgTag(image, { alt: item.author, sizes: '64px' })}</span>` : '';
    return `<figure class="pp-quote"><blockquote>${richText(item.quote)}</blockquote><figcaption>${avatar}<span><strong>${esc(item.author)}</strong>${item.role ? `<span class="pp-muted">${esc(item.role)}</span>` : ''}</span></figcaption></figure>`;
  }).join('');
  if (!items && !ctx.preview) return '';
  return section(block, `<div class="pp-wrap${block.variant === 'quote' ? ' pp-narrow' : ''}">${blockHeading(block, ctx)}<div class="pp-quotes">${items}</div></div>`, ctx);
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
    return `<div class="pp-plan"><h3 class="pp-h">${esc(pkg.name)}</h3>${price}${pkg.description ? `<p>${esc(pkg.description)}</p>` : ''}${items}${button(block.buttonLabel, targetHref(block.buttonTarget, ctx), { secondary: true })}</div>`;
  }).join('');
  if (!cards && !ctx.preview) return '';
  return section(block, `<div class="pp-wrap">${blockHeading(block, ctx)}${block.intro ? `<div class="pp-prose pp-intro">${richText(block.intro)}</div>` : ''}<div class="pp-plans${block.variant === 'list' ? ' pp-plans--list' : ''}">${cards}</div></div>`, ctx);
}

function renderContact(block, ctx) {
  const s = strings(ctx.locale);
  // One form a page (document.js); a page stored with more shows the first.
  if (ctx.page.blocks.find((b) => b.type === 'contact') !== block) {
    return ctx.preview ? section(block, `<div class="pp-wrap pp-narrow"><p class="pp-preview-hint">${esc(s.secondContactForm)}</p></div>`, ctx) : '';
  }
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
${ctx.captcha ? widgetHtml(ctx.captcha, { locale: ctx.locale, esc }) : ''}
<button class="pp-btn" type="submit"${disabled}>${esc(block.submitLabel || s.send)}</button>
${ctx.preview ? `<p class="pp-muted">${esc(s.previewForm)}</p>` : ''}</form>`;
  const notes = `<p id="contact-sent-${esc(block.id)}" class="pp-note pp-note--ok" role="status">${esc(block.successMessage || s.sent)}</p><p id="contact-error-${esc(block.id)}" class="pp-note pp-note--err" role="alert">${esc(s.failed)}</p>`
    + (ctx.captcha ? `<p id="contact-captcha-${esc(block.id)}" class="pp-note pp-note--err" role="alert">${esc(s.captchaFailed)}</p>` : '')
    // On every form: a page cached before the spam check came on posts
    // without its answer, and the visitor is asked to reload (publicWebsite.js).
    + `<p id="contact-reload-${esc(block.id)}" class="pp-note pp-note--err" role="alert">${esc(s.reloadForm)}</p>`;
  const intro = `<div>${blockHeading(block, ctx)}${block.intro ? `<div class="pp-prose">${richText(block.intro)}</div>` : ''}</div>`;
  if (block.variant === 'split') {
    return section(block, `<div class="pp-wrap pp-split pp-split--top">${intro}<div>${notes}${form}</div></div>`, ctx);
  }
  return section(block, `<div class="pp-wrap pp-narrow">${intro}${notes}${form}</div>`, ctx);
}

function renderBooking(block, ctx) {
  const s = strings(ctx.locale);
  const enabled = !!(ctx.booking && ctx.booking.enabled);
  // Hidden on the live site while booking is off or nothing is bookable;
  // the preview shows the block as it would be, and why it is not.
  if (!enabled && !ctx.preview) return '';
  const url = enabled && block.serviceId && ctx.booking.serviceIds && ctx.booking.serviceIds.has(block.serviceId)
    ? `${ctx.booking.url}?service=${block.serviceId}`
    : (enabled ? ctx.booking.url : '/book');
  const hint = enabled ? '' : `<p class="pp-preview-hint">${esc(s.bookingHidden)}</p>`;
  const inner = `<div class="pp-wrap pp-narrow pp-center">${blockHeading(block, ctx)}${block.text ? `<div class="pp-prose">${richText(block.text)}</div>` : ''}${button(block.buttonLabel || s.book, url)}${hint}</div>`;
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
  return section(block, `<div class="pp-wrap"><div class="pp-insta-head">${blockHeading(block, ctx, title)}${profile}</div><div class="${block.variant === 'grid' ? 'pp-grid pp-cols-3' : 'pp-strip'}">${tiles}</div></div>`, ctx);
}

/**
 * The address a link target (document.js linkTarget) leads to on this
 * site, or null when it leads nowhere: a hidden or removed page, a block
 * no longer on its page, the booking page while booking is off.
 */
function targetHref(target, ctx) {
  if (!target) return null;
  const page = (id) => ctx.document.pages.find((p) => p.id === id && !p.hidden);
  switch (target.kind) {
  case 'page': {
    const p = page(target.pageId);
    return p ? pageHref(p) : null;
  }
  case 'anchor': {
    const p = page(target.pageId);
    if (!p || !p.blocks.some((b) => b.id === target.blockId)) return null;
    return `${p.id === ctx.page.id ? '' : pageHref(p)}#b-${target.blockId}`;
  }
  case 'booking':
    return ctx.booking && ctx.booking.enabled ? ctx.booking.url : null;
  case 'legal':
    // Its own address, or the external one the CMS page leads to.
    return ctx.legalPages?.[target.slug]?.href || `/${target.slug}`;
  case 'url':
    return target.url;
  default:
    return null;
  }
}

function renderFaq(block, ctx) {
  // A draft keeps an unfinished question; the page shows only asked ones.
  const items = block.items.filter((item) => item.question).map((item) => (
    `<details class="pp-faq__item"><summary>${esc(item.question)}</summary><div class="pp-prose">${item.answer}</div></details>`
  )).join('');
  if (!items && !ctx.preview) return '';
  return section(block, `<div class="pp-wrap pp-narrow">${blockHeading(block, ctx)}<div class="pp-faq__list">${items}</div></div>`, ctx);
}

function renderSteps(block, ctx) {
  const items = block.items.filter((item) => item.title || item.text);
  if (!items.length && !ctx.preview) return '';
  const steps = items.map((item, index) => {
    const mark = (block.variant === 'icons' && icon(item.icon, 26)) || String(index + 1);
    return `<li class="pp-step"><span class="pp-step__mark" aria-hidden="true">${mark}</span>${heading(item.title, 3)}${item.text ? `<p>${inline(item.text)}</p>` : ''}</li>`;
  }).join('');
  return section(block, `<div class="pp-wrap">${blockHeading(block, ctx)}<ol class="pp-steps__list" style="--steps:${items.length}">${steps}</ol></div>`, ctx);
}

function renderCta(block, ctx) {
  const buttons = block.buttons
    .map((b, index) => button(b.label, targetHref(b.target, ctx), { secondary: index > 0 }))
    .filter(Boolean).join('');
  if (!block.heading && !block.text && !buttons && !ctx.preview) return '';
  const text = `<div>${blockHeading(block, ctx)}${block.text ? `<div class="pp-prose">${block.text}</div>` : ''}</div>`;
  const actions = buttons ? `<div class="pp-actions">${buttons}</div>` : '';
  return section(block, `<div class="pp-wrap pp-cta__in${block.variant === 'split' ? ' pp-cta__in--split' : ''}">${text}${actions}</div>`, ctx);
}

function renderLogos(block, ctx) {
  const items = block.items.map((item) => {
    const image = resolveImage(item.image, ctx);
    if (!image) return '';
    const img = imgTag(image, { alt: item.image.alt, sizes: '160px' });
    return item.url ? `<a class="pp-logo" href="${esc(item.url)}"${linkAttrs(item.url)}>${img}</a>` : `<span class="pp-logo">${img}</span>`;
  }).join('');
  if (!items && !ctx.preview) return '';
  const cls = `pp-logos__row pp-logos__row--${block.variant}${block.grayscale ? ' pp-logos__row--gray' : ''}`;
  return section(block, `<div class="pp-wrap">${blockHeading(block, ctx)}<div class="${cls}">${items}</div></div>`, ctx);
}

/** Links to social profiles as icons (also the footer's social column). */
function socialLinks(links, { labels = false } = {}) {
  return links.filter((link) => link.url).map((link) => {
    const name = NETWORK_LABELS[link.network];
    const label = labels ? `<span>${esc(name)}</span>` : '';
    return `<a class="pp-social__link" href="${esc(link.url)}"${linkAttrs(link.url)}${labels ? '' : ` aria-label="${esc(name)}"`}>${icon(link.network, 22)}${label}</a>`;
  }).join('');
}

function renderSocial(block, ctx) {
  const links = socialLinks(block.links, { labels: block.variant === 'buttons' });
  if (!links && !ctx.preview) return '';
  return section(block, `<div class="pp-wrap pp-center">${blockHeading(block, ctx)}<div class="pp-social__row pp-social__row--${block.variant}">${links}</div></div>`, ctx);
}

function renderDivider(block, ctx) {
  return section(block, '<div class="pp-wrap"><hr class="pp-line"></div>', ctx, `pp-divider--${block.width} pp-space-${block.spacing}`);
}

function renderSpacer(block, ctx) {
  return section(block, block.divider ? '<div class="pp-wrap"><hr class="pp-rule"></div>' : '', ctx);
}

// The imported single-page site keeps the containers the old page wrapped
// it in (server.js buildPublicSiteDocument), so its stylesheet, written
// against .site-shell and .site-main, applies unchanged. Divs, not <main>:
// the page has its own.
function renderCustomHtml(block, ctx) {
  const html = ctx.sanitizeCustomHtml(block.html);
  if (!html && !ctx.preview) return '';
  const inner = block.legacy ? `<div class="site-shell"><div class="site-main">${html}</div></div>` : html;
  return section(block, `<div class="pp-custom">${inner}</div>`, ctx);
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
  divider: renderDivider,
  faq: renderFaq,
  steps: renderSteps,
  cta: renderCta,
  logos: renderLogos,
  social: renderSocial,
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

// A font file's format as @font-face names it.
const CSS_FONT_FORMAT = { woff2: 'woff2', woff: 'woff', ttf: 'truetype' };

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
      const file = (font.formats && font.formats[weight]) || 'woff2';
      // The file's version: a replaced font gets a new address (fontsService).
      const version = font.versions && /^[a-z0-9]{1,40}$/.test(font.versions[weight] || '') ? `?v=${font.versions[weight]}` : '';
      faces.push(`@font-face{font-family:'${font.family}';font-style:normal;font-weight:${weight};font-display:swap;src:url('/fonts/${encodeURIComponent(folder)}/${weight}.${file}${version}') format('${CSS_FONT_FORMAT[file]}')}`);
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
body{margin:0;background:var(--bg);color:var(--text);font:400 1.0625rem/1.65 var(--font-body);-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;flex-direction:column}
body>main{flex:1 0 auto}
img,video{display:block;max-width:100%}
a{color:var(--link)}
.pp-h{font-family:var(--font-heading);font-weight:600;line-height:1.15;letter-spacing:-.01em;margin:0 0 .6em;color:var(--text)}
h1.pp-h:not(.pp-display),h2.pp-h{font-size:clamp(1.6rem,1.2rem + 1.6vw,2.4rem)}
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
.pp-two-cols{display:grid;gap:1.5rem 3rem}@media (min-width:720px){.pp-two-cols{grid-template-columns:1fr 1fr}}
.pp-prose h2,.pp-prose h3{font-family:var(--font-heading);font-weight:600;line-height:1.2;margin:1.2em 0 .5em;color:var(--text)}.pp-prose h2{font-size:1.6rem}.pp-prose h3{font-size:1.25rem}.pp-prose>:first-child{margin-top:0}
.pp-prose ul,.pp-prose ol{margin:0 0 1em;padding-left:1.4em}.pp-prose blockquote{margin:0 0 1em;padding-left:1em;border-left:3px solid var(--border);color:var(--muted)}
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
.pp-header--static{position:relative}
.pp-header.pp-header--over{position:absolute;left:0;right:0;background:linear-gradient(rgba(0,0,0,.45),transparent);backdrop-filter:none;border-bottom-color:transparent;--text:#fff}.pp-header--over .pp-nav a,.pp-header--over .pp-brand{text-shadow:0 1px 3px rgba(0,0,0,.4)}
.pp-header--over .pp-menu summary{border-color:rgba(255,255,255,.5)}.pp-header--over .pp-menu ul{--text:var(--page-text)}
@media (min-width:761px){.pp-header--center .pp-header__in{flex-direction:column;justify-content:center;gap:.6rem;padding:1rem 0}}
.pp-nav--underline .pp-nav a{padding:.3rem 0;border-bottom:2px solid transparent}.pp-nav--underline .pp-nav a:hover,.pp-nav--underline .pp-nav a[aria-current]{border-bottom-color:currentColor}
.pp-nav--pill .pp-nav ul{gap:.4rem}.pp-nav--pill .pp-nav a{padding:.45rem .95rem;border-radius:999px}.pp-nav--pill .pp-nav a:hover{background:color-mix(in srgb,var(--text) 8%,transparent)}.pp-nav--pill .pp-nav a[aria-current]{background:var(--accent);color:var(--accent-fg)}
.pp-menu--panel{position:static}.pp-menu--panel ul{left:0;right:0;top:100%;min-width:0;border-radius:0;border-width:1px 0;box-shadow:none;padding:.5rem 1.25rem 1rem}
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
.pp-divider.pp-space-none{padding:0}.pp-divider.pp-space-small{padding:1.5rem 0}.pp-divider.pp-space-medium{padding:3rem 0}.pp-divider.pp-space-large{padding:6rem 0}
.pp-line{border:0;border-top:1px solid var(--border);margin:0}.pp-v-medium .pp-line{border-top-width:3px}
.pp-divider--short .pp-line{width:min(160px,40%);margin:0 auto}
.pp-spacer.pp-v-small{padding:1.5rem 0}.pp-spacer.pp-v-medium{padding:3rem 0}.pp-spacer.pp-v-large{padding:6rem 0}
.pp-rule{border:0;border-top:1px solid var(--border);margin:0}
.pp-customHtml{padding:0}
.pp-system .pp-prose h1,.pp-system .pp-prose h4,.pp-system .pp-prose h5,.pp-system .pp-prose h6{font-family:var(--font-heading);line-height:1.2}
.pp-faq__list{display:grid;gap:.6rem}
.pp-faq__item{border-bottom:1px solid var(--border);padding:.2rem 0}
.pp-v-boxed .pp-faq__item{border:1px solid var(--border);border-radius:calc(var(--radius) / 2);background:var(--surface);padding:.2rem 1.1rem}
.pp-faq__item summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;gap:1rem;padding:.9rem 0;font-weight:600;font-size:1.05rem}
.pp-faq__item summary::-webkit-details-marker{display:none}
.pp-faq__item summary::after{content:"+";flex:none;font-weight:400;font-size:1.4rem;line-height:1;color:var(--link)}
.pp-faq__item[open] summary::after{content:"\u2212"}
.pp-faq__item .pp-prose{padding:0 0 1rem;color:var(--muted)}
.pp-steps__list{list-style:none;margin:0;padding:0;display:grid;gap:2rem}
@media (min-width:860px){.pp-steps__list{grid-template-columns:repeat(min(var(--steps),4),1fr)}}
.pp-step{position:relative}
.pp-step .pp-h{font-size:1.2rem;margin:.9rem 0 .4rem}
.pp-step p{margin:0;color:var(--muted)}
.pp-step__mark{display:inline-flex;align-items:center;justify-content:center;width:3rem;height:3rem;border-radius:50%;border:2px solid var(--accent);color:var(--link);font:600 1.2rem/1 var(--font-heading)}
.pp-cta__in{display:grid;gap:1.5rem;justify-items:center;text-align:center;max-width:760px}
.pp-cta__in .pp-h{margin-bottom:.5rem}
.pp-cta__in--split{max-width:none;text-align:left;justify-items:start}
@media (min-width:860px){.pp-cta__in--split{grid-template-columns:1fr auto;align-items:center}}
.pp-actions{display:flex;flex-wrap:wrap;gap:.8rem;justify-content:center}.pp-cta__in--split .pp-actions{justify-content:flex-start}
.pp-logos__row{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:1.5rem 3rem}
.pp-logos__row--grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));justify-items:center}
.pp-logo{display:block}.pp-logo img{display:block;max-height:56px;max-width:160px;width:auto;height:auto;object-fit:contain}
.pp-logos__row--gray .pp-logo img{filter:grayscale(1);opacity:.7;transition:filter .2s,opacity .2s}.pp-logos__row--gray a.pp-logo:hover img,.pp-logos__row--gray a.pp-logo:focus-visible img{filter:none;opacity:1}
.pp-social__row{display:flex;flex-wrap:wrap;justify-content:center;gap:.8rem}
.pp-social__link{display:inline-flex;align-items:center;gap:.5rem;min-width:44px;min-height:44px;justify-content:center;color:var(--text);text-decoration:none;border-radius:999px}
.pp-social__row--icons .pp-social__link{border:1px solid var(--border)}
.pp-social__row--buttons .pp-social__link{padding:.55rem 1.1rem;border:1px solid var(--border);font-weight:600}
.pp-social__link:hover{color:var(--link);border-color:currentColor}
.pp-footer{background:var(--surface);border-top:1px solid var(--border);padding:3.5rem 0 2rem;font-size:.95rem}
.pp-footer__in{display:grid;gap:2rem}
@media (min-width:760px){.pp-footer__in{grid-template-columns:2fr 1fr 1fr}}
.pp-footer a{color:var(--text);text-decoration:none}
.pp-footer li{margin:0 0 .5rem}
.pp-footer p{margin:.4rem 0 0;color:var(--muted)}
.pp-copy{grid-column:1/-1;border-top:1px solid var(--border);padding-top:1.5rem;font-size:.85rem}
@media (min-width:760px){.pp-footer__in--n1{grid-template-columns:1fr}.pp-footer__in--n2{grid-template-columns:2fr 1fr}.pp-footer__in--n4{grid-template-columns:2fr 1fr 1fr 1fr}.pp-footer__in--n5{grid-template-columns:2fr 1fr 1fr 1fr 1fr}}
.pp-footer{color:var(--text)}.pp-footer__h{font:600 .8rem/1.3 var(--font-body);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 .8rem}
.pp-footer__contact{font-style:normal}.pp-footer__contact p{margin:0 0 .4rem;color:var(--text)}
.pp-footer__social{justify-content:flex-start}
.pp-copy--legal{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.5rem 1.5rem}.pp-copy--legal ul{display:flex;flex-wrap:wrap;gap:.4rem 1.2rem}.pp-copy--legal li{margin:0}
.pp-skip{position:absolute;left:-10000px}.pp-skip:focus{left:1rem;top:1rem;z-index:20;background:var(--surface);padding:.6rem 1rem}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}`;

// The marker is a pseudo-element above the section's children: an outline
// would be painted under a positioned full-bleed hero picture.
const PREVIEW_CSS = `.pp-hero__placeholder{background:linear-gradient(135deg,#3a3a3a,#1c1c1c);min-height:100%}
.pp-video-note{position:absolute;z-index:2;top:1rem;right:1rem;padding:.35rem .7rem;border-radius:999px;background:rgba(0,0,0,.6);color:#fff;font:600 .8rem/1.2 var(--font-body)}
.pp-preview-hint{margin:1rem auto 0;max-width:34rem;padding:.5rem .8rem;border-radius:.5rem;background:rgba(0,0,0,.06);color:var(--muted);font-size:.9rem}
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
  return `:root{--bg:${p.bg};--text:${p.text};--page-text:${p.text};--muted:${p.muted};--surface:${p.surface};--border:${p.border};--accent:${p.accent};--accent-fg:${p.accentFg};--link:${p.link};--dark-bg:${p.darkBg};--dark-text:${p.darkText};--dark-muted:${p.darkMuted};--dark-link:${p.darkLink};--radius:${radius};--btn-radius:${btnRadius};--font-body:${fontStack(ctx.fonts.body)};--font-heading:${fontStack(ctx.fonts.heading || ctx.fonts.body)}}`;
}

function pageHref(page) {
  return page.isHome ? '/' : `/${page.slug}`;
}

// A menu item's label: its own, else its page's menu label or title, else
// the legal page's name; an item to an address or a block needs its own.
function menuLabel(item, ctx) {
  if (item.label) return item.label;
  const s = strings(ctx.locale);
  if (item.target.kind === 'page') {
    const page = ctx.document.pages.find((p) => p.id === item.target.pageId);
    return page ? (page.navLabel || page.title || s.home) : '';
  }
  // By slug, whether or not the footer shows the page.
  if (item.target.kind === 'legal') return ctx.legalPages?.[item.target.slug]?.label || '';
  if (item.target.kind === 'booking') return s.book;
  return '';
}

function navLinks(ctx) {
  return ctx.document.menu.items.filter((item) => !item.hidden).map((item) => {
    const href = targetHref(item.target, ctx);
    const label = href && menuLabel(item, ctx);
    if (!label) return '';
    const current = item.target.kind === 'page' && item.target.pageId === ctx.page.id ? ' aria-current="page"' : '';
    return `<li><a href="${esc(href)}"${linkAttrs(href)}${current}>${esc(label)}</a></li>`;
  }).join('');
}

function renderHeader(ctx) {
  const { branding } = ctx;
  const { menu } = ctx.document;
  const s = strings(ctx.locale);
  const name = branding.companyName || 'PicPeak';
  const logo = branding.logoUrl ? `<img src="${esc(branding.logoUrl)}" alt="" height="40">` : '';
  const links = navLinks(ctx);
  const nav = links
    ? `<nav class="pp-nav" aria-label="Main"><ul>${links}</ul></nav><details class="pp-menu${menu.mobile === 'panel' ? ' pp-menu--panel' : ''}"><summary>${esc(s.menu)}</summary><nav aria-label="Main"><ul>${links}</ul></nav></details>`
    : '';
  // Over the picture only on a page that starts with a hero shown with its
  // picture (heroLayout: one whose picture is gone is shown text only).
  const first = ctx.page.blocks[0];
  const over = menu.transparent && first && first.type === 'hero' && heroLayout(first, ctx) === 'overlay';
  const classes = ['pp-header'];
  if (menu.layout === 'center') classes.push('pp-header--center');
  if (over) classes.push('pp-header--over');
  else if (!menu.sticky) classes.push('pp-header--static');
  if (menu.style !== 'plain') classes.push(`pp-nav--${menu.style}`);
  // Hex colours only (document.js): safe inside the attribute.
  const vars = [menu.background && `--bg:${menu.background}`, menu.text && `--text:${menu.text}`].filter(Boolean).join(';');
  return `<header class="${classes.join(' ')}"${vars ? ` style="${vars}"` : ''}><div class="pp-wrap pp-header__in"><a class="pp-brand" href="/">${logo}<span>${esc(name)}</span></a>${nav}</div></header>`;
}

function footerColumn(column, ctx) {
  const { branding } = ctx;
  const h = column.heading ? `<h2 class="pp-footer__h">${esc(column.heading)}</h2>` : '';
  switch (column.kind) {
  case 'brand':
    return `<div>${h}<strong>${esc(branding.companyName || 'PicPeak')}</strong>${branding.companyTagline ? `<p>${esc(branding.companyTagline)}</p>` : ''}${branding.footerText ? `<p>${esc(branding.footerText)}</p>` : ''}</div>`;
  case 'pages': {
    const pages = ctx.document.pages.filter((p) => !p.hidden)
      .map((p) => `<li><a href="${esc(pageHref(p))}">${esc(p.navLabel || p.title)}</a></li>`).join('');
    return `<nav aria-label="Pages">${h}<ul>${pages}</ul></nav>`;
  }
  case 'links': {
    const links = column.links.map((link) => {
      const href = targetHref(link.target, ctx);
      const label = href && menuLabel(link, ctx);
      return label ? `<li><a href="${esc(href)}"${linkAttrs(href)}>${esc(label)}</a></li>` : '';
    }).join('');
    return `<nav aria-label="${esc(column.heading || 'Links')}">${h}<ul>${links}</ul></nav>`;
  }
  case 'text':
    return `<div>${h}${column.text ? `<div class="pp-prose">${column.text}</div>` : ''}</div>`;
  case 'contact': {
    const lines = [
      column.email && `<a href="mailto:${esc(column.email)}">${esc(column.email)}</a>`,
      column.phone && `<a href="${esc(`tel:${column.phone.replace(/\s+/g, '')}`)}">${esc(column.phone)}</a>`,
      column.address && esc(column.address).replace(/\n/g, '<br>'),
    ].filter(Boolean).map((line) => `<p>${line}</p>`).join('');
    return `<div>${h}<address class="pp-footer__contact">${lines}</address></div>`;
  }
  case 'social':
    return `<div>${h}<div class="pp-social__row pp-social__row--icons pp-footer__social">${socialLinks(column.social)}</div></div>`;
  default:
    return '';
  }
}

function renderFooter(ctx) {
  const { branding } = ctx;
  const { footer } = ctx.document;
  const s = strings(ctx.locale);
  const name = branding.companyName || 'PicPeak';
  const legal = (ctx.legalLinks || []).map((l) => `<li><a href="${esc(l.href)}">${esc(l.label)}</a></li>`);
  if (branding.supportEmail) legal.push(`<li><a href="mailto:${esc(branding.supportEmail)}">${esc(s.support)}</a></li>`);
  const year = String((ctx.now || new Date()).getUTCFullYear());
  const copyright = footer.copyright ? footer.copyright.replace(/\{year\}/g, year) : `© ${year} ${name}`;
  const columns = footer.columns.map((column) => footerColumn(column, ctx));
  if (footer.legal === 'column') columns.push(`<ul>${legal.join('')}</ul>`);
  const copy = footer.legal === 'bottom' && legal.length
    ? `<div class="pp-copy pp-copy--legal"><span>${esc(copyright)}</span><ul>${legal.join('')}</ul></div>`
    : `<p class="pp-copy">${esc(copyright)}</p>`;
  // Three columns is the footer as it always was; other counts have a class.
  const count = columns.length === 3 ? '' : ` pp-footer__in--n${columns.length}`;
  const custom = footer.background === 'custom' && footer.backgroundColor;
  const bg = custom ? ' pp-custom-bg' : (footer.background === 'dark' ? ' pp-dark' : '');
  const style = custom ? ` style="${customBackgroundStyle(footer, ctx)}"` : '';
  return `<footer class="pp-footer${bg}"${style}><div class="pp-wrap pp-footer__in${count}">${columns.join('')}${copy}</div></footer>`;
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
  if (!ctx.noCanonical) tags.push(`<link rel="canonical" href="${esc(canonical || pageHref(page))}">`);
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
 *   booking { enabled, url }, legalLinks (footer), legalPages (by slug), baseUrl, robots, customCss,
 *   sanitizeCustomHtml(html) -> html
 */
function renderPage(input) {
  const ctx = { ...input, resolved: input.resolved || [] };
  ctx.firstHeroId = ctx.page.blocks[0] && ctx.page.blocks[0].type === 'hero' ? ctx.page.blocks[0].id : null;
  // One h1 a page: a hero's headline, else the first block heading.
  ctx.needsH1 = !ctx.page.blocks.some((block) => block.type === 'hero' && block.heading);
  const blocks = ctx.page.blocks.map((block) => RENDERERS[block.type](block, ctx)).join('\n');
  // The first image the page shows stands in for a missing OG image.
  ctx.firstImage = ctx.resolved.length ? ctx.resolved[0].image : null;
  const body = `<a class="pp-skip" href="#main">Skip to content</a>
${renderHeader(ctx)}
<main id="main">
${blocks}
</main>
${renderFooter(ctx)}`;
  return renderHead(ctx, body);
}

/**
 * A CMS page (legal, not-found) in the website's design: the context of
 * renderPage with a page of no blocks, and `content`, CMS HTML already kept
 * to its allowlist (sanitizeCmsHtml).
 */
function renderSystemPage(input, { content, canonical = true }) {
  const ctx = { ...input, resolved: [], noCanonical: !canonical };
  const body = `<a class="pp-skip" href="#main">Skip to content</a>
${renderHeader(ctx)}
<main id="main">
<section class="pp-block pp-system"><div class="pp-wrap pp-narrow"><h1 class="pp-h">${esc(ctx.page.title)}</h1><div class="pp-prose">${content}</div></div></section>
</main>
${renderFooter(ctx)}`;
  return renderHead(ctx, body);
}

/** The images (photo and upload refs) a rendered page shows, in page order. */
function renderedImages(input) {
  const resolved = [];
  renderPage({ ...input, resolved });
  return resolved.map(({ ref }) => ref);
}

module.exports = {
  renderPage,
  renderSystemPage,
  renderedImages,
  richText,
  inline,
  srcsetFor,
  pageHref,
  _internal: { palette, fontFaces, resolveImage },
};
