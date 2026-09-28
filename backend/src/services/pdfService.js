/**
 * pdfService — render quote / invoice PDFs.
 *
 * Built on PDFKit + swissqrbill (the latter ships the SwissQRBill class
 * for the QR-bill payment slip + a `Table` helper for the line items).
 * Same engine renders both quotes and invoices — they differ only in
 * title, lead-in text, optional Rabatt column (quotes only) and the
 * QR-bill section (invoices only, when qr_format = 'swiss').
 *
 * Public API:
 *   renderQuoteToBuffer(context)    → Promise<Buffer>
 *   renderInvoiceToBuffer(context)  → Promise<Buffer>
 *
 * The caller (quoteService / invoiceService) hydrates the `context` from
 * the DB and passes everything in — keeping pdfService a pure renderer
 * makes both unit-tests and preview-from-form (no DB write) trivial.
 *
 * Money: every "*_minor" field is treated as INTEGER minor units
 * (cents/Rappen) and rendered via Intl.NumberFormat using the supplied
 * locale + currency.
 *
 * Layout reference: the user's existing Angebot / Rechnung templates
 * (issuer block top-right, customer block left, "Datum" line, title,
 * salutation + lead-in, line-item table, totals box right-aligned,
 * payment conditions block, IBAN block, footer).
 */

const PDFDocument = require('pdfkit');
const { SwissQRBill, Table } = require('swissqrbill/pdf');
const { t } = require('./pdf-i18n');
const { parsePromotionSnapshot } = require('../utils/lineItemTotals');
const { parseInlineMarkdown } = require('../utils/placeholders');
const pdfFonts = require('./pdf/fonts');
const { BUILT_IN: THEME_BUILT_IN, builtInTheme } = require('./pdf/theme');

// Page metrics in PDF points (1pt = 1/72in). A4 = 595.28 × 841.89.
// 1mm = 2.834645669pt.
const MM = 2.834645669;
const PAGE = {
  // A4 ISO 216 — portrait. Quote/invoice rendering is hard-wired to this
  // orientation (DIN 5008 address window only makes sense in portrait).
  // Landscape callers (tax report, future wide-table exports) read their
  // metrics from getPageMetrics('landscape') instead.
  width: 595.28,
  height: 841.89,
  marginTop: 40,
  marginBottom: 40,
  marginLeft: 40,
  marginRight: 40,
  contentWidth: 595.28 - 80, // 515.28
};

// A4 landscape — width and height swapped. Same 40pt margins on all
// sides, so contentWidth grows from 515pt to 762pt — enough horizontal
// room for the tax-report table's 9 columns without column squashing.
const PAGE_LANDSCAPE = {
  width: 841.89,
  height: 595.28,
  marginTop: 40,
  marginBottom: 40,
  marginLeft: 40,
  marginRight: 40,
  contentWidth: 841.89 - 80, // 761.89
};

/**
 * Page metrics for the requested orientation. Default 'portrait' keeps
 * every existing caller behaving identically. Used by createBaseDocument
 * and by any renderer that needs to size its content against the page.
 */
function getPageMetrics(orientation) {
  return orientation === 'landscape' ? PAGE_LANDSCAPE : PAGE;
}

/**
 * The page metrics of a letter drawn with `theme` (#1445 layout): its left,
 * right and bottom margins in mm, or PAGE's 40 pt where it sets none. The
 * top margin stays: the address window and the issuer block set it.
 */
function pageMetricsFor(theme) {
  const margins = theme && theme.layout && theme.layout.margins;
  if (!margins) return PAGE;
  const left = margins.left != null ? margins.left * MM : PAGE.marginLeft;
  const right = margins.right != null ? margins.right * MM : PAGE.marginRight;
  const bottom = margins.bottom != null ? margins.bottom * MM : PAGE.marginBottom;
  return Object.freeze({
    ...PAGE, marginLeft: left, marginRight: right, marginBottom: bottom, contentWidth: PAGE.width - left - right,
  });
}

/**
 * A contract's signature page is drawn with these metrics, never the
 * theme's: pdfStampService stamps signatures at CONTRACT_SIGNATURE_LAYOUT's
 * coordinates, which are derived from them.
 */
const SIGNATURE_PAGE = PAGE;

/** The metrics the document being drawn uses (set by its renderer). */
const pageOf = (doc) => (doc && doc._page) || PAGE;

/**
 * Running text in the theme's size and line height (#1445): the size, and
 * the PDFKit text options that give the line height. A theme without a line
 * height keeps PDFKit's natural one — no option at all, so the bytes of an
 * unchanged theme stay what they were.
 */
function bodyText(doc) {
  const theme = (doc && doc._theme) || {};
  const size = theme.bodySize || 10;
  // PDFKit's natural line is ~1.15 em; lineGap adds the rest.
  const options = theme.lineHeight ? { lineGap: Math.max(0, (theme.lineHeight - 1.15) * size) } : {};
  return { size, options };
}

/**
 * The letterhead column's scale: the sender's address and contact rows and the
 * document's meta rows, one step below the theme's body text. The letterhead
 * stays secondary to the letter without becoming a second scale of its own —
 * before #1546 the sender half was a hardcoded 8.5pt against the meta half's
 * hardcoded 10pt, and neither followed a theme that set a different body size.
 * The row leading is derived too, so a larger size can't crowd the rows.
 */
function letterheadText(doc) {
  const size = Math.max(7, bodyText(doc).size - 1);
  return { size, leading: Math.round(size * 1.35) };
}

const addressWindowOn = (doc) => !(doc && doc._theme && doc._theme.layout && doc._theme.layout.addressWindow === false);

/**
 * A logo the theme places at the left or the centre of the page top, above
 * the letter (#1445). With the address window on, it is kept above the
 * window. Returns the y below it, or null when the logo sits in the issuer
 * column (the built-in look) or there is none.
 */
function drawPageLogo(doc, issuer) {
  const logo = (doc && doc._theme && doc._theme.logo) || THEME_BUILT_IN.logo;
  if (!logo || logo.position === 'right') return null;
  const file = issuer.showLogo !== false && issuer.logoPath ? issuer.logoPath : null;
  if (!file) return null;
  const P = pageOf(doc);
  let height = Math.max(24, Math.min(200, Number(issuer.logoHeight) || 56));
  if (addressWindowOn(doc)) height = Math.min(height, ADDR_WINDOW.top - 8 - P.marginTop);
  const width = logo.position === 'center' ? P.contentWidth : 220;
  try {
    doc.image(file, P.marginLeft, P.marginTop, { fit: [width, height], align: logo.position === 'center' ? 'center' : 'left' });
  } catch (err) {
    require('../utils/logger').warn('PDFKit failed to embed logo image', { path: file, err: err.message });
    reportFinding(doc, { code: 'LOGO_MISSING', severity: 'warning' });
    return null;
  }
  return P.marginTop + height + 8;
}

// DIN 5008 Form B address window — the standard window position for
// envelopes commonly used in DACH (B5 / C5-6 / DL with window). The
// window's top-left corner sits 45mm from the top and 20mm from the
// left of the A4 sheet, 85mm × 45mm in size. Picking Form B (the
// "newer" form) over Form A means the document still fits envelopes
// printed by every German/Swiss/Austrian/Liechtenstein vendor.
//
// We render INSIDE the window:
//   - Return address line (small grey "Absender" reference)
//     positioned in the upper ~5mm of the window
//   - The actual recipient address starts ~17.7mm below the top of
//     the window (DIN 5008 says address-line 1 starts on row 4 of
//     the window, which is 5mm down + 12.7mm of line-rows)
const ADDR_WINDOW = {
  left:   20 * MM,        // 56.69pt
  top:    45 * MM,        // 127.56pt
  width:  85 * MM,        // 240.94pt
  height: 45 * MM,        // 127.56pt
  // Vertical offsets inside the window.
  returnLineY: 47 * MM,   // 133.23pt — tiny "Absender" reference line
  addressY:    52 * MM,   // 147.40pt — first line of recipient address
};

// Default to PDFKit's built-in Helvetica. These constants are STILL
// used by the rest of the renderer as logical font names; when the
// admin has uploaded a custom TTF (business_profile.pdf_font_ttf_path),
// renderDocument registers it under these same names so every existing
// `doc.font(doc._fonts ? doc._fonts.body : FONT_BODY)` / `doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD)` call automatically
// picks it up. If only one weight is available we register it for both
// — bold falls back gracefully to regular.
/**
 * The QR-bill's reserved area: the bottom 105 mm of the page — the 62 mm
 * receipt plus the 148 mm payment part, flush with the bottom edge. Nothing
 * of ours may be drawn inside it, so a page that carries the slip under its
 * content ends 105 mm early.
 */
const QR_BILL_BAND_HEIGHT = (105 / 25.4) * 72;

/**
 * Where the two things that normally live in the bottom margin go on a page
 * that carries the slip: the page number just above the band, the footer
 * above the number — the same order as on a page without one.
 */
const SLIP_BAND_NUMBER_GAP = 14;
const SLIP_BAND_FOOTER_GAP = SLIP_BAND_NUMBER_GAP + 8;

/** A line of air between the last content and the footer under it. */
const FOOTER_AIR = 6;

/**
 * The document's two smaller steps, derived from the theme's body size so the
 * whole document moves together when a theme sets a different one (#1546).
 * `small` is the fine print — the footer, the page number, the VAT note.
 */
const smallTextSize = (theme) => Math.max(6, ((theme && theme.bodySize) || 10) - 2);
const footerLineHeight = (theme) => Math.round(smallTextSize(theme) * 1.5);

const FONT_BODY = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const FONT_ITALIC = 'Helvetica-Oblique';

/**
 * A colour from the theme of the document being drawn (#1445). Renderers
 * put the resolved theme on `doc._theme`; without one, the built-in colours
 * apply — the values this file used to hard-code.
 */
function themeColor(doc, key) {
  const colors = (doc && doc._theme && doc._theme.colors) || THEME_BUILT_IN.colors;
  return colors[key] || THEME_BUILT_IN.colors[key];
}

/**
 * Layout constants for the contract signature page (the dedicated
 * final page of every contract PDF). Both renderContractToBuffer
 * AND pdfStampService read these — the unsigned render draws empty
 * boxes at these coordinates; the stamp service later overlays the
 * signature PNGs at the same coordinates with pdf-lib.
 *
 * Coordinates are PDFKit-style (top-left origin, y increases down).
 * pdfStampService converts to pdf-lib's bottom-left origin internally.
 *
 * Changing any value here means re-rendering all unsigned PDFs that
 * are still pending signature — or the stamps will land in the wrong
 * place. Leave alone unless redesigning the signature page entirely.
 */
const CONTRACT_SIGNATURE_LAYOUT = {
  // Title row at top of page.
  titleY: PAGE.marginTop,
  // Prompt text below title (small instruction line).
  promptY: PAGE.marginTop + 50,
  // Y of the "Customer" / "Contractor" labels above each box.
  paneLabelY: PAGE.marginTop + 100,
  // Y of the empty signature box itself.
  boxY: PAGE.marginTop + 114,
  // Each box is half the content width minus a 20pt gutter.
  boxWidth: (PAGE.contentWidth - 20) / 2,
  // Tall enough that a typical canvas signature reads cleanly.
  boxHeight: 80,
  // Two side-by-side panes — customer on the left, admin on the right.
  customerX: PAGE.marginLeft,
  adminX: PAGE.marginLeft + ((PAGE.contentWidth - 20) / 2) + 20,
};

// Signature slots (#1445): two to a row; a row is the label, the box and three
// caption lines (name, date and time, how it was signed) plus a gap. The first
// row is exactly the two legacy boxes above.
const SIGNATURE_ROW_HEIGHT = 160;
const MAX_SIGNATURE_SLOTS = 6;

/**
 * ISO 3166-1 alpha-2 → full country name, locale-aware. Falls back to
 * the bare code when not in the map (no need to maintain every nation
 * on earth — the user said de + en, with the issuer in LI/CH).
 *
 * Using `Intl.DisplayNames` would be neat but Node's built-in support
 * for German names is patchy across versions, so a small explicit
 * table is more reliable for the formats actually used.
 */
const COUNTRY_NAMES = {
  de: {
    LI: 'Liechtenstein', CH: 'Schweiz', AT: 'Österreich', DE: 'Deutschland',
    FR: 'Frankreich',    IT: 'Italien', ES: 'Spanien',    PT: 'Portugal',
    NL: 'Niederlande',   BE: 'Belgien', LU: 'Luxemburg',  GB: 'Vereinigtes Königreich',
    US: 'USA',           DK: 'Dänemark', SE: 'Schweden',  NO: 'Norwegen',
    FI: 'Finnland',      PL: 'Polen',   CZ: 'Tschechien', SK: 'Slowakei',
    HU: 'Ungarn',        IE: 'Irland',
  },
  en: {
    LI: 'Liechtenstein', CH: 'Switzerland', AT: 'Austria', DE: 'Germany',
    FR: 'France',        IT: 'Italy',       ES: 'Spain',   PT: 'Portugal',
    NL: 'Netherlands',   BE: 'Belgium',     LU: 'Luxembourg',
    GB: 'United Kingdom',US: 'United States',
    DK: 'Denmark',       SE: 'Sweden',      NO: 'Norway',
    FI: 'Finland',       PL: 'Poland',      CZ: 'Czechia', SK: 'Slovakia',
    HU: 'Hungary',       IE: 'Ireland',
  },
};

/**
 * Build the salutation line. When the customer record carries an
 * honorific (Herr / Frau / Mr. / Ms. / Dr.) AND a last name, we use
 * a personalised greeting; otherwise we fall back to the generic
 * locale-specific opening from the i18n dictionary.
 *
 * Recognised honorifics are matched loosely (lowercased + trimmed,
 * dot suffix stripped) so "Herr", "herr", "Mr.", "Mr" all hit. The
 * gendered forms only fire when we can pick a gender from the
 * honorific; ambiguous titles like "Dr." use the inclusive
 * "Sehr geehrte/r Dr. <last>," (German) or "Dear Dr. <last>,"
 * (English) variant.
 */
function personalSalutation(locale, salutation, lastName) {
  const honorific = (salutation || '').trim();
  const last = (lastName || '').trim();
  if (!honorific || !last) return null;
  const key = honorific.toLowerCase().replace(/\.+$/, '').trim();

  // gender from the honorific: 'm' / 'f' / null (ambiguous)
  let gender = null;
  if (['herr', 'mr', 'mister', 'monsieur', 'señor', 'senhor', 'meneer', 'sig', 'г-н', 'господин'].includes(key)) gender = 'm';
  if (['frau', 'mrs', 'ms', 'miss', 'madame', 'mademoiselle', 'señora', 'senhora', 'mevrouw', 'sig.ra', 'г-жа', 'госпожа'].includes(key)) gender = 'f';

  switch ((locale || 'de').toLowerCase()) {
  case 'de':
    if (gender === 'm') return `Sehr geehrter ${honorific} ${last},`;
    if (gender === 'f') return `Sehr geehrte ${honorific} ${last},`;
    return `Sehr geehrte/r ${honorific} ${last},`;
  case 'en':
    return `Dear ${honorific} ${last},`;
  case 'fr':
    if (gender === 'm') return `Cher ${honorific} ${last},`;
    if (gender === 'f') return `Chère ${honorific} ${last},`;
    return `Cher/Chère ${honorific} ${last},`;
  case 'nl':
    return `Geachte ${honorific} ${last},`;
  case 'pt':
    if (gender === 'm') return `Prezado ${honorific} ${last},`;
    if (gender === 'f') return `Prezada ${honorific} ${last},`;
    return `Prezado(a) ${honorific} ${last},`;
  case 'ru':
    return `Уважаемый(ая) ${honorific} ${last}!`;
  default:
    return `Dear ${honorific} ${last},`;
  }
}

function countryName(code, locale) {
  if (!code) return '';
  const upper = String(code).trim().toUpperCase().slice(0, 2);
  const dict = COUNTRY_NAMES[locale] || COUNTRY_NAMES.en;
  return dict[upper] || COUNTRY_NAMES.en[upper] || upper;
}

/**
 * Format a minor-unit BigInt-ish integer as a localised currency string.
 * Returns just the number portion ("750.00") not "CHF 750.00" — the
 * currency label is rendered separately in the totals box for layout
 * reasons (matches the reference PDFs).
 */
function formatMinor(minor, currency, locale = 'de-CH') {
  const value = Number(minor || 0) / 100;
  // We render only the number — currency renders as a separate column
  // to keep totals right-aligned cleanly.
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatCurrencyLabel(currency) {
  // Render the ISO code; matches the user's reference PDFs which show
  // "Gesamtbetrag CHF 750.00".
  return (currency || '').toUpperCase();
}

function formatDate(value, dateFormat) {
  if (!value) return '';
  const d = (value instanceof Date) ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  // Respect the `general_date_format` app setting (read once in the
  // service layer and passed through ctx.dateFormat). We build the
  // string by hand instead of going through Intl.DateTimeFormat so
  // a chosen "DD.MM.YYYY" actually renders with dots even when the
  // customer's preferred_language maps to a locale that prints
  // slashes (en-GB → 02/12/2025).
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  const format = (dateFormat && dateFormat.format) || 'DD.MM.YYYY';
  switch (format) {
  case 'MM/DD/YYYY': return `${mm}/${dd}/${yyyy}`;
  case 'DD/MM/YYYY': return `${dd}/${mm}/${yyyy}`;
  case 'YYYY-MM-DD': return `${yyyy}-${mm}-${dd}`;
  case 'DD.MM.YYYY':
  default:
    return `${dd}.${mm}.${yyyy}`;
  }
}

/**
 * Resolve the BCP-47 locale used for number / currency formatting.
 *
 * Strategy: the issuer's country code wins. CH/LI/DE/AT issuers all
 * get the Swiss-style apostrophe thousands separator (e.g. 1'000.00 —
 * what the local accountant + the bank expects on Stelleabrechnung /
 * Rechnung), regardless of the document language. Outside the DACH
 * region we fall through to the bare ISO 639 locale → BCP-47 mapping
 * so en-GB, pt-PT, etc. keep their conventional formatting.
 *
 * Per maintainer: "in FL, CH, DE we write 1'000.00 not 1,000.00".
 */
function localeForIntl(locale, issuerCountryCode) {
  const cc = (issuerCountryCode || '').toUpperCase();
  if (['CH', 'LI', 'DE', 'AT'].includes(cc)) {
    // de-CH is the only one of these that uses the apostrophe
    // separator in Intl.NumberFormat. fr-CH would render 1 000.00
    // (NBSP) which Swiss accountants don't want either.
    return 'de-CH';
  }
  const map = { de: 'de-CH', en: 'en-GB', fr: 'fr-CH', nl: 'nl-NL', pt: 'pt-PT', ru: 'ru-RU' };
  return map[locale] || locale || 'en-GB';
}

/**
 * Render the issuer block (top-right): logo + company name as
 * a side-by-side banner, then the address block, then a tidy
 * label/value contact column. Matches the reference letterhead.
 *
 * Layout decisions:
 *   - Top banner: logo on the LEFT of the column with the company
 *     name vertically centred to the RIGHT of it (mirrors the
 *     "LUCA BRESCH MEDIA" branding screenshot). Either piece can be
 *     suppressed via issuer.showLogo / issuer.showCompanyName.
 *   - Address: line1 → "postal city" → CountryName, left-aligned
 *     within the right-side column.
 *   - Contact rows use two columns: "Phone:" labels at left,
 *     values aligned underneath each other. Looks like a small
 *     invisible table.
 */
/**
 * The sender's contact rows, without their colons. Shared with the caller that
 * measures the letterhead grid, so the rows that are measured are exactly the
 * rows that get drawn.
 */
function issuerContactRows(issuer, locale) {
  return [
    issuer.phone   ? [t(locale, 'contact_phone'),  issuer.phone]   : null,
    issuer.mobile  ? [t(locale, 'contact_mobile'), issuer.mobile]  : null,
    issuer.email   ? [t(locale, 'contact_email'),  issuer.email]   : null,
    issuer.website ? [t(locale, 'contact_web'),    issuer.website] : null,
    // Only when set: a business that isn't VAT-registered has no number.
    issuer.vatId   ? [vatIdLabel(locale, issuer.countryCode), issuer.vatId] : null,
    // Migration 139 — Steuernummer (DE/AT local tax number). Distinct
    // from VAT-ID; both can appear simultaneously.
    issuer.taxId   ? [t(locale, 'tax_id_label'), issuer.taxId] : null,
  ].filter(Boolean);
}

/**
 * The two vertical rules the right-hand letterhead column lines up on: a colon
 * edge that every label ends at, and `right` — the page's right margin — that
 * every value ends at. `rows` are [label, value, fontSize]; the label is
 * measured with the colon the drawing adds.
 *
 * Before #1546 each row sized its own value column, so one long row dragged its
 * own label out of line with the rows above it, and the sender block used a
 * different grid again.
 */
function measureLabelGrid(doc, rows, right, { gap = 8, leftLimit = null, anchorLeft = null } = {}) {
  const body = (doc && doc._fonts && doc._fonts.body) || FONT_BODY;
  let labelW = 0;
  let valueW = 40;
  for (const [label, value, fontSize] of rows) {
    doc.font(body).fontSize(fontSize);
    labelW = Math.max(labelW, doc.widthOfString(`${label}:`) + 2);
    valueW = Math.max(valueW, doc.widthOfString(String(value)) + 2);
  }
  doc.fontSize(bodyText(doc).size);
  // `anchorLeft` pins the label column to a column the caller already owns, so
  // the labels line up with whatever it drew above them; otherwise the columns
  // are packed against `right`.
  if (anchorLeft != null) {
    const valueX = anchorLeft + labelW + gap;
    return { gap, labelW, valueW: Math.max(valueW, right - valueX), valueX, labelX: anchorLeft, right };
  }
  // The column may never reach into the address field: the sender block sits
  // level with it. It is the VALUE column that gives way — labels are drawn
  // without wrapping, so narrowing their column just runs them into the values
  // beside them, and a long website or e-mail address would do exactly that.
  // A value that no longer fits is cut with an ellipsis instead.
  if (leftLimit != null && right - (labelW + gap + valueW) < leftLimit) {
    valueW = Math.max(60, right - leftLimit - gap - labelW);
  }
  const valueX = right - valueW;
  return { gap, labelW, valueW, valueX, labelX: valueX - gap - labelW, right };
}

/**
 * One row of the letterhead grid: the label at the column's left edge, the
 * value at the value column's. Both left-aligned — the column reads as an
 * ordinary two-column block, which is what a letterhead looks like.
 */
function drawGridRow(doc, grid, label, value, y) {
  doc.text(`${label}:`, grid.labelX, y, { width: grid.labelW, align: 'left', lineBreak: false });
  doc.text(String(value), grid.valueX, y, {
    width: grid.valueW, align: 'left', lineBreak: false, ellipsis: true,
  });
}

function drawIssuerBlock(doc, issuer, x, y, width, locale, { grid = null } = {}) {
  const startY = y;
  // A logo the theme puts at the left or centre of the page is drawn there
  // (drawPageLogo), not in this column.
  const themeLogo = (doc._theme && doc._theme.logo) || THEME_BUILT_IN.logo;
  const showLogo = issuer.showLogo !== false && themeLogo.position === 'right'; // default true
  const showName = issuer.showCompanyName !== false; // default true

  // ---- top banner: logo (left) + company name (right of it) -----
  // Path resolution happens upstream in resolveLogoFile() — by the
  // time we get here, `issuer.logoPath` is either:
  //   - an absolute file path that has already been confirmed to
  //     exist on disk + filtered for PNG/JPEG, or
  //   - null when nothing resolved (logged upstream).
  // We still wrap doc.image() in try/catch because PDFKit can reject
  // valid-looking PNG/JPEG bytes (mislabelled extension, truncated
  // download, etc.) — we'd rather render the rest of the PDF than
  // crash on a broken logo.
  const letterhead = letterheadText(doc);
  const nameSize = bodyText(doc).size + 2;
  const logoFound = showLogo && issuer.logoPath ? issuer.logoPath : null;
  const drawLogoSafely = (file, opts) => {
    try {
      doc.image(file, opts.x, opts.y, { fit: [opts.w, opts.h] });
      return true;
    } catch (err) {
      const logger = require('../utils/logger');
      logger.warn('PDFKit failed to embed logo image', {
        path: file, err: err.message,
      });
      reportFinding(doc, { code: 'LOGO_MISSING', severity: 'warning' });
      return false;
    }
  };

  // Logo height is admin-configurable (migration 108). Falls back to
  // 56pt — the prior hard-coded value — when unset.
  const bannerH = Math.max(24, Math.min(200, Number(issuer.logoHeight) || 56));
  const inlineName = issuer.companyNameInline === true;
  // Logo and company name stack VERTICALLY (logo on top, name
  // underneath). When `companyNameInline` is set, the bold-title
  // name branch is skipped and the name is rendered as a regular
  // address line right before the street address (handled below).
  let logoDrawn = false;
  // The theme can put the logo beside the name instead of above it (#1445).
  const besideName = themeLogo.stack === 'inline' && showName && issuer.companyName && !inlineName;
  if (logoFound && besideName) {
    const logoW = Math.min(width * 0.45, bannerH * 2);
    logoDrawn = drawLogoSafely(logoFound, { x, y, w: logoW, h: bannerH });
    if (logoDrawn) {
      doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(nameSize).fillColor(themeColor(doc, 'text'))
        .text(issuer.companyName, x + logoW + 6, y + Math.max(0, bannerH / 2 - 8), { width: width - logoW - 6, align: 'left' });
      y = Math.max(y + bannerH, doc.y) + 6;
    }
  } else if (logoFound) {
    logoDrawn = drawLogoSafely(logoFound, { x, y, w: width, h: bannerH });
    if (logoDrawn) y += bannerH + 4;
  }
  if (showName && issuer.companyName && !inlineName && !(besideName && logoDrawn)) {
    // Bold-title branch — the standard letterhead look. Skipped when
    // the admin opted into the inline-name variant.
    doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(nameSize).fillColor(themeColor(doc, 'text'))
      .text(issuer.companyName, x, y, { width, align: 'left' });
    y = doc.y + 6;
  }

  // ---- address block (left-aligned within the column) -----------
  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(letterhead.size).fillColor(themeColor(doc, 'text'));
  const cityCountry = (() => {
    // Match the screenshot: "FL-9494 Schaan / Liechtenstein" on one
    // line. Fall back gracefully when fields are missing. The
    // country name comes from the explicit `countryName` override
    // when set (migration 107); otherwise we resolve it from the
    // ISO country code via the locale-aware COUNTRY_NAMES map.
    const cc = issuer.countryCode ? String(issuer.countryCode).toUpperCase() : '';
    const pc = issuer.postalCode || '';
    const city = issuer.city || '';
    const left = [cc && pc ? `${cc}-${pc}` : (pc || cc), city].filter(Boolean).join(' ');
    const country = issuer.countryName || countryName(issuer.countryCode, locale);
    return [left, country].filter(Boolean).join(' / ');
  })();
  // When the admin opted into the inline-name variant (migration 108)
  // the company name renders as the first address line, in the same
  // plain weight + size as the rest of the address. The bold-title
  // branch above is skipped in that case.
  const inlineCompanyLine = (showName && issuer.companyName && inlineName)
    ? issuer.companyName : null;
  const addressLines = [
    inlineCompanyLine,
    issuer.addressLine1,
    issuer.addressLine2,
    cityCountry,
  ].filter(Boolean);
  // The logo, the name and these lines all start at the column's left edge,
  // which is also where the contact and meta labels below them start (#1546).
  for (const line of addressLines) {
    doc.text(line, x, y, { width, align: 'left' });
    y = doc.y;
  }
  y += 6;

  // ---- contact rows, on the letterhead grid ---------------------
  // The caller passes the grid when the document's meta rows share this
  // column; on its own the block measures its own rows the same way.
  const contactRows = issuerContactRows(issuer, locale);
  // Without a grid from the caller — the contract renderer and the tax report —
  // the columns start at this block's own left edge, so the contact rows line
  // up with the address lines above them rather than being packed against the
  // right margin.
  const rowGrid = grid || measureLabelGrid(
    doc, contactRows.map(([label, value]) => [label, value, letterhead.size]),
    x + width, { anchorLeft: x });
  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(letterhead.size);
  for (const [label, value] of contactRows) {
    drawGridRow(doc, rowGrid, label, value, y);
    y += letterhead.leading;
  }
  return Math.max(y, startY + 60);
}

/**
 * What the business's VAT number is called on its documents, by the
 * business's country: MWST-Nr. in Switzerland and Liechtenstein, UID-Nr. in
 * Austria, USt-IdNr. in Germany (German documents; other languages have one
 * name).
 */
function vatIdLabel(locale, countryCode) {
  const cc = String(countryCode || '').toUpperCase();
  if (cc === 'CH' || cc === 'LI') return t(locale, 'vat_id_label_ch');
  if (cc === 'AT') return t(locale, 'vat_id_label_at');
  return t(locale, 'vat_id_label');
}

/**
 * Render the recipient block INSIDE the DIN 5008 Form B address
 * window. Two parts:
 *
 *   1. Return address line (small grey "Absender" reference) at the
 *      top of the window — this is what's visible through window
 *      envelopes above the actual address, by convention separated
 *      with "*" or "·". Optional; suppressed when issuerLine is
 *      blank.
 *   2. Actual recipient block starting at ADDR_WINDOW.addressY:
 *      - With company → bold company name, then "z. Hd. <name>"
 *      - Without company → bold person name, NO attention line
 *        (avoids the "Noam Mayer / z. Hd. Noam Mayer" duplicate)
 *      - Address: Street → "POSTAL CITY" (no country prefix on
 *        postal — the country line below carries that already)
 *      - Country line in caps for window-envelope readability
 *
 * The block is positioned absolutely; the caller does not need to
 * thread a `y` cursor through. Returns the y of the next free row
 * AFTER the address window (useful when drawing the horizontal
 * divider below).
 */
function drawRecipientBlock(doc, recipient, locale, { flowY = null } = {}) {
  // With the theme's address window off (#1445) the block sits in the flow
  // at the left margin — a letter handed over digitally needs no envelope
  // window, and no return-address line for one.
  const inWindow = flowY == null;
  const x = inWindow ? ADDR_WINDOW.left : pageOf(doc).marginLeft;
  const w = ADDR_WINDOW.width;

  // ---- tiny return address line at top of window ----------------
  if (inWindow && recipient.issuerLine) {
    doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(7.5).fillColor('#555');
    doc.text(recipient.issuerLine, x, ADDR_WINDOW.returnLineY, {
      width: w, align: 'left', lineBreak: false,
    });
  }

  // ---- recipient address ----------------------------------------
  let y = inWindow ? ADDR_WINDOW.addressY : flowY;

  // Body size and one step up for the name, so a theme that sets a larger body
  // carries the recipient with it (#1546). Identical to the previous 11/10 at
  // the default body size.
  doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(bodyText(doc).size + 1).fillColor(themeColor(doc, 'text'));
  if (recipient.companyName) {
    doc.text(recipient.companyName, x, y, { width: w });
    y = doc.y;
  }
  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(bodyText(doc).size);
  // Postal line mirrors the issuer block: "<CC>-<postal> <city>"
  // (e.g. "FL-9494 Schaan"). The country code prefix is dropped
  // when the customer has no countryCodeIso so the line still
  // reads cleanly. The country name on the line below comes from
  // the explicit `country` override (customer_accounts.country_name,
  // migration 107) or falls back to the locale-aware lookup.
  const cc = recipient.countryCodeIso ? String(recipient.countryCodeIso).toUpperCase() : '';
  const pc = recipient.postalCode || '';
  const postalLeft = cc && pc ? `${cc}-${pc}` : (pc || cc);
  const postalSegment = [postalLeft, recipient.city].filter(Boolean).join(' ');
  const lines = [
    recipient.hasCompany ? recipient.attentionLine : null,
    recipient.addressLine1,
    recipient.addressLine2,
    postalSegment,
    recipient.country || countryName(recipient.countryCodeIso, locale),
  ].filter(Boolean);
  for (const line of lines) {
    doc.text(line, x, y, { width: w });
    y = doc.y;
  }
  // Return position just below the address window so the caller
  // can position the date row / title underneath.
  return inWindow ? Math.max(y, ADDR_WINDOW.top + ADDR_WINDOW.height) : y;
}

/**
 * Draw DIN 5008 folding marks on the LEFT page edge so the printed
 * letter can be folded cleanly to fit a window envelope.
 *
 *   'half'  → single mark at 148.5mm from top (C5 / half-fold)
 *   'third' → DIN 5008 thirds-fold: marks at 105mm AND 210mm so the
 *             paper folds neatly into thirds for DL / C5-6 envelopes
 *   'both'  → 1/2 mark + both thirds marks (three total)
 *   'none' (or anything else) → no marks
 *
 * Marks are drawn 7.5mm long, anchored against the left edge of the
 * paper, 0.4pt hairline, mid-grey so they're visible to the person
 * folding but unobtrusive when the page is scanned or photocopied.
 */
function drawFoldingMarks(doc, mode) {
  if (!mode || mode === 'none') return;
  const MARK_LEN_PT = 7.5 * MM; // 7.5mm = ~21.26pt
  const ys = [];
  if (mode === 'half' || mode === 'both') {
    ys.push(148.5 * MM); // 1/2 fold (C5 envelope)
  }
  if (mode === 'third' || mode === 'both') {
    // DIN 5008 thirds fold uses TWO marks at 105mm and 210mm. The
    // 105mm line aligns with the top edge of the address window
    // after the first fold; the 210mm line aligns with the next
    // fold for the bottom third.
    ys.push(105 * MM);
    ys.push(210 * MM);
  }
  doc.save();
  doc.strokeColor(themeColor(doc, 'rule')).lineWidth(0.4);
  for (const y of ys) {
    doc.moveTo(0, y).lineTo(MARK_LEN_PT, y).stroke();
  }
  doc.restore();
}

function drawTitle(doc, title, x, y) {
  const size = (doc._theme && doc._theme.titleSize) || 20;
  doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(size).fillColor(themeColor(doc, 'accent')).text(title, x, y);
  doc.fillColor(themeColor(doc, 'text'));
  return doc.y + 8;
}

/**
 * Render the line-items table via swissqrbill's Table helper. We supply
 * widths in points; the helper draws the borderless layout the
 * reference PDF uses.
 *
 * Columns (quotes):   Pos / Anzahl / Beschreibung / Rabatt / Einzelpreis / Summe
 * Columns (invoices): Pos / Anzahl / Beschreibung / Einzelpreis / Summe
 */
/**
 * The height swissqrbill's Table gives a row: its tallest cell's text plus that
 * cell's vertical padding, measured the way the library's own first pass
 * measures it (lib/pdf/table.cjs, layer 0).
 *
 * We need it up front because the table breaks rows against
 * `doc.page.margins.bottom` and offers no hook at the break — so a running
 * carry-over row, and room for the closing blocks on the last page, both have
 * to be planned before it draws (#1546).
 */
function measureTableRow(doc, row, defaults) {
  // Mirrors the library for the row shapes this file builds. It does NOT read
  // `textOptions`, `minHeight`, `maxHeight`, `row.height` or a column without a
  // width — none of which our rows set. Adding one of those to a row without
  // teaching this function about it would drift the planner silently.
  let tallest = 0;
  let padTop = 0;
  let padBottom = 0;
  for (const column of row.columns) {
    const [top, right, bottom, left] = column.padding || row.padding || [0, 0, 0, 0];
    padTop = Math.max(padTop, top);
    padBottom = Math.max(padBottom, bottom);
    doc.font(column.fontName || row.fontName || defaults.fontName);
    doc.fontSize(column.fontSize || row.fontSize || defaults.fontSize);
    tallest = Math.max(tallest, doc.heightOfString(String(column.text), {
      align: column.align, baseline: 'middle', lineBreak: true,
      width: column.width - left - right,
    }));
  }
  return tallest + padTop + padBottom;
}

/**
 * `reserveOnLastPage` is how much of the last page the caller needs below the
 * table — the totals, the payment block and the footer, which are pinned to
 * the foot of the page. The table stops that far short, so the pinned blocks
 * never have to push themselves onto a page of their own.
 */
function drawLineItems(doc, ctx, { reserveOnLastPage = 0 } = {}) {
  const { type, locale, lineItems, currency, intlLocale } = ctx;
  // On a Stornorechnung the line items were snapshotted from the
  // original at FULL positive amounts (so the DB-level invariant
  // qty × unit = line_total still holds for both rows of the pair).
  // The cancellation semantics live on the row-level totals, which
  // are already negative in the DB. For the customer-facing PDF
  // we flip the per-line total display sign so each row visually
  // reads as a credit ("-CHF 300.00") — matches what bookkeepers
  // expect on a Storno.
  const isStorno = type === 'invoice' && ctx.doc?.kind === 'storno';
  const lineTotalSign = isStorno ? -1 : 1;
  const labels = {
    pos:   t(locale, 'table_pos'),
    qty:   t(locale, 'table_qty'),
    desc:  t(locale, 'table_description'),
    disc:  t(locale, 'table_discount'),
    unit:  t(locale, 'table_unit_price'),
    total: t(locale, 'table_line_total'),
  };

  // One table for quotes, invoices and contracts (#1451). A contract shows
  // its source quote's lines, so it follows the quote's discount rule.
  const showDiscount = (type === 'quote' || type === 'contract')
    && lineItems.some((li) => li.lineKind !== 'discount' && Number(li.discountPercent) > 0);
  // Units (migration 220) go into the quantity cell ("8 Std."), which is
  // widened — borrowed from the description — only when a line has one.
  const hasUnits = lineItems.some((li) => li.unit);
  const unitLabel = (unit) => t(locale, `unit_${unit}`);
  const quantityText = (li) => {
    if (!li.unit) return stripTrailingZeros(li.quantity);
    if (li.unit === 'flat') return unitLabel('flat');
    return `${stripTrailingZeros(li.quantity)} ${unitLabel(li.unit)}`;
  };
  // Comments under a line use the theme's italic face when there is one.
  const italicFont = ctx.fonts?.italic || 'Helvetica-Oblique';

  // Column widths sum to PAGE.contentWidth = 515.28. swissqrbill's
  // PDFColumn carries `width` + `align` directly on each cell; there
  // is NO top-level `columns: [...]` on the Table constructor. The
  // previous attempt to pass column widths separately was a no-op,
  // which is why numeric cells were left-aligned even though their
  // headers were right-aligned (header `textOptions.align` happened
  // to work on PDFKit's underlying text() call, but cell-level
  // alignment needs the API-supported `align` property).
  // Column widths sum to PAGE.contentWidth = 515.28. The qty column
  // gets a bit more room than the original 40pt so the German
  // header "Anzahl" (6 chars at 10pt + padding ≈ 50pt) doesn't wrap
  // across two lines. Width borrowed from the description column,
  // which has plenty of slack.
  // Column order matches the public quote response webpage:
  //   #  /  Description  /  Qty  /  [Discount]  /  Unit  /  Total
  // The maintainer's call — description first reads more like a
  // line-by-line list, which is how the web view presents it.
  // Widths sum to PAGE.contentWidth (515.28); description takes the
  // widest column, qty + numeric columns stay narrow but right-
  // aligned.
  const widths = showDiscount
    ? (hasUnits ? [30, 205, 75, 50, 75, 80] : [30, 225, 55, 50, 75, 80])
    : (hasUnits ? [30, 255, 75, 70, 85] : [30, 275, 55, 70, 85]);
  // Wider theme margins (#1445) narrow the table: the description column
  // gives up the difference, the numeric columns keep their width.
  const contentWidth = pageOf(doc).contentWidth;
  widths[1] += contentWidth - PAGE.contentWidth;

  // Per-row padding — tight rows. 3pt top + 3pt bottom keeps each
  // line item compact, with just enough vertical breathing room
  // for the divider lines to read clearly. swissqrbill's PDFPadding
  // type requires array form (number | [top, right, bottom, left]);
  // the earlier object form was silently dropped.
  const ROW_PADDING = [3, 4, 3, 4];
  // Match the totals box font size; the maintainer wants the line
  // items and the billing totals to read at the same weight so the
  // eye doesn't bounce between two scales. Both follow the theme (#1546).
  const ROW_FONT_SIZE = bodyText(doc).size;
  // Visual divider between items — thin grey rule under every data
  // row. swissqrbill PDFRow supports `borderWidth` as a 4-tuple
  // [top, right, bottom, left] and matching `borderColor`. We only
  // want the bottom line on each data row, and a slightly darker
  // bottom on the header row to anchor the column titles. The
  // grand-total divider above the sum row is drawn separately in
  // drawTotals; here we just delimit items from one another.
  const ROW_BORDER_BOTTOM_WIDTH = [0, 0, 0.5, 0];
  const ROW_BORDER_BOTTOM_COLOR = ['#000', '#000', '#cccccc', '#000'];
  const HEADER_BORDER_BOTTOM_WIDTH = [0, 0, 1, 0];
  const HEADER_BORDER_BOTTOM_COLOR = ['#000', '#000', '#000', '#000'];

  // Migration 119 — sub-items + details_text.
  //
  // Hierarchy rendering:
  //   - Top-level items get a numeric position (1, 2, 3...) and their
  //     line_total renders in full weight.
  //   - Sub-items render with an empty position column, the
  //     description indented with a bullet prefix ("• "), and
  //     their line_total wrapped in parentheses to mark it as
  //     display-only (doesn't roll into net). Sub-items with
  //     unit_price = 0 render the price columns empty.
  //
  // Details rendering:
  //   - Each item that has a non-empty details_text gets an extra
  //     row right below it: empty position cell + the details text
  //     spanning the description column (smaller font, italic, grey).
  //     swissqrbill's Table can't actually span columns, so the
  //     details row fills the description cell width and leaves the
  //     remaining columns empty — visually equivalent.
  //
  // We compute a displayIndex for top-level items so the position
  // column stays 1..N regardless of how many sub-items sit between
  // parents in the array.
  let topLevelCount = 0;
  // A package whose price is the sum of its sub-items has no unit price of
  // its own: an empty cell, not "0.00" next to the sum it shows.
  const parents = new Set();
  for (const item of lineItems) {
    if (item.parentLineItemId != null) parents.add(`id:${item.parentLineItemId}`);
    if (item.parentPosition != null) parents.add(`pos:${item.parentPosition}`);
  }
  const isPackageSum = (li) => !Number(li.unitPriceMinor)
    && (parents.has(`id:${li.id}`) || parents.has(`pos:${li.position}`));
  const buildItemRow = (li) => {
    const isSubItem = li.parentLineItemId != null || li.parentPosition != null;
    // A discount line (migration 220) is numbered like any other line, but
    // shows no quantity or unit price — just its amount.
    const isDiscount = li.lineKind === 'discount';
    const posLabel = isSubItem ? '' : String(++topLevelCount);
    // Bullet (U+2022) is part of the WinAnsi character set that
    // PDFKit's built-in Helvetica supports, unlike the earlier "↳"
    // (U+21B3) which rendered as the font's .notdef glyph ("!3").
    // Custom TTFs registered via business_profile.pdf_font_ttf_path
    // typically include the arrow too, but the bullet is the safe
    // common-denominator that always renders.
    let descText = isSubItem ? `\u2022 ${li.description || ''}` : (li.description || '');
    if (isDiscount && li.promotion && li.promotion.type === 'percent') {
      descText = `${descText} (${stripTrailingZeros(li.promotion.percent)} %)`;
    }
    const subItemPriceless = isSubItem && (!li.unitPriceMinor || Number(li.unitPriceMinor) === 0);
    const unitText = subItemPriceless || isDiscount || (!isSubItem && isPackageSum(li))
      ? ''
      : formatMinor(li.unitPriceMinor, currency, intlLocale);
    const qtyText = isDiscount ? '' : quantityText(li);
    const displayLineTotal = lineTotalSign * Number(li.lineTotalMinor || 0);
    const lineTotalText = subItemPriceless
      ? ''
      : isSubItem || li.excluded
        ? `(${formatMinor(displayLineTotal, currency, intlLocale)})`
        : formatMinor(displayLineTotal, currency, intlLocale);
    // A not-booked add-on (#1451) is muted, its amount in parentheses like a
    // sub-item's: it is not part of the total.
    const numericColor = isSubItem || li.excluded ? themeColor(doc, 'muted') : themeColor(doc, 'text');

    return {
      padding: ROW_PADDING,
      fontSize: ROW_FONT_SIZE,
      // Data rows name the body font explicitly — only the header row did,
      // so a custom PDF font could stop short of the cells.
      fontName: ctx.fonts?.body || FONT_BODY,
      // Border is set by the caller (buildGroupRows) so the LAST row
      // of each "group" (parent + sub-items + their details_text
      // rows) carries the divider, and the rows above it leave the
      // bottom edge empty. Without this, every row gets its own line
      // and parent + sub-items look like separate items.
      borderWidth: [0, 0, 0, 0],
      columns: showDiscount
        ? [
          { text: posLabel,                                          width: widths[0], align: 'left'  },
          { text: descText,                                          width: widths[1], align: 'left',  textColor: numericColor },
          { text: qtyText,                                           width: widths[2], align: 'right', textColor: numericColor },
          { text: subItemPriceless || isDiscount ? '' : `${stripTrailingZeros(li.discountPercent)}%`, width: widths[3], align: 'right', textColor: numericColor },
          { text: unitText,                                          width: widths[4], align: 'right', textColor: numericColor },
          { text: lineTotalText,                                     width: widths[5], align: 'right', textColor: numericColor },
        ]
        : [
          { text: posLabel,                                          width: widths[0], align: 'left'  },
          { text: descText,                                          width: widths[1], align: 'left',  textColor: numericColor },
          { text: qtyText,                                           width: widths[2], align: 'right', textColor: numericColor },
          { text: unitText,                                          width: widths[3], align: 'right', textColor: numericColor },
          { text: lineTotalText,                                     width: widths[4], align: 'right', textColor: numericColor },
        ],
    };
  };

  /**
   * Build a "details" row that follows an item with non-empty
   * details_text. The details text fills the description cell at a
   * smaller font + italic-ish (Helvetica-Oblique) + grey colour;
   * other cells stay empty. No bottom border so the row visually
   * belongs to the item above it.
   */
  const buildDetailsRow = (text) => ({
    padding: [0, 4, 3, 4],
    fontSize: Math.max(6, ROW_FONT_SIZE - 1),
    borderWidth: [0, 0, 0, 0],
    columns: showDiscount
      ? [
        { text: '',   width: widths[0], align: 'left' },
        { text,       width: widths[1], align: 'left', textColor: themeColor(doc, 'muted'), fontName: italicFont },
        { text: '',   width: widths[2], align: 'right' },
        { text: '',   width: widths[3], align: 'right' },
        { text: '',   width: widths[4], align: 'right' },
        { text: '',   width: widths[5], align: 'right' },
      ]
      : [
        { text: '',   width: widths[0], align: 'left' },
        { text,       width: widths[1], align: 'left', textColor: themeColor(doc, 'muted'), fontName: italicFont },
        { text: '',   width: widths[2], align: 'right' },
        { text: '',   width: widths[3], align: 'right' },
        { text: '',   width: widths[4], align: 'right' },
      ],
  });

  const headerRow = {
    // Table accepts any registered font name; if a custom font is in
    // use we route the bold row through it too.
    fontName: ctx.fonts?.bold || FONT_BOLD,
    fontSize: ROW_FONT_SIZE,
    padding: ROW_PADDING,
    borderWidth: HEADER_BORDER_BOTTOM_WIDTH,
    borderColor: HEADER_BORDER_BOTTOM_COLOR,
    header: true,
    columns: showDiscount
      ? [
        { text: labels.pos,   width: widths[0], align: 'left'  },
        { text: labels.desc,  width: widths[1], align: 'left'  },
        { text: labels.qty,   width: widths[2], align: 'right' },
        { text: labels.disc,  width: widths[3], align: 'right' },
        { text: labels.unit,  width: widths[4], align: 'right' },
        { text: labels.total, width: widths[5], align: 'right' },
      ]
      : [
        { text: labels.pos,   width: widths[0], align: 'left'  },
        { text: labels.desc,  width: widths[1], align: 'left'  },
        { text: labels.qty,   width: widths[2], align: 'right' },
        { text: labels.unit,  width: widths[3], align: 'right' },
        { text: labels.total, width: widths[4], align: 'right' },
      ],
  };

  // Group rows so a parent + its sub-items + every involved details_text
  // share ONE bottom divider drawn after the entire group. Without
  // this grouping, each row (parent, sub-item, details) gets its own
  // divider and the visual cohesion is lost — sub-items look like
  // independent line items, and a details block looks orphaned below
  // its parent's divider.
  //
  // Algorithm:
  //   - Iterate items in their array order (already grouped by the
  //     editor: parent → its sub-items → next parent).
  //   - Collect each parent's row + its details row + every sub-item's
  //     row + sub-items' details rows into a single "group" array.
  //   - Apply the bottom border ONLY to the last row of each group.
  const groups = [];
  let currentGroup = null;
  for (const li of lineItems) {
    const isSubItem = li.parentLineItemId != null || li.parentPosition != null;
    if (!isSubItem) {
      // Start a new group at every top-level item. Only a top-level line that
      // isn't excluded counts towards the carry-over: a sub-item's amount is
      // shown in parentheses because it is already inside its parent's, and an
      // unbooked add-on is not in the total at all.
      currentGroup = { rows: [], netMinor: li.excluded ? 0 : lineTotalSign * Number(li.lineTotalMinor || 0) };
      groups.push(currentGroup);
    } else if (!currentGroup) {
      // Defensive: if the array starts with an orphaned sub-item
      // (shouldn't happen — validateLineItemHierarchy rejects this)
      // give it its own group rather than crashing.
      currentGroup = { rows: [], netMinor: 0 };
      groups.push(currentGroup);
    }
    currentGroup.rows.push(buildItemRow(li));
    if (li.detailsText && String(li.detailsText).trim().length > 0) {
      currentGroup.rows.push(buildDetailsRow(String(li.detailsText).trim()));
    }
    // An add-on (#1451) ends with its status: title, description, then booked
    // or not booked.
    if (li.addOn) currentGroup.rows.push(buildDetailsRow(t(locale, li.addOn === 'booked' ? 'addon_booked' : 'addon_not_booked')));
  }
  // Apply the bottom border to the last row of each group.
  for (const group of groups) {
    if (group.rows.length === 0) continue;
    const last = group.rows[group.rows.length - 1];
    last.borderWidth = ROW_BORDER_BOTTOM_WIDTH;
    last.borderColor = ROW_BORDER_BOTTOM_COLOR;
  }

  /**
   * The carry-over row: "Übertrag" in the description column and the running
   * net in the amount column. It closes a page that continues, and opens the
   * page that continues it, so a reader who separates the sheets can still
   * follow the arithmetic.
   */
  const lastColumn = widths.length - 1;
  const carryRow = (amountMinor, key) => ({
    padding: ROW_PADDING,
    fontSize: ROW_FONT_SIZE,
    fontName: ctx.fonts?.bold || FONT_BOLD,
    borderWidth: ROW_BORDER_BOTTOM_WIDTH,
    borderColor: ROW_BORDER_BOTTOM_COLOR,
    columns: widths.map((width, i) => ({
      width,
      align: i <= 1 ? 'left' : 'right',
      text: i === 1 ? t(locale, key) : i === lastColumn ? formatMinor(amountMinor, currency, intlLocale) : '',
    })),
  });

  // ---- pagination ------------------------------------------------
  // Planned here rather than left to the library's own row break (#1546): it
  // breaks against `doc.page.margins.bottom` with no hook at the break, so
  // neither the carry-over rows nor the reserve for the pinned closing blocks
  // could be placed. Each page is handed a table that fits it, so the
  // library never has to break one itself.
  const P = pageOf(doc);
  const defaults = { fontName: ctx.fonts?.body || FONT_BODY, fontSize: ROW_FONT_SIZE };
  const headerHeight = measureTableRow(doc, headerRow, defaults);
  const carryHeight = measureTableRow(doc, carryRow(0, 'table_carry_forward'), defaults);
  for (const group of groups) {
    group.rowHeights = group.rows.map((row) => measureTableRow(doc, row, defaults));
    group.height = group.rowHeights.reduce((sum, height) => sum + height, 0);
  }

  const pageBottom = doc.page.height - doc.page.margins.bottom;

  // What the planner places. A group normally moves as one, so a parent, its
  // sub-items and their comments keep the single divider they share. A group
  // taller than a page cannot move as one: its rows are placed individually
  // instead, which costs that group its shared divider but keeps the
  // carry-over rows correct. Rows are far shorter than a page — the API caps a
  // description at 1000 characters and a comment at 2000.
  const wholePage = pageBottom - P.marginTop - headerHeight - carryHeight;
  const units = [];
  for (const group of groups) {
    if (group.height <= wholePage) {
      units.push({ rows: group.rows, height: group.height, netMinor: group.netMinor });
      continue;
    }
    group.rows.forEach((row, i) => units.push({
      rows: [row],
      height: group.rowHeights[i],
      // The line total sits on the group's first row, so that is where the
      // carry-over starts counting it.
      netMinor: i === 0 ? group.netMinor : 0,
    }));
  }

  const pages = [];
  let index = 0;
  let pageTop = doc.y;
  let startOnNewPage = false;
  let carryIn = null;
  let runningNet = 0;
  while (index < units.length) {
    const top = pageTop + headerHeight + (carryIn != null ? carryHeight : 0);
    const remaining = units.slice(index).reduce((sum, unit) => sum + unit.height, 0);
    // The last page is the one everything left fits on beside the reserve; any
    // earlier page has to keep room for the carry-over row that closes it.
    const isLast = top + remaining <= pageBottom - reserveOnLastPage;
    const limit = isLast ? pageBottom - reserveOnLastPage : pageBottom - carryHeight;
    // A page that can't be the last one has to leave a unit for the next,
    // otherwise it becomes the last page after all — with the reserve already
    // spent on line items and the pinned blocks nowhere to go.
    const ceiling = isLast ? units.length : units.length - 1;
    const taken = [];
    let y = top;
    // `<`, not `<=`: the library breaks a row whose bottom REACHES the bottom
    // margin (`rowY + rowHeight >= bottom`), so equality is a fit here and a
    // break there — which is exactly the disagreement this planner exists to
    // avoid.
    while (index < ceiling && y + units[index].height < limit) {
      y += units[index].height;
      runningNet += units[index].netMinor;
      taken.push(units[index]);
      index += 1;
    }
    if (taken.length === 0) {
      if (pageTop > P.marginTop) {
        // Nothing fits in what is left of this page — a long intro, or a
        // caller that only guaranteed a few points. Start the chunk on a fresh
        // page rather than handing the library a unit it cannot place: it
        // would draw the header here, break to a page of its own and repeat
        // the header there, leaving an orphan header behind and the carry-over
        // pinned to the foot of a page carrying nothing.
        pageTop = P.marginTop;
        startOnNewPage = true;
        continue;
      }
      // At the top of a page and still too tall: a single row longer than the
      // page. Place it and let the library carry the overflow, rather than
      // looping forever on a unit that can never fit.
      runningNet += units[index].netMinor;
      taken.push(units[index]);
      index += 1;
    }
    const more = index < units.length;
    pages.push({
      units: taken,
      carryIn,
      carryOut: more ? runningNet : null,
      newPage: startOnNewPage || pages.length > 0,
    });
    startOnNewPage = false;
    carryIn = more ? runningNet : null;
    pageTop = P.marginTop;
  }
  // No line items at all: the header still renders, as it always did.
  if (pages.length === 0) pages.push({ units: [], carryIn: null, carryOut: null, newPage: false });

  pages.forEach((page) => {
    if (page.newPage) {
      doc.addPage();
      doc.x = P.marginLeft;
      doc.y = P.marginTop;
    }
    const rows = [headerRow];
    if (page.carryIn != null) rows.push(carryRow(page.carryIn, 'table_carry_brought'));
    for (const unit of page.units) rows.push(...unit.rows);
    new Table({ width: contentWidth, rows }).attachTo(doc);
    if (page.carryOut != null) {
      // The row that closes a continuing page is pinned to its foot, like the
      // totals on the last one: the page breaks early so the last page can hold
      // the pinned blocks, and a carry-over left floating under the final item
      // would read as an unfinished total rather than the foot of a page.
      //
      // Drawn directly rather than as a one-row table: the library starts a
      // page of its own as soon as a row's bottom reaches the bottom margin,
      // which at the foot of the page is exactly where this row sits. That
      // would emit a blank page carrying nothing but "Übertrag" — and it would
      // depend on measureTableRow agreeing with the library to the point.
      const [padTop, padRight, , padLeft] = ROW_PADDING;
      const rowTop = pageBottom - carryHeight;
      const lastX = P.marginLeft + contentWidth - widths[lastColumn];
      doc.font(ctx.fonts?.bold || FONT_BOLD).fontSize(ROW_FONT_SIZE).fillColor(themeColor(doc, 'text'));
      doc.text(t(locale, 'table_carry_forward'),
        P.marginLeft + widths[0] + padLeft, rowTop + padTop, { lineBreak: false });
      doc.text(formatMinor(page.carryOut, currency, intlLocale),
        lastX + padLeft, rowTop + padTop,
        { width: widths[lastColumn] - padLeft - padRight, align: 'right', lineBreak: false });
      doc.moveTo(P.marginLeft, rowTop + carryHeight)
        .lineTo(P.marginLeft + contentWidth, rowTop + carryHeight)
        .strokeColor(ROW_BORDER_BOTTOM_COLOR[2])
        .lineWidth(ROW_BORDER_BOTTOM_WIDTH[2])
        .stroke();
      doc.fillColor(themeColor(doc, 'text'));
    }
  });
  return doc.y;
}

function stripTrailingZeros(value) {
  if (value == null) return '';
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  const s = num.toString();
  // Only strip zeros AFTER the decimal point. Naively replacing
  // `/\.?0+$/` also ate the trailing zero in whole numbers like
  // "10" → "1", which made a quantity of 10 render as 1 on the
  // PDF while the total (qty * unit) stayed correct: Anzahl=10,
  // Einzelpreis 123, Summe 1230, but the column read "1".
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '') || '0';
}

/**
 * Totals box, right-aligned. Two columns: label (left), value (right).
 * VAT row drops when rate is 0 + amount is 0? No — reference shows
 * "ges. MwSt. 0.0% 0.00" so we keep it visible.
 */
/**
 * The totals under a contract's line table (#1445).
 *
 * Separate from `drawTotals` on purpose: that one is pinned to a fixed
 * offset from the page bottom and shares its geometry with the payment
 * block beneath it, neither of which exists in a contract — the table sits
 * mid-document, between clauses. This draws the same three figures with the
 * same column arithmetic, labels and money formatting, inline where the
 * table ended.
 *
 * `totals` is the frozen snapshot's shape (netMinor / vatRatePercent /
 * vatMinor / shippingMinor / grossMinor), not the quote service's.
 */
function drawContractTotals(doc, ctx, x, y, width) {
  const { locale, currency, intlLocale, totals } = ctx;
  const right = x + width;
  const valueCol = 80;
  const rateCol = 40;
  const valueX = right - valueCol;
  const rateX = right - valueCol - rateCol;
  const labelX = x + (width - 20) / 2 + 20;
  const labelCol = rateX - labelX - 6;
  const body = doc._fonts ? doc._fonts.body : FONT_BODY;
  const bold = doc._fonts ? doc._fonts.bold : FONT_BOLD;

  const row = (label, value, rate) => {
    doc.font(bold).fontSize(10).text(label, labelX, y, { width: labelCol });
    if (rate != null) doc.font(body).text(rate, rateX, y, { width: rateCol, align: 'right' });
    doc.font(body).text(value, valueX, y, { width: valueCol, align: 'right' });
    y = doc.y + 4;
  };

  doc.moveTo(x, y).lineTo(right, y).strokeColor(themeColor(doc, 'text')).lineWidth(0.8).stroke();
  y += 6;
  doc.fillColor(themeColor(doc, 'text'));

  row(t(locale, 'totals_net'), formatMinor(totals.netMinor, currency, intlLocale));
  if (Number(totals.shippingMinor) > 0) {
    row(t(locale, 'totals_shipping'), formatMinor(totals.shippingMinor, currency, intlLocale));
  }
  if (Number(totals.vatMinor) !== 0 || Number(totals.vatRatePercent) > 0) {
    row(
      ctx.vatLabel || t(locale, 'totals_vat'),
      formatMinor(totals.vatMinor, currency, intlLocale),
      `${stripTrailingZeros(totals.vatRatePercent)}%`,
    );
  }

  doc.moveTo(labelX, y).lineTo(right, y).strokeColor(themeColor(doc, 'text')).lineWidth(0.8).stroke();
  y += 6;
  doc.font(bold).fontSize(11).text(t(locale, 'totals_grand'), labelX, y, { width: labelCol });
  doc.text(formatMinor(totals.grossMinor, currency, intlLocale), valueX, y, { width: valueCol, align: 'right' });
  y = doc.y + 6;
  doc.fontSize(10);
  return y;
}

function drawTotals(doc, ctx, x, y, width) {
  const { locale, currency, intlLocale, totals } = ctx;
  // One scale for the whole document: the theme's body size, with the note
  // under the VAT row in the fine print step (#1546).
  const size = bodyText(doc).size;
  // Layout: align the totals labels with the RIGHT column of the
  // payment block beneath (where "Please transfer the amount …",
  // "<Account holder>", and "<IBAN>" appear). Both columns of the
  // payment block split the page in half, so the right-column
  // anchor sits at `x + width/2 + 10` (mirrors drawPaymentBlock's
  // `rightX = x + colWidth + 20` with colWidth = (width-20)/2).
  // Values + VAT-rate column stay right-aligned to the page edge
  // so amounts still stack tabularly.
  const right = x + width;
  const valueCol = 80;
  const rateCol = 40;
  const valueX = right - valueCol;
  const rateX  = right - valueCol - rateCol;
  const labelX = x + (width - 20) / 2 + 20;  // matches drawPaymentBlock.rightX
  const labelCol = rateX - labelX - 6;       // small gap before rate column

  // Divider line ABOVE the totals block — spans the FULL page
  // content width (from the left margin to the right edge) so it
  // visually closes off the line-items table above and the totals
  // stack below as one continuous letterhead section.
  doc.moveTo(x, y).lineTo(right, y).strokeColor(themeColor(doc, 'text')).lineWidth(0.8).stroke();
  y += 6;

  doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(size);
  doc.text(t(locale, 'totals_net'), labelX, y, { width: labelCol });
  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY);
  doc.text(formatMinor(totals.netAmountMinor, currency, intlLocale), valueX, y, { width: valueCol, align: 'right' });
  y = doc.y + 4;

  doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).text(t(locale, 'totals_shipping'), labelX, y, { width: labelCol });
  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).text(formatMinor(totals.shippingAmountMinor, currency, intlLocale), valueX, y, { width: valueCol, align: 'right' });
  y = doc.y + 4;

  // Not VAT-registered and no VAT on this document: no MwSt. row (see
  // vatRowHidden); the VAT note below stands in its place.
  if (!vatRowHidden(ctx)) {
    // Custom VAT label (Settings → Accounting) overrides the per-locale default.
    const vatLabel = (ctx.issuer && ctx.issuer.vatLabel) || t(locale, 'totals_vat');
    doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).text(vatLabel, labelX, y, { width: labelCol });
    doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).text(`${stripTrailingZeros(totals.vatRate)}%`, rateX, y, { width: rateCol, align: 'right' });
    doc.text(formatMinor(totals.vatAmountMinor, currency, intlLocale), valueX, y, { width: valueCol, align: 'right' });
    y = doc.y + 4;
  }

  // Free-text VAT / legal note (#794) — printed directly under the MwSt. line
  // (Benedikt's requested spot). The admin sets the exact wording in
  // Settings → CRM → Invoices (e.g. the Austrian Kleinunternehmer statement).
  // Optional; wraps across the totals column. Font size is restored to the row
  // scale so the Mahngebühr / Rundung / grand-total rows below are unaffected.
  if (ctx.vatNote) {
    doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(smallTextSize(doc._theme)).fillColor('#555');
    doc.text(ctx.vatNote, labelX, y, { width: right - labelX });
    doc.fillColor(themeColor(doc, 'text')).fontSize(size);
    y = doc.y + 4;
  }

  // Mahngebühr row — only rendered when a late fee has been added
  // (second reminder onwards). Sits between VAT and the grand-total
  // divider so the customer sees a clear "VAT + late fee → Total"
  // arithmetic chain. The grand-total figure below folds it in.
  const lateFeeMinor = Number(totals.lateFeeAmountMinor || 0);
  if (lateFeeMinor > 0) {
    doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).text(t(locale, 'totals_late_fee'), labelX, y, { width: labelCol });
    doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).text(formatMinor(lateFeeMinor, currency, intlLocale), valueX, y, { width: valueCol, align: 'right' });
    y = doc.y + 4;
  }

  // Rundung — sub-cent reconciliation row (crm_invoice_round_total). Only
  // rendered when the stored (clean) net differs from the sum of the
  // visible line totals; bridges "Betrag Netto" (= Σ lines, foots with
  // the items) down/up to the clean Gesamtbetrag below. Zero ⇒ omitted,
  // so unrounded documents are byte-identical to before.
  const roundingMinor = Number(totals.roundingAdjustmentMinor || 0);
  if (roundingMinor !== 0) {
    doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).text(t(locale, 'totals_rounding'), labelX, y, { width: labelCol });
    doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).text(formatMinor(roundingMinor, currency, intlLocale), valueX, y, { width: valueCol, align: 'right' });
    y = doc.y + 4;
  }
  y += 6;

  // Divider line above grand total — spans the right half of the
  // page only, from the label anchor to the right edge, so it sits
  // visually over the same column as "Please transfer …" below.
  doc.moveTo(labelX, y).lineTo(right, y).strokeColor(themeColor(doc, 'text')).lineWidth(0.8).stroke();
  y += 6;

  // Grand-total row uses the SAME font size as the rows above (and
  // as the line-item table) — the maintainer wants the billing
  // titles to read at one consistent scale instead of stair-
  // stepping up to a bigger headline. The row stays bold for
  // visual emphasis. Includes the Mahngebühr when present so the
  // customer's "owed" figure is the single bottom-line number.
  const grandTotalMinor = Number(totals.totalAmountMinor || 0) + lateFeeMinor;
  doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(size);
  doc.text(t(locale, 'totals_grand'), labelX, y, { width: labelCol });
  doc.text(formatCurrencyLabel(currency), rateX, y, { width: rateCol, align: 'right' });
  doc.text(formatMinor(grandTotalMinor, currency, intlLocale), valueX, y, { width: valueCol, align: 'right' });
  return doc.y + 10;
}

/**
 * Render the payment conditions + IBAN block. Two columns side by side
 * matching the reference layout:
 *   left: "Payment conditions: <text>. The amount must be paid within
 *         30 days from invoice date."
 *   right: "Please transfer the amount to the following bank account:
 *          <IBAN>"
 */
function drawPaymentBlock(doc, ctx, x, y, width) {
  const { type, locale, paymentTerm, bank, intlLocale, totals, currency, issuer, doc: docMeta } = ctx;
  const size = bodyText(doc).size;
  const colWidth = (width - 20) / 2;
  const leftX = x;
  const rightX = x + colWidth + 20;
  const startY = y;

  // Quote vs invoice differs in two ways:
  //   - Quotes never render the IBAN block (right column). A quote
  //     is an offer, not a demand for payment, so wiring money
  //     against an unsigned quote should not be encouraged.
  //   - Quotes honor the per-issuer toggles for the net-days line
  //     and the Skonto line. Both default true; setting either to
  //     false suppresses that specific row.
  // Invoices always show every available row + the IBAN.
  const isQuote = type === 'quote';
  const showNetDaysHere = isQuote ? (issuer?.quoteShowNetDays !== false) : true;
  // Skonto is suppressed once the invoice is in dunning. A
  // "Mahnrechnung" rewarding the customer with an early-payment
  // discount makes no business sense — they're already late.
  // Quotes still respect the per-issuer toggle.
  const reminderLevel = Number(docMeta?.reminderLevel || 0);
  const showSkontoHere = isQuote
    ? (issuer?.quoteShowSkonto !== false)
    : reminderLevel === 0;
  // Invoices show the IBAN block in the right column EXCEPT when a
  // Swiss QR-bill slip is appended: that slip already prints the
  // account/IBAN ("Konto / Zahlbar an") in human-readable form, so
  // repeating "Der Betrag ist auf die folgende Bankverbindung zu
  // überweisen: …" under the totals is pure duplication. The EPC QR
  // path keeps the block — its QR lives on a trailing page, so having
  // the bank details on the invoice page itself still helps.
  const showIbanHere    = !isQuote && ctx.qrFormat !== 'swiss';

  // If the quote has nothing to print in either column, bail out
  // early — don't render a bare "Payment conditions:" header with
  // no rows under it.
  const hasNetDaysRow = showNetDaysHere && paymentTerm?.netDays;
  const hasSkontoRow  = showSkontoHere && paymentTerm?.skontoPercent && paymentTerm?.skontoWithinDays;
  // Late-fee note in the payment block is redundant now that the
  // Mahngebühr appears as its own row in the totals stack. Keep it
  // suppressed to avoid duplicate "+CHF 25.00 late fee" text.
  const hasLateFeeRow = false;
  const hasLeftContent = paymentTerm?.description || hasNetDaysRow || hasSkontoRow || hasLateFeeRow;
  if (!hasLeftContent && !showIbanHere) return y;

  if (hasLeftContent) {
    doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(size).fillColor(themeColor(doc, 'text'));
    doc.text(t(locale, 'payment_conditions') + ':', leftX, y, { width: colWidth });
    y = doc.y + 2;
    doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(size);
    if (paymentTerm?.description) {
      doc.text(paymentTerm.description, leftX, y, { width: colWidth });
      y = doc.y + 4;
    }
    if (hasNetDaysRow) {
      doc.text(
        `${paymentTerm.netDays} ${t(locale, 'net_days_suffix')}`,
        leftX, y, { width: colWidth }
      );
      y = doc.y + 4;
    }
    if (hasSkontoRow) {
      doc.text(
        t(locale, 'skonto_phrase', {
          percent: stripTrailingZeros(paymentTerm.skontoPercent),
          days: paymentTerm.skontoWithinDays,
        }),
        leftX, y, { width: colWidth }
      );
      y = doc.y + 2;
      // Show the post-discount amount so the customer doesn't have
      // to do the math. Computed off the grand total (incl. VAT +
      // shipping) per CH/DE convention.
      const skontoTotalMinor = totals?.totalAmountMinor
        ? Math.round(Number(totals.totalAmountMinor) * (1 - Number(paymentTerm.skontoPercent) / 100))
        : null;
      if (skontoTotalMinor != null) {
        doc.fillColor('#444').text(
          `${t(locale, 'skonto_amount_label')}: ${formatCurrencyLabel(currency)} ${formatMinor(skontoTotalMinor, currency, intlLocale)}`,
          leftX, y, { width: colWidth }
        );
        doc.fillColor(themeColor(doc, 'text'));
        y = doc.y + 4;
      } else {
        y += 2;
      }
    }
    // Late fee note for second-reminder invoices (never on quotes).
    if (hasLateFeeRow) {
      doc.fillColor('#a00').text(
        t(locale, 'late_fee_note', {
          amount: `${formatCurrencyLabel(ctx.currency)} ${formatMinor(docMeta.lateFeeMinor, ctx.currency, intlLocale)}`,
        }),
        leftX, y, { width: colWidth }
      );
      doc.fillColor(themeColor(doc, 'text'));
      y = doc.y + 4;
    }
  }

  // Right column: IBAN (invoices only).
  let ry = startY;
  if (showIbanHere && bank) {
    doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(size);
    doc.text(t(locale, 'iban_intro'), rightX, ry, { width: colWidth });
    ry = doc.y + 4;
    doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(size);
    if (bank.accountHolder) {
      doc.text(bank.accountHolder, rightX, ry, { width: colWidth });
      ry = doc.y;
    }
    if (bank.iban) {
      const formatted = bank.iban.replace(/(.{4})/g, '$1 ').trim();
      doc.text(formatted, rightX, ry, { width: colWidth });
      ry = doc.y;
    }
    if (bank.bic) {
      doc.text(`BIC: ${bank.bic}`, rightX, ry, { width: colWidth });
      ry = doc.y;
    }
  }
  return Math.max(y, ry) + 8;
}

/**
 * What drawFooter occupies above the bottom edge it is given: one line, two
 * when the issuer set a footer line, nothing when the theme turned the footer
 * off. The placement decisions read this rather than a constant of their own,
 * so a two-line footer can't be laid over (#1546).
 */
function footerHeightFor(theme, issuer) {
  const footer = (theme && theme.footer) || { mode: 'address', text: '' };
  if (footer.mode === 'none') return 0;
  const line = footerLineHeight(theme);
  return issuer?.footerLine ? line * 2 + 4 : line;
}

/** footerHeightFor for a document that already carries its theme. */
function footerHeight(doc, issuer = {}) {
  return footerHeightFor(doc && doc._theme, issuer);
}

/**
 * How tall the closing blocks come out: the totals box, the outro and the
 * payment block, together with the gaps between them.
 *
 * They are pinned to the foot of the last page (#1546), so the line table has
 * to stop that far short — and a pinned block that is taller than the room
 * reserved for it is drawn straight over the footer. The height is therefore
 * measured rather than estimated: the blocks are drawn once into a document
 * that is never piped anywhere, with the same theme, fonts and page metrics,
 * and the cursor tells us what they need. Estimating from a table of row
 * heights would drift the first time drawPaymentBlock grew a row.
 */
function measureClosingHeight(ctx, PAGE, options) {
  try {
    return measureClosingBlocks(ctx, PAGE, options);
  } catch (err) {
    // Never fail a document over a measurement. A generous fallback breaks the
    // table a little early; too small a one would draw the pinned blocks over
    // the footer.
    require('../utils/logger').warn('Could not measure the closing blocks; using a fallback height', { err: err.message });
    return { totals: 110, outro: 0, payment: 140, total: 260 };
  }
}

function measureClosingBlocks(ctx, PAGE, { isStorno }) {
  const scrap = new PDFDocument({
    // Tall enough that nothing drawn here can paginate. An outro is accepted up
    // to 5000 characters (routes/adminQuotes): on an A4 scrap PDFKit would
    // break it and reset the cursor to the top margin, and the height would
    // come back as the tail of the block rather than the whole of it.
    size: [PAGE.width, 20000],
    margins: {
      top: PAGE.marginTop, bottom: 0,
      left: PAGE.marginLeft, right: PAGE.marginRight,
    },
  });
  scrap._theme = ctx.theme;
  scrap._page = PAGE;
  scrap._fonts = registerThemeFonts(scrap, ctx.issuer, ctx.theme);
  const body = bodyText(scrap);
  const top = PAGE.marginTop;
  // Each block is measured on its own as well as together: pinned, only the
  // total matters, but a closing text too tall to pin has to flow, and then
  // each block needs to be placed whole. drawTotals and drawPaymentBlock draw
  // every cell of a row at an explicit y, so a block that straddles a page
  // break leaves single cells stranded on pages of their own (#1546).
  const afterTotals = drawTotals(scrap, ctx, PAGE.marginLeft, top, PAGE.contentWidth);
  let y = afterTotals;
  if (ctx.doc.outroText) {
    scrap.font(scrap._fonts.body).fontSize(body.size);
    scrap.text(ctx.doc.outroText, PAGE.marginLeft, y, { width: PAGE.contentWidth, ...body.options });
    y = scrap.y + 12;
    scrap.fontSize(body.size);
  }
  const afterOutro = y;
  if (!isStorno) y = drawPaymentBlock(scrap, ctx, PAGE.marginLeft, y + 12, PAGE.contentWidth);
  // Deliberately not ended: nothing reads the bytes, and ending it would embed
  // the fonts and serialise a whole document we throw away.
  return {
    totals: Math.max(0, afterTotals - top),
    outro: Math.max(0, afterOutro - afterTotals),
    payment: isStorno ? 0 : Math.max(0, y - afterOutro),
    total: Math.max(0, y - top),
  };
}

function drawFooter(doc, issuer, locale, { bottomLimit = null } = {}) {
  // Footer format (per design review):
  //   "<Company>, <Street>, <CC>-<PostalCode> <City>, <CountryName>"
  // e.g.
  //   "Luca Bresch Media, Im Fetzer 45a, FL-9494 Schaan, Liechtenstein"
  //
  // The previous version printed `<PostalCode> <City>, <CC>` which
  // dropped the country prefix from the postal block AND used the
  // bare ISO code instead of the full country name.
  //
  // Footer sits within the content area (above the bottom margin) —
  // writing past doc.page.height - marginBottom triggers PDFKit's
  // auto-page-break (the original bug behind the mysterious empty
  // trailing pages).
  // Theme (#1445): the address line, a custom line, or no footer at all.
  const footer = (doc._theme && doc._theme.footer) || { mode: 'address', text: '' };
  const reserved = footerHeight(doc, issuer);
  if (!reserved) return;
  const lineH = footerLineHeight(doc._theme);
  const hasFooterLine = !!issuer.footerLine;
  const P = pageOf(doc);
  // Normally the footer sits in the bottom margin band. `bottomLimit` pulls it
  // up when something else owns the bottom of the page — the QR-bill's
  // reserved area on a page that carries both content and the slip (#1546).
  const defaultY = doc.page.height - P.marginBottom - reserved;
  const footerY = bottomLimit == null ? defaultY : Math.min(defaultY, bottomLimit - reserved);

  const cc = issuer.countryCode ? String(issuer.countryCode).toUpperCase() : '';
  const pc = issuer.postalCode || '';
  const postalLeft = cc && pc ? `${cc}-${pc}` : (pc || cc);
  const postalSegment = [postalLeft, issuer.city].filter(Boolean).join(' ');

  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(smallTextSize(doc._theme)).fillColor(themeColor(doc, 'subtle'));
  const parts = (footer.mode === 'custom' ? [footer.text] : [
    issuer.companyName,
    issuer.addressLine1,
    postalSegment,
    // Prefer the explicit country_name override (migration 107)
    // before falling back to the COUNTRY_NAMES lookup.
    issuer.countryName || countryName(issuer.countryCode, locale),
  ]).filter(Boolean);
  doc.text(parts.join(', '), P.marginLeft, footerY, {
    width: P.contentWidth, align: 'center', lineBreak: false,
  });
  if (hasFooterLine) {
    doc.text(issuer.footerLine, P.marginLeft, footerY + lineH, {
      width: P.contentWidth, align: 'center', lineBreak: false,
    });
  }
  // Reset fill colour so any code that runs after the footer (e.g.
  // the QR-bill page) doesn't inherit the grey.
  doc.fillColor(themeColor(doc, 'text'));
}

/**
 * Build the Swiss QR-bill payment slip from the issuer/recipient/amount, or
 * return null when this document has none and when swissqrbill refuses the
 * data. Drawing it is attachSwissQrBill's job, so the caller can lay the page
 * out around a slip it knows will render (#1546).
 *
 * The spec puts the slip full width at the bottom of a page, in its own
 * 105 mm band: either under the last invoice page's content, or on a page of
 * its own as it always was.
 */
function buildSwissQrBill(ctx) {
  if (ctx.qrFormat !== 'swiss') return null;
  const { issuer, bank, doc: docMeta, recipient } = ctx;
  if (!bank?.iban) return null;

  // swissqrbill expects amounts in major units (CHF, not Rappen).
  const totalMajor = Number(docMeta.totalAmountMinor || 0) / 100;

  try {
    return new SwissQRBill({
      currency: (ctx.currency || 'CHF').toUpperCase() === 'EUR' ? 'EUR' : 'CHF',
      amount: totalMajor > 0 ? totalMajor : undefined,
      creditor: {
        name: bank.accountHolder || issuer.companyName || '',
        address: issuer.addressLine1 || '',
        zip: issuer.postalCode || '',
        city: issuer.city || '',
        country: (issuer.countryCode || 'CH').toUpperCase(),
        account: bank.iban.replace(/\s+/g, ''),
      },
      debtor: recipient?.companyName ? {
        name: recipient.companyName.slice(0, 70),
        address: recipient.addressLine1 || '',
        zip: recipient.postalCode || '',
        city: recipient.city || '',
        country: (recipient.countryCodeIso || 'CH').toUpperCase(),
      } : undefined,
      message: docMeta.invoiceNumber ? `${docMeta.invoiceNumber}` : undefined,
    });
  } catch (err) {
    // Don't kill PDF rendering if QR generation fails — log + carry on.
    // The invoice without QR is still legally valid; admin gets a flag
    // via the calling service. Because this runs before the footer is
    // placed, a slip that can't be built also can't leave the page laid
    // out around one.
    const logger = require('../utils/logger');
    logger.warn('SwissQRBill render failed; emitting invoice without QR section', { err: err.message });
    return null;
  }
}

/**
 * Is the QR-bill's band on the current page free for it? Asked before the page
 * is laid out around the slip, because attachTo() answers the same question
 * itself and inserts a slip-sized page when it disagrees — one that nothing
 * marks as a payment slip, so it would be numbered and stamped at A4
 * coordinates (#1546).
 */
function slipBandIsClear(doc) {
  doc.y = doc.page.height - QR_BILL_BAND_HEIGHT;
  return SwissQRBill.isSpaceSufficient(doc);
}

/**
 * Draw a built slip: under the content of the page just finished, or on a
 * page of its own. Returns whether it landed.
 */
function attachSwissQrBill(doc, qr, { attachToCurrentPage = false } = {}) {
  // swissqrbill draws every field of the slip at an explicit y inside the
  // reserved band, and the band reaches the very bottom of the sheet. With a
  // bottom margin of 28-30mm (MARGIN_BOUNDS allows 30) PDFKit breaks the page
  // under the library's feet and the amount, "Konto / Zahlbar an", the IBAN and
  // "Zahlbar durch" land on pages of their own — a payment part with no amount
  // on it. Its own isSpaceSufficient can't see this: it compares against the
  // page height, not the margin. Zeroing the bottom margin for the draw is the
  // same trick stampPageNumbers uses to write into the margin band.
  const restoreBottom = doc.page.margins.bottom;
  if (attachToCurrentPage) {
    // The caller confirmed the band with slipBandIsClear before it placed the
    // footer; attachTo() measures the free space from `doc.y`, so put the
    // cursor back on the band's top edge.
    doc.y = doc.page.height - QR_BILL_BAND_HEIGHT;
    markSlipBandPage(doc);
  } else {
    doc.addPage();
    markPaymentSlipPage(doc);
  }
  try {
    doc.page.margins.bottom = 0;
    qr.attachTo(doc);
    return true;
  } catch (err) {
    // Same contract as a slip that couldn't be built: log it and emit the
    // invoice without the QR section. Before #1546 the draw sat inside
    // buildSwissQrBill's try; keeping it wrapped means a throw here still
    // costs the QR rather than the whole document.
    const logger = require('../utils/logger');
    logger.warn('SwissQRBill render failed; emitting invoice without QR section', { err: err.message });
    reportFinding(doc, { code: 'QR_MISSING', severity: 'warning' });
    return false;
  } finally {
    doc.page.margins.bottom = restoreBottom;
  }
}

/**
 * Build an EPC069-12 (SEPA Credit Transfer) QR payload.
 *
 * Format (each field on its own line, '\n' separator):
 *   1. "BCD"                          service tag
 *   2. "002"                          version
 *   3. "1"                            character set (UTF-8)
 *   4. "SCT"                          identification (SEPA Credit Transfer)
 *   5. BIC                            optional in v002
 *   6. Beneficiary name               max 70 chars, required
 *   7. IBAN                           no spaces, required
 *   8. Amount                         "EUR123.45", optional (customer
 *                                     enters amount manually if absent)
 *   9. Purpose                        ISO 11649 4-letter, optional
 *  10. Structured reference           max 35 chars, optional
 *  11. Unstructured reference         max 140 chars, optional
 *  12. Beneficiary-to-originator info max 70 chars, optional
 *
 * Total payload <= 331 bytes. EPC QR is EUR-only; banking apps
 * silently reject non-EUR payloads.
 */
function buildEpcPayload({ name, iban, amount, currency, reference }) {
  // Amount field: "<ISO 4217 3-letter><amount with 2 decimals>".
  // Spec says EUR-only, but many wallets accept other 3-letter
  // codes and either honour or ignore them. Emit whatever the
  // invoice carries so the QR isn't a no-op for CHF/USD/etc.
  const cur = String(currency || 'EUR').toUpperCase().slice(0, 3);
  const lines = [
    'BCD',
    '002',
    '1',
    'SCT',
    '',                                                 // BIC (optional in v002)
    String(name || '').slice(0, 70),
    String(iban || '').replace(/\s+/g, '').toUpperCase(),
    amount > 0 ? `${cur}${amount.toFixed(2)}` : '',
    '',                                                 // purpose
    '',                                                 // structured reference
    String(reference || '').slice(0, 140),              // unstructured reference
    '',                                                 // info
  ];
  return lines.join('\n');
}

/**
 * Append an EPC (SEPA) QR code to the document. Unlike Swiss QR-bill
 * which is a full-page payment slip, EPC is just a QR code with a
 * short caption — banking apps scan it to prefill a SEPA Credit
 * Transfer. We add it on a fresh page so it never collides with the
 * line items / totals above.
 *
 * Requires EUR currency. Non-EUR docs log a warning and skip — EPC
 * QR codes in CHF/USD/etc. are silently rejected by every major
 * banking app, so emitting one would be worse than emitting nothing.
 */
async function appendEpcQr(doc, ctx) {
  if (ctx.qrFormat !== 'epc') return;
  const logger = require('../utils/logger');
  const { issuer, bank, doc: docMeta } = ctx;

  if (!bank?.iban) {
    logger.warn('EPC QR skipped — no IBAN on the resolved bank account');
    return;
  }

  // EPC069-12 spec is technically EUR-only, but most banking apps
  // still parse the payload for non-EUR currencies and either honor
  // it (when the bank supports the destination currency) or fall
  // back to manual entry. Render the QR regardless and log a note
  // when the currency isn't EUR so the admin sees it in the logs —
  // emitting something is always more useful than emitting nothing.
  const currencyUpper = (ctx.currency || 'EUR').toUpperCase();
  if (currencyUpper !== 'EUR') {
    logger.info('EPC QR rendered with non-EUR currency; banking apps may fall back to manual entry', {
      currency: currencyUpper,
    });
  }

  const totalMajor = Number(docMeta.totalAmountMinor || 0) / 100;
  const payload = buildEpcPayload({
    name: bank.accountHolder || issuer.companyName || '',
    iban: bank.iban,
    amount: totalMajor,
    currency: currencyUpper,
    reference: docMeta.invoiceNumber || '',
  });

  let pngBuffer;
  try {
    const QRCode = require('qrcode');
    pngBuffer = await QRCode.toBuffer(payload, {
      errorCorrectionLevel: 'M',
      type: 'png',
      margin: 2,
      width: 320,
    });
  } catch (err) {
    logger.warn('EPC QR generation failed', { err: err.message });
    return;
  }

  // A page of its own: with the totals and payment block pinned to the foot of
  // the last content page there is never room for this block above them, and
  // unlike the Swiss slip it has no reserved band of its own to sit in.
  // Centred, with a caption explaining what it is.
  const P = pageOf(doc);
  doc.addPage();
  markPaymentSlipPage(doc);
  const captionTop = P.marginTop + 20;
  doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(14).fillColor(themeColor(doc, 'text'));
  doc.text(t(ctx.locale, 'epc_qr_title'), P.marginLeft, captionTop, {
    width: P.contentWidth, align: 'center', lineBreak: false,
  });
  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(10).fillColor('#444');
  doc.text(t(ctx.locale, 'epc_qr_subtitle'), P.marginLeft, captionTop + 22, {
    width: P.contentWidth, align: 'center',
  });

  // QR centred on the page, sized at ~180pt (≈63mm) — comfortably
  // scannable on every phone camera + small enough to leave room
  // for the printed IBAN beneath.
  const qrSize = 180;
  const qrX = (P.width - qrSize) / 2;
  const qrY = captionTop + 60;
  try {
    doc.image(pngBuffer, qrX, qrY, { fit: [qrSize, qrSize] });
  } catch (err) {
    logger.warn('EPC QR embed failed', { err: err.message });
    return;
  }

  // Human-readable summary under the QR so the customer can still
  // initiate the transfer manually if their banking app can't scan.
  const summaryY = qrY + qrSize + 24;
  doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(10).fillColor(themeColor(doc, 'text'));
  const summaryLines = [
    bank.accountHolder || issuer.companyName || '',
    bank.iban.replace(/(.{4})/g, '$1 ').trim(),
    bank.bic ? `BIC: ${bank.bic}` : '',
    totalMajor > 0
      ? `${t(ctx.locale, 'totals_grand')}: ${currencyUpper} ${formatMinor(docMeta.totalAmountMinor, currencyUpper, ctx.intlLocale)}`
      : '',
    docMeta.invoiceNumber
      ? `${t(ctx.locale, 'reference_label')}: ${docMeta.invoiceNumber}`
      : '',
  ].filter(Boolean);
  let lineY = summaryY;
  for (const line of summaryLines) {
    doc.text(line, P.marginLeft, lineY, { width: P.contentWidth, align: 'center' });
    lineY = doc.y + 2;
  }
}

/** Register the theme's faces; falls back to the issuer's family, then Helvetica. */
function registerThemeFonts(doc, issuer = {}, theme = null) {
  const fontFamily = (theme && theme.fontFamily) || issuer.pdfFontFamily || null;
  // An uploaded family arrives as `theme.fontFiles`, resolved by the theme
  // service before the render (services/pdf/uploadedFonts).
  const fonts = pdfFonts.registerFonts(doc, { fontFamily, fontFiles: theme && theme.fontFiles });
  // A configured font that can't be loaded falls back to Helvetica without a
  // word; a render that collects findings (the template check) hears of it.
  if (!fonts && fontFamily) {
    reportFinding(doc, { code: 'FONT_MISSING', severity: 'warning', key: fontFamily || 'custom' });
  }
  return fonts || { body: FONT_BODY, bold: FONT_BOLD, italic: FONT_ITALIC };
}

/**
 * Note a problem the render worked around (a missing font or logo) on
 * `doc._findings`, when the caller asked for them (#1445 template check).
 */
function reportFinding(doc, finding) {
  if (!doc || !Array.isArray(doc._findings)) return;
  if (!doc._findings.some((f) => f.code === finding.code)) doc._findings.push(finding);
}

/** Remember that the page just added is a payment slip (QR-bill or EPC). */
function markPaymentSlipPage(doc) {
  const range = doc.bufferedPageRange();
  if (!doc._paymentSlipPages) doc._paymentSlipPages = new Set();
  doc._paymentSlipPages.add(range.start + range.count - 1);
}

/**
 * Remember that the page just drawn carries a QR-bill band at its bottom but
 * document content above it. Unlike a dedicated slip page it stays numbered
 * and counted — its footer and page number move above the band (#1546).
 */
function markSlipBandPage(doc) {
  const range = doc.bufferedPageRange();
  if (!doc._slipBandPages) doc._slipBandPages = new Set();
  doc._slipBandPages.add(range.start + range.count - 1);
}

/**
 * "Page x of y" in each page's bottom margin, at the theme's position —
 * except on a payment-slip page, which has its own fixed layout and isn't
 * counted (#1445; the label used to land inside the QR-bill's payment
 * part). `beforeStamp` runs on every numbered page first (the contract
 * footer).
 */
/**
 * `insertedBeforeLast` is how many pages will be merged in before the last
 * page (a contract's merged attachments). The footers are drawn here, before
 * that merge, so without it a signature page sitting after 20 attachment
 * pages read "3 of 3".
 */
function stampPageNumbers(doc, locale, { beforeStamp, insertedBeforeLast = 0, docLabel = null } = {}) {
  const position = (doc._theme && doc._theme.pageNumbers) || 'bottom-right';
  const range = doc.bufferedPageRange();
  const slips = doc._paymentSlipPages || new Set();
  const bands = doc._slipBandPages || new Set();
  const pages = [];
  for (let i = range.start; i < range.start + range.count; i += 1) {
    if (!slips.has(i)) pages.push(i);
  }
  pages.forEach((pageIndex, n) => {
    doc.switchToPage(pageIndex);
    // With the page already laid out, a bottom margin of 0 lets us write
    // into the margin band without PDFKit starting a new page (#794).
    doc.page.margins.bottom = 0;
    if (beforeStamp) beforeStamp(pageIndex);
    if (position === 'none') return;
    doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(smallTextSize(doc._theme)).fillColor(themeColor(doc, 'subtle'));
    const inserted = Math.max(0, Number(insertedBeforeLast) || 0);
    const total = pages.length + inserted;
    const isLast = n === pages.length - 1;
    const pageLabel = t(locale, 'page_of', { current: isLast ? total : n + 1, total });
    // A continuation page separated from the first one still names the
    // document it belongs to (#1546); the first page carries the number in
    // full already.
    const label = n > 0 && docLabel ? `${docLabel} · ${pageLabel}` : pageLabel;
    const centred = position === 'bottom-center';
    const P = pageOf(doc);
    const labelW = centred ? P.contentWidth : 240;
    const labelX = centred ? P.marginLeft : doc.page.width - P.marginRight - labelW;
    // A page whose bottom 105 mm belong to the QR-bill keeps its number above
    // the slip, where the footer sits too.
    const labelY = bands.has(pageIndex)
      ? doc.page.height - QR_BILL_BAND_HEIGHT - SLIP_BAND_NUMBER_GAP
      : doc.page.height - P.marginBottom + 8;
    doc.text(label, labelX, labelY, {
      width: labelW, align: centred ? 'center' : 'right', lineBreak: false,
    });
    doc.fillColor(themeColor(doc, 'text'));
  });
}

/**
 * Build a configured PDFDocument with our font conventions and return
 * it alongside its page metrics. Used by both the quote/invoice
 * renderer below (portrait, DIN 5008) and the tax-report renderer
 * (landscape, wide table). Keeps font registration + page sizing in
 * one place so future PDF features stay consistent.
 *
 *   options = {
 *     orientation: 'portrait' | 'landscape' (default 'portrait'),
 *     issuer: { pdfFontTtfPath? } — used for optional custom-font registration,
 *     info:   { Title?, Author? } — PDF metadata (filename in Chrome viewer),
 *   }
 *
 * Returns: { doc, page, fonts } where
 *   doc   — pdfkit PDFDocument instance, ready to write to
 *   page  — page metrics for the chosen orientation (see getPageMetrics)
 *   fonts — { body, bold } logical font names; the caller passes these
 *           to doc.font(...) calls and they resolve to either the
 *           built-in Helvetica family or the admin's custom TTF.
 *
 * The function does NOT pipe the document to a stream — the caller
 * decides whether to buffer (`doc.on('data', ...)`) or stream straight
 * to an HTTP response. Mirrors the pattern the existing renderDocument
 * already uses internally.
 */
function createBaseDocument(options = {}) {
  const orientation = options.orientation === 'landscape' ? 'landscape' : 'portrait';
  const page = getPageMetrics(orientation);
  const doc = new PDFDocument({
    size: 'A4',
    layout: orientation,
    bufferPages: true,
    margins: {
      top: page.marginTop, bottom: page.marginBottom,
      left: page.marginLeft, right: page.marginRight,
    },
    info: options.info || {},
  });

  // Font registration. Resolution priority:
  //   1. issuer.pdfFontTtfPath  → legacy free-text upload (migration 103).
  //      The UI for setting it was retired in favour of the dropdown,
  //      but any existing value still wins so deployments that already
  //      pointed at a custom brand font keep rendering with it.
  //   2. issuer.pdfFontFamily   → bundled-fonts dropdown (migration 121).
  //      Maps to backend/assets/fonts/<family>/400.ttf for body and
  //      <family>/700.ttf for bold. Falls back to 600/400 if 700 is
  //      missing (some families don't ship every weight).
  //   3. Helvetica              → PDFKit's built-in default.
  //
  // Same block is mirrored below in renderDocument so quote / invoice
  // / tax-report PDFs all resolve fonts identically.
  // `options.theme` (#1445) picks the font family and colours; without it
  // the issuer's family (or Helvetica) and the built-in colours apply.
  doc._theme = options.theme || null;
  doc._fonts = registerThemeFonts(doc, options.issuer || {}, options.theme || null);

  return { doc, page, fonts: doc._fonts };
}

/**
 * Register the issuer's custom font faces (legacy uploaded TTF, else the
 * bundled family) per services/pdf/fonts.js. Returns the
 * `{ body, bold, italic }` logical names when a custom font applies, or
 * `null` when the document stays on Helvetica.
 *
 * Exported via _internal for unit tests.
 */
function registerCustomFonts(doc, issuer) {
  if (!issuer || typeof issuer !== 'object') return null;
  return pdfFonts.registerFonts(doc, { fontFamily: issuer.pdfFontFamily });
}

/**
 * The main renderer. `type` is 'quote' | 'invoice'. Returns Buffer.
 */
function renderDocument(type, context) {
  return new Promise((resolve, reject) => {
    // Wrap the body in an async IIFE so we can `await` the EPC QR
    // PNG generation (which uses the qrcode library asynchronously).
    // Errors from the IIFE bubble up via reject(); the doc 'end'
    // event still resolves the outer Promise once writes flush.
    (async () => {
      try {
        const ctx = normaliseContext(type, context);
        // The theme's margins (#1445); every PAGE below is this letter's.
        const PAGE = pageMetricsFor(ctx.theme);
        const doc = new PDFDocument({
          size: 'A4',
          // bufferPages: true keeps every page open in memory after
          // they're emitted so we can switch back and stamp the page
          // numbers ("Page 1 of N" / "Seite 1 von N") once we know how
          // many pages the document ended up with. Without buffering,
          // PDFKit flushes each page as soon as the next one starts,
          // so we couldn't know N until it was too late.
          bufferPages: true,
          margins: {
            top: PAGE.marginTop, bottom: PAGE.marginBottom,
            left: PAGE.marginLeft, right: PAGE.marginRight,
          },
          info: {
          // Chrome's built-in PDF viewer uses this Title metadata
          // as the default save name when the PDF is served from a
          // blob URL (where the original HTTP Content-Disposition
          // header can't propagate). Format mirrors the filename
          // we set on the HTTP response: "<number>_<customerLabel>"
          // so saved files have a meaningful name in either path.
            Title: (() => {
              const docNumber = ctx.doc.invoiceNumber || ctx.doc.quoteNumber
              || (type === 'quote' ? 'Quote' : 'Invoice');
              // Prefer the recipient (customer) for the label —
              // matches how admins typically file invoices.
              const recipient = ctx.recipient?.companyName || '';
              return recipient ? `${docNumber}_${recipient}` : String(docNumber);
            })(),
            Author: ctx.issuer.companyName || 'picpeak',
            // A fixed creation date makes the same inputs give the same bytes:
            // PDFKit's /ID is derived from this dictionary, so without it two
            // renders of one document differ. Callers that compare renders
            // (the tests, the theme preview) pass it; a send does not, because
            // each sent file is recorded with its own sha256.
            ...(ctx.generatedAt ? { CreationDate: new Date(ctx.generatedAt) } : {}),
          },
        });

        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Font registration. Same resolution priority as
        // createBaseDocument: pdfFontTtfPath (legacy override) →
        // pdfFontFamily (bundled dropdown) → Helvetica. Helpers below
        // read `doc._fonts` (one extra word per doc) so we don't have
        // to thread the font names through every drawing function or
        // fork the helpers per branding.
        // The theme (#1445) adds colours, the title size, the footer and
        // page-number settings, and an italic face for line comments.
        doc._theme = ctx.theme;
        doc._page = PAGE;
        doc._fonts = registerThemeFonts(doc, ctx.issuer, ctx.theme);
        ctx.fonts = doc._fonts;
        const body = bodyText(doc);

        // ---- header layout (DIN 5008 Form B) -------------------------
        //   - recipient block in the address window (top-left,
        //     45mm from top, 20mm from left, 85×45mm)
        //   - issuer block top-right (logo + company + address +
        //     contact) sized to NOT overlap the address window
        //
        // The two blocks are positioned absolutely; we keep a `y`
        // cursor for the body content that starts BELOW both blocks.
        const leftX = PAGE.marginLeft;
        const metaRight = leftX + PAGE.contentWidth;
        // Sender column: nudged down by 16pt so it doesn't crowd the very top
        // of the page, leaving room for the logo + name banner above it.
        const issuerY = PAGE.marginTop + 16;
        const windowOn = addressWindowOn(doc);
        const windowBottom = windowOn ? ADDR_WINDOW.top + ADDR_WINDOW.height : 0;

        // Storno discriminator. Drives:
        //   - page title swap ("Stornorechnung" instead of "Rechnung")
        //   - the mandatory reference row in the meta block
        //   - sign flip on line totals (row-level totals are already
        //     stored negative in the DB, so drawTotals renders them
        //     naturally — see drawLineItems for the per-item flip)
        //   - suppression of payment terms / IBAN / QR-bill blocks
        // `type === 'invoice'` is preserved as the outer document
        // family — Storni share the invoice renderer surface, only
        // the cosmetic + accounting-sign branches differ.
        const isStorno = type === 'invoice' && ctx.doc.kind === 'storno';
        // Mahnung (reminder letter) reuses the invoice surface: same line items +
        // a Mahngebühr row + the new grand total, but a "Mahnung" title and NO
        // QR (the QR would encode the original amount, not the new total).
        const isMahnung = type === 'invoice' && ctx.doc.kind === 'mahnung';

        // ---- the right-hand column ------------------------------------
        // The sender's contact rows and the document's meta block
        // ("Informationsblock": number, dates, references) are two halves of one
        // letterhead column. They are built and measured before either is drawn
        // so both sit on the same grid — one colon edge, one right edge, the
        // page's right margin (#1546).
        const docNumberForDisplay = ctx.doc.invoiceNumber || ctx.doc.quoteNumber || '';
        const numberLabelKey = type === 'quote' ? 'quote_number_label' : 'invoice_number_label';
        const issueDateText = formatDate(ctx.doc.issueDate, ctx.dateFormat);

        const metaRows = [];
        if (docNumberForDisplay) metaRows.push([t(ctx.locale, numberLabelKey), docNumberForDisplay]);
        metaRows.push([t(ctx.locale, 'date'), issueDateText]);
        if (type === 'invoice') {
          // The date or period of the service (MWSTG Art. 26): the event
          // date, or a monthly invoice's period. Nothing when neither exists.
          const period = ctx.doc.servicePeriod;
          if (period && period.from) {
            const from = formatDate(period.from, ctx.dateFormat);
            const to = period.to ? formatDate(period.to, ctx.dateFormat) : null;
            if (to && to !== from) metaRows.push([t(ctx.locale, 'service_period'), `${from} – ${to}`]);
            else if (from !== issueDateText) metaRows.push([t(ctx.locale, 'service_date'), from]);
            // A service date that only repeats the issue date reads as a
            // duplicate, but MWSTG Art. 26 and §14(4) Nr. 6 UStG want the time
            // of supply on the document. Settings → CRM → Invoices decides
            // which way that goes (#1546); the default states it in words.
            else if (ctx.serviceDateMode === 'note') {
              metaRows.push([t(ctx.locale, 'service_date'), t(ctx.locale, 'service_date_same_as_issue')]);
            } else if (ctx.serviceDateMode === 'repeat') {
              metaRows.push([t(ctx.locale, 'service_date'), from]);
            }
          }
          // The due date, on the invoice itself (not on a Storno or a Mahnung).
          if (!isStorno && !isMahnung && ctx.doc.dueDate) {
            metaRows.push([t(ctx.locale, 'due_date'), formatDate(ctx.doc.dueDate, ctx.dateFormat)]);
          }
        }
        // The dated rows above set the column widths. A reference is prose
        // rather than a figure and can be half a line long, so it is added
        // after the grid is measured and only takes a grid row when it fits
        // one — otherwise it would stretch the value column and drag every
        // label out of line.
        const letterhead = letterheadText(doc);
        const gridRows = [
          ...issuerContactRows(ctx.issuer, ctx.locale)
            .map(([label, value]) => [label, value, letterhead.size]),
          ...metaRows.map(([label, value]) => [label, value, letterhead.size]),
        ];
        const grid = measureLabelGrid(doc, gridRows, metaRight, {
          leftLimit: windowOn ? ADDR_WINDOW.left + ADDR_WINDOW.width + 12 : leftX,
        });

        // Every document this one points at is a row of the same block (#1546).
        // They used to be full-width lines under the title, where they read as
        // the opening of the letter rather than as the document's metadata.
        //
        // A Storno names the invoice it reverses: the §14c-defensible link from
        // the cancellation to the original. Readers and Finanzamt auditors need
        // both numbers and the original issue date to reconstruct the chain
        // from the documents alone, so it is stamped first and carries its date.
        //
        // An invoice names the quote it came from. We keep invoice numbers on a
        // strict monotonic sequence (R-YYYY-NNNN) because CH/LI/DE/AT require
        // "lückenlose Rechnungsnummern", so the provenance is a reference
        // rather than a mirrored number.
        //
        // A cancelled-and-reissued invoice (migration 114) and a reissued quote
        // (#1451) name what they replace, so the chain stays traceable.
        const datedReference = (relationKey, titleKey, ref) => {
          const datePart = ref.issueDate
            ? ` ${t(ctx.locale, 'reference_dated', { date: formatDate(ref.issueDate, ctx.dateFormat) })}`
            : '';
          return `${t(ctx.locale, relationKey)} ${t(ctx.locale, titleKey)} ${ref.number}${datePart}`;
        };
        const references = [];
        if (isStorno && ctx.doc.cancelsInvoice) {
          references.push(datedReference('reference_cancels', 'invoice_title', ctx.doc.cancelsInvoice));
        }
        if (type === 'invoice' && !isStorno && ctx.doc.sourceQuoteNumber) {
          references.push(`${t(ctx.locale, 'quote_title')} ${ctx.doc.sourceQuoteNumber}`);
        }
        if (type === 'invoice' && !isStorno && ctx.doc.replacesInvoice) {
          references.push(datedReference('reference_replaces', 'invoice_title', ctx.doc.replacesInvoice));
        }
        if (type === 'quote' && ctx.doc.replacesQuote) {
          references.push(datedReference('reference_replaces', 'quote_title', ctx.doc.replacesQuote));
        }

        // ---- header blocks --------------------------------------------
        // A logo the theme places at the left or centre (#1445) goes first;
        // the issuer column and a recipient in the flow start below it.
        const logoBottom = drawPageLogo(doc, ctx.issuer);
        const centredLogo = logoBottom != null && ctx.theme.logo && ctx.theme.logo.position === 'center';
        const issuerEndY = drawIssuerBlock(doc, ctx.issuer, grid.labelX,
          centredLogo ? Math.max(issuerY, logoBottom) : issuerY,
          metaRight - grid.labelX, ctx.locale, { grid });
        const recipientEndY = drawRecipientBlock(doc, ctx.recipient, ctx.locale,
          windowOn ? {} : { flowY: Math.max(issuerY, logoBottom || 0) });

        // ---- meta block -----------------------------------------------
        // Bottom-aligned to the address field's lower edge: DIN 5008 Form B
        // sets the two level with each other, and ending them together means
        // the title can start immediately under both, with neither a dead band
        // between header and body nor everything crowded against the top.
        doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(letterhead.size).fillColor(themeColor(doc, 'text'));
        const referenceLabel = t(ctx.locale, 'reference_label');
        const besideField = [...metaRows];
        const underField = [];
        references.forEach((value) => {
          if (doc.widthOfString(value) + 2 <= grid.valueW) besideField.push([referenceLabel, value]);
          else underField.push([referenceLabel, value]);
        });

        let y = windowOn
          ? Math.max(issuerEndY + 12, windowBottom - besideField.length * letterhead.leading)
          : Math.max(issuerEndY, recipientEndY) + 6;
        besideField.forEach(([label, value]) => {
          drawGridRow(doc, grid, label, value, y);
          y += letterhead.leading;
        });

        // The body starts below the meta block AND below the address field —
        // whichever reaches further down.
        y = Math.max(y, recipientEndY, windowBottom);
        // A reference too long for the grid's value column reads as one
        // full-width row under the field rather than wrapping in the column.
        underField.forEach(([label, value]) => {
          doc.text(`${label}: ${value}`, leftX, y, { width: PAGE.contentWidth, align: 'left' });
          y = doc.y + 2;
        });
        y += 4; // cushion before the title

        // ---- title ----------------------------------------------------
        const title = type === 'quote'
          ? t(ctx.locale, 'quote_title')
          : isStorno
            ? t(ctx.locale, 'storno_title')
            : isMahnung
              ? t(ctx.locale, 'mahnung_title')
              : t(ctx.locale, 'invoice_title');
        y = drawTitle(doc, title, leftX, y + 2);

        // ---- salutation + lead-in ------------------------------------
        // Personalised greeting when the customer record has an
        // honorific + last name on file ("Sehr geehrter Herr Bresch,"),
        // otherwise the generic locale-specific opening from the i18n
        // dictionary ("Sehr geehrte Damen und Herren,").
        const greeting = personalSalutation(ctx.locale, ctx.recipient?.salutation, ctx.recipient?.lastName)
        || t(ctx.locale, 'salutation');
        doc.font(doc._fonts ? doc._fonts.bold : FONT_BOLD).fontSize(body.size).fillColor(themeColor(doc, 'text'));
        doc.text(greeting, leftX, y, { width: PAGE.contentWidth, ...body.options });
        y = doc.y + 4;
        doc.font(doc._fonts ? doc._fonts.body : FONT_BODY);
        const leadIn = type === 'quote'
          ? t(ctx.locale, 'lead_in_quote')
          : t(ctx.locale, 'lead_in_invoice');
        doc.text(leadIn, leftX, y, { width: PAGE.contentWidth, ...body.options });
        y = doc.y + 16;

        // ---- intro text override (admin-customisable) -----------------
        if (ctx.doc.introText) {
          doc.text(ctx.doc.introText, leftX, y, { width: PAGE.contentWidth, ...body.options });
          y = doc.y + 12;
        }
        doc.fontSize(body.size);

        // ---- line items table ----------------------------------------
        // Small top padding — tight against the lead-in text since the
        // maintainer wants the items right under the greeting/intro.
        y += 8;
        doc.y = y;
        doc.x = leftX;

        // The table plans its own page breaks (drawLineItems), so it can put
        // a carry-over row at the foot of a page that continues and keep the
        // last page's foot free for the blocks pinned there. Only the last
        // page is shortened — an earlier approach inflated the bottom margin
        // for the whole table, which shortened EVERY page and broke a long
        // invoice far too early.
        // ---- what the closing blocks need -----------------------------
        // Measured before the table draws, by rendering them once into a
        // document that is thrown away: they are pinned to the foot of the last
        // page, so the table has to stop exactly that far short (#1546).
        const closing = measureClosingHeight(ctx, PAGE, { isStorno });
        const closingHeight = closing.total;

        // Where the closing blocks sit: above the footer, or above the QR-bill's
        // reserved band when the slip shares the page. Both anchors are fixed —
        // the blocks are pinned to the foot of the page, wherever the table
        // happened to end.
        const footerReserve = footerHeight(doc, ctx.issuer);
        const bandTop = PAGE.height - QR_BILL_BAND_HEIGHT;
        const closingTop = (withSlip) => (withSlip
          ? bandTop - SLIP_BAND_FOOTER_GAP
          : PAGE.height - PAGE.marginBottom) - footerReserve - FOOTER_AIR - closingHeight;
        // What the table has to leave free on its last page: the closing blocks,
        // the footer under them, and a line of air between table and totals.
        const TABLE_TO_CLOSING_GAP = 12;
        const idealReserve = PAGE.height - PAGE.marginBottom
          - (closingTop(false) - TABLE_TO_CLOSING_GAP);
        // A closing block can only be pinned if it leaves the table a page worth
        // having. A quote whose outro runs to several thousand characters is
        // taller than the page on its own, and then the blocks flow from the
        // table and paginate themselves, as any long body text does.
        const usable = PAGE.height - PAGE.marginBottom - PAGE.marginTop;
        const pinned = idealReserve <= usable * 0.6;
        const tableReserve = pinned ? idealReserve : 0;

        drawLineItems(doc, ctx, { reserveOnLastPage: tableReserve });
        const tableEnd = doc.y;

        // ---- totals + payment block, pinned to the foot ---------------
        // The QR-bill is built first so the page is only laid out around a slip
        // that will actually render, and so its band is known before the
        // closing blocks are placed.
        const qrBill = type === 'invoice' && !isStorno && !isMahnung
          ? buildSwissQrBill(ctx)
          : null;
        // The table left room for these blocks, so they pin to the foot of the
        // page it ended on. A single line item taller than that room is the one
        // case where it can't, and then they take a page of their own rather
        // than being drawn over the footer.
        let contentTop = tableEnd + TABLE_TO_CLOSING_GAP;
        if (pinned && contentTop > closingTop(false)) {
          doc.addPage();
          contentTop = PAGE.marginTop;
        }
        // The slip shares this page only when the closing blocks still clear
        // its band, and only when they are pinned — a block that flows can end
        // anywhere. On a first page the address field alone reaches the middle
        // of the sheet, so a single-page invoice never shares; a continuation
        // page that carries only a few rows usually does.
        //
        // The library is asked as well: if it would refuse the space it would
        // insert a slip-sized page of its own, and the footer has already been
        // placed for a page that carries the band.
        const slipSharesPage = !!qrBill && pinned && contentTop <= closingTop(true)
          && slipBandIsClear(doc);
        y = pinned ? closingTop(slipSharesPage) : contentTop;
        // Flowing, because the blocks together are taller than the page. Only
        // the outro may actually flow: the totals and the payment block draw
        // every cell of a row at an explicit y, so PDFKit breaks the page
        // between two cells of the same row and strands them on pages of their
        // own. Each of those blocks is therefore placed whole, on a fresh page
        // when this one can't hold it (#1546).
        const flowBottom = PAGE.height - PAGE.marginBottom - footerReserve - FOOTER_AIR;
        const startBlock = (height) => {
          if (y + height <= flowBottom) return;
          doc.addPage();
          y = PAGE.marginTop;
        };
        if (!pinned) startBlock(closing.totals);

        // ---- totals box (right-aligned) -------------------------------
        y = drawTotals(doc, ctx, leftX, y, PAGE.contentWidth);

        // ---- outro text -----------------------------------------------
        // The one block that may run over a page: it is a single wrapped
        // paragraph, so PDFKit breaks it between lines. The raised bottom
        // margin keeps that break above the footer band, on this page and on
        // any it adds.
        if (ctx.doc.outroText) {
          const clear = PAGE.marginBottom + footerReserve + FOOTER_AIR;
          if (!pinned) {
            doc.page.margins.bottom = clear;
            doc.options.margins.bottom = clear;
          }
          doc.font(doc._fonts ? doc._fonts.body : FONT_BODY).fontSize(body.size).fillColor(themeColor(doc, 'text'));
          doc.text(ctx.doc.outroText, leftX, y, { width: PAGE.contentWidth, ...body.options });
          y = doc.y + 12;
          doc.fontSize(body.size);
          if (!pinned) {
            doc.page.margins.bottom = PAGE.marginBottom;
            doc.options.margins.bottom = PAGE.marginBottom;
          }
        }

        // ---- payment conditions + IBAN block --------------------------
        // Suppressed on Stornorechnungen: a cancellation document is
        // not a payment instrument — no Zahlungsbedingungen, no IBAN,
        // no Skonto. Customers reading a Storno expect total clarity
        // that this is the REVERSAL of an obligation, not a new one.
        if (!isStorno) {
          if (!pinned) startBlock(closing.payment + 12);
          y = drawPaymentBlock(doc, ctx, leftX, y + 12, PAGE.contentWidth);
        }

        // ---- folding marks (left edge) --------------------------------
        drawFoldingMarks(doc, context.theme ? ctx.theme.foldingMarks : ctx.issuer?.foldingMarks);

        // ---- footer ---------------------------------------------------
        // On a page that also carries the QR-bill the footer moves up, so it
        // stays out of the slip's reserved area.
        drawFooter(doc, ctx.issuer, ctx.locale,
          slipSharesPage ? { bottomLimit: bandTop - SLIP_BAND_FOOTER_GAP } : {});

        // ---- payment QR (invoices only) -------------------------------
        // Two paths, mutually exclusive:
        //   - 'swiss' → SwissQRBill payment slip (CHF / EUR within CH/LI)
        //   - 'epc'   → SEPA EPC069-12 QR code (EUR-only, every SEPA bank)
        // The slip can share the last page when its band is clear; the EPC
        // block keeps a page of its own, because with the closing blocks
        // pinned to the foot there is never room for it above them.
        // 'none' is a no-op. Suppressed on Stornorechnungen — negative-amount
        // QR codes aren't a defined construct in either spec.
        if (type === 'invoice' && !isStorno && !isMahnung) {
          if (qrBill) {
            attachSwissQrBill(doc, qrBill, { attachToCurrentPage: slipSharesPage });
          } else if (ctx.qrFormat === 'epc') {
            await appendEpcQr(doc, ctx);
          }
        }

        // ---- page numbers ("Page 1 of N" / "Seite 1 von N") -----------
        // Stamped after everything else so we know the final page
        // count. bufferPages: true (on the PDFDocument options above)
        // keeps every page open for back-editing — bufferedPageRange()
        // returns {start, count}. We switchToPage() each one, draw the
        // pagination label in the bottom-right corner, then end.
        try {
          // Stamp on every page including single-page documents: "Page 1 of
          // 1" tells the recipient the document is complete. The payment-slip
          // page is left alone and not counted (#1445).
          stampPageNumbers(doc, ctx.locale, { docLabel: docNumberForDisplay || null });
        } catch (err) {
          const logger = require('../utils/logger');
          logger.warn('Failed to stamp page numbers on PDF', { err: err.message });
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
    })();
  });
}

/**
 * Normalise + default the context shape so the rest of the renderer
 * can rely on it without optional-chaining everywhere.
 */
function normaliseContext(type, ctx) {
  const locale = ctx.locale || 'de';
  return {
    type,
    locale,
    intlLocale: localeForIntl(locale, ctx.issuer?.countryCode),
    currency: (ctx.currency || ctx.doc?.currency || ctx.issuer?.defaultCurrency || 'CHF').toUpperCase(),
    issuer: ctx.issuer || {},
    recipient: ctx.recipient || {},
    bank: ctx.bank || null,
    paymentTerm: ctx.paymentTerm || null,
    lineItems: Array.isArray(ctx.lineItems) ? ctx.lineItems : [],
    totals: ctx.totals || {},
    doc: ctx.doc || {},
    qrFormat: ctx.qrFormat || 'none',
    // Free-text VAT/legal note printed under the MwSt. line on invoices (#794).
    vatNote: (typeof ctx.vatNote === 'string' && ctx.vatNote.trim()) ? ctx.vatNote.trim() : null,
    // Is the business VAT-registered (Settings → Accounting)? Null = never set.
    vatRegistered: typeof ctx.vatRegistered === 'boolean' ? ctx.vatRegistered : null,
    // What to print when the service date is the issue date (Settings → CRM →
    // Invoices): say so in words, repeat the date, or leave the row out.
    serviceDateMode: ['note', 'repeat', 'omit'].includes(ctx.serviceDateMode)
      ? ctx.serviceDateMode : 'note',
    // Date-format config from the `general_date_format` app setting.
    // Shape: `{ format: 'DD.MM.YYYY' | 'DD/MM/YYYY' | 'MM/DD/YYYY' |
    // 'YYYY-MM-DD', locale?: string }`. The service layer hydrates
    // this; defaults to DD.MM.YYYY when unset.
    dateFormat: ctx.dateFormat || { format: 'DD.MM.YYYY' },
    // PDF theme (#1445); callers without one get the built-in look.
    theme: ctx.theme || builtInTheme(type),
    generatedAt: ctx.generatedAt || null,
  };
}

/**
 * A business that isn't VAT-registered (Settings → Accounting) shows no VAT
 * on its documents (MWSTG Art. 27): no MwSt. row when the document carries
 * none, and the VAT note stands in its place. Never set → the row stays; a
 * document that does carry VAT keeps its row, so the totals add up.
 */
function vatRowHidden(ctx) {
  const totals = ctx.totals || {};
  return ctx.vatRegistered === false && !Number(totals.vatRate) && !Number(totals.vatAmountMinor);
}

// The public renderers go through services/pdf/renderIsolation (#1445): a
// worker thread with a heap limit and a timeout, so one pathological document
// can't stall or exhaust the server. The worker calls the `_raw` functions.
const isolation = () => require('./pdf/renderIsolation');

async function renderQuoteToBuffer(context) {
  return (await isolation().renderInWorker('quote', context)).buffer;
}

async function renderInvoiceToBuffer(context) {
  return (await isolation().renderInWorker('invoice', context)).buffer;
}

/**
 * Render a contract PDF. `context` is the shape produced by
 * contractService.buildRenderContext: { locale, issuer, recipient, doc,
 * sections, signatures }. Returns Promise<Buffer>.
 *
 * Layout:
 *   - DIN 5008 envelope window (same as quotes/invoices) so the
 *     recipient address lines up with envelope windows.
 *   - Title from doc.title (admin-typed) or t('contract_title').
 *   - Contract number + issue date right-aligned under the issuer block.
 *   - intro_text paragraph.
 *   - For each section: bold heading from t('section_<key>'), then each
 *     block rendered as a paragraph (block.name bold, then block.body).
 *   - outro_text paragraph.
 *   - Two-column signature block at the bottom of the closing page, with
 *     the signer's name and date under each box. Signature images are
 *     stamped in afterwards by pdfStampService, never by this renderer.
 */
/**
 * Render a contract. Resolves `{ buffer, slots }`: where each signature slot
 * landed on the signature page (#1445), for the stamp service and the
 * generated document's record. Runs in the render worker.
 */
async function renderContractWithSlots(context) {
  const { buffer, slots, itemPages, findings } = await isolation().renderInWorker('contract', context);
  return { buffer, slots, itemPages, findings };
}

/** renderContractWithSlots in this thread — what the render worker runs. */
function renderContractInProcess(context) {
  let placedSlots = [];
  // Where each clause landed (1-based pages), for the template editor's
  // page-break markers, and what the render had to work around.
  const itemPages = [];
  const findings = [];
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        const ctx = context || {};
        const locale = ctx.locale || 'de';
        const theme = ctx.theme || builtInTheme('contract');
        // Settings → General date format, like quotes and invoices (#1445;
        // contracts used to pass the locale here, which always fell back).
        const dateFormat = ctx.dateFormat || { format: 'DD.MM.YYYY' };
        // A footer (theme) sits in the bottom margin, so the margin grows
        // by its height and body text never runs into it.
        const footerReserve = footerHeightFor(theme, ctx.issuer);
        // The theme's margins (#1445) for the letter pages. The signature
        // page keeps SIGNATURE_PAGE — stamped signatures land at its fixed
        // coordinates, whatever the margins are.
        const PAGE = pageMetricsFor(theme);
        const doc = new PDFDocument({
          size: 'A4',
          bufferPages: true,
          margins: {
            top: PAGE.marginTop, bottom: PAGE.marginBottom + footerReserve,
            left: PAGE.marginLeft, right: PAGE.marginRight,
          },
          info: {
            Title: `${ctx.doc?.contractNumber || 'Contract'}${ctx.recipient?.companyName ? '_' + ctx.recipient.companyName : ''}`,
            Author: ctx.issuer?.companyName || 'picpeak',
            ...(ctx.generatedAt ? { CreationDate: new Date(ctx.generatedAt) } : {}),
          },
        });

        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), slots: placedSlots, itemPages, findings }));
        doc.on('error', reject);

        doc._theme = theme;
        doc._page = PAGE;
        doc._findings = findings;
        doc._fonts = registerThemeFonts(doc, ctx.issuer || {}, theme);
        const currentPage = () => doc.bufferedPageRange().count;
        const body = bodyText(doc);

        // ---- header: issuer + recipient blocks (DIN 5008) ------------
        const issuerWidth = 180;
        const issuerX = PAGE.width - PAGE.marginRight - issuerWidth;
        const issuerY = PAGE.marginTop + 16;

        // A logo the theme places at the left or centre (#1445) goes first;
        // the issuer column and a recipient in the flow start below it.
        const logoBottom = drawPageLogo(doc, ctx.issuer || {});
        const centredLogo = logoBottom != null && theme.logo && theme.logo.position === 'center';
        const issuerEndY = drawIssuerBlock(doc, ctx.issuer || {}, issuerX, centredLogo ? Math.max(issuerY, logoBottom) : issuerY,
          issuerWidth, locale);
        const windowOn = addressWindowOn(doc);
        const recipientEndY = drawRecipientBlock(doc, ctx.recipient || {}, locale,
          windowOn ? {} : { flowY: Math.max(issuerY, logoBottom || 0) });
        let y = Math.max(issuerEndY, recipientEndY, windowOn ? ADDR_WINDOW.top + ADDR_WINDOW.height : 0) + 6;
        // Folding marks on the letter page, when the contract theme has them.
        drawFoldingMarks(doc, theme.foldingMarks);

        // ---- contract number + date (right-aligned) ------------------
        const docNumberForDisplay = ctx.doc?.contractNumber || '';
        const numberLabel = t(locale, 'contract_number_label');
        const dateLabel = t(locale, 'date');
        const issueDateDisplay = formatDate(ctx.doc?.issueDate, dateFormat);
        const labelColumnWidth = 110;
        const valueColumnWidth = 120;
        const blockWidth = labelColumnWidth + valueColumnWidth;
        const blockRightX = PAGE.width - PAGE.marginRight;
        const blockLeftX = blockRightX - blockWidth;

        doc.font(doc._fonts.body).fontSize(9).fillColor(themeColor(doc, 'text'));
        // Number row
        doc.text(numberLabel, blockLeftX, y, { width: labelColumnWidth, align: 'right' });
        doc.font(doc._fonts.bold).text(
          docNumberForDisplay,
          blockLeftX + labelColumnWidth,
          y,
          { width: valueColumnWidth, align: 'right' },
        );
        y += 14;
        // Date row
        doc.font(doc._fonts.body);
        doc.text(dateLabel, blockLeftX, y, { width: labelColumnWidth, align: 'right' });
        doc.text(
          issueDateDisplay,
          blockLeftX + labelColumnWidth,
          y,
          { width: valueColumnWidth, align: 'right' },
        );
        y += 22;

        // ---- title --------------------------------------------------
        const title = ctx.doc?.title || t(locale, 'contract_title');
        doc.font(doc._fonts.bold).fontSize(theme.titleSize).fillColor(themeColor(doc, 'accent'));
        doc.text(title, PAGE.marginLeft, y, { width: PAGE.contentWidth });
        doc.fillColor(themeColor(doc, 'text'));
        y = doc.y + 10;

        // ---- helper: ensure space before drawing, paginate if needed.
        const bottomLimit = PAGE.height - PAGE.marginBottom - 20 - footerReserve;
        const ensureSpace = (needed) => {
          if (y + needed > bottomLimit) {
            doc.addPage();
            y = PAGE.marginTop;
          }
        };

        // ---- helper: render body text with inline **bold** support.
        // utils/placeholders.parseInlineMarkdown splits the text into bold
        // and regular runs (and resolves `\*`-style escapes, which is how a
        // placeholder value stays literal); each run switches the font via
        // PDFKit's `continued: true` text continuation. The first run anchors
        // at (PAGE.marginLeft, y); later runs continue from PDFKit's cursor
        // so wrapping works across font switches. After rendering, we read
        // doc.y as the new cursor.
        const renderBodyMarkdown = (text, opts) => {
          const runs = parseInlineMarkdown(text);
          if (runs.length === 0) return;
          const last = runs.length - 1;
          runs.forEach((run, i) => {
            doc.font(run.bold ? doc._fonts.bold : doc._fonts.body);
            if (i === 0) {
              doc.text(run.text, PAGE.marginLeft, y, { ...opts, continued: i < last });
            } else {
              doc.text(run.text, { ...opts, continued: i < last });
            }
          });
        };

        // ---- intro text ---------------------------------------------
        if (ctx.doc?.introText) {
          doc.font(doc._fonts.body).fontSize(body.size).fillColor(themeColor(doc, 'text'));
          ensureSpace(40);
          renderBodyMarkdown(ctx.doc.introText, { width: PAGE.contentWidth, align: 'left', ...body.options });
          y = doc.y + 12;
        }

        // ---- sections + blocks --------------------------------------
        for (const sec of ctx.sections || []) {
          if (!sec.blocks || sec.blocks.length === 0) continue;
          ensureSpace(32);
          doc.font(doc._fonts.bold).fontSize(13).fillColor(themeColor(doc, 'accent'));
          doc.text(t(locale, `section_${sec.section}`), PAGE.marginLeft, y, {
            width: PAGE.contentWidth, align: 'left',
          });
          y = doc.y + 6;
          // Thin separator under the section heading.
          doc
            .strokeColor(themeColor(doc, 'rule'))
            .lineWidth(0.5)
            .moveTo(PAGE.marginLeft, y)
            .lineTo(PAGE.marginLeft + PAGE.contentWidth, y)
            .stroke();
          y += 8;

          for (const block of sec.blocks) {
            ensureSpace(48);
            const firstPage = currentPage();
            if (block.name) {
              doc.font(doc._fonts.bold).fontSize(10).fillColor(themeColor(doc, 'text'));
              doc.text(String(block.name), PAGE.marginLeft, y, {
                width: PAGE.contentWidth, align: 'left',
              });
              y = doc.y + 4;
            }
            doc.font(doc._fonts.body).fontSize(body.size).fillColor(themeColor(doc, 'text'));
            renderBodyMarkdown(block.body, { width: PAGE.contentWidth, align: 'left', ...body.options });
            y = doc.y + 10;
            // If text rendering pushed past page bottom, PDFKit
            // auto-paginated — sync y to the new doc.y for the next
            // block.
            if (doc.y < y) y = doc.y;

            // Special-case: when the block is the
            // `quote_line_items_table` system block AND the contract
            // was generated from a quote, draw the quote's line items
            // right after the body text — with the SAME table the quote
            // and invoice PDFs use (#1451), so units, discount lines,
            // comment rows and number formatting match on all three.
            // (This used to be a hand-drawn copy with its own "\u21B3"
            // glyph Helvetica can't render and a hard-coded de-CH.)
            if (
              block.slug === 'quote_line_items_table'
              && ctx.quoteLineItems
              && ctx.quoteLineItems.length > 0
            ) {
              ensureSpace(40);
              doc.x = PAGE.marginLeft;
              doc.y = y;
              y = drawLineItems(doc, {
                type: 'contract',
                locale,
                currency: (ctx.quoteCurrency || 'CHF').toUpperCase(),
                intlLocale: localeForIntl(locale, ctx.issuer?.countryCode),
                fonts: doc._fonts,
                lineItems: ctx.quoteLineItems.map((li) => ({
                  quantity: li.quantity,
                  description: li.description,
                  unitPriceMinor: li.unit_price_minor,
                  discountPercent: li.discount_percent,
                  lineTotalMinor: li.line_total_minor,
                  parentLineItemId: li.parent_line_item_id || null,
                  parentPosition: li.parent_position == null ? null : Number(li.parent_position),
                  detailsText: li.details_text || null,
                  lineKind: li.line_kind || 'item',
                  unit: li.unit || null,
                  promotion: parsePromotionSnapshot(li.promotion_snapshot),
                })),
              });

              y += 10;
              doc.y = y;
              doc.fillColor(themeColor(doc, 'text'));

              // The totals the contract was sent with (#1445). Without this
              // the contract printed a table of line amounts and never named
              // the sum the customer was signing for. Drawn from the frozen
              // snapshot only, so the figure and the table can never disagree;
              // a contract sent before the snapshot carried totals prints the
              // table alone, exactly as it did when it went out.
              if (ctx.quoteTotals) {
                ensureSpace(60);
                y = drawContractTotals(doc, {
                  locale,
                  currency: (ctx.quoteCurrency || 'CHF').toUpperCase(),
                  intlLocale: localeForIntl(locale, ctx.issuer?.countryCode),
                  totals: ctx.quoteTotals,
                  vatLabel: ctx.issuer && ctx.issuer.vatLabel,
                }, PAGE.marginLeft, doc.y, PAGE.contentWidth);
                doc.y = y;
                doc.fillColor(themeColor(doc, 'text'));
              }
            }
            if (block.position != null) {
              itemPages.push({ position: Number(block.position), firstPage, lastPage: currentPage() });
            }
          }

          y += 6;
        }

        // ---- outro text ---------------------------------------------
        if (ctx.doc?.outroText) {
          ensureSpace(40);
          doc.font(doc._fonts.body).fontSize(body.size).fillColor(themeColor(doc, 'text'));
          renderBodyMarkdown(ctx.doc.outroText, { width: PAGE.contentWidth, align: 'left', ...body.options });
          y = doc.y + 16;
        }

        // ---- signature page (dedicated final page, fixed layout) ----
        // The unsigned PDF ALWAYS contains an empty signature page at
        // the end, with both signature boxes at FIXED coordinates
        // (see CONTRACT_SIGNATURE_LAYOUT below). pdfStampService.js
        // uses those same coordinates to overlay signature PNGs with
        // pdf-lib AFTER the unsigned PDF is rendered — no re-render
        // needed at signing time. This is the same model DocuSign /
        // Adobe Sign use: the original is byte-immutable; signatures
        // are appended as overlays.
        //
        // Audit data (timestamps, IPs, hashes) is rendered as a
        // SEPARATE "audit certificate" PDF by pdfStampService — not
        // embedded here — so the contract PDF stays purely
        // representational and the audit trail is a sibling document
        // that can be verified independently.
        doc.addPage();
        const L = CONTRACT_SIGNATURE_LAYOUT;

        // Title row
        doc.font(doc._fonts.bold).fontSize(16).fillColor(themeColor(doc, 'text'));
        doc.text(t(locale, 'signature_page_title'), SIGNATURE_PAGE.marginLeft, L.titleY, {
          width: SIGNATURE_PAGE.contentWidth, align: 'left',
        });
        doc.strokeColor(themeColor(doc, 'rule')).lineWidth(0.5)
          .moveTo(SIGNATURE_PAGE.marginLeft, L.titleY + 22)
          .lineTo(SIGNATURE_PAGE.marginLeft + SIGNATURE_PAGE.contentWidth, L.titleY + 22)
          .stroke();

        // Closing prompt — generic line so unsigned doc reads coherently
        doc.font(doc._fonts.body).fontSize(10).fillColor(themeColor(doc, 'text'));
        doc.text(t(locale, 'signature_page_prompt'), SIGNATURE_PAGE.marginLeft, L.promptY, {
          width: SIGNATURE_PAGE.contentWidth, align: 'left',
        });

        // Signature slots (#1445): one per signer, customers first and the
        // issuer last, two to a row. Without signers the two legacy boxes sit
        // exactly where CONTRACT_SIGNATURE_LAYOUT always put them. Where each
        // slot landed goes back to the caller, so signatures are stamped from
        // the document's record rather than from a constant.
        const slotDefs = Array.isArray(ctx.signatureSlots) && ctx.signatureSlots.length
          ? ctx.signatureSlots.slice(0, MAX_SIGNATURE_SLOTS)
          : [
            { key: 'customer', role: 'customer', label: t(locale, 'signature_customer'), ...(ctx.signatures?.customer || {}) },
            { key: 'admin', role: 'issuer', label: t(locale, 'signature_admin'), ...(ctx.signatures?.admin || {}) },
          ];
        const { count: pageCount } = doc.bufferedPageRange();
        placedSlots = slotDefs.map((slot, index) => {
          const offset = Math.floor(index / 2) * SIGNATURE_ROW_HEIGHT;
          const x = index % 2 === 0 ? L.customerX : L.adminX;
          const boxY = L.boxY + offset;
          doc.font(doc._fonts.bold).fontSize(10).fillColor(themeColor(doc, 'text'));
          doc.text(slot.label || '', x, L.paneLabelY + offset, { width: L.boxWidth, lineBreak: false, ellipsis: true });
          doc.strokeColor('#cccccc').lineWidth(0.5).rect(x, boxY, L.boxWidth, L.boxHeight).stroke();
          // Caption labels: the name (known for invited signers) and an empty
          // date, which the stamp service fills in when the slot is signed.
          const captionY = boxY + L.boxHeight + 6;
          doc.font(doc._fonts.body).fontSize(9).fillColor(themeColor(doc, 'text'));
          doc.text(`${t(locale, 'signed_label_name')}: ${slot.name || ''}`, x, captionY,
            { width: L.boxWidth, lineBreak: false, ellipsis: true });
          doc.text(`${t(locale, 'signed_label_date')}: ${slot.signedAt ? formatDate(slot.signedAt, dateFormat) : ''}`,
            x, captionY + 12, { width: L.boxWidth, lineBreak: false });
          return {
            key: slot.key, role: slot.role, label: slot.label || '', pageIndex: pageCount - 1,
            x, y: boxY, width: L.boxWidth, height: L.boxHeight, captionY,
          };
        });

        // ---- page numbers ("Page 1 of N" / "Seite 1 von N") ----------
        // Same stamp the quote/invoice renderer uses (line 1680 above).
        // bufferPages:true keeps every page open for switchToPage; we
        // walk the range after all content is drawn so we know N.
        try {
          // The footer (when the theme has one) and the page numbers go into
          // each page's bottom margin, clear of the body text (#1445; the
          // numbers used to sit inside the content area and could overlap it).
          stampPageNumbers(doc, locale, {
            beforeStamp: () => {
              drawFooter(doc, ctx.issuer || {}, locale);
              // A template preview names itself on every page (#1445), below
              // the page number, so a printed preview can't pass for a contract.
              if (ctx.previewLabel) {
                doc.font(doc._fonts.body).fontSize(7).fillColor(themeColor(doc, 'subtle'));
                doc.text(String(ctx.previewLabel), PAGE.marginLeft, doc.page.height - PAGE.marginBottom + 20, {
                  width: PAGE.contentWidth, align: 'left', lineBreak: false, ellipsis: true,
                });
                doc.fillColor(themeColor(doc, 'text'));
              }
            },
            insertedBeforeLast: ctx.mergedAttachmentPages,
          });
        } catch (err) {
          const logger = require('../utils/logger');
          logger.warn('Failed to stamp page numbers on contract PDF', { err: err.message });
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
    })();
  });
}

/** The contract PDF alone (see renderContractWithSlots). */
async function renderContractToBuffer(context) {
  return (await renderContractWithSlots(context)).buffer;
}

module.exports = {
  renderQuoteToBuffer,
  renderInvoiceToBuffer,
  renderContractToBuffer,
  renderContractWithSlots,
  // Building blocks shared with other PDF features (tax report etc.) —
  // they all run through createBaseDocument so the font + orientation
  // story stays consistent.
  createBaseDocument,
  getPageMetrics,
  drawIssuerBlock,
  // Shared with pdfStampService — the same coordinates the unsigned
  // render uses to draw empty signature boxes are used to overlay
  // signature PNGs at stamping time. Single source of truth.
  CONTRACT_SIGNATURE_LAYOUT,
  SIGNATURE_ROW_HEIGHT,
  MAX_SIGNATURE_SLOTS,
  PAGE,
  FONT_BODY,
  FONT_BOLD,
  // The renderers without the worker, for services/pdf/renderIsolation.
  _raw: { renderDocument, renderContract: renderContractInProcess },
  // Exposed for unit tests + advanced callers.
  _internal: {
    formatMinor, formatDate, t, registerCustomFonts, registerThemeFonts, drawLineItems, stampPageNumbers, themeColor,
  },
};
