const DEFAULT_PUBLIC_SITE_TITLE = 'PicPeak — Curated Galleries, Effortless Sharing';

const DEFAULT_PUBLIC_SITE_HTML = `
<section class="hero" id="welcome">
  <div class="hero__inner">
    <span class="hero__badge">PicPeak Showcase</span>
    <h1>Share the story of {{company_name}}</h1>
    <p class="hero__lead">{{company_tagline}}</p>
    <div class="hero__cta">
      <a href="#features" class="button button--primary">Explore Features</a>
      <a href="#collections" class="button button--ghost">View Sample Galleries</a>
    </div>
    <dl class="hero__stats">
      <div>
        <dt>Private invites</dt>
        <dd>Secure links for every guest</dd>
      </div>
      <div>
        <dt>Curated delivery</dt>
        <dd>Highlight every favourite instantly</dd>
      </div>
      <div>
        <dt>Fully branded</dt>
        <dd>Colours, typography, and logo that match you</dd>
      </div>
    </dl>
  </div>
  <div class="hero__visual">
    <article class="deck deck--primary">
      <header class="deck__header">
        <img src="{{brand_logo_url}}" alt="{{company_name}} logo" class="deck__logo" loading="lazy" decoding="async" />
        <span class="deck__title">PicPeak Gallery</span>
      </header>
      <ul class="deck__list">
        <li>Guided cover stories</li>
        <li>Guest uploads with approvals</li>
        <li>Protected high-res downloads</li>
      </ul>
    </article>
    <article class="deck deck--secondary">
      <p class="deck__quote">“PicPeak makes delivery feel like part of the celebration. Our couples relive the day the moment they open the link.”</p>
      <p class="deck__author">— Studio Miraval</p>
    </article>
  </div>
</section>

<section class="features" id="features">
  <div class="section-head">
    <span class="section-badge">Why teams pick PicPeak</span>
    <h2>Design-first galleries with the workflow you already love</h2>
    <p>Bring the PicPeak admin experience to your clients with branded, secure, and responsive public pages.</p>
  </div>
  <div class="feature-grid">
    <article>
      <h3>Beautiful by default</h3>
      <p>Every gallery inherits your PicPeak theme, typography, and colour palette automatically.</p>
    </article>
    <article>
      <h3>Guided storytelling</h3>
      <p>Create anchored sections, spotlight favourite collections, and embed testimonials that build trust.</p>
    </article>
    <article>
      <h3>Secure sharing</h3>
      <p>Password gates, expiring links, and download protection keep every celebration personal.</p>
    </article>
  </div>
</section>

<section class="workflow" id="workflow">
  <div class="workflow__content">
    <h2>Launch in minutes</h2>
    <ol class="workflow__steps">
      <li>
        <h4>Brand it once</h4>
        <p>PicPeak automatically applies your logo, colours, and support details.</p>
      </li>
      <li>
        <h4>Curate sections</h4>
        <p>Highlight hero stories, featured galleries, and timeline moments with simple HTML blocks.</p>
      </li>
      <li>
        <h4>Share confidently</h4>
        <p>Send a single link that greets guests before they enter their private gallery.</p>
      </li>
    </ol>
  </div>
  <div class="workflow__media">
    <figure class="workflow__browser">
      <img src="/picpeak-logo-transparent.png" alt="PicPeak interface" loading="lazy" decoding="async" />
      <figcaption>PicPeak dashboard &mdash; trusted by studios worldwide.</figcaption>
    </figure>
  </div>
</section>

<section class="collections" id="collections">
  <div class="section-head">
    <span class="section-badge">Showcase highlights</span>
    <h2>Curated sample galleries that mirror your client experience</h2>
    <p>Drop in featured stories, welcome messages, and callouts that prepare guests for what comes next.</p>
  </div>
  <div class="collection-showcase">
    <article>
      <h3>Signature Galleries</h3>
      <p>Use responsive cards to preview your most loved collections or vendor partnerships.</p>
    </article>
    <article>
      <h3>Welcome timelines</h3>
      <p>Guide guests from arrival to download with steps that feel effortless and on-brand.</p>
    </article>
  </div>
</section>

<section class="stories" id="stories">
  <div class="section-head section-head--center">
    <span class="section-badge">Client notes</span>
    <h2>Experiences that keep guests coming back</h2>
  </div>
  <div class="story-grid">
    <figure>
      <blockquote>“From the welcome page to the final download, everything felt like us. PicPeak turned our gallery into part of the celebration.”</blockquote>
      <figcaption>— Harper &amp; Elias</figcaption>
    </figure>
    <figure>
      <blockquote>“The public landing page gives every collection a narrative. Our couples feel the care we put into every image.”</blockquote>
      <figcaption>— Jordan Rivera, Photographer</figcaption>
    </figure>
  </div>
</section>

<section class="cta" id="contact">
  <div class="cta__inner">
    <div>
      <h2>Ready to welcome your guests?</h2>
      <p>Create a PicPeak landing page that matches your studio and introduces every celebration with confidence.</p>
    </div>
    <div class="cta__actions">
      <a href="mailto:{{support_email}}" class="button button--primary">Contact us</a>
      <a href="#features" class="button button--ghost">Review features</a>
    </div>
  </div>
</section>

<footer class="site-footer" id="legal">
  <div class="footer-inner">
    <div>
      <h2>{{company_name}}</h2>
      <p>Powered by PicPeak to keep every celebration beautifully organised.</p>
    </div>
    <div class="footer-links">
      <a href="/datenschutz">Privacy Policy</a>
      <a href="/impressum">Impressum</a>
      <a href="mailto:{{support_email}}">Support</a>
    </div>
  </div>
</footer>
`;

const DEFAULT_PUBLIC_SITE_CSS = `
*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  background: linear-gradient(180deg, var(--brand-background), var(--brand-surface, #ffffff) 55%);
  color: var(--brand-text);
  -webkit-font-smoothing: antialiased;
}

a {
  color: inherit;
  text-decoration: none;
}

img {
  max-width: 100%;
  display: block;
}

.site-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, var(--brand-elevated, rgba(15, 23, 42, 0.03)), transparent 65%);
}

.site-header {
  position: sticky;
  top: 0;
  z-index: 30;
  background: var(--brand-surface, rgba(255, 255, 255, 0.92));
  backdrop-filter: blur(18px);
  border-bottom: 1px solid var(--brand-border, rgba(15, 23, 42, 0.08));
}

.header-inner {
  max-width: 1100px;
  margin: 0 auto;
  padding: 1rem 1.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.brand-logo {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  object-fit: contain;
  background: rgba(148, 163, 184, 0.12);
  padding: 6px;
}

.brand-copy {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.brand-label {
  margin: 0;
  font-weight: 600;
  font-size: 1rem;
  letter-spacing: -0.01em;
  color: var(--brand-text);
}

.brand-tagline {
  margin: 0;
  font-size: 0.85rem;
  color: var(--brand-muted-text, rgba(15, 23, 42, 0.65));
}

.site-nav {
  display: flex;
  gap: 1rem;
  font-size: 0.95rem;
  color: var(--brand-muted-text, rgba(15, 23, 42, 0.65));
}

.site-nav a {
  position: relative;
  padding: 0.25rem 0;
}

.site-nav a::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: -6px;
  width: 100%;
  height: 2px;
  background: transparent;
  transition: background 0.2s ease;
}

.site-nav a:hover::after {
  background: var(--brand-primary);
}

.site-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4rem;
  padding: 2.5rem 1.5rem 4rem;
}

@media (min-width: 960px) {
  .site-main {
    padding: 3rem 0 5rem;
    gap: 5rem;
  }

  .hero,
  .features,
  .workflow,
  .collections,
  .stories,
  .cta {
    max-width: 1100px;
    margin: 0 auto;
  }
}

.hero {
  display: grid;
  gap: 2.5rem;
  align-items: center;
}

@media (min-width: 960px) {
  .hero {
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
  }
}

.hero__inner {
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
}

.hero__badge {
  display: inline-flex;
  align-items: center;
  padding: 0.55rem 0.9rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: rgba(34, 197, 94, 0.18);
  color: var(--brand-primary);
}

.hero h1 {
  margin: 0;
  font-size: clamp(2.65rem, 4.8vw, 3.6rem);
  letter-spacing: -0.02em;
  line-height: 1.08;
}

.hero__lead {
  margin: 0;
  max-width: 32rem;
  color: var(--brand-muted-text, rgba(15, 23, 42, 0.72));
  font-size: 1.05rem;
  line-height: 1.6;
}

.hero__cta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.85rem;
}

.hero__stats {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  margin: 0;
  padding: 0;
}

.hero__stats dt {
  font-weight: 600;
  color: var(--brand-text);
}

.hero__stats dd {
  margin: 0.35rem 0 0;
  color: var(--brand-muted-text, rgba(15, 23, 42, 0.6));
  font-size: 0.95rem;
}

.hero__visual {
  display: grid;
  gap: 1.5rem;
}

.deck {
  border-radius: 20px;
  padding: 1.75rem;
  background: var(--brand-surface, #fff);
  box-shadow: 0 35px 60px -35px rgba(15, 23, 42, 0.35);
  border: 1px solid var(--brand-border, rgba(15, 23, 42, 0.08));
  display: grid;
  gap: 1.35rem;
}

.deck--primary {
  border-color: rgba(34, 197, 94, 0.2);
}

.deck--secondary {
  background: linear-gradient(135deg, var(--brand-surface, #fff), var(--brand-elevated, rgba(15, 23, 42, 0.03)));
}

.deck__header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.deck__logo {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: rgba(34, 197, 94, 0.12);
  padding: 6px;
}

.deck__title {
  font-weight: 600;
  letter-spacing: -0.01em;
}

.deck__list {
  margin: 0;
  padding-left: 1.1rem;
  display: grid;
  gap: 0.65rem;
  color: var(--brand-muted-text, rgba(15, 23, 42, 0.68));
}

.deck__quote {
  margin: 0;
  font-size: 1.05rem;
  line-height: 1.7;
  color: var(--brand-text, rgba(15, 23, 42, 0.78));
}

.deck__author {
  margin: 0;
  font-weight: 600;
  color: var(--brand-text);
}

.section-head {
  display: grid;
  gap: 1rem;
  max-width: 640px;
}

.section-head--center {
  text-align: center;
  margin: 0 auto;
}

.section-badge {
  display: inline-flex;
  padding: 0.45rem 0.9rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: rgba(34, 197, 94, 0.14);
  color: var(--brand-primary);
}

.section-head h2 {
  margin: 0;
  font-size: clamp(2rem, 3vw, 2.6rem);
  letter-spacing: -0.018em;
}

.section-head p {
  margin: 0;
  color: var(--brand-muted-text, rgba(15, 23, 42, 0.65));
}

.feature-grid {
  display: grid;
  gap: 1.5rem;
  margin-top: 2.5rem;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.feature-grid article {
  background: var(--brand-surface, rgba(255, 255, 255, 0.9));
  border-radius: 16px;
  padding: 1.75rem;
  border: 1px solid var(--brand-border, rgba(15, 23, 42, 0.08));
  box-shadow: 0 18px 40px -30px rgba(15, 23, 42, 0.28);
}

.workflow {
  display: grid;
  gap: 2rem;
  align-items: center;
}

@media (min-width: 960px) {
  .workflow {
    grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
  }
}

.workflow__steps {
  margin: 1.75rem 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 1.5rem;
}

.workflow__steps h4 {
  margin: 0 0 0.35rem;
  font-size: 1.05rem;
  color: var(--brand-text);
}

.workflow__steps p {
  margin: 0;
  color: var(--brand-muted-text, rgba(15, 23, 42, 0.65));
}

.workflow__browser {
  margin: 0;
  background: var(--brand-elevated, rgba(15, 23, 42, 0.05));
  border-radius: 20px;
  border: 1px solid var(--brand-border, rgba(15, 23, 42, 0.1));
  padding: 2rem;
  text-align: center;
  color: var(--brand-muted-text, rgba(15, 23, 42, 0.55));
  font-size: 0.85rem;
}

.collection-showcase {
  margin-top: 2.5rem;
  display: grid;
  gap: 1.5rem;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.collection-showcase article {
  background: var(--brand-surface, rgba(255, 255, 255, 0.92));
  border-radius: 18px;
  border: 1px solid var(--brand-border, rgba(15, 23, 42, 0.08));
  padding: 1.5rem;
  box-shadow: 0 18px 45px -32px rgba(15, 23, 42, 0.3);
}

.story-grid {
  margin-top: 2.5rem;
  display: grid;
  gap: 1.5rem;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}

.story-grid figure {
  margin: 0;
  padding: 1.75rem;
  background: var(--brand-surface, rgba(255, 255, 255, 0.95));
  border-radius: 20px;
  border: 1px solid var(--brand-border, rgba(15, 23, 42, 0.08));
  box-shadow: 0 18px 42px -32px rgba(15, 23, 42, 0.28);
}

.story-grid blockquote {
  margin: 0 0 1.2rem;
  font-size: 1.05rem;
  line-height: 1.7;
  color: var(--brand-text, rgba(15, 23, 42, 0.8));
}

.story-grid figcaption {
  font-weight: 600;
  color: var(--brand-muted-text, rgba(15, 23, 42, 0.7));
}

.cta {
  background: linear-gradient(135deg, var(--brand-primary), var(--brand-accent));
  color: #fff;
  border-radius: 28px;
  padding: clamp(2.5rem, 5vw, 3.5rem);
}

.cta__inner {
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
  max-width: 720px;
}

.cta__inner h2 {
  margin: 0;
  font-size: clamp(2rem, 3vw, 2.5rem);
}

.cta__inner p {
  margin: 0;
  font-size: 1.05rem;
  opacity: 0.95;
}

.cta__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.85rem 1.75rem;
  border-radius: 999px;
  font-weight: 600;
  transition: transform 160ms ease, box-shadow 200ms ease, background 200ms ease, color 200ms ease;
  border: 1px solid transparent;
}

.button:hover {
  transform: translateY(-2px);
}

.button--primary {
  background: var(--brand-primary);
  color: #fff;
  box-shadow: 0 25px 45px -25px rgba(15, 23, 42, 0.55);
}

.button--primary:hover {
  background: var(--brand-accent);
}

.button--ghost {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.45);
  color: inherit;
}

.site-footer {
  padding: 3rem 1.5rem;
  background: var(--brand-elevated, rgba(15, 23, 42, 0.05));
  border-top: 1px solid var(--brand-border, rgba(15, 23, 42, 0.08));
}

.footer-inner {
  max-width: 1100px;
  margin: 0 auto;
  display: grid;
  gap: 1.5rem;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.footer-inner h2 {
  margin: 0 0 0.5rem;
  font-size: 1.1rem;
}

.footer-inner p {
  margin: 0;
  color: var(--brand-muted-text, rgba(15, 23, 42, 0.65));
  line-height: 1.6;
}

.footer-links {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  font-weight: 600;
  color: var(--brand-primary);
}

.footer-links a {
  color: inherit;
}

.footer-links a:hover {
  text-decoration: underline;
}

@media (max-width: 960px) {
  .site-nav {
    display: none;
  }

  .hero__visual {
    grid-template-columns: minmax(0, 1fr);
  }

  .workflow {
    grid-template-columns: minmax(0, 1fr);
  }

  .cta__inner {
    gap: 1.5rem;
  }
}
`;

module.exports = {
  DEFAULT_PUBLIC_SITE_TITLE,
  DEFAULT_PUBLIC_SITE_HTML,
  DEFAULT_PUBLIC_SITE_CSS,
};
