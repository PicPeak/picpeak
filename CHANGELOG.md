# Changelog

All notable changes to PicPeak will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.82.6-beta.0](https://github.com/PicPeak/picpeak/compare/v3.82.5-beta.0...v3.82.6-beta.0) (2026-07-07)


### Bug Fixes

* **workflows:** backfill existing invoices + anchor dunning grace to due date when enabled ([#750](https://github.com/PicPeak/picpeak/issues/750)) ([9596342](https://github.com/PicPeak/picpeak/commit/9596342d6a9ef107193cfc123487a8061f4a91ca))
* **workflows:** scope dunning backfill to its own flow via targetWorkflowId ([da3a77d](https://github.com/PicPeak/picpeak/commit/da3a77dac40a892158167aec939a1458d488a951))

## [3.82.5-beta.0](https://github.com/PicPeak/picpeak/compare/v3.82.4-beta.0...v3.82.5-beta.0) (2026-07-07)


### Bug Fixes

* **admin:** stop the event-date field crashing the page on backspace ([760a201](https://github.com/PicPeak/picpeak/commit/760a201b6070a4edfe8192bcddce948c5f0c3fec))

## [3.82.4-beta.0](https://github.com/PicPeak/picpeak/compare/v3.82.3-beta.0...v3.82.4-beta.0) (2026-07-07)


### Bug Fixes

* **email,ui:** billing emails follow customer language + readable payment-check confirmation ([0c2d319](https://github.com/PicPeak/picpeak/commit/0c2d319fc1ed67843cc60afdcaea5807ea49226f))
* **email,ui:** billing emails follow customer language + readable payment-check confirmation ([fcc3e91](https://github.com/PicPeak/picpeak/commit/fcc3e9195d6f63b2dffddfa72a867a3e32325e81))
* **email:** sibling billing emails follow customer language too ([c0008be](https://github.com/PicPeak/picpeak/commit/c0008be39bc8a9d354e48ce8d6bd89662bc53ebb))

## [3.82.3-beta.0](https://github.com/PicPeak/picpeak/compare/v3.82.2-beta.0...v3.82.3-beta.0) (2026-07-06)


### Bug Fixes

* **branding:** make 'Show logo in hero' a true global toggle with per-event override ([#756](https://github.com/PicPeak/picpeak/issues/756)) ([a88da99](https://github.com/PicPeak/picpeak/commit/a88da99c8d35c0c7cb7f96a235e984edad74ac7c))
* **branding:** make 'Show logo in hero' a true global toggle with per-event override ([#756](https://github.com/PicPeak/picpeak/issues/756)) ([96fe478](https://github.com/PicPeak/picpeak/commit/96fe478bf87a3350185206b3d6f15133138b995d))
* **branding:** unify hero logo SIZE the same way as visibility ([#756](https://github.com/PicPeak/picpeak/issues/756)) ([60b03b1](https://github.com/PicPeak/picpeak/commit/60b03b17287539b3ad5e5d32f4eda8622f0575e4))

## [3.82.2-beta.0](https://github.com/PicPeak/picpeak/compare/v3.82.1-beta.0...v3.82.2-beta.0) (2026-07-05)


### Bug Fixes

* **og:** broaden social-crawler coverage (Bluesky Cardyb, WeChat-scraper, fediverse, etc.) ([a0a28a4](https://github.com/PicPeak/picpeak/commit/a0a28a47777db9ca9e60a5134c8d86503c060e79))
* **og:** route branded short URLs + slideshow links to OG, add Viber ([#699](https://github.com/PicPeak/picpeak/issues/699)) ([0dffe0c](https://github.com/PicPeak/picpeak/commit/0dffe0ce92339e0608b3ef660e84c31a62f4a98c))
* **og:** route branded short URLs + slideshow to OG handler, add Viber ([#699](https://github.com/PicPeak/picpeak/issues/699)) ([a87ad77](https://github.com/PicPeak/picpeak/commit/a87ad77d8d5215c88f5d95cc7aebaa1769938ec0))

## [3.82.1-beta.0](https://github.com/PicPeak/picpeak/compare/v3.82.0-beta.0...v3.82.1-beta.0) (2026-07-05)


### Bug Fixes

* **invoices:** correct payment-check email template key so dunning email sends ([9a76333](https://github.com/PicPeak/picpeak/commit/9a763337b658299aae0d7c985071c4a775000f99))
* **invoices:** correct payment-check email template key so dunning email sends ([3682de1](https://github.com/PicPeak/picpeak/commit/3682de195b46eae692db3ff4a1476b00d3a6e216))

## [3.82.0-beta.0](https://github.com/PicPeak/picpeak/compare/v3.81.0-beta.0...v3.82.0-beta.0) (2026-07-03)


### Features

* **setup:** final community step ([#732](https://github.com/PicPeak/picpeak/issues/732)) + fix create-admin button overflow ([#730](https://github.com/PicPeak/picpeak/issues/730)) ([a5f49e3](https://github.com/PicPeak/picpeak/commit/a5f49e32350564ee4d3894f33e9611e9244cc994))
* **setup:** final community/thank-you step ([#732](https://github.com/PicPeak/picpeak/issues/732)); fix create-admin button overflow ([#730](https://github.com/PicPeak/picpeak/issues/730)) ([dadaaee](https://github.com/PicPeak/picpeak/commit/dadaaeea7781cb62811256b512003e5c4d6ad95e))

## [3.81.0-beta.0](https://github.com/PicPeak/picpeak/compare/v3.80.0-beta.0...v3.81.0-beta.0) (2026-07-03)


### Features

* admin two-factor authentication (TOTP) with recovery codes + CLI reset ([cf07361](https://github.com/PicPeak/picpeak/commit/cf073615effa8a91e19374ad3e9924e6e7322950))
* **admin-ui:** TOTP MFA enrollment + two-step login; remove stub 2FA toggle ([96e3c68](https://github.com/PicPeak/picpeak/commit/96e3c68b9d6b35a82abcad664a6da7b19150b4fd))
* **auth:** admin TOTP MFA — enrollment, login challenge, recovery, CLI reset ([72e2ef6](https://github.com/PicPeak/picpeak/commit/72e2ef6721b0572ed34455de901aa357eacd8c76))


### Bug Fixes

* event creation 500s on PostgreSQL (NaN slideshow seed) + stray "0" boolean renders ([b187f58](https://github.com/PicPeak/picpeak/commit/b187f588b4d12af7a7849f8558c0085573d4af76))
* **security:** close cross-event thumbnail leak, bulk-op ownership bypass, + hardening ([081f3ed](https://github.com/PicPeak/picpeak/commit/081f3edcdffc65a77000cc638e364ea9dc03767f))
* **security:** cross-event thumbnail leak, bulk-op ownership bypass + auth hardening ([b732974](https://github.com/PicPeak/picpeak/commit/b732974779803b67097c81ae6bce2de0f2910794))

## [3.80.0-beta.0](https://github.com/PicPeak/picpeak/compare/v3.79.1-beta.0...v3.80.0-beta.0) (2026-07-03)


### Features

* **backup:** fold .picpeak restore into the Restore wizard's Upload source ([86324e7](https://github.com/PicPeak/picpeak/commit/86324e7da75069e61686b1b77495f02c33b12e1a))
* first-run setup wizard (feature selection + config) and portable .picpeak backup roundtrip ([e513e83](https://github.com/PicPeak/picpeak/commit/e513e8345b73e37ebedc9c9ec09665ffc5773e23))
* **setup:** add restore-from-backup branch to the first-run wizard ([a95ee47](https://github.com/PicPeak/picpeak/commit/a95ee473ae7fb2bf3c94c610724476701145d113))
* **setup:** per-feature config step after feature selection ([07b450a](https://github.com/PicPeak/picpeak/commit/07b450a954a53781d23a71749552e4101c637777))


### Bug Fixes

* **backup:** address .picpeak review — table filter, superuser guard, tests ([fa7665c](https://github.com/PicPeak/picpeak/commit/fa7665c5b1ad18a4db4f0b59eb4c197a3c9a36e2))
* **setup:** keep the first-run wizard light regardless of dark mode ([d4b143f](https://github.com/PicPeak/picpeak/commit/d4b143f313d00f2a30abcbc1a880c140d7455e7b))

## [3.79.1-beta.0](https://github.com/PicPeak/picpeak/compare/v3.79.0-beta.0...v3.79.1-beta.0) (2026-07-02)


### Bug Fixes

* **settings:** remove duplicate Mail import that broke the dev server ([5b535f8](https://github.com/PicPeak/picpeak/commit/5b535f86580275eda768fa2d85a8c94bd701f832))
* **settings:** remove duplicate Mail import that crashes the dev server ([4aa6583](https://github.com/PicPeak/picpeak/commit/4aa6583baef55e2c12e9cde7d391156436de518f))

## [3.79.0-beta.0](https://github.com/PicPeak/picpeak/compare/v3.78.0-beta.0...v3.79.0-beta.0) (2026-07-02)


### Features

* setup wizard + argument-driven unattended install ([681619f](https://github.com/PicPeak/picpeak/commit/681619f0a14070309342a9f908a5bbc8a57d47d8))
* **setup:** step-by-step wizard + argument-driven unattended install ([d35c413](https://github.com/PicPeak/picpeak/commit/d35c413651bc10f177a683a8057ad92c03b1cf00))

## [3.78.0-beta.0](https://github.com/PicPeak/picpeak/compare/v3.77.3-beta.0...v3.78.0-beta.0) (2026-07-02)


### Features

* zero-config first run — in-browser admin bootstrap + auto-generated secrets ([bafc96f](https://github.com/PicPeak/picpeak/commit/bafc96f468e3b5cca2ec3291e7b568886755099d))


### Bug Fixes

* **ci:** enable release-PR auto-merge with the PAT, not GITHUB_TOKEN ([e08a33d](https://github.com/PicPeak/picpeak/commit/e08a33d9ea273dc18877743f71f59d64bfc3dfb5))
* enable release-PR auto-merge with the PAT so releases actually publish ([97b9853](https://github.com/PicPeak/picpeak/commit/97b9853709fb59a900d70bb2a6bf365d98ae4f86))

## [3.77.3-beta.0](https://github.com/PicPeak/picpeak/compare/v3.77.2-beta.0...v3.77.3-beta.0) (2026-07-02)


### Bug Fixes

* set GH_REPO in release-please auto-merge step ([d00d52a](https://github.com/PicPeak/picpeak/commit/d00d52a2215dfcae34086cf3e10fe4da0aef09c9))

## [3.77.2-beta.0](https://github.com/PicPeak/picpeak/compare/v3.77.1-beta.0...v3.77.2-beta.0) (2026-07-02)


### Bug Fixes

* auto-publish release-please PRs without manual approval ([fb64ec0](https://github.com/PicPeak/picpeak/commit/fb64ec0910f8c3ecffb40d85e4f3a08f73503671))
* **ci:** auto-publish release-please PRs without manual approval ([#719](https://github.com/PicPeak/picpeak/issues/719)) ([a3e7232](https://github.com/PicPeak/picpeak/commit/a3e7232b8ed012b8449a76d3e4ea3c5daddd5514))

## [3.77.1-beta.0](https://github.com/PicPeak/picpeak/compare/v3.77.0-beta.0...v3.77.1-beta.0) (2026-07-02)


### Documentation

* require screenshots for UI changes in PRs ([f5b4aa7](https://github.com/PicPeak/picpeak/commit/f5b4aa7a5bc321ffbd33f1c1b92003435a7ee842))
* require screenshots for UI changes in PRs ([8ca7477](https://github.com/PicPeak/picpeak/commit/8ca74776f4d3f7be930a713afe4ac4de594adedd))

## [3.77.0-beta.0](https://github.com/PicPeak/picpeak/compare/v3.76.2-beta.0...v3.77.0-beta.0) (2026-07-01)


### Features

* admin photos list/grid toggle + upload failure report ([#707](https://github.com/PicPeak/picpeak/issues/707), [#708](https://github.com/PicPeak/picpeak/issues/708)) ([e873f7c](https://github.com/PicPeak/picpeak/commit/e873f7c98ce108b090d70a3b7df2d2929699e997))
* admin photos list/grid toggle + upload failure report ([#707](https://github.com/PicPeak/picpeak/issues/707), [#708](https://github.com/PicPeak/picpeak/issues/708)) ([6f95796](https://github.com/PicPeak/picpeak/commit/6f95796b7c19829197eaff0d4934ad9b84d0e2f3))

## [3.76.2-beta.0](https://github.com/PicPeak/picpeak/compare/v3.76.1-beta.0...v3.76.2-beta.0) (2026-06-30)


### Bug Fixes

* **ci:** whatsnew highlights — set GH_REPO so gh runs without a checkout ([3feed0f](https://github.com/PicPeak/picpeak/commit/3feed0fae6a5792a7192a529942e08d9872b7e6e))
* **ci:** whatsnew highlights — set GH_REPO so gh runs without a checkout ([2a5f0a8](https://github.com/PicPeak/picpeak/commit/2a5f0a8601ba5cb28243b39278ecdc0892388a96))

## [3.76.1-beta.0](https://github.com/PicPeak/picpeak/compare/v3.76.0-beta.0...v3.76.1-beta.0) (2026-06-30)


### Bug Fixes

* **whatsnew:** decode HTML entities and trim em-dash detail in fallback bullets ([5582644](https://github.com/PicPeak/picpeak/commit/5582644dc49330549be2a3a4cdd5b1ba0f21a294))

## [3.76.0-beta.0](https://github.com/PicPeak/picpeak/compare/v3.75.1-beta.0...v3.76.0-beta.0) (2026-06-30)


### Features

* **gallery:** branded URL shortener — /s/&lt;slug&gt; with OG injection ([#699](https://github.com/PicPeak/picpeak/issues/699)) ([a0f7033](https://github.com/PicPeak/picpeak/commit/a0f7033ffc812f92d56e2eac7bd2f498b95ef83b))

## [3.75.1-beta.0](https://github.com/PicPeak/picpeak/compare/v3.75.0-beta.0...v3.75.1-beta.0) (2026-06-30)


### Bug Fixes

* **og:** rich social previews for share-token + slideshow URLs ([#699](https://github.com/PicPeak/picpeak/issues/699)) ([25bf7bb](https://github.com/PicPeak/picpeak/commit/25bf7bb5239420da078749bac270196df6968581))
* **og:** rich social previews for share-token + slideshow URLs ([#699](https://github.com/PicPeak/picpeak/issues/699)) ([1b8747d](https://github.com/PicPeak/picpeak/commit/1b8747dc82763ba6b4da3a55045cab8740da2a13))

## [3.75.0-beta.0](https://github.com/PicPeak/picpeak/compare/v3.74.0-beta.0...v3.75.0-beta.0) (2026-06-30)


### Features

* **updates:** "What's New" highlights after update + pre-update teaser ([a1a73bf](https://github.com/PicPeak/picpeak/commit/a1a73bf75ff3fcd0833fdf7922a35ad09f19439b))
* **updates:** "What's New" highlights after update + pre-update teaser ([500cf85](https://github.com/PicPeak/picpeak/commit/500cf8522e556575bd74d4c71d38a83fb2596b5e))


### Documentation

* **readme:** credit [@the-luap](https://github.com/the-luap) as creator/lead maintainer ([3528f6b](https://github.com/PicPeak/picpeak/commit/3528f6b8b7e2b537b111f7787d48459a976ef744))
* **readme:** credit [@the-luap](https://github.com/the-luap) as creator/lead maintainer ([748238e](https://github.com/PicPeak/picpeak/commit/748238e8caf198e3899954804e61a2e179058957))

## [3.74.0-beta.0](https://github.com/PicPeak/picpeak/compare/v3.73.0-beta.0...v3.74.0-beta.0) (2026-06-29)


### Features

* **admin:** in-app migration banner for the org rename ([0213347](https://github.com/PicPeak/picpeak/commit/02133478bd2684c562d11cc122cf5059832ff76a))
* **admin:** in-app migration banner for the org rename ([#669](https://github.com/PicPeak/picpeak/issues/669)) ([2a4bf3b](https://github.com/PicPeak/picpeak/commit/2a4bf3b868c6733d0b865c8c0e977ba84d6e6453))


### Documentation

* branch model + migration-to-org guide + PR template ([166ef47](https://github.com/PicPeak/picpeak/commit/166ef47611a248c4d517e26d390d87d21f077ca1))
* branch model + migration-to-org guide + PR-template target hint ([d606fcd](https://github.com/PicPeak/picpeak/commit/d606fcd5a425fed3c968ec06b071a386bf558c28))
* prominent migration banner at the top of README ([14bd3e1](https://github.com/PicPeak/picpeak/commit/14bd3e1a6c6cf74378d6f316024584d8941cbcd5))
* prominent migration banner at the top of README ([#669](https://github.com/PicPeak/picpeak/issues/669)) ([5839bba](https://github.com/PicPeak/picpeak/commit/5839bba72a56cc29077f63f7daa038995fb09dfb))

## [3.73.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.72.0-beta.0...v3.73.0-beta.0) (2026-06-29)


### Features

* **dashboard:** revenue "year" tile toggles 365 days ↔ calendar YTD ([d1c9e02](https://github.com/the-luap/picpeak/commit/d1c9e02bcf50b6c08eebc85acdbfba29bfee84ac))
* **invoices:** surface monthly/manual accumulator drafts in the Bills list ([e457656](https://github.com/the-luap/picpeak/commit/e457656b9d06bb420c9d0985fe15c30d6c88aed9))


### Bug Fixes

* **invoices:** add bank transfer to the mark-paid method list ([e96ef4c](https://github.com/the-luap/picpeak/commit/e96ef4c5a35bc9e575bc3419fb318a3ee9df1bd6))
* **invoices:** badge held (unsent, no send date) invoices as "Draft" ([e4367e0](https://github.com/the-luap/picpeak/commit/e4367e028a5228ef50c4bbd522d0777bc7340b52))
* **invoices:** show "Draft" on the invoice detail page for accumulator drafts ([ca09442](https://github.com/the-luap/picpeak/commit/ca0944293f66b6465a577340e63d592598915092))
* **reminders:** wrap is_active/is_archived wheres in formatBoolean ([b9d9138](https://github.com/the-luap/picpeak/commit/b9d91385b43de7ede508884f7cf78b5cf785f853))

## [3.72.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.71.3-beta.0...v3.72.0-beta.0) (2026-06-28)


### Features

* **workflows:** booking cutover — wire booking actions + hold documents behind approval gates ([ec33ec7](https://github.com/the-luap/picpeak/commit/ec33ec7670a4feb1108d1bcbfe34727f63cc8cf9))


### Bug Fixes

* **workflows:** defer quote.accepted/declined emit until the 15-min response window locks ([539a837](https://github.com/the-luap/picpeak/commit/539a83711d1996dc9c262365f2c511e7bc445add))
* **workflows:** make the dashboard pending-approvals card items clickable too ([6e20d58](https://github.com/the-luap/picpeak/commit/6e20d58487c5e20b08e1d1b4ddd4e76f9e922a79))

## [3.71.3-beta.0](https://github.com/the-luap/picpeak/compare/v3.71.2-beta.0...v3.71.3-beta.0) (2026-06-27)


### Bug Fixes

* **events:** wire customer notifications into both public API entry points ([#647](https://github.com/the-luap/picpeak/issues/647)) ([f017542](https://github.com/the-luap/picpeak/commit/f01754247cdb94c5935ad5abbda116841f6c7fba))

## [3.71.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.71.1-beta.0...v3.71.2-beta.0) (2026-06-27)


### Bug Fixes

* event-reminder, email-language & gallery-publish bugs surfaced during workflow testing ([c8714ca](https://github.com/the-luap/picpeak/commit/c8714ca42f4d82d50fe611b2a630260ebecbe740))

## [3.71.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.71.0-beta.0...v3.71.1-beta.0) (2026-06-26)


### Bug Fixes

* **admin:** stack publish-gallery dialog CTAs so the German label fits ([#670](https://github.com/the-luap/picpeak/issues/670)) ([748af98](https://github.com/the-luap/picpeak/commit/748af98f3d3f8c00695b82e94d741a0e10a39a81))

## [3.71.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.70.0-beta.0...v3.71.0-beta.0) (2026-06-25)


### Features

* admin-configurable workflow engine + dunning/Mahngebühr rework (RFC — feedback welcome) ([15be3b8](https://github.com/the-luap/picpeak/commit/15be3b8d32965eedc08d46ccc525c65a3bf34de6))
* **workflows:** per-quote booking-workflow picker + quote→invoice (no gallery) built-in ([d14f1d8](https://github.com/the-luap/picpeak/commit/d14f1d850cc995b2cb1119ba0424f123feba50ec))
* **workflows:** pre-event reminder picks the template GROUP on the block, type stays automatic ([10d091b](https://github.com/the-luap/picpeak/commit/10d091b55e0c44738b4001a71def6416a8f0aeb0))
* **workflows:** route webhook node through the delivery pipeline (full Option 1) ([675e41a](https://github.com/the-luap/picpeak/commit/675e41a2f72c8c23fa5c36b13bc6b95abcb9d570))
* **workflows:** warn when disabling a built-in (reverts to legacy, not off) ([c5f131c](https://github.com/the-luap/picpeak/commit/c5f131cec32826331722ef3705c5f5422e31726d))


### Bug Fixes

* **crm:** pre-event reminder resolves recipient from the event row, not a non-existent column ([5fbe514](https://github.com/the-luap/picpeak/commit/5fbe514db6e386eee2eeade548bccbb5bbc5b422))
* **event-types:** renaming a type's slug cascades to events, quotes + reminder template ([415c93a](https://github.com/the-luap/picpeak/commit/415c93a512f74898d0225ce2e9298f24cc12f60d))
* **workflows:** close review blockers — prefetch-safe approvals + loud gate-edge failure ([98ab717](https://github.com/the-luap/picpeak/commit/98ab717043e3fdefac0934bf8f4621d523b15e9a))
* **workflows:** harden graph validation + refuse enabling unimplemented flows ([d927464](https://github.com/the-luap/picpeak/commit/d927464778272bd862aa01903179672f4d47368a))
* **workflows:** matchFilter strict equality + accurate comment ([dee8d40](https://github.com/the-luap/picpeak/commit/dee8d40bb3235a908bba514a97a62d3a91a6e131))
* **workflows:** ship built-ins disabled for first beta + enabled-based mutex + admin sentinel ([5893ecb](https://github.com/the-luap/picpeak/commit/5893ecb27a0365a79ec04336c5a122b31d31db0e))
* **workflows:** wire a real, SSRF-guarded webhook action (was a silent no-op) ([af7eea8](https://github.com/the-luap/picpeak/commit/af7eea8b43e37905a79138bcde4b1026dea13050))

## [3.70.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.69.1-beta.0...v3.70.0-beta.0) (2026-06-23)


### Features

* **analytics:** pluggable trackers — Umami + Rybbit + Custom ([#663](https://github.com/the-luap/picpeak/issues/663) Phase 1) ([83461fe](https://github.com/the-luap/picpeak/commit/83461fe5d4d44006482167464d92e70546cf7377))

## [3.69.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.69.0-beta.0...v3.69.1-beta.0) (2026-06-23)


### Bug Fixes

* **analytics:** admin dashboard reads correct fields + Umami device API ([#661](https://github.com/the-luap/picpeak/issues/661)) ([349f566](https://github.com/the-luap/picpeak/commit/349f566e87b33c59f61eb28b8abc5f889e6285d6))
* **analytics:** admin dashboard reads correct fields + Umami device API ([#661](https://github.com/the-luap/picpeak/issues/661)) ([7534447](https://github.com/the-luap/picpeak/commit/7534447b6c0df4290fd8dac12270673097096f1b))

## [3.69.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.68.1-beta.0...v3.69.0-beta.0) (2026-06-22)


### Features

* **feedback:** per-guest favorite + like caps with mobile-friendly limit modal ([#655](https://github.com/the-luap/picpeak/issues/655)) ([3ac7017](https://github.com/the-luap/picpeak/commit/3ac70177efc237b8169278208983b0de3629bc72))
* **feedback:** per-guest favorite + like caps with mobile-friendly limit modal ([#655](https://github.com/the-luap/picpeak/issues/655)) ([f2814e4](https://github.com/the-luap/picpeak/commit/f2814e4a4ce3aa9affc232243d615a15a1aae0c0))


### Bug Fixes

* **i18n:** replace ASCII quote with U+201D in DE perGuestLimitsDesc ([98e97e3](https://github.com/the-luap/picpeak/commit/98e97e3cf214c96cdefd99bfedd6724f0b85c41c))

## [3.68.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.68.0-beta.0...v3.68.1-beta.0) (2026-06-22)


### Bug Fixes

* **gallery:** unbreak password entry in Instagram in-app browser ([#654](https://github.com/the-luap/picpeak/issues/654)) ([6193ab7](https://github.com/the-luap/picpeak/commit/6193ab7f6aafd94b6e2e432ddf170361fd306d4e))
* **gallery:** unbreak password entry in Instagram in-app browser ([#654](https://github.com/the-luap/picpeak/issues/654)) ([b1bfd48](https://github.com/the-luap/picpeak/commit/b1bfd4838e7104e4f85695e180b20222206073ac))
* **test:** raise bootCrmDb beforeAll timeout on slideshow suites ([f4b6b89](https://github.com/the-luap/picpeak/commit/f4b6b8941a30a20615cc87627a0663ff6d03c932))

## [3.68.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.67.1-beta.0...v3.68.0-beta.0) (2026-06-21)


### Features

* **whatsapp:** admin-selectable template parameters + reorder ([#647](https://github.com/the-luap/picpeak/issues/647) follow-up) ([80e8ec5](https://github.com/the-luap/picpeak/commit/80e8ec5bc71f0653d56f1087521f5207aee0ba8f))

## [3.67.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.67.0-beta.0...v3.67.1-beta.0) (2026-06-21)


### Bug Fixes

* **branding+whatsapp:** preserve customCss through preset switches ([#645](https://github.com/the-luap/picpeak/issues/645)) + admin-pinned WhatsApp template language ([#647](https://github.com/the-luap/picpeak/issues/647)) ([cde028e](https://github.com/the-luap/picpeak/commit/cde028e9199a9ddb09957a87590732f4bd4d7a7b))

## [3.67.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.66.1-beta.0...v3.67.0-beta.0) (2026-06-21)


### Features

* Live Slideshow ("Diashow") — fullscreen, auto-updating projector view for live events ([4356393](https://github.com/the-luap/picpeak/commit/4356393b4433dd6b4147388688766b9464294c89))
* **slideshow:** add image fit setting (fill vs black bars) ([b5c73e0](https://github.com/the-luap/picpeak/commit/b5c73e05bd41b262f864e8c700b1d38582b3817f))
* **slideshow:** admin ui for live slideshow ([385b05a](https://github.com/the-luap/picpeak/commit/385b05adcf6a4acb7939e372328a55df7dae5e08))
* **slideshow:** backend api for live slideshow ([dea5e0f](https://github.com/the-luap/picpeak/commit/dea5e0f8a6421c056868c2d9bea11e5bf1ee106a))
* **slideshow:** db columns for live slideshow ([1029dd0](https://github.com/the-luap/picpeak/commit/1029dd05bdb9ca0a97ad86100145221850648651))
* **slideshow:** en/de strings for live slideshow ([cb761ee](https://github.com/the-luap/picpeak/commit/cb761ee621aa553cf210c4224b6cbbf7bf2ef0cb))
* **slideshow:** gate behind a feature flag + move globals to a Settings tab ([69367b4](https://github.com/the-luap/picpeak/commit/69367b45be1c13d87e73e72da34a1f41a5849dfe))
* **slideshow:** public fullscreen slideshow viewer ([fd02254](https://github.com/the-luap/picpeak/commit/fd02254f78bd1860780355ebaa68293d58ce18b3))


### Bug Fixes

* **slideshow:** deny display-only token on download/upload/feedback (PR [#646](https://github.com/the-luap/picpeak/issues/646) review) ([e36b330](https://github.com/the-luap/picpeak/commit/e36b3309ca66404d189d5b218cc1f0eba925e4c7))
* **slideshow:** dip-to-white/black no longer flickers the image ([db8388c](https://github.com/the-luap/picpeak/commit/db8388c79e44f5d254d984810bd62bfb11effd0f))
* **slideshow:** drop updated_at from event writes ([1e40f82](https://github.com/the-luap/picpeak/commit/1e40f8296ca59ff0395f6cc09ee452ab62653cdc))
* **slideshow:** feature flag is a master kill-switch, not just admin UI ([759784a](https://github.com/the-luap/picpeak/commit/759784a4d1cfe7e67c825293760169ad6904f090))
* **slideshow:** fill the viewport instead of black bars ([6ec46de](https://github.com/the-luap/picpeak/commit/6ec46de0e7bb821ea4e4a7fc2318792b810c3f36))
* **slideshow:** read globals from app_settings, not the missing settings table ([0f4388d](https://github.com/the-luap/picpeak/commit/0f4388d68ab85049c46e7af566d35f4fbf6e4d02))
* **slideshow:** surface backend error in the live slideshow card ([056f938](https://github.com/the-luap/picpeak/commit/056f9381de5dbe90243bea409b587b4910050cbf))


### Performance Improvements

* **slideshow:** cache global settings to cut /state DB reads (PR [#646](https://github.com/the-luap/picpeak/issues/646) review) ([a995131](https://github.com/the-luap/picpeak/commit/a995131f4266e112c96c6e8cedd5158995ebe899))


### Documentation

* **slideshow:** add Live Slideshow guide + README entries ([16013d1](https://github.com/the-luap/picpeak/commit/16013d1cf9ad82ee052f905f9702feffde7b67eb))

## [3.66.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.66.0-beta.0...v3.66.1-beta.0) (2026-06-19)


### Bug Fixes

* **deps:** bump qs/brace-expansion overrides + add uuid override for node-cron ([d705059](https://github.com/the-luap/picpeak/commit/d705059d3c2904184f037bbe0208fe128fdb9b63))
* **security:** close BOLA on photo-export + NAT64 SSRF in URL guard ([b8211e9](https://github.com/the-luap/picpeak/commit/b8211e9944da9e7b1c43a25e2f24c8a2425000cf))
* **security:** close NAT64 SSRF + photo-export BOLA + sweep Trivy alerts (GHSA-wmjx-pc37-272r, GHSA-9v4w-jrhx-g5wr) ([6f40db8](https://github.com/the-luap/picpeak/commit/6f40db859751efc2c931bc981a48148808fd3701))

## [3.66.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.65.1-beta.0...v3.66.0-beta.0) (2026-06-19)


### Features

* **categories:** per-category download permissions ([#640](https://github.com/the-luap/picpeak/issues/640) part B) ([820f483](https://github.com/the-luap/picpeak/commit/820f4835f1f5a41cbef6816c387ef9ec3dafd526))
* **common:** generic Promise-based ConfirmDialog primitive ([#640](https://github.com/the-luap/picpeak/issues/640) part C) ([a3fcb5b](https://github.com/the-luap/picpeak/commit/a3fcb5bc9e82849ebe1f55620e8aa7e60ccd973f))
* **feedback:** export shape toggle — per-action vs per-guest pivot ([#640](https://github.com/the-luap/picpeak/issues/640) part E) ([fabd67a](https://github.com/the-luap/picpeak/commit/fabd67aecd6caf308956e5b4cb9df7dd44452142))
* **whatsapp:** WhatsApp Business API notification channel ([#640](https://github.com/the-luap/picpeak/issues/640) part D) ([78c8e9d](https://github.com/the-luap/picpeak/commit/78c8e9d9f91d56e07e04df4ed90fb05ccdfb69d2))


### Bug Fixes

* **archives:** stream-extract restore for &gt;2 GiB + preserve original_filename via manifest ([#640](https://github.com/the-luap/picpeak/issues/640)) ([e4e79a0](https://github.com/the-luap/picpeak/commit/e4e79a0b3a6d3ddbbc2f3cebdcadc89307147248))
* **i18n:** wrap WhatsApp token show/hide aria-label through t() ([a8bb7b4](https://github.com/the-luap/picpeak/commit/a8bb7b439f6f57af9653ce283c951070bd52f3c2))
* **settings:** hoist tab-visibility useEffect above isLoading early return ([49bfb45](https://github.com/the-luap/picpeak/commit/49bfb45332993b919ad4f949a0cd912a85888620))

## [3.65.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.65.0-beta.0...v3.65.1-beta.0) (2026-06-18)


### Bug Fixes

* **i18n:** sweep activity-type translations + Events / API Tokens / Webhooks settings tabs ([f17c654](https://github.com/the-luap/picpeak/commit/f17c654e146683683f347ae2cd46de9cf3e47989))

## [3.65.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.64.0-beta.0...v3.65.0-beta.0) (2026-06-18)


### Features

* **accounting:** consolidate VAT/financial config into Settings → Accounting ([dc7b87b](https://github.com/the-luap/picpeak/commit/dc7b87bb874e22ac6902fd2d48531ecdb6108c88))
* **accounting:** explain dispositions inline, drop markup from pass-through ([9a023c0](https://github.com/the-luap/picpeak/commit/9a023c019750ebcd8d21e005aaf9a77a32cb34a3))
* **accounting:** incoming-invoice workflow v2 + VAT/financial settings consolidation ([b527915](https://github.com/the-luap/picpeak/commit/b5279155ea4c545e13bab8bde46a39cfccf107fe))
* **accounting:** invoices force-enable the Accounting master ([51837c3](https://github.com/the-luap/picpeak/commit/51837c3a88f711b164fafe2c7677e1a91c7542f9))
* **accounting:** re-categorize incoming invoices, note field, pending re-bill pool ([36a8e42](https://github.com/the-luap/picpeak/commit/36a8e42f90f15a1ba96d9c4f004fa542d33e4937))
* **accounting:** supplier-country tax default + configurable default output VAT code ([267b121](https://github.com/the-luap/picpeak/commit/267b121d66994bc57b10cd0694ab0e4320b163d9))


### Bug Fixes

* **accounting:** address the-luap PR [#636](https://github.com/the-luap/picpeak/issues/636) review ([707c5d0](https://github.com/the-luap/picpeak/commit/707c5d027798bdafb9fe09d7efcbd9ea65330076))
* **accounting:** tax-report storno totals + hours-line date on Postgres ([db9e41d](https://github.com/the-luap/picpeak/commit/db9e41d19846b31b29c5c1be2ee06a7958bb43b0))
* **crm:** editor totals box computed VAT 100× too small ([e9b297c](https://github.com/the-luap/picpeak/commit/e9b297c162a19da31d53de377b90bfd5cda1b0a7))
* **hours:** move logActivity out of the entry transactions (SQLite deadlock) ([348955b](https://github.com/the-luap/picpeak/commit/348955b261713fc9f0b48391a1d4117f6f8c873f))

## [3.64.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.63.0-beta.0...v3.64.0-beta.0) (2026-06-18)


### Features

* **admin/exports:** inline preview modal with copy-to-clipboard ([#631](https://github.com/the-luap/picpeak/issues/631)) ([fc5c1ae](https://github.com/the-luap/picpeak/commit/fc5c1ae93f87678fcc16bc84a14a60a59b1a3c7b))
* **admin/exports:** inline preview modal with copy-to-clipboard ([#631](https://github.com/the-luap/picpeak/issues/631)) ([27b5f7e](https://github.com/the-luap/picpeak/commit/27b5f7e4b68e43345cd99dd5cc77308dcd7ec98b))

## [3.63.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.62.0-beta.0...v3.63.0-beta.0) (2026-06-17)


### Features

* **events:** duplicate-gallery action ([#626](https://github.com/the-luap/picpeak/issues/626)) ([e985d25](https://github.com/the-luap/picpeak/commit/e985d25207671cbfefcdda9775a96eadf2fe0698))


### Bug Fixes

* **events:** publish-from-draft email carries the real password ([#627](https://github.com/the-luap/picpeak/issues/627)) ([83b568e](https://github.com/the-luap/picpeak/commit/83b568ee2ddc007b7d981fd4b46b69810f0165c3))
* **gallery:** admin edits to welcome_message land for returning guests ([#625](https://github.com/the-luap/picpeak/issues/625)) ([ea6245c](https://github.com/the-luap/picpeak/commit/ea6245cfdea67bd4668e2100f295433a3d29f7f1))
* **upload:** auto-throttle on low-memory hosts + correct documented RAM minimum ([#628](https://github.com/the-luap/picpeak/issues/628)) ([714a9f6](https://github.com/the-luap/picpeak/commit/714a9f6fb1f48ba1316cc240054d5128749581d8))

## [3.62.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.61.0-beta.0...v3.62.0-beta.0) (2026-06-17)


### Features

* **accounting:** add a Banana "Income & Expense" (cash-book) export format ([445d6d7](https://github.com/the-luap/picpeak/commit/445d6d7b6d6b0692d5b7c0a3dd0ca8b71dfad6ef))
* **accounting:** bill editor VAT dropdown + GET returns vat_code snapshot ([2479d87](https://github.com/the-luap/picpeak/commit/2479d87afc5b094a5323bca0b67e6404ce05a4e2))
* **accounting:** clearer tax-export window + gate journal export on accounting flag ([3edd832](https://github.com/the-luap/picpeak/commit/3edd8321035c48d6b3e8b157d4b94075657fc7a0))
* **accounting:** data-driven revenue-rate VAT map (multi-country) ([873be91](https://github.com/the-luap/picpeak/commit/873be910a5e88a6d942f116c2bcfecfef9161024))
* **accounting:** move Chart of accounts into Settings → Accounting ([97795f6](https://github.com/the-luap/picpeak/commit/97795f6d1ed25d23396a76b63c225b110ddc315e))
* **accounting:** move Treuhänder export onto the Tax page ([b1f73c1](https://github.com/the-luap/picpeak/commit/b1f73c1df9408ddae821760eb8ed57c726d2e056))
* **accounting:** relocate VAT codes + rate maps into Settings → Accounting ([4ff5b84](https://github.com/the-luap/picpeak/commit/4ff5b84cb66e40be960c2be7a67334cf0cc98be2))
* **accounting:** scope the tax-report export to income-only or cost-only ([9f3b286](https://github.com/the-luap/picpeak/commit/9f3b28684ff36b131420cd975df634a29d660323))
* **accounting:** snapshot the chosen VAT code on quote/invoice create + storno ([5b52969](https://github.com/the-luap/picpeak/commit/5b52969e36a41bbc08a98e0bca1ce0e937d77f56))
* **accounting:** snapshot vat_code on quotes/invoices + export prefers it (foundation) ([0a7dc1c](https://github.com/the-luap/picpeak/commit/0a7dc1cf5da17a5bef204f6680844c8ab2b44269))
* **accounting:** tax report VAT-payable honours registration + reclaim ([d7107aa](https://github.com/the-luap/picpeak/commit/d7107aaf0adf5e03f08085c7691b6530b15ed702))
* **accounting:** unify tax report into one signed, typed, sortable ledger ([fd1dd81](https://github.com/the-luap/picpeak/commit/fd1dd81e8dfc790d960a7e6d888beba895a23461))
* **accounting:** VAT registration + reclaim-country settings in the Accounting tab ([4d87684](https://github.com/the-luap/picpeak/commit/4d876848823bce2c79e629308c92206c64d9893d))
* **accounting:** VAT registration/reclaim settings + un-gated VAT-codes read ([fbbbb8a](https://github.com/the-luap/picpeak/commit/fbbbb8ab7335f07ecf48e217632c7011bd7c88cd))
* **accounting:** VAT-code dropdown in the quote editor (+ reusable VatRateSelect) ([6e1924b](https://github.com/the-luap/picpeak/commit/6e1924bae8b50dbb8460e151c1d9a79553fddb19))
* **branding:** force color mode = standard look; hide overridden theme controls ([4749e22](https://github.com/the-luap/picpeak/commit/4749e222dc41695a2494a3b740952745bb854d4e))


### Bug Fixes

* **accounting:** Banana export is now a tab-separated .txt (actually importable) ([a195067](https://github.com/the-luap/picpeak/commit/a19506749a449ec0a628da776af5a5bea8a2e46e))
* **accounting:** Banana I&E export uses the 'Category' column (not 'ContraAccount') ([53a16f9](https://github.com/the-luap/picpeak/commit/53a16f9f6f9b11c224b3ff5f337f8a7fe4dbfc38))
* **accounting:** emit ISO dates in exports (Postgres returns Date objects) ([0c0fb29](https://github.com/the-luap/picpeak/commit/0c0fb29770d7559b8b35a1b2a0aae1315485d875))
* **accounting:** label the outgoing-invoice totals block in the tax summary ([f3e77e7](https://github.com/the-luap/picpeak/commit/f3e77e78079c6869a3a5de062a90f1a04fecde3c))
* **accounting:** PR [#622](https://github.com/the-luap/picpeak/issues/622) blockers — CSV formula injection + IMAP double-ingest race ([cd6d578](https://github.com/the-luap/picpeak/commit/cd6d57839b4753b2848620c5960332cc945580ce))
* **accounting:** PR [#622](https://github.com/the-luap/picpeak/issues/622) concerns — flag-cache, customer master gate, VAT-unconfigured, helpers, page cap ([a93b6dc](https://github.com/the-luap/picpeak/commit/a93b6dc232375e1362e091c8868a409b1335dcae))
* **accounting:** tax report cost side queried a non-existent column ([ab65a47](https://github.com/the-luap/picpeak/commit/ab65a470a009d33558a7167dd2c3c649f785e686))
* **accounting:** tidy the tax-export scope selector styling ([8deb7e0](https://github.com/the-luap/picpeak/commit/8deb7e0741a5bf559cb9f9b78350821dc84bdb53))
* **accounting:** UTF-8 BOM on the ledger export so Banana reads it correctly ([74144da](https://github.com/the-luap/picpeak/commit/74144da45fc0a7a2c2e88d17a23b584ba77e9262))
* **branding:** force lock = light/dark only; Branding stays the full preset, galleries hide color+mode ([a7c1913](https://github.com/the-luap/picpeak/commit/a7c19135bb9645a7f95d5fe76581098db305394f))
* **branding:** when a force lock is active, collapse the theme customizer to just the Force control ([1ac653a](https://github.com/the-luap/picpeak/commit/1ac653ad1b9f47af8cb24cb53ffa60a1e95192fc))
* **crm:** admin surfaces follow the admin light/dark toggle, not the gallery theme ([#620](https://github.com/the-luap/picpeak/issues/620)) ([d3266a0](https://github.com/the-luap/picpeak/commit/d3266a0d1c458e8ae9c57ccd2f650e699544d2d6))
* **flags:** close CRM/accounting feature-gating gaps from the audit ([03fa3d8](https://github.com/the-luap/picpeak/commit/03fa3d82962d6d6f3cd9630e01258013d567865e))
* **settings:** don't insert non-existent created_at into app_settings ([8621338](https://github.com/the-luap/picpeak/commit/8621338c489cbd5194da6ac22d1fe1bd9d730cb0))


### Documentation

* **readme:** add CRM + accounting to features, tax disclaimer, update contributor ([116743b](https://github.com/the-luap/picpeak/commit/116743ba438505a52b021f80f678c5a0094d20d4))

## [3.61.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.60.6-beta.0...v3.61.0-beta.0) (2026-06-13)


### Features

* **projects:** Project Overview cockpit — link (multiple) quotes/contracts/hours into projects ([58f93ae](https://github.com/the-luap/picpeak/commit/58f93ae71350cc4a100f15a1a11f478750dace91))


### Bug Fixes

* **projects:** "one customer matches" rule for deal-lineage attach ([f74d8d4](https://github.com/the-luap/picpeak/commit/f74d8d4e8cd9fa040e067ffd751b183a9673161b))
* **projects:** address review — cross-customer guards + email/queue hardening ([9d13880](https://github.com/the-luap/picpeak/commit/9d13880f2b177a1a090c4685798e199a1f47b5ec))
* **projects:** enforce single-customer projects (guard event attach + re-label) ([4b1e85c](https://github.com/the-luap/picpeak/commit/4b1e85c8555b03cbed4abbd80e9cb45b831df6bf))

## [3.60.6-beta.0](https://github.com/the-luap/picpeak/compare/v3.60.5-beta.0...v3.60.6-beta.0) (2026-06-10)


### Bug Fixes

* **gallery:** guest upload honours general_max_files_per_upload + i18n placeholder interpolates ([#613](https://github.com/the-luap/picpeak/issues/613)) ([40a4aa2](https://github.com/the-luap/picpeak/commit/40a4aa2d85d93c9dc1faa69f0e6f8524ff917e29))
* **gallery:** guest upload honours general_max_files_per_upload + i18n placeholder interpolates ([#613](https://github.com/the-luap/picpeak/issues/613)) ([69b5186](https://github.com/the-luap/picpeak/commit/69b5186582d56c42cec520abbe5454171f9f666b))

## [3.60.5-beta.0](https://github.com/the-luap/picpeak/compare/v3.60.4-beta.0...v3.60.5-beta.0) (2026-06-09)


### Bug Fixes

* **admin/events:** delete cascade orphaned photo folders because it read a non-existent column ([#608](https://github.com/the-luap/picpeak/issues/608)) ([284680e](https://github.com/the-luap/picpeak/commit/284680e0357db20177e45ab4ab01de0fbcac2a98))
* **admin/events:** delete cascade orphaned photo folders because it read a non-existent column ([#608](https://github.com/the-luap/picpeak/issues/608)) ([457c956](https://github.com/the-luap/picpeak/commit/457c9563869156bc4773d873661a75d5115b25db))

## [3.60.4-beta.0](https://github.com/the-luap/picpeak/compare/v3.60.3-beta.0...v3.60.4-beta.0) (2026-06-08)


### Bug Fixes

* **admin:** graceful logo-img fallback + show sidebar widgets during perm hydration ([#523](https://github.com/the-luap/picpeak/issues/523) follow-up 2) ([f51b9cf](https://github.com/the-luap/picpeak/commit/f51b9cf8df2dfba07590b35cc63def689df98c4a))
* **admin:** logo-img fallback + sidebar perm hydration + filename NFD transliteration ([#523](https://github.com/the-luap/picpeak/issues/523) follow-up 2, [#607](https://github.com/the-luap/picpeak/issues/607)) ([fcd3ca3](https://github.com/the-luap/picpeak/commit/fcd3ca36c659eafa47c036f622da8114433b1c74))
* **downloads:** transliterate accented characters in filename via NFD instead of dropping them ([#607](https://github.com/the-luap/picpeak/issues/607)) ([620163f](https://github.com/the-luap/picpeak/commit/620163f2db77cda40b81edcac79a32cbb4fd278f))

## [3.60.3-beta.0](https://github.com/the-luap/picpeak/compare/v3.60.2-beta.0...v3.60.3-beta.0) (2026-06-04)


### Bug Fixes

* **security:** re-apply SVG CSP on the direct favicon route (PR [#603](https://github.com/the-luap/picpeak/issues/603) blocker) ([1214b6b](https://github.com/the-luap/picpeak/commit/1214b6b762ce6c763b9a28389c17905d8e47d87f))

## [3.60.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.60.1-beta.0...v3.60.2-beta.0) (2026-06-04)


### Bug Fixes

* **admin-header:** skeleton brand block + move LanguageSelector into profile menu on &lt;sm ([#523](https://github.com/the-luap/picpeak/issues/523) follow-up) ([b48b5b0](https://github.com/the-luap/picpeak/commit/b48b5b0000fd95bc149335614eb062dd373fc50a))
* **admin-header:** skeleton brand block + move LanguageSelector into profile menu on &lt;sm ([#523](https://github.com/the-luap/picpeak/issues/523) follow-up) ([fe10191](https://github.com/the-luap/picpeak/commit/fe10191b82546473f035435731bf6d6ecca2efd6))

## [3.60.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.60.0-beta.0...v3.60.1-beta.0) (2026-06-02)


### Bug Fixes

* **notifications:** restore /clear-all route the frontend already calls ([#597](https://github.com/the-luap/picpeak/issues/597)) ([940fc60](https://github.com/the-luap/picpeak/commit/940fc607400afa528f7f464c1d41541f46a4070d))

## [3.60.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.59.1-beta.0...v3.60.0-beta.0) (2026-06-02)


### Features

* **restore:** docker-logs visibility + ADMIN_CREDENTIALS.txt restore notice ([3322a1d](https://github.com/the-luap/picpeak/commit/3322a1d998bedf39274dbb473b44e7b1e7cbff51))


### Bug Fixes

* **backup-ui:** respect general_date_format + general_time_format ([09f6a1a](https://github.com/the-luap/picpeak/commit/09f6a1af6acfce5ef0da173fb3c17a16bb679047))
* **restore:** coerce pg bigint counts to Number before comparing (PR [#596](https://github.com/the-luap/picpeak/issues/596) round 2) ([354fbed](https://github.com/the-luap/picpeak/commit/354fbed18220b47167b9bf6b11b3881fc120b7ae))
* **restore:** hoist preservedMeta above SQLite/PG split (PR [#596](https://github.com/the-luap/picpeak/issues/596) blocker) ([a23fa3b](https://github.com/the-luap/picpeak/commit/a23fa3bb12cd05a922c0fb860ae97ffd3fe2baff))
* **restore:** move operator-meta replay after post-restore verification (PR [#596](https://github.com/the-luap/picpeak/issues/596) round 3) ([20e3092](https://github.com/the-luap/picpeak/commit/20e3092c146dd9151b6e7a370f885154f0adeecc))
* **restore:** set was_successful=true on the completed update ([7988c18](https://github.com/the-luap/picpeak/commit/7988c189723fa4639413b3a5339c148521c92c11))


### Documentation

* consolidate disaster-recovery into Backup & Restore guide ([43cb0ea](https://github.com/the-luap/picpeak/commit/43cb0ea4bfc4f241a55d2681f14c064df6b87920))

## [3.59.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.59.0-beta.0...v3.59.1-beta.0) (2026-05-31)


### Bug Fixes

* **admin-header:** hide wordmark on &lt;sm when logo also shows ([#523](https://github.com/the-luap/picpeak/issues/523)) ([c246fd3](https://github.com/the-luap/picpeak/commit/c246fd3cc89962d626218029ab3da1346a726246))
* **admin-header:** truncate long company names on narrow widths ([#523](https://github.com/the-luap/picpeak/issues/523) regression) ([e7cf834](https://github.com/the-luap/picpeak/commit/e7cf834325e8686613fbbee78d52213cb3ba98b1))
* **api/v1/events:** also honour require_password + branding defaults ([#592](https://github.com/the-luap/picpeak/issues/592) follow-up) ([2d44b1a](https://github.com/the-luap/picpeak/commit/2d44b1ab2d251a4fc752cfeb645cb2126c0da3b7))
* **api/v1/events:** honour global devtools-detection default on create ([#592](https://github.com/the-luap/picpeak/issues/592)) ([2304b25](https://github.com/the-luap/picpeak/commit/2304b2562465f8c86c82f2155fbdce264e68fdb3))
* **bug-batch:** [#523](https://github.com/the-luap/picpeak/issues/523) [#564](https://github.com/the-luap/picpeak/issues/564) [#590](https://github.com/the-luap/picpeak/issues/590) [#591](https://github.com/the-luap/picpeak/issues/591) [#592](https://github.com/the-luap/picpeak/issues/592) ([c68a03c](https://github.com/the-luap/picpeak/commit/c68a03c20e70b8049ed851d41e20143813935a3a))
* **csp:** external bootstrap script to survive strict reverse-proxy CSP ([#564](https://github.com/the-luap/picpeak/issues/564)) ([dcc629c](https://github.com/the-luap/picpeak/commit/dcc629cad23ce0ca89aabb6f8b1eacfde599774e))
* **gallery:** preserve per-viewer is_liked across hard refresh ([#590](https://github.com/the-luap/picpeak/issues/590) follow-up) ([791e997](https://github.com/the-luap/picpeak/commit/791e9974eb4c81cc4b095f9b604eccd708fb3a66))
* **gallery:** toggle (not add) the local liked set on click ([#590](https://github.com/the-luap/picpeak/issues/590)) ([d292b9f](https://github.com/the-luap/picpeak/commit/d292b9fa10bffe5d751629b900c606763fa8e73a))
* **nginx:** defensive large_client_header_buffers bump ([#591](https://github.com/the-luap/picpeak/issues/591)) ([c83e883](https://github.com/the-luap/picpeak/commit/c83e88348fbd473fb1de041cebabd3ace65d4d98))

## [3.59.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.58.0-beta.0...v3.59.0-beta.0) (2026-05-29)


### Features

* **admin/users:** reactivate + delete actions for deactivated admin users ([c4a9b36](https://github.com/the-luap/picpeak/commit/c4a9b3636fc7a9209ae724acb7c8cffe141d93ea))
* **admin/users:** reactivate + delete actions for deactivated admin users ([dfcebcc](https://github.com/the-luap/picpeak/commit/dfcebccee98a551980ad2be78a8356fd39894f8a))

## [3.58.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.57.2-beta.0...v3.58.0-beta.0) (2026-05-29)


### Features

* **i18n:** add Slovenian (sl) language support ([433af15](https://github.com/the-luap/picpeak/commit/433af1514687b5c103e72db800954f96fd42b9b8))

## [3.57.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.57.1-beta.0...v3.57.2-beta.0) (2026-05-29)


### Documentation

* list CRM under Beta Features + note dev-compose rebuild gotcha ([1ed4804](https://github.com/the-luap/picpeak/commit/1ed48046cbba1df3710cee197943521aedd1fe3d))

## [3.57.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.57.0-beta.0...v3.57.1-beta.0) (2026-05-29)


### Bug Fixes

* **email:** preserve dots + subaddresses across all normalization sites ([de9a924](https://github.com/the-luap/picpeak/commit/de9a924c77faebc2d0c1ff230a52d8da313259e8))

## [3.57.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.56.0-beta.0...v3.57.0-beta.0) (2026-05-29)


### Features

* **admin:** clickable version links + update-available modal with changelog & upgrade command ([48cf112](https://github.com/the-luap/picpeak/commit/48cf1121e546e112cd37d94f7924a808c020dd8f))


### Documentation

* **release:** establish stable-channel cadence + promotion process ([e537923](https://github.com/the-luap/picpeak/commit/e537923857b4b6000d715bba23a78f8685b44ee6))

## [3.56.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.55.0-beta.0...v3.56.0-beta.0) (2026-05-29)


### Features

* CRM module — quotes, contracts, invoices, hours, calendar, tax ([5f0fcc2](https://github.com/the-luap/picpeak/commit/5f0fcc225c29ce0f4410c5aba5ecd5a3a6d07259))


### Bug Fixes

* **crm:** thread trx through sequence-claim sites to unblock SQLite ([d1aecaa](https://github.com/the-luap/picpeak/commit/d1aecaa1804c0039744eb79a4032d1ed923e0b85))
* **quote-response:** compute minutes-remaining for the DE changeWithin string ([5ce0b6e](https://github.com/the-luap/picpeak/commit/5ce0b6edc3fef41f2f22dd585a668f471ac47a2e))

## [3.55.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.54.7-beta.0...v3.55.0-beta.0) (2026-05-27)


### Features

* **lightbox:** multi-photo Web Share save-to-Photos on iOS ([#557](https://github.com/the-luap/picpeak/issues/557)) ([d5823c7](https://github.com/the-luap/picpeak/commit/d5823c79d9a187461c0126adcff7f4374cd0e8aa))


### Bug Fixes

* **events:** preserve branding inheritance when saving events with null color_theme ([d5a37df](https://github.com/the-luap/picpeak/commit/d5a37df2c41425511dc8a1f974088bebb768f0d5))
* **lightbox+events:** Android download lag, multi-photo Web Share re-land, theme branding inheritance ([e016f51](https://github.com/the-luap/picpeak/commit/e016f510b6cc57a9ed1b59e2ee24fedd5d7097c3))
* **lightbox:** eliminate download lag on Android by skipping the blob round-trip ([0479521](https://github.com/the-luap/picpeak/commit/04795219a0b66fdd1ef73748d803adfdfc0d676f))

## [3.54.7-beta.0](https://github.com/the-luap/picpeak/compare/v3.54.6-beta.0...v3.54.7-beta.0) (2026-05-26)


### Bug Fixes

* **lightbox:** restrict Web Share save-to-Photos path to iOS ([#554](https://github.com/the-luap/picpeak/issues/554)) ([578397b](https://github.com/the-luap/picpeak/commit/578397bc6b27b56ccf3bf1f2f244e0e0053c493a))
* **lightbox:** restrict Web Share save-to-Photos path to iOS ([#554](https://github.com/the-luap/picpeak/issues/554)) ([2a309c7](https://github.com/the-luap/picpeak/commit/2a309c75a74be3af3eb67758f8d65f801ef3019a))

## [3.54.6-beta.0](https://github.com/the-luap/picpeak/compare/v3.54.5-beta.0...v3.54.6-beta.0) (2026-05-25)


### Bug Fixes

* **api/v1:** accept color_theme + create feedback row on event create ([#550](https://github.com/the-luap/picpeak/issues/550)) ([7ef0e40](https://github.com/the-luap/picpeak/commit/7ef0e40e7cee2ab6eeea4fe75c558e930e31241d))
* **api/v1:** accept color_theme + create feedback row on event create ([#550](https://github.com/the-luap/picpeak/issues/550)) ([1b521e7](https://github.com/the-luap/picpeak/commit/1b521e761c3e2cc6c885d03ef746aa7e77e6f067))

## [3.54.5-beta.0](https://github.com/the-luap/picpeak/compare/v3.54.4-beta.0...v3.54.5-beta.0) (2026-05-22)


### Bug Fixes

* **nginx:** honour outer X-Forwarded-Proto when behind a reverse proxy ([#547](https://github.com/the-luap/picpeak/issues/547)) ([b351d17](https://github.com/the-luap/picpeak/commit/b351d17ee99528dd4251e74dfc47cd1fe289d9c3))
* **nginx:** honour outer X-Forwarded-Proto when behind a reverse proxy ([#547](https://github.com/the-luap/picpeak/issues/547)) ([5488de3](https://github.com/the-luap/picpeak/commit/5488de3383d33d8a037587dd9112d36ea035c465))

## [3.54.4-beta.0](https://github.com/the-luap/picpeak/compare/v3.54.3-beta.0...v3.54.4-beta.0) (2026-05-21)


### Bug Fixes

* recover three orphaned commits from [#527](https://github.com/the-luap/picpeak/issues/527) (BRAND_TITLE runtime, Web Share, pan zoom) ([9607b46](https://github.com/the-luap/picpeak/commit/9607b4666c0abf22e54b43be3e87e3243db2cdbc))

## [3.54.3-beta.0](https://github.com/the-luap/picpeak/compare/v3.54.2-beta.0...v3.54.3-beta.0) (2026-05-21)


### Bug Fixes

* **lightbox:** fill the heart icon when liked ([#538](https://github.com/the-luap/picpeak/issues/538) follow-up) ([3e39112](https://github.com/the-luap/picpeak/commit/3e39112a1276c194259d936dad813f3b0fc2dc3f))
* **lightbox:** fill the heart icon when liked ([#538](https://github.com/the-luap/picpeak/issues/538) follow-up) ([600c29d](https://github.com/the-luap/picpeak/commit/600c29db8a75fa44e72da55bc5288908de614d9d))

## [3.54.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.54.1-beta.0...v3.54.2-beta.0) (2026-05-20)


### Bug Fixes

* **feedback:** three guest-mode bugs from [#538](https://github.com/the-luap/picpeak/issues/538) (filter, like state, count leak) ([c900be9](https://github.com/the-luap/picpeak/commit/c900be92dd490b21aabb10fd56b6fbc3da444ee0))
* **feedback:** three guest-mode bugs reported in [#538](https://github.com/the-luap/picpeak/issues/538) ([5311588](https://github.com/the-luap/picpeak/commit/5311588baf3c6acfc971cb014a142d6b4b153aa1))

## [3.54.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.54.0-beta.0...v3.54.1-beta.0) (2026-05-20)


### Bug Fixes

* **public-site:** honor dark theme surface colors ([8b72721](https://github.com/the-luap/picpeak/commit/8b727218127db2a738ad5a4381358076c1575c8a))

## [3.54.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.53.0-beta.0...v3.54.0-beta.0) (2026-05-20)


### Features

* **install:** skip legacy chain when modern bootstrap fingerprint detected ([#530](https://github.com/the-luap/picpeak/issues/530)) ([8f0108c](https://github.com/the-luap/picpeak/commit/8f0108ce233f457d6a0f4f3dbc3e1b0a7217e74e))


### Bug Fixes

* **install:** skip legacy chain on recovery-state DBs + schema-drift CI ([#530](https://github.com/the-luap/picpeak/issues/530)) ([a0ebc97](https://github.com/the-luap/picpeak/commit/a0ebc97cdd871041ff3cfdcc7276c413ac89d24f))

## [3.53.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.52.1-beta.0...v3.53.0-beta.0) (2026-05-19)


### Features

* **events:** default Guest Feedback ON via admin setting ([#520](https://github.com/the-luap/picpeak/issues/520)) ([3465b55](https://github.com/the-luap/picpeak/commit/3465b55abc98e52cf58ba46b811f4ec115d53012))


### Bug Fixes

* **bug-batch-518:** lightbox comments toggle + further fixes ([633a2ae](https://github.com/the-luap/picpeak/commit/633a2ae72405ae1fc885cb710ed896476ffee467))
* **header:** hide language name on mobile to free the title ([#523](https://github.com/the-luap/picpeak/issues/523)) ([4b4ecfd](https://github.com/the-luap/picpeak/commit/4b4ecfdf7143c8f353355ecd6d5ee14bbf50c9bb))
* **lightbox:** hide comments toggle when allow_comments=false ([#518](https://github.com/the-luap/picpeak/issues/518)) ([d44e1ad](https://github.com/the-luap/picpeak/commit/d44e1adba7a444b03511e9402cd39d25fe5acafe))
* **og:** brandable static title + wider crawler UA coverage ([#521](https://github.com/the-luap/picpeak/issues/521)) ([b960639](https://github.com/the-luap/picpeak/commit/b96063903513fcc4cbe0e72f59ccbc37d7b1c0ab))

## [3.52.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.52.0-beta.0...v3.52.1-beta.0) (2026-05-18)


### Bug Fixes

* **install:** self-chowning entrypoint kills fresh-install restart loop ([#484](https://github.com/the-luap/picpeak/issues/484)) ([42c5cda](https://github.com/the-luap/picpeak/commit/42c5cda38c0deeb4e61554e9e4a913bd5cd0b980))

## [3.52.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.51.5-beta.0...v3.52.0-beta.0) (2026-05-18)


### Features

* **api/v1:** accept category_id on POST /events/:id/photos ([2d5a2ad](https://github.com/the-luap/picpeak/commit/2d5a2ad78a5f6c101315214399a9c158ff0549da))
* **api/v1:** accept category_id on POST /events/:id/photos ([6901e26](https://github.com/the-luap/picpeak/commit/6901e2661ed74e69f19c52ce046ee911b818d463))


### Bug Fixes

* **api/v1:** scope category lookup to event_owned or global ([92bb9e1](https://github.com/the-luap/picpeak/commit/92bb9e1a12f77ce5e8c1286716198362b2bfdff2))

## [3.51.5-beta.0](https://github.com/the-luap/picpeak/compare/v3.51.4-beta.0...v3.51.5-beta.0) (2026-05-17)


### Bug Fixes

* **email:** parse JSON-encoded language setting before using as locale ([ebc7da2](https://github.com/the-luap/picpeak/commit/ebc7da21bea90ff84f5351bef4fd3c2605d3a68f))

## [3.51.4-beta.0](https://github.com/the-luap/picpeak/compare/v3.51.3-beta.0...v3.51.4-beta.0) (2026-05-17)


### Bug Fixes

* **categories:** strip diacritics from auto-generated slugs ([a747eb3](https://github.com/the-luap/picpeak/commit/a747eb351d1cf0ed269751cb685b504993d33dde))

## [3.51.3-beta.0](https://github.com/the-luap/picpeak/compare/v3.51.2-beta.0...v3.51.3-beta.0) (2026-05-16)


### Bug Fixes

* **i18n:** settings page resets UI language to server default ([482e91b](https://github.com/the-luap/picpeak/commit/482e91bbf8b8deee361ffc8b031094fb99cc569d))

## [3.51.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.51.1-beta.0...v3.51.2-beta.0) (2026-05-16)


### Bug Fixes

* **i18n:** drive customer "Preferred language" select from SUPPORTED_LANGUAGES ([#510](https://github.com/the-luap/picpeak/issues/510)) ([51890e1](https://github.com/the-luap/picpeak/commit/51890e1aa5bacb5cfb5c9dc6e59770bd18406a66))

## [3.51.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.51.0-beta.0...v3.51.1-beta.0) (2026-05-16)


### Bug Fixes

* **install:** silence clean-install postgres log noise ([#484](https://github.com/the-luap/picpeak/issues/484)) ([99e60a2](https://github.com/the-luap/picpeak/commit/99e60a243321a06f659d811babbcda9ffef655c4))
* **install:** silence clean-install postgres log noise ([#484](https://github.com/the-luap/picpeak/issues/484)) ([86b33d4](https://github.com/the-luap/picpeak/commit/86b33d4ddaf98e1f32473832b0f89565750174e5))

## [3.51.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.50.0-beta.0...v3.51.0-beta.0) (2026-05-14)


### Features

* **downloads:** preserve original camera filenames on download (opt-in) ([#493](https://github.com/the-luap/picpeak/issues/493)) ([826e43e](https://github.com/the-luap/picpeak/commit/826e43ebac940782be234630c50bbd54a3250f98))

## [3.50.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.49.6-beta.0...v3.50.0-beta.0) (2026-05-14)


### Features

* **lightbox:** medium-resolution preview tier ([#492](https://github.com/the-luap/picpeak/issues/492)) ([3083c74](https://github.com/the-luap/picpeak/commit/3083c748b92fe7800044125524d053f5eeb28d4a))
* **lightbox:** medium-resolution preview tier ([#492](https://github.com/the-luap/picpeak/issues/492)) ([61f1d13](https://github.com/the-luap/picpeak/commit/61f1d132104f485cfde9bd874e1c0ffdc042c4af))

## [3.49.6-beta.0](https://github.com/the-luap/picpeak/compare/v3.49.5-beta.0...v3.49.6-beta.0) (2026-05-14)


### Bug Fixes

* **install:** defer events.hero_photo_id FK to break circular reference ([#484](https://github.com/the-luap/picpeak/issues/484)) ([62b3ed6](https://github.com/the-luap/picpeak/commit/62b3ed636414d358c0c73712b732207fc6fa1200))
* **install:** defer events.hero_photo_id FK to break circular reference ([#484](https://github.com/the-luap/picpeak/issues/484)) ([87834a7](https://github.com/the-luap/picpeak/commit/87834a7fff57a53bb1060ad7061dd6d279922f42))

## [3.49.5-beta.0](https://github.com/the-luap/picpeak/compare/v3.49.4-beta.0...v3.49.5-beta.0) (2026-05-14)


### Bug Fixes

* **admin-users:** normalise date fields to ISO across DB drivers ([#485](https://github.com/the-luap/picpeak/issues/485)) ([d300426](https://github.com/the-luap/picpeak/commit/d3004263905edeffe59065e201f203a6768b4384))
* **admin-users:** normalise date fields to ISO across DB drivers ([#485](https://github.com/the-luap/picpeak/issues/485)) ([b6b58d0](https://github.com/the-luap/picpeak/commit/b6b58d0659fc8caee68a65e112780a1122d55907))

## [3.49.4-beta.0](https://github.com/the-luap/picpeak/compare/v3.49.3-beta.0...v3.49.4-beta.0) (2026-05-14)


### Bug Fixes

* **install:** drop racy migration step + add missing frontend container ([#484](https://github.com/the-luap/picpeak/issues/484)) ([d4155c4](https://github.com/the-luap/picpeak/commit/d4155c46117eb1db6255ebac0ea47e6fc3e99801))
* **install:** silence pg healthcheck noise + drop legacy workers container ([#484](https://github.com/the-luap/picpeak/issues/484)) ([d39406b](https://github.com/the-luap/picpeak/commit/d39406b2414cdfcae84e8175d90821dd3a5287bb))
* **install:** silence pg healthcheck noise + drop legacy workers container ([#484](https://github.com/the-luap/picpeak/issues/484)) ([0b0b1bb](https://github.com/the-luap/picpeak/commit/0b0b1bb2d529dbaae8e49891d8d5e8019b971838))

## [3.49.3-beta.0](https://github.com/the-luap/picpeak/compare/v3.49.2-beta.0...v3.49.3-beta.0) (2026-05-14)


### Bug Fixes

* **promo-banner:** center by default + admin alignment selector ([#482](https://github.com/the-luap/picpeak/issues/482)) ([d1034ce](https://github.com/the-luap/picpeak/commit/d1034ce1c65c31b06005cfd0c047dba3251579ab))
* **promo-banner:** center by default + admin alignment selector ([#482](https://github.com/the-luap/picpeak/issues/482)) ([a803491](https://github.com/the-luap/picpeak/commit/a803491cf477c0d62e23d6a019e0d252e2c537f8))

## [3.49.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.49.1-beta.0...v3.49.2-beta.0) (2026-05-13)


### Bug Fixes

* **ci:** pin TRIVY_PLATFORM per matrix arch (post-[#477](https://github.com/the-luap/picpeak/issues/477) follow-up) ([6750f5d](https://github.com/the-luap/picpeak/commit/6750f5d3b06f6312629e81c4c84100c572746b69))
* **ci:** pin TRIVY_PLATFORM per matrix arch (post-[#477](https://github.com/the-luap/picpeak/issues/477) follow-up) ([c3256dc](https://github.com/the-luap/picpeak/commit/c3256dc6bf49a2352dfe38b804d757683bb3ac22))

## [3.49.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.49.0-beta.0...v3.49.1-beta.0) (2026-05-13)


### Bug Fixes

* **ci:** scan multi-arch images per-arch by digest, pin trivy-action ([#476](https://github.com/the-luap/picpeak/issues/476)) ([1144e9d](https://github.com/the-luap/picpeak/commit/1144e9d1625eb69d8e2a53b1a3aa1b515798fc80))

## [3.49.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.48.1-beta.0...v3.49.0-beta.0) (2026-05-13)


### Features

* **og:** per-event opt-in to use hero photo as social-share preview ([#474](https://github.com/the-luap/picpeak/issues/474)) ([d856340](https://github.com/the-luap/picpeak/commit/d856340f0d230ad26539ba1088f739f03aaafc13))
* **og:** per-event opt-in to use hero photo as social-share preview ([#474](https://github.com/the-luap/picpeak/issues/474)) ([0bc7e2a](https://github.com/the-luap/picpeak/commit/0bc7e2af171d1a4c6e91ba541d293b90c17c111b))

## [3.48.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.48.0-beta.0...v3.48.1-beta.0) (2026-05-12)


### Bug Fixes

* **customer-routes:** Cache-Control: no-store on customer endpoints ([#470](https://github.com/the-luap/picpeak/issues/470)) ([3122dd0](https://github.com/the-luap/picpeak/commit/3122dd08a8bc08deb937236aaa3f750119a979b9))

## [3.48.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.47.2-beta.0...v3.48.0-beta.0) (2026-05-12)


### Features

* **customers:** "Manage galleries" dialog on customer detail page ([6d1af7a](https://github.com/the-luap/picpeak/commit/6d1af7a0113b6e3de44ab9bf2645591f4d6d68b4))
* **customers:** "Manage galleries" dialog with immediate access revocation + section reorder + portal-flag revert ([9be9296](https://github.com/the-luap/picpeak/commit/9be9296eb58d7733d0b5f8ce6eb48e9832f65e7c))
* **customers:** email customer when admin adds new gallery access ([c02c947](https://github.com/the-luap/picpeak/commit/c02c947463011de80d9af3e947fc6d1caadc3313))
* **customers:** replace-assignments endpoint for a single customer ([5377b88](https://github.com/the-luap/picpeak/commit/5377b88e0e0c27ecde18c2a366fb7d06f279f2ec))
* **gallery:** revoke customer-minted JWTs when assignment is removed ([55a5846](https://github.com/the-luap/picpeak/commit/55a5846f6f802a1bc1910bb046325fe272a1b584))


### Bug Fixes

* **customer:** don't log customer out on transient session-refresh errors ([9e418c7](https://github.com/the-luap/picpeak/commit/9e418c759ce508adf6025e0740468d8229938ffe))


### Reverts

* **customer-portal:** make the global flag UI-only, drop the kill-switch middleware ([3f44193](https://github.com/the-luap/picpeak/commit/3f4419356a4f30509052a6d00b71485af2c17f85))

## [3.47.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.47.1-beta.0...v3.47.2-beta.0) (2026-05-11)


### Bug Fixes

* **activity-log:** smart feature_flags_updated rendering + 33 missing activity types ([4703fd5](https://github.com/the-luap/picpeak/commit/4703fd574f57bfab327ffefec5986bb08b240c95))

## [3.47.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.47.0-beta.0...v3.47.1-beta.0) (2026-05-11)


### Bug Fixes

* **features:** customer-portal card uses 'Clients' to match sidebar wording ([441cc41](https://github.com/the-luap/picpeak/commit/441cc419377055a5872f71afb19036cc5c932b58))
* **features:** customer-portal card uses 'Clients' to match sidebar wording ([dec2f5d](https://github.com/the-luap/picpeak/commit/dec2f5d3d2224b0d66f02bb9a562b4ddeaac77df))

## [3.47.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.46.3-beta.0...v3.47.0-beta.0) (2026-05-11)


### Features

* **email-templates:** categorise + link to feature flags ([84c06af](https://github.com/the-luap/picpeak/commit/84c06affb73687529e35dbbac15801deb41dc4f2))
* **email-templates:** categorise + sub-categorise + link to feature flags ([2cae3fe](https://github.com/the-luap/picpeak/commit/2cae3fe47deb667af5991ae1a90e3b5698693119))
* **email-templates:** group Templates UI by category + Feature off chip ([5ec26fc](https://github.com/the-luap/picpeak/commit/5ec26fc9981028163cab122e229c83cdbbf35828))
* **email-templates:** group Templates UI by category with core sub-sections ([53eecb6](https://github.com/the-luap/picpeak/commit/53eecb6f83ff75f1f3c75d68cee5e46d114ac8d1))
* **email-templates:** seed missing locale translations + post-075 templates ([e3150e4](https://github.com/the-luap/picpeak/commit/e3150e42130cacf19dc7beadb8c86c76c0fff340))
* **email-templates:** seed missing nl/pt/ru/fr translations ([358f7ee](https://github.com/the-luap/picpeak/commit/358f7ee99e2941ad179d5859178b35a80886542f))


### Bug Fixes

* **email-templates:** backfill subcategory + customer password reset translations ([2343a16](https://github.com/the-luap/picpeak/commit/2343a162df070cd5bd6abdc331bc5ca4aa283132))

## [3.46.3-beta.0](https://github.com/the-luap/picpeak/compare/v3.46.2-beta.0...v3.46.3-beta.0) (2026-05-11)


### Bug Fixes

* **branding:** socials + promo round-trip from DB to form ([#460](https://github.com/the-luap/picpeak/issues/460)) ([bd2288e](https://github.com/the-luap/picpeak/commit/bd2288e6a01786cec0649b3326189e9737db359e))
* **branding:** socials + promo round-trip from DB to form ([#460](https://github.com/the-luap/picpeak/issues/460)) ([ae64a6a](https://github.com/the-luap/picpeak/commit/ae64a6acbc119f78394e65cee7bf49910e1c7013))

## [3.46.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.46.1-beta.0...v3.46.2-beta.0) (2026-05-11)


### Bug Fixes

* **customer-portal:** post-merge fixes for event save, theme fonts, and customer→gallery handoff ([9776d8a](https://github.com/the-luap/picpeak/commit/9776d8a6fcccb5e19e7c652b7e47557213d85731))
* **events:** CustomerAccountPicker hooks order crashed /admin/events/new ([2a7ae07](https://github.com/the-luap/picpeak/commit/2a7ae0702dfc56e69bf845ded19888c29519414a))

## [3.46.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.46.0-beta.0...v3.46.1-beta.0) (2026-05-11)


### Bug Fixes

* **import:** capture photo dimensions in fileWatcher + s3AutoImporter ([#447](https://github.com/the-luap/picpeak/issues/447)) ([5b14854](https://github.com/the-luap/picpeak/commit/5b148542e6f2396ce47e3b6c301f186f9af9adec))

## [3.46.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.45.1-beta.0...v3.46.0-beta.0) (2026-05-11)


### Features

* **branding:** Customer dashboard header toggles in Branding page ([b252cb6](https://github.com/the-luap/picpeak/commit/b252cb67eb3645224a279fbbe9c14871438473f8))
* customer accounts ([#354](https://github.com/the-luap/picpeak/issues/354)) — recurring logins, profile, password reset, branded customer surface ([fe52953](https://github.com/the-luap/picpeak/commit/fe5295373b0bfeec1e81086206ffab7ce1b91094))
* **customers:** customer portal ([#354](https://github.com/the-luap/picpeak/issues/354)) on top of feature-flags reorg ([087ef45](https://github.com/the-luap/picpeak/commit/087ef45942a8a51d09af2cd8ec85aca330f6cf7f))


### Bug Fixes

* **auth:** restore COOKIE_SECURE='auto' default for production ([adfa29e](https://github.com/the-luap/picpeak/commit/adfa29e91eeea52aa672e38269c389a5178d9e5a))
* **customer:** unwrap /customer/* from RequireFeature gate ([da08a58](https://github.com/the-luap/picpeak/commit/da08a5828ab855365a2a2a6f4854b09eb409907a))
* **server:** drop missing requireCustomerPortal middleware import ([4fa7225](https://github.com/the-luap/picpeak/commit/4fa72257329942a6b598fa90c83c6bca7586fe33))
* **server:** mount /api/admin/feature-flags route ([f048011](https://github.com/the-luap/picpeak/commit/f048011324bfa4cee8f89b0131b68dd520446ca2))

## [3.45.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.45.0-beta.0...v3.45.1-beta.0) (2026-05-10)


### Bug Fixes

* **create-event:** branding-default theme survives eventTypes refetch ([d62c529](https://github.com/the-luap/picpeak/commit/d62c529b0278a9ac790b22f46f49004df71112ea))
* **create-event:** branding-default theme survives eventTypes refetch ([#323](https://github.com/the-luap/picpeak/issues/323)-B) ([37d487d](https://github.com/the-luap/picpeak/commit/37d487db86fe9fc11facff6d2c0bb9a24e6f6277))

## [3.45.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.44.2-beta.0...v3.45.0-beta.0) (2026-05-10)


### Features

* **footer:** hideable legal links + socials + promo banner ([#441](https://github.com/the-luap/picpeak/issues/441) + [#440](https://github.com/the-luap/picpeak/issues/440)) ([f3505c2](https://github.com/the-luap/picpeak/commit/f3505c2631cc5b4ae13a0f0d593a1ddd95fefdcb))

## [3.44.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.44.1-beta.0...v3.44.2-beta.0) (2026-05-10)


### Bug Fixes

* **events:** clamp page state when totalPages drops below current page ([#442](https://github.com/the-luap/picpeak/issues/442)) ([b4e30a4](https://github.com/the-luap/picpeak/commit/b4e30a4293c77e6dc34e955741ee113b9d530718))
* **events:** clamp page state when totalPages drops below current page ([#442](https://github.com/the-luap/picpeak/issues/442)) ([9c4a96f](https://github.com/the-luap/picpeak/commit/9c4a96fe977b7a0907f5dea99491385195b76184))

## [3.44.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.44.0-beta.0...v3.44.1-beta.0) (2026-05-10)


### Bug Fixes

* **events:** admins can clear expiration on edit even when 'Require expiration' is ON ([#426](https://github.com/the-luap/picpeak/issues/426)) ([3fd8af3](https://github.com/the-luap/picpeak/commit/3fd8af3d56b54f81cc20b75109cc212d23fc84c1))
* **events:** admins can clear expiration on edit even when "Require expiration" is ON ([#426](https://github.com/the-luap/picpeak/issues/426)) ([e544561](https://github.com/the-luap/picpeak/commit/e54456135cc8605fad949a955261cecc3f986355))

## [3.44.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.43.3-beta.0...v3.44.0-beta.0) (2026-05-10)


### Features

* **settings:** Features tab + sidebar reorg with feature-flag gating ([c3798e1](https://github.com/the-luap/picpeak/commit/c3798e19c8f928eac0ca1d7694d1ecfd78a1e437))
* **settings:** Features tab + sidebar reorg with feature-flag gating ([15e3336](https://github.com/the-luap/picpeak/commit/15e333681fe4ce94afa8e5b477b339b179d0195a))

## [3.43.3-beta.0](https://github.com/the-luap/picpeak/compare/v3.43.2-beta.0...v3.43.3-beta.0) (2026-05-09)


### Bug Fixes

* **gallery:** serve thumbnails / photos / hero via storage abstraction ([#432](https://github.com/the-luap/picpeak/issues/432)) ([d3007b0](https://github.com/the-luap/picpeak/commit/d3007b0dd29d37a46ce26e8b4eb15908e0f8e3d2))

## [3.43.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.43.1-beta.0...v3.43.2-beta.0) (2026-05-09)


### Documentation

* **contributing:** update branch reference from main to beta ([ed37caf](https://github.com/the-luap/picpeak/commit/ed37caf3d898d9b2db985e6c6ff203457fd4aa38))

## [3.43.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.43.0-beta.0...v3.43.1-beta.0) (2026-05-09)


### Bug Fixes

* **event:** correct updating client access ([d00f6fa](https://github.com/the-luap/picpeak/commit/d00f6fa7de59bdbd30efe9ce824e795cf05616f4))
* **event:** ensure client share token is generated only when necessary ([916580a](https://github.com/the-luap/picpeak/commit/916580adefd464417729e418aa1727b67566fea3))

## [3.43.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.42.7-beta.0...v3.43.0-beta.0) (2026-05-09)


### Features

* **localization:** add French translations for fit options in thumbnails ([2c12885](https://github.com/the-luap/picpeak/commit/2c1288583fe787c1514c3cace0e2d92a212bb3a3))
* **localization:** add i18next configuration and CLI commands for localization management ([74e87b9](https://github.com/the-luap/picpeak/commit/74e87b968b3152603dbfca72fae06372b7c7f519))
* **localization:** add i18next extraction helper & refactor backup configuration component to tsx ([e7228b0](https://github.com/the-luap/picpeak/commit/e7228b07805a40aa67ccb7e3592848218eabbca2))
* **localization:** add missing translations ([86ee6c8](https://github.com/the-luap/picpeak/commit/86ee6c80aa1f26b2ad47775337ebed301193e662))
* **localization:** improve English translations for clarity and consistency ([46b99c6](https://github.com/the-luap/picpeak/commit/46b99c629215832e66d9215a210fd6eaf8c89fb4))
* **localization:** update thumbnail settings and add fit options translations ([5fc427c](https://github.com/the-luap/picpeak/commit/5fc427c74b5cdda6ce1568006d9a94abdc692b3b))
* **translations:** add French language support and improve localization handling ([a5db4bd](https://github.com/the-luap/picpeak/commit/a5db4bd46e6a5cc84c9563588f90d3461c277528))


### Documentation

* **localization:** enhance French language support and improve i18next configuration ([d1bc5e0](https://github.com/the-luap/picpeak/commit/d1bc5e030f55c15bf09f37b97f8e1608578a2395))

## [Unreleased]

### Bug Fixes

* **event:** fix updating client access ([ee85e1d](https://github.com/the-luap/picpeak/commit/ee85e1d))

### Features

* **i18n:** add French (fr) language support with full translation coverage
* **i18n:** add i18next configuration with language detection and namespace setup
* **i18n:** add CLI commands for localization management (extraction, validation)
* **i18n:** add `i18nextExtractionHelper` developer script for auditing missing translation keys
* **i18n:** complete and restructure translation files for EN, DE, NL, PT, RU with consistent key naming

### Code Refactoring

* **admin:** convert `BackupConfiguration`, `BackupDashboard`, and `BackupManagement` from JSX to TSX with full i18n support
* **admin:** remove stale `.d.ts` declaration files replaced by TSX components
* **i18n:** clean up `useLocalizedTimeAgo` hook and update `useLocalizedDate`

## [3.42.7-beta.0](https://github.com/the-luap/picpeak/compare/v3.42.6-beta.0...v3.42.7-beta.0) (2026-05-09)


### Bug Fixes

* **auth:** default COOKIE_SECURE to 'auto' in production + first-install UX ([#427](https://github.com/the-luap/picpeak/issues/427)) ([e1c9382](https://github.com/the-luap/picpeak/commit/e1c93823c4a3095dd2afa618f393a061806f18a3))

## [3.42.6-beta.0](https://github.com/the-luap/picpeak/compare/v3.42.5-beta.0...v3.42.6-beta.0) (2026-05-09)


### Bug Fixes

* **external-media:** pre-generate thumbnails so reference-mode galleries load fast ([#423](https://github.com/the-luap/picpeak/issues/423)) ([e2ffd9f](https://github.com/the-luap/picpeak/commit/e2ffd9f93d228f9e16408fe424c65b26db67ac8e))
* **external-media:** pre-generate thumbnails so reference-mode galleries load fast ([#423](https://github.com/the-luap/picpeak/issues/423)) ([f3d0f16](https://github.com/the-luap/picpeak/commit/f3d0f161c9e554a5149e6b4eafdb0ac42bebf277))

## [3.42.5-beta.0](https://github.com/the-luap/picpeak/compare/v3.42.4-beta.0...v3.42.5-beta.0) (2026-05-08)


### Bug Fixes

* **admin:** test email always sends, regardless of update availability ([#418](https://github.com/the-luap/picpeak/issues/418)) ([9326a42](https://github.com/the-luap/picpeak/commit/9326a427b32458dfdaa01530bac66cda84ed7b72))

## [3.42.4-beta.0](https://github.com/the-luap/picpeak/compare/v3.42.3-beta.0...v3.42.4-beta.0) (2026-05-08)


### Bug Fixes

* **events:** typed-DELETE confirmation for bulk delete ([#417](https://github.com/the-luap/picpeak/issues/417)) ([e165ee5](https://github.com/the-luap/picpeak/commit/e165ee5d9fa805c704a64f91c9514bf0ab75b5b8))
* **events:** typed-DELETE confirmation for bulk delete ([#417](https://github.com/the-luap/picpeak/issues/417)) ([99e420b](https://github.com/the-luap/picpeak/commit/99e420b1b9783a1d6b4eb892c09d0af3340bf314))

## [3.42.3-beta.0](https://github.com/the-luap/picpeak/compare/v3.42.2-beta.0...v3.42.3-beta.0) (2026-05-07)


### Bug Fixes

* **create-event:** re-apply Branding theme on stale→fresh settings ([#323](https://github.com/the-luap/picpeak/issues/323)-B) ([401abf7](https://github.com/the-luap/picpeak/commit/401abf7a27cb73dd7fb8399f4c05644c95767093))
* **security:** scan triage cleanup — drop dead deps, harden Docker/nginx/postMessage ([7abfeb9](https://github.com/the-luap/picpeak/commit/7abfeb91cc7bbb9b6853146dbfe16b8d9835bcb3))
* **security:** scan triage cleanup — drop dead deps, harden Docker/nginx/postMessage ([6b6191a](https://github.com/the-luap/picpeak/commit/6b6191a4260650e21c45f6153cac1b142bf8483a))

## [3.42.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.42.1-beta.0...v3.42.2-beta.0) (2026-05-07)


### Bug Fixes

* **security:** patch 18 dependency CVEs (axios + transitives + nodemailer + i18next-http-backend) ([b7d6ca0](https://github.com/the-luap/picpeak/commit/b7d6ca0b65e652b50d957380f93ed16e151e94a8))
* **security:** patch 18 dependency CVEs (axios + transitives) ([523f499](https://github.com/the-luap/picpeak/commit/523f49916bea44697d40f61e0b6e44b83decc4b9))

## [3.42.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.42.0-beta.0...v3.42.1-beta.0) (2026-05-07)


### Bug Fixes

* **gallery:** WCAG-safe Download button text + extract HeaderDownloadButton ([#401](https://github.com/the-luap/picpeak/issues/401) follow-ups) ([04e928d](https://github.com/the-luap/picpeak/commit/04e928d7621743d9d99797f0996f8c7aa50e7b2d))
* **gallery:** WCAG-safe Download button text + extract HeaderDownloadButton ([#401](https://github.com/the-luap/picpeak/issues/401) follow-ups) ([0c80abd](https://github.com/the-luap/picpeak/commit/0c80abd57b806b9df01429a093c30c12c80c0601))

## [3.42.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.41.0-beta.0...v3.42.0-beta.0) (2026-05-07)


### Features

* **gallery:** icon-only menu, accent Download CTA ([#386](https://github.com/the-luap/picpeak/issues/386)) ([876b35b](https://github.com/the-luap/picpeak/commit/876b35b4a512f70cfc19561e35ce9d915a599547))

## [3.41.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.40.1-beta.0...v3.41.0-beta.0) (2026-05-06)


### Features

* **branding:** 8-token CI palette + force color mode + dark-mode consistency ([8050927](https://github.com/the-luap/picpeak/commit/80509276074b8125b6d676839afabb0b6f89206f))
* **branding:** force color mode (dark or light) site-wide ([5a162fc](https://github.com/the-luap/picpeak/commit/5a162fc8bec47a49cb1bcaa92ff72e197e8d2e42))
* **branding:** inline force color mode with auto-save + clearer palette help text ([67d7d8d](https://github.com/the-luap/picpeak/commit/67d7d8d3fa25ceab0eda02b291f2e220b222f84a))
* **email:** expand email palette to 8 tokens + Sync from Branding button ([47b6b39](https://github.com/the-luap/picpeak/commit/47b6b39f3a942aee93b970031d95a952cb769d09))
* **events:** Sync from Branding button in gallery theme customizer + clarified default inheritance ([bdbe7b8](https://github.com/the-luap/picpeak/commit/bdbe7b80a13b8b215ac544ba9105100e792eeda2))
* **i18n:** add Brazilian Portuguese (pt-BR) locale ([375f512](https://github.com/the-luap/picpeak/commit/375f51285b5db9c0dfcc04761d24927282e57796))
* **i18n:** improve pt locale with pt-BR phrasings, remove duplicate pt-BR file ([f25559c](https://github.com/the-luap/picpeak/commit/f25559c0e76776f7cfe8d187e1fea05e751bbafe))
* **theme:** expand color settings to 8-token CI palette + alt button ([114aab5](https://github.com/the-luap/picpeak/commit/114aab57771a4bba03a9e5c616c75a37c9b25969))


### Bug Fixes

* **admin:** tab underlines use accent (not accent-dark) for proper highlight color ([565ae45](https://github.com/the-luap/picpeak/commit/565ae45ca71e46166c8bbfc0eb0b6da92d74f120))
* **branding:** admin sidebar uses accent-dark, primary buttons follow CI token ([fc2bce3](https://github.com/the-luap/picpeak/commit/fc2bce3a01f02b2d131ca4ce1c8e81fc9dc62755))
* **branding:** comprehensive sweep — replace remaining primary-* legacy colors with accent tokens ([578a174](https://github.com/the-luap/picpeak/commit/578a1745b8d010eeeb261d3452fd192b1ec7bcf8))
* **branding:** selected-state accent colors, force-mode actually flips galleries, compact color picker layout ([5b410ed](https://github.com/the-luap/picpeak/commit/5b410ed9f87daad8e96345a86897f2a9e9419802))
* **branding:** working tooltips, high-contrast selected states, gallery chrome follows accent ([b19bb0c](https://github.com/the-luap/picpeak/commit/b19bb0c6208744f329cb3e99f4e26a83f191710a))
* **cms:** apply dark mode to CMS editor, public CMS, and admin modals ([d2a10f6](https://github.com/the-luap/picpeak/commit/d2a10f6523655488267d6f68835d7adb46dcf962))
* **theme:** centralise force-mode enforcement inside ThemeContext so every gallery flips ([21188f4](https://github.com/the-luap/picpeak/commit/21188f48d76dd29bc1251bcc6faf9d6d96c805b5))

## [3.40.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.40.0-beta.0...v3.40.1-beta.0) (2026-05-04)


### Bug Fixes

* **auth:** /auth/session must enforce session timeout symmetrically ([#350](https://github.com/the-luap/picpeak/issues/350) recurrence) ([c8e09c2](https://github.com/the-luap/picpeak/commit/c8e09c2a2a7d0920901560317eecd773b83251c0))
* **auth:** /auth/session must enforce session timeout symmetrically ([#350](https://github.com/the-luap/picpeak/issues/350) recurrence) ([b106da1](https://github.com/the-luap/picpeak/commit/b106da1ededa27fc8727f2c0e74a9182e6e9c895))

## [3.40.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.39.1-beta.0...v3.40.0-beta.0) (2026-05-04)


### Features

* **branding:** per-family generic fallback via meta.json ([dcff451](https://github.com/the-luap/picpeak/commit/dcff4515721482e06c2ef1c1eb34f9e12754c07c))
* **branding:** self-hosted webfonts with filesystem scanner ([d04bf28](https://github.com/the-luap/picpeak/commit/d04bf288084144bf53ef0ba988fa32ed703d7351))


### Bug Fixes

* **fonts:** drop immutable Cache-Control to allow font replacement rollout ([5703fcb](https://github.com/the-luap/picpeak/commit/5703fcb80680155e3b637dd5fc15c430de963c40))


### Documentation

* **fonts:** cache rollout, stale-list note, meta.json ([bd0e052](https://github.com/the-luap/picpeak/commit/bd0e052b1a1847718151a16117dacc6c42a2178e))

## [3.39.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.39.0-beta.0...v3.39.1-beta.0) (2026-05-04)


### Documentation

* **readme:** add Contributors section with @Luca-Timo and @Rekoo-PS ([c60ab74](https://github.com/the-luap/picpeak/commit/c60ab74ae2daabc4b11fea1f1b2df728294b03c8))
* **readme:** add Contributors section with @Luca-Timo and @Rekoo-PS ([dbe0a30](https://github.com/the-luap/picpeak/commit/dbe0a3055bd2c71981cb7d9cf43c2b22b9e3276c))

## [3.39.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.38.0-beta.0...v3.39.0-beta.0) (2026-05-04)


### Features

* **gallery:** decouple header style from layout, add banner option ([1f1a856](https://github.com/the-luap/picpeak/commit/1f1a856083b1966ed4b32a23a14442f1727cecef))

## [3.38.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.37.0-beta.0...v3.38.0-beta.0) (2026-05-04)


### Features

* **events:** bulk delete with password confirmation ([#384](https://github.com/the-luap/picpeak/issues/384)) ([647aea2](https://github.com/the-luap/picpeak/commit/647aea21ae42fe0d089bf45568702617a25b98e4))

## [3.37.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.36.0-beta.0...v3.37.0-beta.0) (2026-05-04)


### Features

* **events:** add Photos column to admin events list ([#384](https://github.com/the-luap/picpeak/issues/384)) ([d561db8](https://github.com/the-luap/picpeak/commit/d561db802b04db8fbb38819a22e840532e775ef0))
* **events:** add Photos column to admin events list ([#384](https://github.com/the-luap/picpeak/issues/384)) ([ffb4318](https://github.com/the-luap/picpeak/commit/ffb4318a1f667e273cd59805673b125d2f17699b))

## [3.36.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.35.0-beta.0...v3.36.0-beta.0) (2026-05-04)


### Features

* **events:** prefill admin email + admin picker on event creation ([3fe8e61](https://github.com/the-luap/picpeak/commit/3fe8e61bd1175e35dcb61604447e5d9c2e902ec5))

## [3.35.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.34.2-beta.0...v3.35.0-beta.0) (2026-05-04)


### Features

* **events:** tree view for external media folder picker ([cdd40ac](https://github.com/the-luap/picpeak/commit/cdd40acb4591d4eb8f80a79c69201556eab1bfd0))
* **events:** tree view for external media folder picker ([f927b09](https://github.com/the-luap/picpeak/commit/f927b09c70f3b6a5c81c3726609a29680b96b6fc))


### Bug Fixes

* **events:** match scrollbar to theme in external folder tree picker ([bd42ee1](https://github.com/the-luap/picpeak/commit/bd42ee1ce03b8f6e7b011b53f2c71453be931cc6))

## [3.34.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.34.1-beta.0...v3.34.2-beta.0) (2026-05-04)


### Bug Fixes

* **docker:** install system ffmpeg on Alpine, drop broken bundled binary ([3ab8a64](https://github.com/the-luap/picpeak/commit/3ab8a64a24f1600e674f77d39139e33857b4dfc8))
* **docker:** install system ffmpeg on Alpine, drop broken bundled binary ([96818c7](https://github.com/the-luap/picpeak/commit/96818c7ae8de0d8fd478cd901ea25a3272eee85d))

## [3.34.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.34.0-beta.0...v3.34.1-beta.0) (2026-05-03)


### Bug Fixes

* **cms:** nl/pt/ru i18n + gate external_url in public response ([08d0462](https://github.com/the-luap/picpeak/commit/08d046276bf259e8511b01415141f51b8484f967))
* **cms:** nl/pt/ru i18n + gate external_url in public response ([bce5c1f](https://github.com/the-luap/picpeak/commit/bce5c1f725043965c2499515f18e93e9578bd204))

## [3.34.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.33.2-beta.0...v3.34.0-beta.0) (2026-05-03)


### Features

* **cms:** add external URL toggle for imprint and privacy pages ([b2c8161](https://github.com/the-luap/picpeak/commit/b2c8161a43c2d0b09d6783e791b3f26862254824))
* **cms:** add per-page external URL override — backend ([66423bb](https://github.com/the-luap/picpeak/commit/66423bb65e83b6204509c9a98d783ba8255c3364))
* **cms:** admin UI for external imprint/privacy URL ([a4e3d10](https://github.com/the-luap/picpeak/commit/a4e3d10fb0c97ea07c4b08d16c0947945d8a7576))
* **cms:** redirect legal links to external URL when configured ([c5bba50](https://github.com/the-luap/picpeak/commit/c5bba505ac92b5257f6bb1c069b8bc23ea6a5a1b))

## [3.33.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.33.1-beta.0...v3.33.2-beta.0) (2026-05-03)


### Bug Fixes

* **events:** admin-set password on reset, full-URL gallery_link in all emails ([0d1f82d](https://github.com/the-luap/picpeak/commit/0d1f82d31a2f9e30bf193496ac203eaf8dfd856b))
* **events:** admin-set password on reset, full-URL gallery_link in all emails ([ff50c74](https://github.com/the-luap/picpeak/commit/ff50c74e1912ccba60f7ccdbead92b76de91388b))

## [3.33.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.33.0-beta.0...v3.33.1-beta.0) (2026-05-03)


### Bug Fixes

* **email:** render conditionals, localise password placeholders, fix caller/template variable drift ([0767203](https://github.com/the-luap/picpeak/commit/07672038d4ac31fc601adfb2338104223856ba71))
* **email:** render conditionals, localise password placeholders, fix caller/template variable drift ([e8052ad](https://github.com/the-luap/picpeak/commit/e8052adf1d2f1717652ac5d6b8cd8bcc01787189))

## [3.33.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.32.5-beta.0...v3.33.0-beta.0) (2026-05-02)


### Features

* native multi-arch Docker images (Apple Silicon, ARM64 Linux) ([df30618](https://github.com/the-luap/picpeak/commit/df3061893d154152b75b8ab0d07e0b1e0078431d))

## [3.32.5-beta.0](https://github.com/the-luap/picpeak/compare/v3.32.4-beta.0...v3.32.5-beta.0) (2026-05-02)


### Bug Fixes

* **theme:** kill initial white frame + theme-aware skeleton tiles ([#358](https://github.com/the-luap/picpeak/issues/358) follow-up) ([f529c9e](https://github.com/the-luap/picpeak/commit/f529c9e3d72f0e3496951dfa5d160afda9a1ac51))
* **theme:** kill initial white frame + theme-aware skeleton tiles ([#358](https://github.com/the-luap/picpeak/issues/358) follow-up) ([1a530ae](https://github.com/the-luap/picpeak/commit/1a530aeaa2d61b34d9721a555b71631c7101c58e))

## [3.32.4-beta.0](https://github.com/the-luap/picpeak/compare/v3.32.3-beta.0...v3.32.4-beta.0) (2026-05-01)


### Bug Fixes

* **events:** stop mapping branding_logo_position onto hero_logo_position ([af2b062](https://github.com/the-luap/picpeak/commit/af2b0628cb4f79a147366665d35c098012071216))
* **events:** stop mapping branding_logo_position onto hero_logo_position ([ef1c875](https://github.com/the-luap/picpeak/commit/ef1c875f6ec1e02657006cb09cd0b1d868ec2fc0))
* **theme:** pre-React bootstrap to kill white-flash on dark galleries ([#358](https://github.com/the-luap/picpeak/issues/358)) ([07b41e6](https://github.com/the-luap/picpeak/commit/07b41e691d2e8a71f775c667d805a2f9adc10590))
* **theme:** pre-React bootstrap to kill white-flash on dark galleries ([#358](https://github.com/the-luap/picpeak/issues/358)) ([f81a872](https://github.com/the-luap/picpeak/commit/f81a8728e67b313ac43f55c94fb635abf9beca05))

## [3.32.3-beta.0](https://github.com/the-luap/picpeak/compare/v3.32.2-beta.0...v3.32.3-beta.0) (2026-05-01)


### Bug Fixes

* **auth:** /auth/session must verify issuer claim like adminAuth ([#350](https://github.com/the-luap/picpeak/issues/350)) ([83dedbc](https://github.com/the-luap/picpeak/commit/83dedbcd45e34a924594dd83f6e3561f776576fb))
* **auth:** make /auth/session verify the issuer claim like adminAuth ([#350](https://github.com/the-luap/picpeak/issues/350)) ([88a6c6a](https://github.com/the-luap/picpeak/commit/88a6c6a7fba7e1419a021f4870518f0b76ac6494))
* **events:** coerce expires_in_days to Number before addDays ([e5712d8](https://github.com/the-luap/picpeak/commit/e5712d8ffe2f0ed980e1df5e1263876af7202b76))
* **events:** coerce expires_in_days to Number before addDays ([db29d0e](https://github.com/the-luap/picpeak/commit/db29d0e2788f63cc9eb0a43ec58313387acb0c0d))

## [3.32.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.32.1-beta.0...v3.32.2-beta.0) (2026-05-01)


### Bug Fixes

* events search/counters ([#346](https://github.com/the-luap/picpeak/issues/346)), lazy gallery skeleton ([#321](https://github.com/the-luap/picpeak/issues/321)), smooth lightbox swipe ([#348](https://github.com/the-luap/picpeak/issues/348)) ([6229b38](https://github.com/the-luap/picpeak/commit/6229b38bac90cc0c538a72688efae3be77a3bb08))
* **events:** server-side search/pagination to remove first-100 cap ([#346](https://github.com/the-luap/picpeak/issues/346)) ([a5b20ca](https://github.com/the-luap/picpeak/commit/a5b20ca3fe77df665d4a9744413d7ee4054858f0))
* **gallery:** lazy-render skeleton grid for fast loads ([#321](https://github.com/the-luap/picpeak/issues/321) follow-up) ([d9d8137](https://github.com/the-luap/picpeak/commit/d9d81372b80f7d44dca54b7993f52c36574048c9))
* **lightbox:** smooth carousel swipe + drop instructional hint ([#348](https://github.com/the-luap/picpeak/issues/348)) ([743086d](https://github.com/the-luap/picpeak/commit/743086d3cb9100fb163bc9d04d968e5b611a1f99))

## [3.32.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.32.0-beta.0...v3.32.1-beta.0) (2026-04-30)


### Documentation

* move documentation to docs.picpeak.app, drop in-repo copies ([02ed5d4](https://github.com/the-luap/picpeak/commit/02ed5d400736f966283a138dedde2455448067ff))
* move documentation to docs.picpeak.app, drop in-repo copies ([0faf9b3](https://github.com/the-luap/picpeak/commit/0faf9b32816f5f94aa584d2336cdb1e0b7082239))

## [3.32.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.31.1-beta.0...v3.32.0-beta.0) (2026-04-29)


### Features

* **webhooks:** enrich event.* payloads with customer contact + share_token ([#341](https://github.com/the-luap/picpeak/issues/341)) ([7ea4801](https://github.com/the-luap/picpeak/commit/7ea4801544fd5cd8bca1907a71b5c4e96ee77649))
* **webhooks:** enrich event.* payloads with customer contact + share_token ([#341](https://github.com/the-luap/picpeak/issues/341)) ([1e69d5f](https://github.com/the-luap/picpeak/commit/1e69d5ff71ac2d1d133b0e40637b437d7cc8bc4f))

## [3.31.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.31.0-beta.0...v3.31.1-beta.0) (2026-04-28)


### Bug Fixes

* **events:** show customer phone in event details view ([#331](https://github.com/the-luap/picpeak/issues/331)) ([4c73d22](https://github.com/the-luap/picpeak/commit/4c73d228ed98b8ec05bec2824aee7ce066a184e1))
* **gallery:** single-finger swipe nav in mobile lightbox ([#332](https://github.com/the-luap/picpeak/issues/332)) ([4c8eba0](https://github.com/the-luap/picpeak/commit/4c8eba0cb43635d92a53d90c58b19007136c1c12))
* **gallery:** use ref for swipe-start to avoid stale-closure miss ([#332](https://github.com/the-luap/picpeak/issues/332)) ([fcddfe0](https://github.com/the-luap/picpeak/commit/fcddfe094b2a01963f7b420afa886e7d5dae4390))
* **lightbox:** mobile toolbar clipping + iOS safe-area + viewport-fit ([#336](https://github.com/the-luap/picpeak/issues/336)) ([42a7ae4](https://github.com/the-luap/picpeak/commit/42a7ae4be8fe7b12104ae036465c9c4117606378))
* mobile lightbox + share previews + customer phone bug triage ([1e40677](https://github.com/the-luap/picpeak/commit/1e4067713ce9a808a7b49319bc262e5c9a6599c6))
* **share:** OG/Twitter-card metadata for gallery share URLs ([#333](https://github.com/the-luap/picpeak/issues/333)) ([5275621](https://github.com/the-luap/picpeak/commit/5275621fcd38f1ec09b54595163ecd5e63614b1a))

## [3.31.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.30.0-beta.0...v3.31.0-beta.0) (2026-04-28)


### Features

* **frontend:** dedupe /public/settings via shared usePublicSettings hook ([#325](https://github.com/the-luap/picpeak/issues/325)) ([3d4ae4d](https://github.com/the-luap/picpeak/commit/3d4ae4d7e9f9995d93563e8092e05215362afb3b))
* native S3 storage backend ([#328](https://github.com/the-luap/picpeak/issues/328)) + presigned download follow-up ([1b717ce](https://github.com/the-luap/picpeak/commit/1b717ce5ededa343d2fbb7e1c3493b4434743565))
* outbound webhooks for event/photo lifecycle ([#327](https://github.com/the-luap/picpeak/issues/327)) ([c488f48](https://github.com/the-luap/picpeak/commit/c488f481caacf0d63dafc47f509e8de2708bc30f))
* presigned download UI + S3 prefix walker auto-importer (follow-ups) ([446d80a](https://github.com/the-luap/picpeak/commit/446d80a4cc5eb0389994e29585b2a98dad373db2))
* S3 storage + webhooks + settings dedupe + backup fixes ([06d54be](https://github.com/the-luap/picpeak/commit/06d54bec4d0afc4a1b9ba6f2449ed7d79f1d3e8f))


### Bug Fixes

* **backup:** cron schedule mapping + manifest format detection + bigint coerce ([ab4095f](https://github.com/the-luap/picpeak/commit/ab4095f5928b1476009cddfd3444d6f5b58b034d))
* **backup:** incremental backups against S3 + jsonb stats parsing ([e232f9f](https://github.com/the-luap/picpeak/commit/e232f9f2cf54aeba1e16d769397428206a0f1801))

## [3.30.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.29.1-beta.0...v3.30.0-beta.0) (2026-04-27)


### Features

* customisable 404 + gallery-not-found pages via CMS ([#324](https://github.com/the-luap/picpeak/issues/324)) ([4f77905](https://github.com/the-luap/picpeak/commit/4f77905b87bea474b3d2496350996deaad041230))
* optional customer phone field gated by global toggle ([#322](https://github.com/the-luap/picpeak/issues/322)) ([be6cb28](https://github.com/the-luap/picpeak/commit/be6cb28c8097d2277c1af2a32cf8bc88ebbc7136))
* public v1 API + token management + OpenAPI docs ([#322](https://github.com/the-luap/picpeak/issues/322)) ([808b15b](https://github.com/the-luap/picpeak/commit/808b15bafbcdab6ea55aff7f0e507153f513a70a))


### Bug Fixes

* dedupe parallel admin 401 redirects to /admin/login ([038e84c](https://github.com/the-luap/picpeak/commit/038e84cae7f56a0a1af8c71b85881ca5d320c6e3))
* floor password_changed_at when comparing against JWT iat ([793e410](https://github.com/the-luap/picpeak/commit/793e410554b461522fbe24014dfd3baa915da2bb))
* theme picker buttons no longer submit the parent form ([#326](https://github.com/the-luap/picpeak/issues/326)) ([2eead52](https://github.com/the-luap/picpeak/commit/2eead523193ccb7f23eb767097ad9698e8312833))
* theme save without Live Preview, Branding default on new events, gallery loading flicker ([#323](https://github.com/the-luap/picpeak/issues/323), [#321](https://github.com/the-luap/picpeak/issues/321)) ([822be9a](https://github.com/the-luap/picpeak/commit/822be9a9b2716f1832a4cb6fccd53602e3cbab51))
* theme-preset match loop ignores extra fields like logoUrl ([#323](https://github.com/the-luap/picpeak/issues/323)) ([b63a877](https://github.com/the-luap/picpeak/commit/b63a8774c4b44733b903736b2ca5a472a884055e))


### Documentation

* add Buy Me a Coffee badge + Support section ([46bc894](https://github.com/the-luap/picpeak/commit/46bc894d917bd55dbd9bafaa64fd38db21488b81))

## [3.29.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.29.0-beta.0...v3.29.1-beta.0) (2026-04-26)


### Bug Fixes

* address bugs and feature requests from discussion [#317](https://github.com/the-luap/picpeak/issues/317) ([6cfff6f](https://github.com/the-luap/picpeak/commit/6cfff6f6a6dbdc5bc1e9fe4fbce5795cdb1855c6))
* discussion [#317](https://github.com/the-luap/picpeak/issues/317) issues and [#318](https://github.com/the-luap/picpeak/issues/318) archive crash ([2f2f405](https://github.com/the-luap/picpeak/commit/2f2f405d9bc2831b3bbe2ca7fbf726d61382dc38))
* prevent backend crash on archive when admin_email is null ([#318](https://github.com/the-luap/picpeak/issues/318)) ([e4b0f96](https://github.com/the-luap/picpeak/commit/e4b0f961b75952b6907cc2291fa256215c09c80c))

## [3.29.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.28.3-beta.0...v3.29.0-beta.0) (2026-04-23)


### Features

* pre-zip download all and photo replacement by name ([#312](https://github.com/the-luap/picpeak/issues/312), [#313](https://github.com/the-luap/picpeak/issues/313)) ([d3f1206](https://github.com/the-luap/picpeak/commit/d3f12068164a6bfe6c4a3817ad2fc2e8ed7abf4f))
* pre-zip download all and photo replacement by name ([#312](https://github.com/the-luap/picpeak/issues/312), [#313](https://github.com/the-luap/picpeak/issues/313)) ([e18afd3](https://github.com/the-luap/picpeak/commit/e18afd3e6b0b5a4cdb4873fb227d1b1d2bf35f21))

## [3.28.3-beta.0](https://github.com/the-luap/picpeak/compare/v3.28.2-beta.0...v3.28.3-beta.0) (2026-04-13)


### Bug Fixes

* revert /api prefix in adminPhotos.js to avoid double-prefix ([094276d](https://github.com/the-luap/picpeak/commit/094276d3cc7117eee30e4bcbce487e54f0eacb29))
* revert /api prefix in adminPhotos.js to avoid double-prefix ([#307](https://github.com/the-luap/picpeak/issues/307)) ([ceb2a09](https://github.com/the-luap/picpeak/commit/ceb2a09f483b4754fda232c5c1f7acb8971aac10))

## [3.28.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.28.1-beta.0...v3.28.2-beta.0) (2026-04-12)


### Bug Fixes

* display welcome message in gallery and fix guest thumbnail URLs ([#306](https://github.com/the-luap/picpeak/issues/306), [#307](https://github.com/the-luap/picpeak/issues/307)) ([b05c36a](https://github.com/the-luap/picpeak/commit/b05c36ac810a557a2ac088ab7bec39bb76f9a2ae))
* display welcome message in gallery and fix guest thumbnail URLs ([#306](https://github.com/the-luap/picpeak/issues/306), [#307](https://github.com/the-luap/picpeak/issues/307)) ([9323bef](https://github.com/the-luap/picpeak/commit/9323befdd99d64b85cca89af24ac1b7034d72eee))

## [3.28.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.28.0-beta.0...v3.28.1-beta.0) (2026-04-12)


### Bug Fixes

* apply sort direction in gallery and respect show_feedback_to_guests ([#302](https://github.com/the-luap/picpeak/issues/302), [#303](https://github.com/the-luap/picpeak/issues/303)) ([3716ff5](https://github.com/the-luap/picpeak/commit/3716ff50854766bde588fbd6b9027f8647e59150))
* apply sort direction in gallery view and respect show_feedback_to_guests ([#302](https://github.com/the-luap/picpeak/issues/302), [#303](https://github.com/the-luap/picpeak/issues/303)) ([dffe057](https://github.com/the-luap/picpeak/commit/dffe057772c922ab6a213e25f171157e0c2badf8))

## [3.28.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.27.0-beta.0...v3.28.0-beta.0) (2026-04-11)


### Features

* add COOKIE_SECURE=auto for mixed HTTPS/HTTP deployments ([#298](https://github.com/the-luap/picpeak/issues/298)) ([b1dfbe4](https://github.com/the-luap/picpeak/commit/b1dfbe4c2fe271d8087974d02cf724f04058bdc9))
* add COOKIE_SECURE=auto for mixed HTTPS/HTTP deployments ([#298](https://github.com/the-luap/picpeak/issues/298)) ([15a8ab4](https://github.com/the-luap/picpeak/commit/15a8ab41fd1c94e3397d300b161cd1fdd459ea05))


### Bug Fixes

* guest feedback flow bugs in Masonry grid and PhotoLightbox ([#292](https://github.com/the-luap/picpeak/issues/292)) ([54badef](https://github.com/the-luap/picpeak/commit/54badefc51b834d55530722f87c81a6ade33e35b))
* guest feedback flow bugs in Masonry grid and PhotoLightbox ([#292](https://github.com/the-luap/picpeak/issues/292)) ([77f07e9](https://github.com/the-luap/picpeak/commit/77f07e9329e47f6ac5040f2e85d2710ebbea3ced))

## [3.27.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.26.2-beta.0...v3.27.0-beta.0) (2026-04-11)


### Features

* add admin dark mode and SEO/robots.txt settings ([9c2a0d2](https://github.com/the-luap/picpeak/commit/9c2a0d272a21dfcace2ec795034e2f1adcba47e0))
* add Apple Liquid Glass templates, image security settings, and automated releases ([6033461](https://github.com/the-luap/picpeak/commit/6033461be118ce78277ec568e1ef1ceeff7311c8))
* add bulk category editing for photos ([#157](https://github.com/the-luap/picpeak/issues/157)) ([eca36c7](https://github.com/the-luap/picpeak/commit/eca36c70a23f18f937a9f5bddeff855e18f364c3))
* add category hero/cover photo selection ([#163](https://github.com/the-luap/picpeak/issues/163)) ([6c30e2c](https://github.com/the-luap/picpeak/commit/6c30e2c2edd19a24d4f30a9558690bb7e2331b32))
* add configurable upload batch size for reverse proxy compatibility ([#208](https://github.com/the-luap/picpeak/issues/208)) ([02a46e0](https://github.com/the-luap/picpeak/commit/02a46e083d68cfdb355b5a4fe4a8da7d667050b9))
* Add CSS template system with custom gallery styling support ([0da45e6](https://github.com/the-luap/picpeak/commit/0da45e699ad998031aa56a92f2da5ee61a04e285))
* add customizable event types with admin management ([f8881d5](https://github.com/the-luap/picpeak/commit/f8881d5bd62d449fb40917ec8c20f0eb16c1fdad))
* add Dutch (nl) locale and fix missing translation keys across all locales ([b54a80d](https://github.com/the-luap/picpeak/commit/b54a80d251bcbb9a126e32eeaef522688bc810c6))
* add Dutch locale and fix missing translation keys ([e32da68](https://github.com/the-luap/picpeak/commit/e32da68cbdfa430d62cbb1057ea418dc6b2f14fb))
* add event management, gallery customization, and release automationFeature/event rename ([40ee671](https://github.com/the-luap/picpeak/commit/40ee67171d41522037bf9d4e7675b62ec564346d))
* add Gallery Premium and Gallery Story layouts (Beta) ([e179def](https://github.com/the-luap/picpeak/commit/e179def3cceefe5fd6acd5574f2986e4f9e223ef))
* add hero image focal point picker with anchor positioning ([#162](https://github.com/the-luap/picpeak/issues/162)) ([734868a](https://github.com/the-luap/picpeak/commit/734868abc23731b0ac9ad73e799194df1e6aa6ab))
* add justified layout modes and aspect-ratio-aware mosaic ([#146](https://github.com/the-luap/picpeak/issues/146)) ([608bbd5](https://github.com/the-luap/picpeak/commit/608bbd50e7b31d49c7516a00e96f284fa16e2777))
* Add justified layout modes and aspect-ratio-aware mosaic ([#146](https://github.com/the-luap/picpeak/issues/146)) ([ef2ae00](https://github.com/the-luap/picpeak/commit/ef2ae00ff20b754c2f2ed797e18c146d12d7f31a))
* add justified/rows layout mode to masonry gallery ([#146](https://github.com/the-luap/picpeak/issues/146)) ([e081b56](https://github.com/the-luap/picpeak/commit/e081b56a44bf9fdaa3dd225d5dd4dde35bfe83d3))
* add justified/rows layout mode to masonry gallery ([#146](https://github.com/the-luap/picpeak/issues/146)) + security fixes ([cd1d504](https://github.com/the-luap/picpeak/commit/cd1d50474f673b759c2f9401fdbe209a84773e39))
* add multi-administrator support with RBAC and fix backup/restore for S3 ([892e47d](https://github.com/the-luap/picpeak/commit/892e47d017064d7922536f8e138bbb290a45cdc9))
* add optional event date and expiration settings ([3079eaa](https://github.com/the-luap/picpeak/commit/3079eaa2e5d1728c2c0f315626cc253e4b08edc2))
* add optional event date and expiration settings ([2151147](https://github.com/the-luap/picpeak/commit/2151147f2d3134448ff32130da44678e2942d73c)), closes [#118](https://github.com/the-luap/picpeak/issues/118)
* add original filename preservation and Lightroom export support ([a59f414](https://github.com/the-luap/picpeak/commit/a59f41463f960a3a74ce3933dc7db84ee3a2018d))
* add original filename preservation and Lightroom export support ([9872ad3](https://github.com/the-luap/picpeak/commit/9872ad3aef6488b359c5499a6dc3d8bfbfa48fde))
* add per-event custom logo upload with bug fixes ([85170b8](https://github.com/the-luap/picpeak/commit/85170b883f504d83f1d862abb3f4e46741074826))
* add per-event hero logo customization options ([0790a1d](https://github.com/the-luap/picpeak/commit/0790a1ddad774af89827a0a392e9fae0a945bff2))
* add per-gallery thumbnail scale setting ([#172](https://github.com/the-luap/picpeak/issues/172)) ([#251](https://github.com/the-luap/picpeak/issues/251)) ([ee46088](https://github.com/the-luap/picpeak/commit/ee46088985ebbbb81d16e5bac23be2060c94397f))
* add photo cap per event and Portuguese (pt-BR) locale ([1fa222e](https://github.com/the-luap/picpeak/commit/1fa222e9c4c26e525c7899e368988c6b0b08da85))
* add photo cap per event and Portuguese locale ([088de43](https://github.com/the-luap/picpeak/commit/088de43f09f974d444f50452ef1117315c289ebc))
* add quilted layout, fix mosaic, and backfill photo dimensions ([#146](https://github.com/the-luap/picpeak/issues/146)) ([46ed1bc](https://github.com/the-luap/picpeak/commit/46ed1bc276867a25b27bf22cd9b9d7e879a6947b))
* add thumbnail settings UI to admin panel ([3a30fea](https://github.com/the-luap/picpeak/commit/3a30fea862034d64fbc7188fc25292594a9319e2))
* add thumbnail settings UI to admin settings page ([#206](https://github.com/the-luap/picpeak/issues/206)) ([7d6d2f5](https://github.com/the-luap/picpeak/commit/7d6d2f56883a4402f0d97c95b0432a8a783c8024))
* add update instructions dialog, email notifications, and capture date sorting ([50c0990](https://github.com/the-luap/picpeak/commit/50c09904a9434f988ab32a07da5d24db0e02065e)), closes [#181](https://github.com/the-luap/picpeak/issues/181)
* add visual WYSIWYG email template editor ([#229](https://github.com/the-luap/picpeak/issues/229)) ([04a7ea8](https://github.com/the-luap/picpeak/commit/04a7ea80f95d6aeb474b145292e75f45fb85c66d))
* **admin:** refine header layout and logo placement ([d64e7d0](https://github.com/the-luap/picpeak/commit/d64e7d08deae7ad1b6f744f447fe546115427942))
* allow admin email updates in UI ([#36](https://github.com/the-luap/picpeak/issues/36)) ([3c2a79a](https://github.com/the-luap/picpeak/commit/3c2a79a31a0f1a44c8ec4f9a87f6fbcea9be651c))
* beta/stable release channels with update notifications and bug fixes ([3c7dc20](https://github.com/the-luap/picpeak/commit/3c7dc2013fc3b57712ddf16db85f495b3cc7bfd7))
* beta/stable release channels with update notifications and bug fixes ([#98](https://github.com/the-luap/picpeak/issues/98)) ([3c7dc20](https://github.com/the-luap/picpeak/commit/3c7dc2013fc3b57712ddf16db85f495b3cc7bfd7))
* configurable upload batch size for reverse proxy compatibility ([9b7495e](https://github.com/the-luap/picpeak/commit/9b7495e0054975e66c9b5006c24a9fae63969de4))
* configurable upload batch size for reverse proxy compatibility ([4243363](https://github.com/the-luap/picpeak/commit/424336340bef8e1629490ade154f0ceebb2a71e1))
* decouple hero header from gallery layouts ([#158](https://github.com/the-luap/picpeak/issues/158)) ([7b8d8bd](https://github.com/the-luap/picpeak/commit/7b8d8bd92ba7a96717bb4d821b38dddc395f701a))
* **docker:** add PUID/PGID and user mapping to avoid bind mount permission issues; feat(setup): prompt for admin email interactively; docs: PUID/PGID in .env.example ([410a33f](https://github.com/the-luap/picpeak/commit/410a33fecf1693cc75816c53ac460ec20089e2a1))
* draft mode, admin branding, and workflow improvements ([dc98206](https://github.com/the-luap/picpeak/commit/dc98206737d1ebe43637319ce8c5b6da2e44c05d))
* draft mode, admin branding, and workflow improvements ([40332a7](https://github.com/the-luap/picpeak/commit/40332a71db6534097940d3f9362b0fe651dba6c7))
* dynamic website title from branding settings ([d29aab7](https://github.com/the-luap/picpeak/commit/d29aab7c70c5777451666fb7d5c7a9729dab684a))
* **events:** add CSS template selector to event edit page ([6a6c2cd](https://github.com/the-luap/picpeak/commit/6a6c2cd34db26a53b5fb96415650e8136a74e47f))
* gallery layouts, bulk category editing, and hero header improvements ([7037106](https://github.com/the-luap/picpeak/commit/7037106bff62593bba600d898a781f79f07b459d))
* gallery layouts, hero customization, bulk categories & event types ([d9e00dc](https://github.com/the-luap/picpeak/commit/d9e00dc0dbd7cef0ddb4665e5306c98aac3573e3))
* gallery layouts, hero customization, event types, and UX improvements ([#146](https://github.com/the-luap/picpeak/issues/146), [#155](https://github.com/the-luap/picpeak/issues/155)-163, [#170](https://github.com/the-luap/picpeak/issues/170), [#171](https://github.com/the-luap/picpeak/issues/171)) ([4280444](https://github.com/the-luap/picpeak/commit/4280444d70e73db09e67e18ce25bac75cf499b75))
* **gallery/filters:** add Rated and Commented filters (UI + backend).\n\n- UI: add star (Rated) and message (Commented) buttons to feedback filter bars (desktop + mobile)\n- Backend: support filter=rated, commented, and combinations via aggregate counts/queries ([b03760a](https://github.com/the-luap/picpeak/commit/b03760ab01e21feb3578f90d065945d437d03452))
* **gallery:** add quick Like/Favorite actions on thumbnails across layouts ([6368f10](https://github.com/the-luap/picpeak/commit/6368f1027f96107ba64964eb126911bfe185f54a))
* **gallery:** always-visible feedback indicators on grid tiles; fallback image rendering in lightbox/hero; auto-auth from shared-link token; fix external photo resolver\n\n- GridGallery: bottom-left icons for like/rated/comment on every tile\n- Hero layout grid: added same indicators (non-intrusive icons)\n- Lightbox/Hero: add fallbackSrc to display thumbnail if original fails\n- GalleryAuth: auto-store token from /gallery/:slug/:token and hydrate event\n- Backend gallery photo route: use resolvePhotoFilePath for external-media\n\nfix(admin): move photo feedback badges to bottom-right on admin grid tiles\n\nfix(dashboard): add missing i18n keys for activity types + fallback to formatter\n\nfix(admin/feedback): correct thumbnail URL base + robust date parsing\n\nRefs: [#19](https://github.com/the-luap/picpeak/issues/19) ([6948aaa](https://github.com/the-luap/picpeak/commit/6948aaa92afc29609f85cf7fd631095f3e32ad3f))
* **gallery:** compact vertical icon-only feedback filter in PhotoFilterBar; remove wide buttons to prevent overflow\n\n- Desktop: vertical icon stack (All/Grid, Likes, Favorites) outside scroll area\n- Mobile: vertical icon stack below categories\n- Keeps existing category bar layout and count\n\nRefs: [#19](https://github.com/the-luap/picpeak/issues/19) ([465f997](https://github.com/the-luap/picpeak/commit/465f997752fc930ac0a3ae530e9e57a378877d53))
* **i18n:** add translations for settings tabs ([c030e87](https://github.com/the-luap/picpeak/commit/c030e872135b39701ef1f4bbb2f28bcaf4ce7fae))
* implement 4 new features with bug fixes and refactoring plan ([77a4bfd](https://github.com/the-luap/picpeak/commit/77a4bfd49975551bf509354097f280cab3e48c7a))
* implement beta/stable release channels with update notifications ([617e778](https://github.com/the-luap/picpeak/commit/617e778a48e0f0c24fcb8441d00ed2a816f19c03))
* improve gallery layouts with aspect-ratio-aware masonry and mosaic modes ([#146](https://github.com/the-luap/picpeak/issues/146)) ([aacfcd5](https://github.com/the-luap/picpeak/commit/aacfcd517ea5739e834cf84627b55b3449740a5c))
* improve hero image UX and live preview ([#163](https://github.com/the-luap/picpeak/issues/163), [#158](https://github.com/the-luap/picpeak/issues/158)) ([d63f67a](https://github.com/the-luap/picpeak/commit/d63f67a2afba1b92610382aa1012428ccacb86bd))
* **lightbox:** keep feedback usable while navigating ([6368f10](https://github.com/the-luap/picpeak/commit/6368f1027f96107ba64964eb126911bfe185f54a)), closes [#19](https://github.com/the-luap/picpeak/issues/19)
* Multi-administrator RBAC, CSS templates & security hardening ([#78](https://github.com/the-luap/picpeak/issues/78)) ([16b3ab0](https://github.com/the-luap/picpeak/commit/16b3ab039ae95f5641dc15a4811eb2b503f1791c))
* multilingual email templates with translations table ([8c5996e](https://github.com/the-luap/picpeak/commit/8c5996e4ec43b2817d84cc040cfe52878ffb61d5))
* multilingual email templates with translations table ([f50d7c0](https://github.com/the-luap/picpeak/commit/f50d7c0c51aa84a2182e450cd4b6a00777a8f9c0))
* **native:** auto-serve SPA when dist exists (unless SERVE_FRONTEND=false); add clear logging; serve index.html for /admin ([fb16b7b](https://github.com/the-luap/picpeak/commit/fb16b7bbb8225192160c08050f1b164c36c8dc74))
* **native:** build frontend and serve SPA from backend (SERVE_FRONTEND); fix Cannot GET /admin on native installs ([9fe10bc](https://github.com/the-luap/picpeak/commit/9fe10bcce2871a48f2409b4936d95c00249deb51))
* **native:** serve built frontend from backend; build frontend during install/update; ensure env flags (SERVE_FRONTEND, FRONTEND_DIR) ([61ad2d6](https://github.com/the-luap/picpeak/commit/61ad2d61c137196c229817989f991e50fa389a6e))
* new features and bug fixes for beta release ([151e1bf](https://github.com/the-luap/picpeak/commit/151e1bf50f206ae0571fa044c75b8bc9f0f40120))
* original filename in admin UI, update dialog, and security hardening ([3ea9d5b](https://github.com/the-luap/picpeak/commit/3ea9d5b1219980032cbee7a2564c0004948923f5))
* original filename in admin UI, update dialog, security hardening, and bug fixes ([bcf2745](https://github.com/the-luap/picpeak/commit/bcf2745ab64acb968ae4bd0710b28e78c14f340c))
* overhaul public landing page and backup tooling ([2a4d388](https://github.com/the-luap/picpeak/commit/2a4d38813f7ab64a6bbb3a666f3c98a29443488d))
* per-event custom logos, customizable event types, and multiple bug fixes ([4c08160](https://github.com/the-luap/picpeak/commit/4c081601e02888d7ad289acb7847aee9d6f5703f))
* photo visibility control with client access ([#172](https://github.com/the-luap/picpeak/issues/172)) ([4a93e4e](https://github.com/the-luap/picpeak/commit/4a93e4e8cbe1b7a23a8be706291a270ccdf5bb55))
* photo visibility control with client access ([#172](https://github.com/the-luap/picpeak/issues/172)) ([e1b6e43](https://github.com/the-luap/picpeak/commit/e1b6e43e524211c913d3d29ade5fc029df12920f))
* pre-generate watermarks for instant lightbox loading ([1be974a](https://github.com/the-luap/picpeak/commit/1be974afbb0b7a1bdbdd140327771907a5d3c2ae)), closes [#112](https://github.com/the-luap/picpeak/issues/112)
* pre-generated watermarks and mobile upload button improvements ([c6fdd38](https://github.com/the-luap/picpeak/commit/c6fdd38e842e1a8c0aa9cbab9fc791e6669e402d))
* register Russian locale and add to language selector ([6f95b8c](https://github.com/the-luap/picpeak/commit/6f95b8c26cd794525e15e45d478f9ead0ec22555))
* **select:** add per-tile checkbox selection in Admin grid and all gallery layouts; tile click opens viewer; checkbox toggles selection; auto-enable selection mode; add testids ([9fda54b](https://github.com/the-luap/picpeak/commit/9fda54bd06d37cd8f8f71056bf4f59e158cd8112))
* **setup/docker:** auto-set PUID/PGID from invoking user and chown bind-mount folders; create missing data/events dirs ([0618b78](https://github.com/the-luap/picpeak/commit/0618b78725e85f97f0a4b4e834c17811c033c8f4))
* **setup:** remove --admin-password; print admin credentials from ADMIN_CREDENTIALS.txt; fix ADMIN_URL to avoid /admin/admin; update native service commands ([84d0f63](https://github.com/the-luap/picpeak/commit/84d0f63d36c68532fea83e7087b1afeaa9b82f39))
* show original filename in admin UI ([#184](https://github.com/the-luap/picpeak/issues/184)) ([0891be1](https://github.com/the-luap/picpeak/commit/0891be197fdb7d92ade5a293b8db0bed26fa6e3a))
* sort photos by capture date with configurable default sort ([#283](https://github.com/the-luap/picpeak/issues/283)) ([8805fa5](https://github.com/the-luap/picpeak/commit/8805fa53e61c6b3672a8f6dad14d2fd17998a451))
* sort photos by capture date with configurable default sort ([#283](https://github.com/the-luap/picpeak/issues/283)) ([633d4a0](https://github.com/the-luap/picpeak/commit/633d4a0f301e355ee9f057347f2f8dee8c5b4163))
* support per-gallery password toggle ([5d6c061](https://github.com/the-luap/picpeak/commit/5d6c061f1c4fd20581b1e74fa114c96530b5de53))
* visual WYSIWYG email template editor ([703c03f](https://github.com/the-luap/picpeak/commit/703c03fbee754a5291b57b885c5e82fbdd3e69e9))
* warn about low thumbnail resolution when selecting beta themes ([ee3f6ae](https://github.com/the-luap/picpeak/commit/ee3f6ae13bf9c9fb3295286e84150e04bf9fbce4))
* warn about low thumbnail resolution with beta themes ([aef9b4e](https://github.com/the-luap/picpeak/commit/aef9b4ed7fc443cbec8890c580759077e05e77b4))


### Bug Fixes

* add allow_user_uploads to gallery API responses ([691e3ab](https://github.com/the-luap/picpeak/commit/691e3aba09f2148afe902a0bb0139d062634e669))
* add lightbox loading spinner and watermark cache invalidation ([050ed37](https://github.com/the-luap/picpeak/commit/050ed378199eb3b15c7c7f243792f68f858803f5))
* Add settings translations and fix manual backup process ([#82](https://github.com/the-luap/picpeak/issues/82)) ([476fcce](https://github.com/the-luap/picpeak/commit/476fcce13f30f9f2d2f98a0c87c25fba09e9eebc))
* add STORAGE_PATH to production docker-compose ([cdda709](https://github.com/the-luap/picpeak/commit/cdda70988664a177b351abc6a259ec39664d17ff))
* address beta feedback - gallery layout fixes, Russian locale, email logo ([#249](https://github.com/the-luap/picpeak/issues/249)) ([486239a](https://github.com/the-luap/picpeak/commit/486239aeb9b5f56551d5aa90f0bad3008eedc3bb))
* address Shannon security assessment findings (37 vulnerabilities) ([#254](https://github.com/the-luap/picpeak/issues/254)) ([23cd9cb](https://github.com/the-luap/picpeak/commit/23cd9cb680eb77b94a97266c3353dfc835f0cc69))
* admin photo feedback filters have no effect ([#293](https://github.com/the-luap/picpeak/issues/293)) ([9ed8a2b](https://github.com/the-luap/picpeak/commit/9ed8a2b1994d139efd100c8fb97e6368655e5530))
* **admin/feedback:** use correct event id when rendering photo thumbnails ([4c7b49a](https://github.com/the-luap/picpeak/commit/4c7b49a5f69a3fce4f9a0e837a082b56bb7e47d6)), closes [#19](https://github.com/the-luap/picpeak/issues/19)
* **admin:** prevent category badge overlap in grid ([d64e7d0](https://github.com/the-luap/picpeak/commit/d64e7d08deae7ad1b6f744f447fe546115427942))
* align backend port to 3000 across all configurations ([3a8d53f](https://github.com/the-luap/picpeak/commit/3a8d53f4927f577c4031c4bc3531e08191dc632a))
* Align nginx backend port for production Docker deployments (v2.2.2) ([#88](https://github.com/the-luap/picpeak/issues/88)) ([e0bd19a](https://github.com/the-luap/picpeak/commit/e0bd19a74dd81bdd45be2384820830bd96769e1c))
* apply password change fix to regular modal + longer toast delay ([#263](https://github.com/the-luap/picpeak/issues/263)) ([c63bc47](https://github.com/the-luap/picpeak/commit/c63bc47089b4b32c570bdeeb1f82bf722569875f))
* apply password change redirect fix to regular modal too ([#263](https://github.com/the-luap/picpeak/issues/263)) ([147dc28](https://github.com/the-luap/picpeak/commit/147dc28440ca69ed970677fa221dfac00c8e2560))
* **backup:** add lastBackup alias and totalBackups for frontend compatibility ([749100c](https://github.com/the-luap/picpeak/commit/749100c92abd2bb123b137e3d3c6bb342b8f5f00))
* **backup:** allow manual backups when automated backups are disabled ([e6dd89e](https://github.com/the-luap/picpeak/commit/e6dd89e969fb7018633159155975bd2bd2fb0409))
* checkbox and toggle settings not persisting after page refresh ([808ed1d](https://github.com/the-luap/picpeak/commit/808ed1d2f1164d9fd1114586c68a1f925bf73ddf)), closes [#117](https://github.com/the-luap/picpeak/issues/117)
* CI workflow fixes for protected branches ([657c205](https://github.com/the-luap/picpeak/commit/657c205a4d8ca49070b69973f4c7a3d1418633af))
* CI workflow fixes for protected branches ([cb01218](https://github.com/the-luap/picpeak/commit/cb012186d93403a1ac4e2d2f5283319603b290d6))
* **ci:** add QEMU setup for multi-arch builds and skip for PRs ([0d36a27](https://github.com/the-luap/picpeak/commit/0d36a273bb58ffd0172efacd828e7171d954b41c))
* clear notifications via API ([#35](https://github.com/the-luap/picpeak/issues/35)) ([013be18](https://github.com/the-luap/picpeak/commit/013be18d982986333e2ac24c7ede907de49690bc))
* correct invitation activation validation and add missing translations ([991aa98](https://github.com/the-luap/picpeak/commit/991aa98f98cffd1d7785c272726615325e2c0208)), closes [#129](https://github.com/the-luap/picpeak/issues/129)
* correct invitation email link URL path ([86fa104](https://github.com/the-luap/picpeak/commit/86fa1046d5439cb451feb164175c919c49ca219a)), closes [#129](https://github.com/the-luap/picpeak/issues/129)
* correct storage path resolution in multiple files ([#96](https://github.com/the-luap/picpeak/issues/96)) ([0e3674b](https://github.com/the-luap/picpeak/commit/0e3674b2b0325bbcee5aa2c9ff7781da92f612d1))
* correct storage path resolution in multiple files ([#96](https://github.com/the-luap/picpeak/issues/96)) ([3ccb815](https://github.com/the-luap/picpeak/commit/3ccb8154eb40a432aa467fb06b3f216fd0d2c6b4))
* **cors:** scope CORS to /api only and avoid throwing on disallowed origins; prevents static asset 500s on native ([90bb21e](https://github.com/the-luap/picpeak/commit/90bb21e38bf1ba97e3fb8185b8d05f1296d745ee))
* database migration restart bug, lightbox loading spinner, and watermark cache invalidation ([7c58749](https://github.com/the-luap/picpeak/commit/7c5874980640ae8c3d1050ce24daeb0a2aeab7a3))
* **db:** improve PostgreSQL connection check in wait-for-db.sh ([e85a68a](https://github.com/the-luap/picpeak/commit/e85a68a386c72c276b4958599b5246e60dfac716))
* display new password after admin password reset ([bd8b885](https://github.com/the-luap/picpeak/commit/bd8b885f7f060160eb852870d143f25ce628f3db))
* docker compose v2 syntax and add missing ADMIN_PASSWORD to .env.example ([#189](https://github.com/the-luap/picpeak/issues/189)) ([0817443](https://github.com/the-luap/picpeak/commit/0817443e793e37c770c6a1968ecae4b9464107b0))
* Docker Swarm DNS resolution and backup status display (v2.2.3) ([082d8ab](https://github.com/the-luap/picpeak/commit/082d8ab2054416b2a4f9e0438aa2bda0a8f4277e))
* Docker Swarm DNS resolution and backup status display (v2.2.3) ([082d8ab](https://github.com/the-luap/picpeak/commit/082d8ab2054416b2a4f9e0438aa2bda0a8f4277e))
* dynamic website title from branding settings ([4701edc](https://github.com/the-luap/picpeak/commit/4701edc12ecfab27cb2d1cfb0b4ed4fd53f56cc6))
* event-specific custom CSS settings not being saved ([dadef81](https://github.com/the-luap/picpeak/commit/dadef81158972d28aa32812203500f77ed08a999)), closes [#136](https://github.com/the-luap/picpeak/issues/136)
* events without expiration date incorrectly shown as expired ([c4f16eb](https://github.com/the-luap/picpeak/commit/c4f16eb76c909158abdb63aa4cc22f817f274dc5))
* external media dimensions, theme race condition, email color customization ([dfae2c2](https://github.com/the-luap/picpeak/commit/dfae2c2bc6d86378c553cd847b439f7cb53a4f2a))
* **frontend:** add missing externalMedia service and mount admin external-media routes; verify Vite build ([ab324f1](https://github.com/the-luap/picpeak/commit/ab324f192859204a3ea3c129530ccfe8f5a36968))
* gallery thumbnails not loading (404 errors) [#96](https://github.com/the-luap/picpeak/issues/96) ([e3c3c4c](https://github.com/the-luap/picpeak/commit/e3c3c4c951c52de99bd0afd95b08d119153997b4))
* **gallery/filters:** always apply global liked/favorited filters by aggregate counts (ignore guest_id); resolves mismatch between client guest_id and server identifier ([526dcd8](https://github.com/the-luap/picpeak/commit/526dcd8dfc030d86143cee799a88a1004d96b116))
* **gallery/filters:** make feedback filters work globally when no guest_id is provided; remove guest_id from client photos query\n\n- Backend /api/gallery/:slug/photos: if filter present and guest_id missing, filter by like_count/favorite_count\n- Frontend useGalleryPhotos: stop passing random guestId (does not match server guest_identifier)\n\nThis makes Liked/Favorited filters reflect photos with aggregate feedback counts as expected. ([5b2561b](https://github.com/the-luap/picpeak/commit/5b2561b6f1da2665d6092ba954f8ff26df3959a4))
* **gallery/sidebar:** compact icon-only feedback filter in sidebar (vertical, small) to avoid overflow; use GalleryFilter variant=compact ([ff89f96](https://github.com/the-luap/picpeak/commit/ff89f96e31130f75bcd7a406c5d895eac17b65de))
* **gallery:** feedback filter headline + horizontal icons in sidebar (compact variant); ensure sidebar content scrolls (flex-col container) ([3a6d061](https://github.com/the-luap/picpeak/commit/3a6d06192a280ead8bd5d1fbfe06554e63f3346e))
* handle legacy non-JSON logo paths when replacing logo ([0d5ce48](https://github.com/the-luap/picpeak/commit/0d5ce48dccf0c61f210725ffae15dafc5e9f7cab))
* handle null dates in dashboard and gallery pages ([c5a8ffc](https://github.com/the-luap/picpeak/commit/c5a8ffc08cd4c53c37fe4fb9cde8519a68f1f343))
* harden gallery downloads and per-gallery auth ([fc1bf53](https://github.com/the-luap/picpeak/commit/fc1bf534129092ca3638e4a4bc47274cd297fa5f))
* hero header state and preview in admin theme editor ([#158](https://github.com/the-luap/picpeak/issues/158)) ([f554f46](https://github.com/the-luap/picpeak/commit/f554f463b3492346dba067c0980b52ef42dd5e70))
* improve ghost button visibility in admin dark mode ([4912e2b](https://github.com/the-luap/picpeak/commit/4912e2bccf282134d5598a8ac80942ed46d0523c))
* improve password validation errors and event list UX ([#170](https://github.com/the-luap/picpeak/issues/170), [#171](https://github.com/the-luap/picpeak/issues/171)) ([171abb3](https://github.com/the-luap/picpeak/commit/171abb31615484d77cf95a99cb5634afa0160adc))
* improve photo serving, category filters, and upload chunking ([#155](https://github.com/the-luap/picpeak/issues/155), [#156](https://github.com/the-luap/picpeak/issues/156), [#161](https://github.com/the-luap/picpeak/issues/161)) ([fa4c838](https://github.com/the-luap/picpeak/commit/fa4c83812d87cfa63394e51186e320a072929d37))
* increase upload limit to 1GB and fix category filters ([#155](https://github.com/the-luap/picpeak/issues/155), [#156](https://github.com/the-luap/picpeak/issues/156)) ([397d33a](https://github.com/the-luap/picpeak/commit/397d33a95a09e0b0986c3f6cf5965c544992a764))
* issue [#203](https://github.com/the-luap/picpeak/issues/203) file type validation + security CVE fixes ([8017171](https://github.com/the-luap/picpeak/commit/80171713e0ffedda56f7cffb403b25a8d55634d1))
* JSON serialize favicon and logo URLs for PostgreSQL storage ([b83f427](https://github.com/the-luap/picpeak/commit/b83f4272b584f937fea1f47656182e514b12d980))
* lightbox watermark loading, white label translations, and dynamic footer year ([3b720ed](https://github.com/the-luap/picpeak/commit/3b720ed56ecd2ded6aec57309f8c408c63a617ef))
* lightbox watermark loading, white label translations, and dynamic footer year ([ce8587b](https://github.com/the-luap/picpeak/commit/ce8587b24df3f53a11a74348eff8b5c5b96c5488))
* lightbox watermark loading, white label translations, and dynamic footer year ([#108](https://github.com/the-luap/picpeak/issues/108)) ([3b720ed](https://github.com/the-luap/picpeak/commit/3b720ed56ecd2ded6aec57309f8c408c63a617ef))
* mobile upload button not visible in gallery ([#113](https://github.com/the-luap/picpeak/issues/113)) ([cacaffa](https://github.com/the-luap/picpeak/commit/cacaffa5c39f67105c4cfb092ea62157121fb72e))
* mobile upload button visibility in gallery ([2a2c23d](https://github.com/the-luap/picpeak/commit/2a2c23d11610e6c81684163eb4ea934a6d6104fb)), closes [#113](https://github.com/the-luap/picpeak/issues/113)
* mobile upload button visibility in gallery ([df7dbff](https://github.com/the-luap/picpeak/commit/df7dbffbffb180e62af0d2b58326f9de0f515439)), closes [#113](https://github.com/the-luap/picpeak/issues/113)
* mobile upload button visibility in gallery ([#113](https://github.com/the-luap/picpeak/issues/113)) ([05a5307](https://github.com/the-luap/picpeak/commit/05a5307e22dc45be4b75b2996ff9fac65dec399d))
* mobile upload button visibility in gallery ([#113](https://github.com/the-luap/picpeak/issues/113)) ([6cb4342](https://github.com/the-luap/picpeak/commit/6cb43428d1e703267edeacda9ede050a8c4f8e0c))
* Multi-administrator RBAC, CSS templates & security hardening ([#80](https://github.com/the-luap/picpeak/issues/80)) ([37d4e1c](https://github.com/the-luap/picpeak/commit/37d4e1cb6132346699a90aebfbaec83d84f931f4))
* **native/http:** disable CSP upgrade-insecure-requests and HSTS unless ENABLE_HSTS=true; prevents HTTPS upgrades on HTTP installs ([24b4a31](https://github.com/the-luap/picpeak/commit/24b4a314a9e97b6c640ca29067e95028a23a8973))
* **native:** correct setup paths to /opt/picpeak/app, update repo URL, add sqlite prod support; docs path fixes ([b992b15](https://github.com/the-luap/picpeak/commit/b992b151d3ca6ccb4a9b2434d94edcdc90ada3b0))
* **native:** remove obsolete workers service; restart only backend; add API request logging and preflight handler; keep static assets outside CORS ([f3604b4](https://github.com/the-luap/picpeak/commit/f3604b438b37e5f2bddf98e79f458bfa2367cb75))
* **nginx:** add Docker DNS resolver for Swarm/dynamic service discovery ([049837f](https://github.com/the-luap/picpeak/commit/049837f9d675ff5a4d93c02e5eb771bf65bc2616))
* **nginx:** Add Docker DNS resolver for Swarm/dynamic service discovery (v2.2.3) ([cc1ddfd](https://github.com/the-luap/picpeak/commit/cc1ddfd42cccac07d5869fe2ee19c25a9ffa50e8))
* **photos:** category changes now persist and display correctly ([#77](https://github.com/the-luap/picpeak/issues/77)) ([d9da98c](https://github.com/the-luap/picpeak/commit/d9da98c355011c247c526b28e6f07b329a632b55))
* **photos:** resolve upload category selection and improve feedback buttons ([#77](https://github.com/the-luap/picpeak/issues/77)) ([856d533](https://github.com/the-luap/picpeak/commit/856d53343c6805706e1498892a29b120938f8547))
* pin npm to v10 in backend Dockerfile ([ddefd3a](https://github.com/the-luap/picpeak/commit/ddefd3a95e5047d4a22aa4b6fef57dfb1c880967))
* pin npm upgrade to v10 in backend Dockerfile ([978e447](https://github.com/the-luap/picpeak/commit/978e4473b5227ee61ad7d17487063eb3284bea36))
* prefer admin token on admin routes ([#23](https://github.com/the-luap/picpeak/issues/23) [#28](https://github.com/the-luap/picpeak/issues/28)) ([d4404e3](https://github.com/the-luap/picpeak/commit/d4404e39bd7953649da02d3e300ffef46573ac97))
* prevent database migration restart failures ([83a4344](https://github.com/the-luap/picpeak/commit/83a4344a01de4f65c5024fdf2d177a04457ccd2f)), closes [#107](https://github.com/the-luap/picpeak/issues/107)
* prevent unnecessary image recompression and fix SQLite migration [#95](https://github.com/the-luap/picpeak/issues/95) ([3cdc0ea](https://github.com/the-luap/picpeak/commit/3cdc0ea7152e63cd72124a91394741a6e6904af3))
* remove non-functional watermark toggle from Feature Toggles ([d4a15db](https://github.com/the-luap/picpeak/commit/d4a15dbe74d0d70bbe6ff03362dc7337fb8f4c5c))
* render minimal/none header styles, cap hero height, switch category hero images ([#158](https://github.com/the-luap/picpeak/issues/158), [#162](https://github.com/the-luap/picpeak/issues/162), [#163](https://github.com/the-luap/picpeak/issues/163)) ([bc6c48b](https://github.com/the-luap/picpeak/commit/bc6c48bb2429505c2de3641693a8ff4f623a4951))
* resend gallery email fails for events without password ([6b3ead7](https://github.com/the-luap/picpeak/commit/6b3ead747b1395d8ea2b3d135a5ac24db05e2eb8)), closes [#137](https://github.com/the-luap/picpeak/issues/137)
* resolve admin invitation flow issues and improve STORAGE_PATH documentation ([41bf6ff](https://github.com/the-luap/picpeak/commit/41bf6ff884d5ef3181f95f3aa4a528434c23947a))
* resolve branding display issues and invitation parsing errors ([1931d73](https://github.com/the-luap/picpeak/commit/1931d73b60d3419203cc8b420841abbfc9e14d2d))
* Resolve branding display issues and invitation parsing errors (v2.2.1) ([#86](https://github.com/the-luap/picpeak/issues/86)) ([d7ecf83](https://github.com/the-luap/picpeak/commit/d7ecf83d32ec6608280b96e6cdee48e9a0ad0afa))
* resolve code quality issues and add missing i18n keys ([#162](https://github.com/the-luap/picpeak/issues/162), [#163](https://github.com/the-luap/picpeak/issues/163)) ([329d224](https://github.com/the-luap/picpeak/commit/329d224846d3f4eefa31e42337f34047c267d578))
* resolve code scanning security alerts (multer, tar, Node 22) ([85a07fc](https://github.com/the-luap/picpeak/commit/85a07fcca7ad935f4c0c300f5ffe2f3af8da1e5f))
* resolve external media dimensions, gallery theme race condition, and add email color customization ([bbeedd1](https://github.com/the-luap/picpeak/commit/bbeedd1888561b6c57586b5f42bbfee3ffc69fd7))
* resolve issues [#194](https://github.com/the-luap/picpeak/issues/194), [#195](https://github.com/the-luap/picpeak/issues/195), [#196](https://github.com/the-luap/picpeak/issues/196), [#197](https://github.com/the-luap/picpeak/issues/197) ([33af088](https://github.com/the-luap/picpeak/commit/33af0885607799e0071e2e74a582c7eb396c9b83))
* resolve issues [#194](https://github.com/the-luap/picpeak/issues/194), [#195](https://github.com/the-luap/picpeak/issues/195), [#196](https://github.com/the-luap/picpeak/issues/196), [#197](https://github.com/the-luap/picpeak/issues/197) ([5ea4ef3](https://github.com/the-luap/picpeak/commit/5ea4ef3cf36b06f9e6c9108f80bfe2e9a6470898))
* resolve issues [#194](https://github.com/the-luap/picpeak/issues/194), [#195](https://github.com/the-luap/picpeak/issues/195), [#196](https://github.com/the-luap/picpeak/issues/196), [#197](https://github.com/the-luap/picpeak/issues/197) ([33483cf](https://github.com/the-luap/picpeak/commit/33483cf32dfae57f8da51c0765353792239135f9))
* resolve issues [#194](https://github.com/the-luap/picpeak/issues/194), [#195](https://github.com/the-luap/picpeak/issues/195), [#196](https://github.com/the-luap/picpeak/issues/196), [#197](https://github.com/the-luap/picpeak/issues/197) ([cd00bc1](https://github.com/the-luap/picpeak/commit/cd00bc13d4e02a86a0f1742ed1f11f064614b8da))
* resolve JWT iat timing issue in password change ([#263](https://github.com/the-luap/picpeak/issues/263)) ([c031b1e](https://github.com/the-luap/picpeak/commit/c031b1e86333d90e8e0e0aa723572efa110f7fd1))
* resolve mixed light/dark mode styling in admin UI ([#175](https://github.com/the-luap/picpeak/issues/175)) ([f8c8abd](https://github.com/the-luap/picpeak/commit/f8c8abd70bbae35d6cd519894624ade33b5115a8))
* resolve password change redirect loop ([#263](https://github.com/the-luap/picpeak/issues/263)) and file watcher crash ([#269](https://github.com/the-luap/picpeak/issues/269)) ([b23c51b](https://github.com/the-luap/picpeak/commit/b23c51b386270dee4d911902b728dfacb1ff1bf9))
* resolve password change redirect loop and file watcher crash ([835bdf5](https://github.com/the-luap/picpeak/commit/835bdf5abb40c7b143c5cdafb507c317a7c349bf)), closes [#269](https://github.com/the-luap/picpeak/issues/269)
* resolve redirect loop after mandatory password change ([#263](https://github.com/the-luap/picpeak/issues/263)) ([07fc5e6](https://github.com/the-luap/picpeak/commit/07fc5e6519cd84f2214479d5f31bc35a495bfe4b))
* resolve redirect loop after mandatory password change ([#263](https://github.com/the-luap/picpeak/issues/263)) ([3c8d344](https://github.com/the-luap/picpeak/commit/3c8d344ddd23974c9cf0f5f63edd6cd07817fee9))
* respect allowed_file_types setting for upload validation ([#203](https://github.com/the-luap/picpeak/issues/203)) ([fe07a14](https://github.com/the-luap/picpeak/commit/fe07a148f1d998c0be00377c1f8b4eca3908305c))
* respect optional email settings in event creation ([831ea6a](https://github.com/the-luap/picpeak/commit/831ea6a3bccfae4ec00ce1f619967b91b85150ce))
* respect optional email settings in event creation ([#217](https://github.com/the-luap/picpeak/issues/217)) ([9c44a0e](https://github.com/the-luap/picpeak/commit/9c44a0ebfa527fa133512eb7f2f03335a2377aaa))
* restore aspect-ratio layouts and improve hero image quality ([#180](https://github.com/the-luap/picpeak/issues/180)) ([3974ba5](https://github.com/the-luap/picpeak/commit/3974ba5de5a6605ad906608d3e4d61620a215059))
* restore aspect-ratio layouts and improve hero image quality ([#180](https://github.com/the-luap/picpeak/issues/180)) ([5cef7fd](https://github.com/the-luap/picpeak/commit/5cef7fdd188389512bc4b55ae61536c8b1219eb8))
* **security:** invalidate tokens on password change, enforce session timeout, fix role update ([f362239](https://github.com/the-luap/picpeak/commit/f3622396e77ce5d0b0741e439fc554a1dccaca50))
* **security:** resolve all npm audit vulnerabilities ([4272618](https://github.com/the-luap/picpeak/commit/4272618b3f7fcb06aaca14fb724a6a7733251f24))
* **security:** resolve Docker image CVEs for code scanning alerts ([cbecb93](https://github.com/the-luap/picpeak/commit/cbecb9323cf4b80c800326de14f6df73f60147c1))
* **security:** token invalidation on password change, session timeout enforcement ([7ca9631](https://github.com/the-luap/picpeak/commit/7ca96315e254eef58d8ecc505f95a5186d2fa2da))
* **security:** upgrade Alpine base image to fix libpng and c-ares CVEs ([b706eeb](https://github.com/the-luap/picpeak/commit/b706eeb5d332e9618706193976a7241aee53d879))
* set JWT iat after password_changed_at to prevent token rejection ([#263](https://github.com/the-luap/picpeak/issues/263)) ([b1d1667](https://github.com/the-luap/picpeak/commit/b1d16670d56e19f7b35e7f2f12f3611fdb3fab58))
* **setup/native:** correct repo URL, paths, and systemd for native install; support sqlite in production knex config ([87b8414](https://github.com/the-luap/picpeak/commit/87b8414e449802db6dc9f762453f7672616b83c9))
* **setup/native:** Debian 12 compatibility (reliable RAM detection, sudo-less run_as_user, git safe.directory); ensure SQLite data dir; use user for migrate ([dc482e6](https://github.com/the-luap/picpeak/commit/dc482e614a5fbac44c6570d812669511301a4403))
* **setup/native:** handle forced updates safely by fetch+checkout/reset instead of pull; stable on rewritten histories ([3697344](https://github.com/the-luap/picpeak/commit/3697344cd0add28b4da71c3b33e2ccc0a96f50f9))
* **setup/update:** detect native installs first (/opt/picpeak/app/backend or systemd unit); avoid false docker updates on root ([adf576f](https://github.com/the-luap/picpeak/commit/adf576fbe17f40c13c1d77dd9751f2e9dbf523a1))
* shorten Save button label on email template editor ([7250c42](https://github.com/the-luap/picpeak/commit/7250c427b905ffa3e8696dff607450f5a0b801b8))
* show upload button in mobile topbar instead of sidebar ([ae181cf](https://github.com/the-luap/picpeak/commit/ae181cf92fc9c1e85cad7a7b843a4d83cec636ac)), closes [#113](https://github.com/the-luap/picpeak/issues/113)
* stabilize uploads and guest feedback filters ([aaaf598](https://github.com/the-luap/picpeak/commit/aaaf59817b3978635d2282c006853e183ab944d4))
* sync header_style DB column with theme editor selections ([#158](https://github.com/the-luap/picpeak/issues/158)) ([2288309](https://github.com/the-luap/picpeak/commit/228830939553fd32c250704bb89a8ce233324d25))
* sync header_style DB column with theme editor selections ([#158](https://github.com/the-luap/picpeak/issues/158)) ([a19e7c4](https://github.com/the-luap/picpeak/commit/a19e7c40a200ff822c947a83349ed07ccf4e1b01))
* update dependencies to resolve code scanning security alerts ([1f524f2](https://github.com/the-luap/picpeak/commit/1f524f23580d2e2a21dbba28cb46aed76e85c475))
* update docker-compose to docker compose and add ADMIN_PASSWORD to .env.example ([#189](https://github.com/the-luap/picpeak/issues/189)) ([a4c6248](https://github.com/the-luap/picpeak/commit/a4c624802b2926a16adcf0472a3041562f9b2f48))
* update packages to fix security vulnerabilities ([8097a0c](https://github.com/the-luap/picpeak/commit/8097a0cb530bd8003597cde81606231efadb0bf5))
* update security policy with private reporting channels ([308e086](https://github.com/the-luap/picpeak/commit/308e08626383bab213ce3eb5563608dff6168ef4))
* update security policy with private reporting channels ([7f77362](https://github.com/the-luap/picpeak/commit/7f7736282f534adf4b9d5331d841a1f0bff7341c))
* update security policy with proper contact email and private reporting ([67b0f32](https://github.com/the-luap/picpeak/commit/67b0f32456d0216e4c685a104c680fa5a5fd578f)), closes [#223](https://github.com/the-luap/picpeak/issues/223)
* use actual photo aspect ratios in masonry columns mode ([#146](https://github.com/the-luap/picpeak/issues/146)) ([8711f96](https://github.com/the-luap/picpeak/commit/8711f967a15f5d57f6ad01bfdbd8d33f9ee96abc))
* use CSS Columns for gap-free mosaic layout ([#146](https://github.com/the-luap/picpeak/issues/146)) ([821d329](https://github.com/the-luap/picpeak/commit/821d3296ea4b6bde499e5497d258f15ab8dd1dbc))
* use photo dimensions for mosaic aspect ratios ([#146](https://github.com/the-luap/picpeak/issues/146)) ([27ff51e](https://github.com/the-luap/picpeak/commit/27ff51e7a1217848859b47940bc88caa6f1fb20f))
* use Release Please extra-files instead of sync-versions job ([fe7d45d](https://github.com/the-luap/picpeak/commit/fe7d45dd122b2dca1b2a21ba5c86d32b9a193074))
* video upload media type, select all, and dimension repair ([#203](https://github.com/the-luap/picpeak/issues/203), [#220](https://github.com/the-luap/picpeak/issues/220), [#180](https://github.com/the-luap/picpeak/issues/180)) ([fc75bcd](https://github.com/the-luap/picpeak/commit/fc75bcdfc38673d6e4dd1cd943cfb4638d3a306c))
* video upload, select all, and dimension repair ([#203](https://github.com/the-luap/picpeak/issues/203), [#220](https://github.com/the-luap/picpeak/issues/220), [#180](https://github.com/the-luap/picpeak/issues/180)) ([a0bb080](https://github.com/the-luap/picpeak/commit/a0bb0805868e742f323b64312c3c5ef8ec408f68))
* watermark thumbnails, custom logo display, and German translations ([f843e4c](https://github.com/the-luap/picpeak/commit/f843e4c25cef02eef354fd3ee25824e20e4f8fc8))
* watermark thumbnails, custom logo display, and German translations ([ea20446](https://github.com/the-luap/picpeak/commit/ea20446a797a00cf45dbe7bf6f06574a79c4d8a6))
* watermark upload JSON parsing and image quality preservation ([0e3b50d](https://github.com/the-luap/picpeak/commit/0e3b50d1b6a2dc532ebdc0981f81f77722e8f23a))
* wire admin photo feedback filters into grid query ([#293](https://github.com/the-luap/picpeak/issues/293)) ([d4b4dc6](https://github.com/the-luap/picpeak/commit/d4b4dc628f28a303ff1c80ba6d8e5e768217ba51))
* wrap email preview with full styled header/footer template ([9a6d2e8](https://github.com/the-luap/picpeak/commit/9a6d2e8e3a3fab8d7969a8a42e94934c38d88392))
* wrap email preview with full styled header/footer template ([fc0911a](https://github.com/the-luap/picpeak/commit/fc0911acf8b7c8a18d71bb4267f1086acd1e0ca1)), closes [#229](https://github.com/the-luap/picpeak/issues/229)
* wrap test email with standard email template ([#252](https://github.com/the-luap/picpeak/issues/252)) ([954a011](https://github.com/the-luap/picpeak/commit/954a0118bae5770c74f1e811e03b8fc702c70db2))


### Documentation

* add API_URL environment variable to .env.example files ([3e69579](https://github.com/the-luap/picpeak/commit/3e69579f5a171b31a253b2a42bb033bf1b97387d))
* add PUID/PGID note for Docker bind mounts to avoid permission issues ([0178e71](https://github.com/the-luap/picpeak/commit/0178e71c67f198c6013ece52b0a2da0e2f1a6b2a))
* clarify file system photo import requires existing event ([#269](https://github.com/the-luap/picpeak/issues/269)) ([5295516](https://github.com/the-luap/picpeak/commit/5295516b67a1d9f035564c5f9a724f25f8d21c78))
* clarify file system photo import requires existing event ([#269](https://github.com/the-luap/picpeak/issues/269)) ([ee0baaf](https://github.com/the-luap/picpeak/commit/ee0baafc59f3588a26172aa8835c12dcaec35d10))
* emphasize importance of STORAGE_PATH in env example ([3397807](https://github.com/the-luap/picpeak/commit/3397807670784e02cbe34a7a60db43c95d64f19c))
* **readme:** reflect new External Media reference mode and update roadmap (gallery feedback status) ([ee13556](https://github.com/the-luap/picpeak/commit/ee13556c5cb4f24fe88e14fd00b821acf65b11cb))

## [3.26.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.26.1-beta.0...v3.26.2-beta.0) (2026-04-11)


### Bug Fixes

* admin photo feedback filters have no effect ([#293](https://github.com/the-luap/picpeak/issues/293)) ([9ed8a2b](https://github.com/the-luap/picpeak/commit/9ed8a2b1994d139efd100c8fb97e6368655e5530))
* wire admin photo feedback filters into grid query ([#293](https://github.com/the-luap/picpeak/issues/293)) ([d4b4dc6](https://github.com/the-luap/picpeak/commit/d4b4dc628f28a303ff1c80ba6d8e5e768217ba51))

## [3.26.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.26.0-beta.0...v3.26.1-beta.0) (2026-04-09)


### Bug Fixes

* apply password change fix to regular modal + longer toast delay ([#263](https://github.com/the-luap/picpeak/issues/263)) ([c63bc47](https://github.com/the-luap/picpeak/commit/c63bc47089b4b32c570bdeeb1f82bf722569875f))
* apply password change redirect fix to regular modal too ([#263](https://github.com/the-luap/picpeak/issues/263)) ([147dc28](https://github.com/the-luap/picpeak/commit/147dc28440ca69ed970677fa221dfac00c8e2560))
* resolve JWT iat timing issue in password change ([#263](https://github.com/the-luap/picpeak/issues/263)) ([c031b1e](https://github.com/the-luap/picpeak/commit/c031b1e86333d90e8e0e0aa723572efa110f7fd1))
* set JWT iat after password_changed_at to prevent token rejection ([#263](https://github.com/the-luap/picpeak/issues/263)) ([b1d1667](https://github.com/the-luap/picpeak/commit/b1d16670d56e19f7b35e7f2f12f3611fdb3fab58))


### Documentation

* clarify file system photo import requires existing event ([#269](https://github.com/the-luap/picpeak/issues/269)) ([5295516](https://github.com/the-luap/picpeak/commit/5295516b67a1d9f035564c5f9a724f25f8d21c78))
* clarify file system photo import requires existing event ([#269](https://github.com/the-luap/picpeak/issues/269)) ([ee0baaf](https://github.com/the-luap/picpeak/commit/ee0baafc59f3588a26172aa8835c12dcaec35d10))

## [3.26.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.25.0-beta.0...v3.26.0-beta.0) (2026-04-09)


### Features

* sort photos by capture date with configurable default sort ([#283](https://github.com/the-luap/picpeak/issues/283)) ([8805fa5](https://github.com/the-luap/picpeak/commit/8805fa53e61c6b3672a8f6dad14d2fd17998a451))
* sort photos by capture date with configurable default sort ([#283](https://github.com/the-luap/picpeak/issues/283)) ([633d4a0](https://github.com/the-luap/picpeak/commit/633d4a0f301e355ee9f057347f2f8dee8c5b4163))


### Bug Fixes

* resolve password change redirect loop ([#263](https://github.com/the-luap/picpeak/issues/263)) and file watcher crash ([#269](https://github.com/the-luap/picpeak/issues/269)) ([b23c51b](https://github.com/the-luap/picpeak/commit/b23c51b386270dee4d911902b728dfacb1ff1bf9))
* resolve password change redirect loop and file watcher crash ([835bdf5](https://github.com/the-luap/picpeak/commit/835bdf5abb40c7b143c5cdafb507c317a7c349bf)), closes [#269](https://github.com/the-luap/picpeak/issues/269)

## [3.25.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.24.1-beta.0...v3.25.0-beta.0) (2026-04-08)


### Features

* draft mode, admin branding, and workflow improvements ([dc98206](https://github.com/the-luap/picpeak/commit/dc98206737d1ebe43637319ce8c5b6da2e44c05d))
* draft mode, admin branding, and workflow improvements ([40332a7](https://github.com/the-luap/picpeak/commit/40332a71db6534097940d3f9362b0fe651dba6c7))

## [3.24.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.24.0-beta.0...v3.24.1-beta.0) (2026-04-05)


### Bug Fixes

* resolve redirect loop after mandatory password change ([#263](https://github.com/the-luap/picpeak/issues/263)) ([07fc5e6](https://github.com/the-luap/picpeak/commit/07fc5e6519cd84f2214479d5f31bc35a495bfe4b))
* resolve redirect loop after mandatory password change ([#263](https://github.com/the-luap/picpeak/issues/263)) ([3c8d344](https://github.com/the-luap/picpeak/commit/3c8d344ddd23974c9cf0f5f63edd6cd07817fee9))

## [3.24.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.23.0-beta.0...v3.24.0-beta.0) (2026-04-04)


### Features

* warn about low thumbnail resolution when selecting beta themes ([ee3f6ae](https://github.com/the-luap/picpeak/commit/ee3f6ae13bf9c9fb3295286e84150e04bf9fbce4))
* warn about low thumbnail resolution with beta themes ([aef9b4e](https://github.com/the-luap/picpeak/commit/aef9b4ed7fc443cbec8890c580759077e05e77b4))

## [3.23.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.22.0-beta.0...v3.23.0-beta.0) (2026-04-04)


### Features

* multilingual email templates with translations table ([8c5996e](https://github.com/the-luap/picpeak/commit/8c5996e4ec43b2817d84cc040cfe52878ffb61d5))
* multilingual email templates with translations table ([f50d7c0](https://github.com/the-luap/picpeak/commit/f50d7c0c51aa84a2182e450cd4b6a00777a8f9c0))


### Bug Fixes

* pin npm to v10 in backend Dockerfile ([ddefd3a](https://github.com/the-luap/picpeak/commit/ddefd3a95e5047d4a22aa4b6fef57dfb1c880967))
* pin npm upgrade to v10 in backend Dockerfile ([978e447](https://github.com/the-luap/picpeak/commit/978e4473b5227ee61ad7d17487063eb3284bea36))

## [3.22.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.21.1-beta.0...v3.22.0-beta.0) (2026-03-25)


### Features

* add Dutch (nl) locale and fix missing translation keys across all locales ([b54a80d](https://github.com/the-luap/picpeak/commit/b54a80d251bcbb9a126e32eeaef522688bc810c6))
* add Dutch locale and fix missing translation keys ([e32da68](https://github.com/the-luap/picpeak/commit/e32da68cbdfa430d62cbb1057ea418dc6b2f14fb))

## [3.21.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.21.0-beta.0...v3.21.1-beta.0) (2026-03-22)


### Bug Fixes

* address Shannon security assessment findings (37 vulnerabilities) ([#254](https://github.com/the-luap/picpeak/issues/254)) ([23cd9cb](https://github.com/the-luap/picpeak/commit/23cd9cb680eb77b94a97266c3353dfc835f0cc69))

## [3.21.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.20.1-beta.0...v3.21.0-beta.0) (2026-03-18)


### Features

* add per-gallery thumbnail scale setting ([#172](https://github.com/the-luap/picpeak/issues/172)) ([#251](https://github.com/the-luap/picpeak/issues/251)) ([ee46088](https://github.com/the-luap/picpeak/commit/ee46088985ebbbb81d16e5bac23be2060c94397f))


### Bug Fixes

* wrap test email with standard email template ([#252](https://github.com/the-luap/picpeak/issues/252)) ([954a011](https://github.com/the-luap/picpeak/commit/954a0118bae5770c74f1e811e03b8fc702c70db2))

## [3.20.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.20.0-beta.0...v3.20.1-beta.0) (2026-03-17)


### Bug Fixes

* address beta feedback - gallery layout fixes, Russian locale, email logo ([#249](https://github.com/the-luap/picpeak/issues/249)) ([486239a](https://github.com/the-luap/picpeak/commit/486239aeb9b5f56551d5aa90f0bad3008eedc3bb))

## [3.20.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.19.2-beta.0...v3.20.0-beta.0) (2026-03-17)


### Features

* photo visibility control with client access ([#172](https://github.com/the-luap/picpeak/issues/172)) ([4a93e4e](https://github.com/the-luap/picpeak/commit/4a93e4e8cbe1b7a23a8be706291a270ccdf5bb55))
* photo visibility control with client access ([#172](https://github.com/the-luap/picpeak/issues/172)) ([e1b6e43](https://github.com/the-luap/picpeak/commit/e1b6e43e524211c913d3d29ade5fc029df12920f))

## [3.19.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.19.1-beta.0...v3.19.2-beta.0) (2026-03-16)


### Bug Fixes

* **security:** invalidate tokens on password change, enforce session timeout, fix role update ([f362239](https://github.com/the-luap/picpeak/commit/f3622396e77ce5d0b0741e439fc554a1dccaca50))
* **security:** token invalidation on password change, session timeout enforcement ([7ca9631](https://github.com/the-luap/picpeak/commit/7ca96315e254eef58d8ecc505f95a5186d2fa2da))

## [3.19.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.19.0-beta.0...v3.19.1-beta.0) (2026-03-16)


### Bug Fixes

* external media dimensions, theme race condition, email color customization ([dfae2c2](https://github.com/the-luap/picpeak/commit/dfae2c2bc6d86378c553cd847b439f7cb53a4f2a))
* resolve external media dimensions, gallery theme race condition, and add email color customization ([bbeedd1](https://github.com/the-luap/picpeak/commit/bbeedd1888561b6c57586b5f42bbfee3ffc69fd7))

## [3.19.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.18.2-beta.0...v3.19.0-beta.0) (2026-03-16)


### Features

* add photo cap per event and Portuguese (pt-BR) locale ([1fa222e](https://github.com/the-luap/picpeak/commit/1fa222e9c4c26e525c7899e368988c6b0b08da85))
* add photo cap per event and Portuguese locale ([088de43](https://github.com/the-luap/picpeak/commit/088de43f09f974d444f50452ef1117315c289ebc))

## [3.18.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.18.1-beta.0...v3.18.2-beta.0) (2026-03-16)


### Bug Fixes

* resolve code scanning security alerts (multer, tar, Node 22) ([85a07fc](https://github.com/the-luap/picpeak/commit/85a07fcca7ad935f4c0c300f5ffe2f3af8da1e5f))
* update dependencies to resolve code scanning security alerts ([1f524f2](https://github.com/the-luap/picpeak/commit/1f524f23580d2e2a21dbba28cb46aed76e85c475))

## [3.18.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.18.0-beta.0...v3.18.1-beta.0) (2026-03-16)


### Bug Fixes

* wrap email preview with full styled header/footer template ([9a6d2e8](https://github.com/the-luap/picpeak/commit/9a6d2e8e3a3fab8d7969a8a42e94934c38d88392))
* wrap email preview with full styled header/footer template ([fc0911a](https://github.com/the-luap/picpeak/commit/fc0911acf8b7c8a18d71bb4267f1086acd1e0ca1)), closes [#229](https://github.com/the-luap/picpeak/issues/229)

## [3.18.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.17.2-beta.0...v3.18.0-beta.0) (2026-03-16)


### Features

* add visual WYSIWYG email template editor ([#229](https://github.com/the-luap/picpeak/issues/229)) ([04a7ea8](https://github.com/the-luap/picpeak/commit/04a7ea80f95d6aeb474b145292e75f45fb85c66d))
* register Russian locale and add to language selector ([6f95b8c](https://github.com/the-luap/picpeak/commit/6f95b8c26cd794525e15e45d478f9ead0ec22555))
* visual WYSIWYG email template editor ([703c03f](https://github.com/the-luap/picpeak/commit/703c03fbee754a5291b57b885c5e82fbdd3e69e9))


### Bug Fixes

* shorten Save button label on email template editor ([7250c42](https://github.com/the-luap/picpeak/commit/7250c427b905ffa3e8696dff607450f5a0b801b8))

## [3.17.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.17.1-beta.0...v3.17.2-beta.0) (2026-03-11)


### Bug Fixes

* update security policy with private reporting channels ([308e086](https://github.com/the-luap/picpeak/commit/308e08626383bab213ce3eb5563608dff6168ef4))
* update security policy with proper contact email and private reporting ([67b0f32](https://github.com/the-luap/picpeak/commit/67b0f32456d0216e4c685a104c680fa5a5fd578f)), closes [#223](https://github.com/the-luap/picpeak/issues/223)
* video upload media type, select all, and dimension repair ([#203](https://github.com/the-luap/picpeak/issues/203), [#220](https://github.com/the-luap/picpeak/issues/220), [#180](https://github.com/the-luap/picpeak/issues/180)) ([fc75bcd](https://github.com/the-luap/picpeak/commit/fc75bcdfc38673d6e4dd1cd943cfb4638d3a306c))
* video upload, select all, and dimension repair ([#203](https://github.com/the-luap/picpeak/issues/203), [#220](https://github.com/the-luap/picpeak/issues/220), [#180](https://github.com/the-luap/picpeak/issues/180)) ([a0bb080](https://github.com/the-luap/picpeak/commit/a0bb0805868e742f323b64312c3c5ef8ec408f68))

## [3.17.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.17.0-beta.0...v3.17.1-beta.0) (2026-03-08)


### Bug Fixes

* respect optional email settings in event creation ([831ea6a](https://github.com/the-luap/picpeak/commit/831ea6a3bccfae4ec00ce1f619967b91b85150ce))
* respect optional email settings in event creation ([#217](https://github.com/the-luap/picpeak/issues/217)) ([9c44a0e](https://github.com/the-luap/picpeak/commit/9c44a0ebfa527fa133512eb7f2f03335a2377aaa))

## [3.17.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.16.0-beta.0...v3.17.0-beta.0) (2026-03-05)


### Features

* configurable upload batch size for reverse proxy compatibility ([9b7495e](https://github.com/the-luap/picpeak/commit/9b7495e0054975e66c9b5006c24a9fae63969de4))

## [3.16.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.15.3-beta.0...v3.16.0-beta.0) (2026-03-05)


### Features

* add thumbnail settings UI to admin panel ([3a30fea](https://github.com/the-luap/picpeak/commit/3a30fea862034d64fbc7188fc25292594a9319e2))
* add thumbnail settings UI to admin settings page ([#206](https://github.com/the-luap/picpeak/issues/206)) ([7d6d2f5](https://github.com/the-luap/picpeak/commit/7d6d2f56883a4402f0d97c95b0432a8a783c8024))

## [3.15.3-beta.0](https://github.com/the-luap/picpeak/compare/v3.15.2-beta.0...v3.15.3-beta.0) (2026-03-02)


### Bug Fixes

* issue [#203](https://github.com/the-luap/picpeak/issues/203) file type validation + security CVE fixes ([8017171](https://github.com/the-luap/picpeak/commit/80171713e0ffedda56f7cffb403b25a8d55634d1))
* respect allowed_file_types setting for upload validation ([#203](https://github.com/the-luap/picpeak/issues/203)) ([fe07a14](https://github.com/the-luap/picpeak/commit/fe07a148f1d998c0be00377c1f8b4eca3908305c))
* **security:** resolve all npm audit vulnerabilities ([4272618](https://github.com/the-luap/picpeak/commit/4272618b3f7fcb06aaca14fb724a6a7733251f24))
* **security:** resolve Docker image CVEs for code scanning alerts ([cbecb93](https://github.com/the-luap/picpeak/commit/cbecb9323cf4b80c800326de14f6df73f60147c1))

## [2.6.0](https://github.com/the-luap/picpeak/compare/v2.5.1...v2.6.0) (2026-03-11)


### Features

* add configurable upload batch size for reverse proxy compatibility ([#208](https://github.com/the-luap/picpeak/issues/208)) ([02a46e0](https://github.com/the-luap/picpeak/commit/02a46e083d68cfdb355b5a4fe4a8da7d667050b9))
* configurable upload batch size for reverse proxy compatibility ([4243363](https://github.com/the-luap/picpeak/commit/424336340bef8e1629490ade154f0ceebb2a71e1))


### Bug Fixes

* video upload media type, select all, and dimension repair ([#203](https://github.com/the-luap/picpeak/issues/203), [#220](https://github.com/the-luap/picpeak/issues/220), [#180](https://github.com/the-luap/picpeak/issues/180)) ([fc75bcd](https://github.com/the-luap/picpeak/commit/fc75bcdfc38673d6e4dd1cd943cfb4638d3a306c))
* video upload, select all, and dimension repair ([#203](https://github.com/the-luap/picpeak/issues/203), [#220](https://github.com/the-luap/picpeak/issues/220), [#180](https://github.com/the-luap/picpeak/issues/180)) ([a0bb080](https://github.com/the-luap/picpeak/commit/a0bb0805868e742f323b64312c3c5ef8ec408f68))

## [2.5.1](https://github.com/the-luap/picpeak/compare/v2.5.0...v2.5.1) (2026-02-22)


### Bug Fixes

* resolve issues [#194](https://github.com/the-luap/picpeak/issues/194), [#195](https://github.com/the-luap/picpeak/issues/195), [#196](https://github.com/the-luap/picpeak/issues/196), [#197](https://github.com/the-luap/picpeak/issues/197) ([33af088](https://github.com/the-luap/picpeak/commit/33af0885607799e0071e2e74a582c7eb396c9b83))
* resolve issues [#194](https://github.com/the-luap/picpeak/issues/194), [#195](https://github.com/the-luap/picpeak/issues/195), [#196](https://github.com/the-luap/picpeak/issues/196), [#197](https://github.com/the-luap/picpeak/issues/197) ([33483cf](https://github.com/the-luap/picpeak/commit/33483cf32dfae57f8da51c0765353792239135f9))

## [2.5.0](https://github.com/the-luap/picpeak/compare/v2.4.0...v2.5.0) (2026-02-21)


### Features

* add admin dark mode and SEO/robots.txt settings ([9c2a0d2](https://github.com/the-luap/picpeak/commit/9c2a0d272a21dfcace2ec795034e2f1adcba47e0))
* add bulk category editing for photos ([#157](https://github.com/the-luap/picpeak/issues/157)) ([eca36c7](https://github.com/the-luap/picpeak/commit/eca36c70a23f18f937a9f5bddeff855e18f364c3))
* add category hero/cover photo selection ([#163](https://github.com/the-luap/picpeak/issues/163)) ([6c30e2c](https://github.com/the-luap/picpeak/commit/6c30e2c2edd19a24d4f30a9558690bb7e2331b32))
* add customizable event types with admin management ([f8881d5](https://github.com/the-luap/picpeak/commit/f8881d5bd62d449fb40917ec8c20f0eb16c1fdad))
* add Gallery Premium and Gallery Story layouts (Beta) ([e179def](https://github.com/the-luap/picpeak/commit/e179def3cceefe5fd6acd5574f2986e4f9e223ef))
* add hero image focal point picker with anchor positioning ([#162](https://github.com/the-luap/picpeak/issues/162)) ([734868a](https://github.com/the-luap/picpeak/commit/734868abc23731b0ac9ad73e799194df1e6aa6ab))
* add justified layout modes and aspect-ratio-aware mosaic ([#146](https://github.com/the-luap/picpeak/issues/146)) ([608bbd5](https://github.com/the-luap/picpeak/commit/608bbd50e7b31d49c7516a00e96f284fa16e2777))
* Add justified layout modes and aspect-ratio-aware mosaic ([#146](https://github.com/the-luap/picpeak/issues/146)) ([ef2ae00](https://github.com/the-luap/picpeak/commit/ef2ae00ff20b754c2f2ed797e18c146d12d7f31a))
* add justified/rows layout mode to masonry gallery ([#146](https://github.com/the-luap/picpeak/issues/146)) ([e081b56](https://github.com/the-luap/picpeak/commit/e081b56a44bf9fdaa3dd225d5dd4dde35bfe83d3))
* add justified/rows layout mode to masonry gallery ([#146](https://github.com/the-luap/picpeak/issues/146)) + security fixes ([cd1d504](https://github.com/the-luap/picpeak/commit/cd1d50474f673b759c2f9401fdbe209a84773e39))
* add optional event date and expiration settings ([3079eaa](https://github.com/the-luap/picpeak/commit/3079eaa2e5d1728c2c0f315626cc253e4b08edc2))
* add optional event date and expiration settings ([2151147](https://github.com/the-luap/picpeak/commit/2151147f2d3134448ff32130da44678e2942d73c)), closes [#118](https://github.com/the-luap/picpeak/issues/118)
* add original filename preservation and Lightroom export support ([a59f414](https://github.com/the-luap/picpeak/commit/a59f41463f960a3a74ce3933dc7db84ee3a2018d))
* add original filename preservation and Lightroom export support ([9872ad3](https://github.com/the-luap/picpeak/commit/9872ad3aef6488b359c5499a6dc3d8bfbfa48fde))
* add per-event custom logo upload with bug fixes ([85170b8](https://github.com/the-luap/picpeak/commit/85170b883f504d83f1d862abb3f4e46741074826))
* add per-event hero logo customization options ([0790a1d](https://github.com/the-luap/picpeak/commit/0790a1ddad774af89827a0a392e9fae0a945bff2))
* add quilted layout, fix mosaic, and backfill photo dimensions ([#146](https://github.com/the-luap/picpeak/issues/146)) ([46ed1bc](https://github.com/the-luap/picpeak/commit/46ed1bc276867a25b27bf22cd9b9d7e879a6947b))
* add update instructions dialog, email notifications, and capture date sorting ([50c0990](https://github.com/the-luap/picpeak/commit/50c09904a9434f988ab32a07da5d24db0e02065e)), closes [#181](https://github.com/the-luap/picpeak/issues/181)
* decouple hero header from gallery layouts ([#158](https://github.com/the-luap/picpeak/issues/158)) ([7b8d8bd](https://github.com/the-luap/picpeak/commit/7b8d8bd92ba7a96717bb4d821b38dddc395f701a))
* gallery layouts, bulk category editing, and hero header improvements ([7037106](https://github.com/the-luap/picpeak/commit/7037106bff62593bba600d898a781f79f07b459d))
* gallery layouts, hero customization, bulk categories & event types ([d9e00dc](https://github.com/the-luap/picpeak/commit/d9e00dc0dbd7cef0ddb4665e5306c98aac3573e3))
* gallery layouts, hero customization, event types, and UX improvements ([#146](https://github.com/the-luap/picpeak/issues/146), [#155](https://github.com/the-luap/picpeak/issues/155)-163, [#170](https://github.com/the-luap/picpeak/issues/170), [#171](https://github.com/the-luap/picpeak/issues/171)) ([4280444](https://github.com/the-luap/picpeak/commit/4280444d70e73db09e67e18ce25bac75cf499b75))
* improve gallery layouts with aspect-ratio-aware masonry and mosaic modes ([#146](https://github.com/the-luap/picpeak/issues/146)) ([aacfcd5](https://github.com/the-luap/picpeak/commit/aacfcd517ea5739e834cf84627b55b3449740a5c))
* improve hero image UX and live preview ([#163](https://github.com/the-luap/picpeak/issues/163), [#158](https://github.com/the-luap/picpeak/issues/158)) ([d63f67a](https://github.com/the-luap/picpeak/commit/d63f67a2afba1b92610382aa1012428ccacb86bd))
* new features and bug fixes for beta release ([151e1bf](https://github.com/the-luap/picpeak/commit/151e1bf50f206ae0571fa044c75b8bc9f0f40120))
* original filename in admin UI, update dialog, and security hardening ([3ea9d5b](https://github.com/the-luap/picpeak/commit/3ea9d5b1219980032cbee7a2564c0004948923f5))
* original filename in admin UI, update dialog, security hardening, and bug fixes ([bcf2745](https://github.com/the-luap/picpeak/commit/bcf2745ab64acb968ae4bd0710b28e78c14f340c))
* per-event custom logos, customizable event types, and multiple bug fixes ([4c08160](https://github.com/the-luap/picpeak/commit/4c081601e02888d7ad289acb7847aee9d6f5703f))
* pre-generate watermarks for instant lightbox loading ([1be974a](https://github.com/the-luap/picpeak/commit/1be974afbb0b7a1bdbdd140327771907a5d3c2ae)), closes [#112](https://github.com/the-luap/picpeak/issues/112)
* pre-generated watermarks and mobile upload button improvements ([c6fdd38](https://github.com/the-luap/picpeak/commit/c6fdd38e842e1a8c0aa9cbab9fc791e6669e402d))
* show original filename in admin UI ([#184](https://github.com/the-luap/picpeak/issues/184)) ([0891be1](https://github.com/the-luap/picpeak/commit/0891be197fdb7d92ade5a293b8db0bed26fa6e3a))
## [3.15.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.15.1-beta.0...v3.15.2-beta.0) (2026-02-22)


### Bug Fixes

* add allow_user_uploads to gallery API responses ([691e3ab](https://github.com/the-luap/picpeak/commit/691e3aba09f2148afe902a0bb0139d062634e669))
* add STORAGE_PATH to production docker-compose ([cdda709](https://github.com/the-luap/picpeak/commit/cdda70988664a177b351abc6a259ec39664d17ff))
* checkbox and toggle settings not persisting after page refresh ([808ed1d](https://github.com/the-luap/picpeak/commit/808ed1d2f1164d9fd1114586c68a1f925bf73ddf)), closes [#117](https://github.com/the-luap/picpeak/issues/117)
* correct invitation activation validation and add missing translations ([991aa98](https://github.com/the-luap/picpeak/commit/991aa98f98cffd1d7785c272726615325e2c0208)), closes [#129](https://github.com/the-luap/picpeak/issues/129)
* correct invitation email link URL path ([86fa104](https://github.com/the-luap/picpeak/commit/86fa1046d5439cb451feb164175c919c49ca219a)), closes [#129](https://github.com/the-luap/picpeak/issues/129)
* correct storage path resolution in multiple files ([#96](https://github.com/the-luap/picpeak/issues/96)) ([0e3674b](https://github.com/the-luap/picpeak/commit/0e3674b2b0325bbcee5aa2c9ff7781da92f612d1))
* correct storage path resolution in multiple files ([#96](https://github.com/the-luap/picpeak/issues/96)) ([3ccb815](https://github.com/the-luap/picpeak/commit/3ccb8154eb40a432aa467fb06b3f216fd0d2c6b4))
* docker compose v2 syntax and add missing ADMIN_PASSWORD to .env.example ([#189](https://github.com/the-luap/picpeak/issues/189)) ([0817443](https://github.com/the-luap/picpeak/commit/0817443e793e37c770c6a1968ecae4b9464107b0))
* event-specific custom CSS settings not being saved ([dadef81](https://github.com/the-luap/picpeak/commit/dadef81158972d28aa32812203500f77ed08a999)), closes [#136](https://github.com/the-luap/picpeak/issues/136)
* events without expiration date incorrectly shown as expired ([c4f16eb](https://github.com/the-luap/picpeak/commit/c4f16eb76c909158abdb63aa4cc22f817f274dc5))
* handle null dates in dashboard and gallery pages ([c5a8ffc](https://github.com/the-luap/picpeak/commit/c5a8ffc08cd4c53c37fe4fb9cde8519a68f1f343))
* hero header state and preview in admin theme editor ([#158](https://github.com/the-luap/picpeak/issues/158)) ([f554f46](https://github.com/the-luap/picpeak/commit/f554f463b3492346dba067c0980b52ef42dd5e70))
* improve ghost button visibility in admin dark mode ([4912e2b](https://github.com/the-luap/picpeak/commit/4912e2bccf282134d5598a8ac80942ed46d0523c))
* improve password validation errors and event list UX ([#170](https://github.com/the-luap/picpeak/issues/170), [#171](https://github.com/the-luap/picpeak/issues/171)) ([171abb3](https://github.com/the-luap/picpeak/commit/171abb31615484d77cf95a99cb5634afa0160adc))
* improve photo serving, category filters, and upload chunking ([#155](https://github.com/the-luap/picpeak/issues/155), [#156](https://github.com/the-luap/picpeak/issues/156), [#161](https://github.com/the-luap/picpeak/issues/161)) ([fa4c838](https://github.com/the-luap/picpeak/commit/fa4c83812d87cfa63394e51186e320a072929d37))
* increase upload limit to 1GB and fix category filters ([#155](https://github.com/the-luap/picpeak/issues/155), [#156](https://github.com/the-luap/picpeak/issues/156)) ([397d33a](https://github.com/the-luap/picpeak/commit/397d33a95a09e0b0986c3f6cf5965c544992a764))
* mobile upload button not visible in gallery ([#113](https://github.com/the-luap/picpeak/issues/113)) ([cacaffa](https://github.com/the-luap/picpeak/commit/cacaffa5c39f67105c4cfb092ea62157121fb72e))
* mobile upload button visibility in gallery ([2a2c23d](https://github.com/the-luap/picpeak/commit/2a2c23d11610e6c81684163eb4ea934a6d6104fb)), closes [#113](https://github.com/the-luap/picpeak/issues/113)
* mobile upload button visibility in gallery ([df7dbff](https://github.com/the-luap/picpeak/commit/df7dbffbffb180e62af0d2b58326f9de0f515439)), closes [#113](https://github.com/the-luap/picpeak/issues/113)
* mobile upload button visibility in gallery ([#113](https://github.com/the-luap/picpeak/issues/113)) ([05a5307](https://github.com/the-luap/picpeak/commit/05a5307e22dc45be4b75b2996ff9fac65dec399d))
* mobile upload button visibility in gallery ([#113](https://github.com/the-luap/picpeak/issues/113)) ([6cb4342](https://github.com/the-luap/picpeak/commit/6cb43428d1e703267edeacda9ede050a8c4f8e0c))
* remove non-functional watermark toggle from Feature Toggles ([d4a15db](https://github.com/the-luap/picpeak/commit/d4a15dbe74d0d70bbe6ff03362dc7337fb8f4c5c))
* render minimal/none header styles, cap hero height, switch category hero images ([#158](https://github.com/the-luap/picpeak/issues/158), [#162](https://github.com/the-luap/picpeak/issues/162), [#163](https://github.com/the-luap/picpeak/issues/163)) ([bc6c48b](https://github.com/the-luap/picpeak/commit/bc6c48bb2429505c2de3641693a8ff4f623a4951))
* resend gallery email fails for events without password ([6b3ead7](https://github.com/the-luap/picpeak/commit/6b3ead747b1395d8ea2b3d135a5ac24db05e2eb8)), closes [#137](https://github.com/the-luap/picpeak/issues/137)
* resolve admin invitation flow issues and improve STORAGE_PATH documentation ([41bf6ff](https://github.com/the-luap/picpeak/commit/41bf6ff884d5ef3181f95f3aa4a528434c23947a))
* resolve code quality issues and add missing i18n keys ([#162](https://github.com/the-luap/picpeak/issues/162), [#163](https://github.com/the-luap/picpeak/issues/163)) ([329d224](https://github.com/the-luap/picpeak/commit/329d224846d3f4eefa31e42337f34047c267d578))
* resolve mixed light/dark mode styling in admin UI ([#175](https://github.com/the-luap/picpeak/issues/175)) ([f8c8abd](https://github.com/the-luap/picpeak/commit/f8c8abd70bbae35d6cd519894624ade33b5115a8))
* restore aspect-ratio layouts and improve hero image quality ([#180](https://github.com/the-luap/picpeak/issues/180)) ([3974ba5](https://github.com/the-luap/picpeak/commit/3974ba5de5a6605ad906608d3e4d61620a215059))
* restore aspect-ratio layouts and improve hero image quality ([#180](https://github.com/the-luap/picpeak/issues/180)) ([5cef7fd](https://github.com/the-luap/picpeak/commit/5cef7fdd188389512bc4b55ae61536c8b1219eb8))
* show upload button in mobile topbar instead of sidebar ([ae181cf](https://github.com/the-luap/picpeak/commit/ae181cf92fc9c1e85cad7a7b843a4d83cec636ac)), closes [#113](https://github.com/the-luap/picpeak/issues/113)
* sync header_style DB column with theme editor selections ([#158](https://github.com/the-luap/picpeak/issues/158)) ([2288309](https://github.com/the-luap/picpeak/commit/228830939553fd32c250704bb89a8ce233324d25))
* sync header_style DB column with theme editor selections ([#158](https://github.com/the-luap/picpeak/issues/158)) ([a19e7c4](https://github.com/the-luap/picpeak/commit/a19e7c40a200ff822c947a83349ed07ccf4e1b01))
* update docker-compose to docker compose and add ADMIN_PASSWORD to .env.example ([#189](https://github.com/the-luap/picpeak/issues/189)) ([a4c6248](https://github.com/the-luap/picpeak/commit/a4c624802b2926a16adcf0472a3041562f9b2f48))
* update packages to fix security vulnerabilities ([8097a0c](https://github.com/the-luap/picpeak/commit/8097a0cb530bd8003597cde81606231efadb0bf5))
* use actual photo aspect ratios in masonry columns mode ([#146](https://github.com/the-luap/picpeak/issues/146)) ([8711f96](https://github.com/the-luap/picpeak/commit/8711f967a15f5d57f6ad01bfdbd8d33f9ee96abc))
* use CSS Columns for gap-free mosaic layout ([#146](https://github.com/the-luap/picpeak/issues/146)) ([821d329](https://github.com/the-luap/picpeak/commit/821d3296ea4b6bde499e5497d258f15ab8dd1dbc))
* use photo dimensions for mosaic aspect ratios ([#146](https://github.com/the-luap/picpeak/issues/146)) ([27ff51e](https://github.com/the-luap/picpeak/commit/27ff51e7a1217848859b47940bc88caa6f1fb20f))


### Documentation

* add API_URL environment variable to .env.example files ([3e69579](https://github.com/the-luap/picpeak/commit/3e69579f5a171b31a253b2a42bb033bf1b97387d))
* emphasize importance of STORAGE_PATH in env example ([3397807](https://github.com/the-luap/picpeak/commit/3397807670784e02cbe34a7a60db43c95d64f19c))
* resolve issues [#194](https://github.com/the-luap/picpeak/issues/194), [#195](https://github.com/the-luap/picpeak/issues/195), [#196](https://github.com/the-luap/picpeak/issues/196), [#197](https://github.com/the-luap/picpeak/issues/197) ([5ea4ef3](https://github.com/the-luap/picpeak/commit/5ea4ef3cf36b06f9e6c9108f80bfe2e9a6470898))
* resolve issues [#194](https://github.com/the-luap/picpeak/issues/194), [#195](https://github.com/the-luap/picpeak/issues/195), [#196](https://github.com/the-luap/picpeak/issues/196), [#197](https://github.com/the-luap/picpeak/issues/197) ([cd00bc1](https://github.com/the-luap/picpeak/commit/cd00bc13d4e02a86a0f1742ed1f11f064614b8da))

## [3.15.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.15.0-beta.0...v3.15.1-beta.0) (2026-02-21)


### Bug Fixes

* docker compose v2 syntax and add missing ADMIN_PASSWORD to .env.example ([#189](https://github.com/the-luap/picpeak/issues/189)) ([0817443](https://github.com/the-luap/picpeak/commit/0817443e793e37c770c6a1968ecae4b9464107b0))
* update docker-compose to docker compose and add ADMIN_PASSWORD to .env.example ([#189](https://github.com/the-luap/picpeak/issues/189)) ([a4c6248](https://github.com/the-luap/picpeak/commit/a4c624802b2926a16adcf0472a3041562f9b2f48))

## [3.15.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.14.0-beta.0...v3.15.0-beta.0) (2026-02-17)


### Features

* original filename in admin UI, update dialog, security hardening, and bug fixes ([bcf2745](https://github.com/the-luap/picpeak/commit/bcf2745ab64acb968ae4bd0710b28e78c14f340c))


### Bug Fixes

* events without expiration date incorrectly shown as expired ([c4f16eb](https://github.com/the-luap/picpeak/commit/c4f16eb76c909158abdb63aa4cc22f817f274dc5))

## [3.14.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.13.1-beta.0...v3.14.0-beta.0) (2026-02-17)


### Features

* add update instructions dialog, email notifications, and capture date sorting ([50c0990](https://github.com/the-luap/picpeak/commit/50c09904a9434f988ab32a07da5d24db0e02065e)), closes [#181](https://github.com/the-luap/picpeak/issues/181)
* original filename in admin UI, update dialog, and security hardening ([3ea9d5b](https://github.com/the-luap/picpeak/commit/3ea9d5b1219980032cbee7a2564c0004948923f5))
* show original filename in admin UI ([#184](https://github.com/the-luap/picpeak/issues/184)) ([0891be1](https://github.com/the-luap/picpeak/commit/0891be197fdb7d92ade5a293b8db0bed26fa6e3a))

## [3.13.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.13.0-beta.0...v3.13.1-beta.0) (2026-02-15)


### Bug Fixes

* restore aspect-ratio layouts and improve hero image quality ([#180](https://github.com/the-luap/picpeak/issues/180)) ([3974ba5](https://github.com/the-luap/picpeak/commit/3974ba5de5a6605ad906608d3e4d61620a215059))
* restore aspect-ratio layouts and improve hero image quality ([#180](https://github.com/the-luap/picpeak/issues/180)) ([5cef7fd](https://github.com/the-luap/picpeak/commit/5cef7fdd188389512bc4b55ae61536c8b1219eb8))

## [3.13.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.12.0-beta.0...v3.13.0-beta.0) (2026-02-06)


### Features

* improve hero image UX and live preview ([#163](https://github.com/the-luap/picpeak/issues/163), [#158](https://github.com/the-luap/picpeak/issues/158)) ([d63f67a](https://github.com/the-luap/picpeak/commit/d63f67a2afba1b92610382aa1012428ccacb86bd))

## [3.12.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.11.0-beta.0...v3.12.0-beta.0) (2026-02-06)


### Features

* add admin dark mode and SEO/robots.txt settings ([9c2a0d2](https://github.com/the-luap/picpeak/commit/9c2a0d272a21dfcace2ec795034e2f1adcba47e0))


### Bug Fixes

* improve ghost button visibility in admin dark mode ([4912e2b](https://github.com/the-luap/picpeak/commit/4912e2bccf282134d5598a8ac80942ed46d0523c))
* resolve mixed light/dark mode styling in admin UI ([#175](https://github.com/the-luap/picpeak/issues/175)) ([f8c8abd](https://github.com/the-luap/picpeak/commit/f8c8abd70bbae35d6cd519894624ade33b5115a8))

## [3.11.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.10.1-beta.0...v3.11.0-beta.0) (2026-02-06)


### Features

* add Gallery Premium and Gallery Story layouts (Beta) ([e179def](https://github.com/the-luap/picpeak/commit/e179def3cceefe5fd6acd5574f2986e4f9e223ef))
* gallery layouts, hero customization, event types, and UX improvements ([#146](https://github.com/the-luap/picpeak/issues/146), [#155](https://github.com/the-luap/picpeak/issues/155)-163, [#170](https://github.com/the-luap/picpeak/issues/170), [#171](https://github.com/the-luap/picpeak/issues/171)) ([4280444](https://github.com/the-luap/picpeak/commit/4280444d70e73db09e67e18ce25bac75cf499b75))


### Bug Fixes

* improve password validation errors and event list UX ([#170](https://github.com/the-luap/picpeak/issues/170), [#171](https://github.com/the-luap/picpeak/issues/171)) ([171abb3](https://github.com/the-luap/picpeak/commit/171abb31615484d77cf95a99cb5634afa0160adc))
* render minimal/none header styles, cap hero height, switch category hero images ([#158](https://github.com/the-luap/picpeak/issues/158), [#162](https://github.com/the-luap/picpeak/issues/162), [#163](https://github.com/the-luap/picpeak/issues/163)) ([bc6c48b](https://github.com/the-luap/picpeak/commit/bc6c48bb2429505c2de3641693a8ff4f623a4951))

## [3.10.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.10.0-beta.0...v3.10.1-beta.0) (2026-02-03)


### Bug Fixes

* sync header_style DB column with theme editor selections ([#158](https://github.com/the-luap/picpeak/issues/158)) ([2288309](https://github.com/the-luap/picpeak/commit/228830939553fd32c250704bb89a8ce233324d25))
* sync header_style DB column with theme editor selections ([#158](https://github.com/the-luap/picpeak/issues/158)) ([a19e7c4](https://github.com/the-luap/picpeak/commit/a19e7c40a200ff822c947a83349ed07ccf4e1b01))

## [3.10.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.9.0-beta.0...v3.10.0-beta.0) (2026-02-03)


### Features

* add category hero/cover photo selection ([#163](https://github.com/the-luap/picpeak/issues/163)) ([6c30e2c](https://github.com/the-luap/picpeak/commit/6c30e2c2edd19a24d4f30a9558690bb7e2331b32))
* add hero image focal point picker with anchor positioning ([#162](https://github.com/the-luap/picpeak/issues/162)) ([734868a](https://github.com/the-luap/picpeak/commit/734868abc23731b0ac9ad73e799194df1e6aa6ab))
* gallery layouts, hero customization, bulk categories & event types ([d9e00dc](https://github.com/the-luap/picpeak/commit/d9e00dc0dbd7cef0ddb4665e5306c98aac3573e3))


### Bug Fixes

* hero header state and preview in admin theme editor ([#158](https://github.com/the-luap/picpeak/issues/158)) ([f554f46](https://github.com/the-luap/picpeak/commit/f554f463b3492346dba067c0980b52ef42dd5e70))
* improve photo serving, category filters, and upload chunking ([#155](https://github.com/the-luap/picpeak/issues/155), [#156](https://github.com/the-luap/picpeak/issues/156), [#161](https://github.com/the-luap/picpeak/issues/161)) ([fa4c838](https://github.com/the-luap/picpeak/commit/fa4c83812d87cfa63394e51186e320a072929d37))
* resolve code quality issues and add missing i18n keys ([#162](https://github.com/the-luap/picpeak/issues/162), [#163](https://github.com/the-luap/picpeak/issues/163)) ([329d224](https://github.com/the-luap/picpeak/commit/329d224846d3f4eefa31e42337f34047c267d578))

## [3.9.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.8.0-beta.0...v3.9.0-beta.0) (2026-02-01)


### Features

* add bulk category editing for photos ([#157](https://github.com/the-luap/picpeak/issues/157)) ([eca36c7](https://github.com/the-luap/picpeak/commit/eca36c70a23f18f937a9f5bddeff855e18f364c3))
* decouple hero header from gallery layouts ([#158](https://github.com/the-luap/picpeak/issues/158)) ([7b8d8bd](https://github.com/the-luap/picpeak/commit/7b8d8bd92ba7a96717bb4d821b38dddc395f701a))
* gallery layouts, bulk category editing, and hero header improvements ([7037106](https://github.com/the-luap/picpeak/commit/7037106bff62593bba600d898a781f79f07b459d))


### Bug Fixes

* increase upload limit to 1GB and fix category filters ([#155](https://github.com/the-luap/picpeak/issues/155), [#156](https://github.com/the-luap/picpeak/issues/156)) ([397d33a](https://github.com/the-luap/picpeak/commit/397d33a95a09e0b0986c3f6cf5965c544992a764))

## [3.8.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.7.0-beta.0...v3.8.0-beta.0) (2026-01-30)


### Features

* add quilted layout, fix mosaic, and backfill photo dimensions ([#146](https://github.com/the-luap/picpeak/issues/146)) ([46ed1bc](https://github.com/the-luap/picpeak/commit/46ed1bc276867a25b27bf22cd9b9d7e879a6947b))
* improve gallery layouts with aspect-ratio-aware masonry and mosaic modes ([#146](https://github.com/the-luap/picpeak/issues/146)) ([aacfcd5](https://github.com/the-luap/picpeak/commit/aacfcd517ea5739e834cf84627b55b3449740a5c))


### Bug Fixes

* use actual photo aspect ratios in masonry columns mode ([#146](https://github.com/the-luap/picpeak/issues/146)) ([8711f96](https://github.com/the-luap/picpeak/commit/8711f967a15f5d57f6ad01bfdbd8d33f9ee96abc))
* use CSS Columns for gap-free mosaic layout ([#146](https://github.com/the-luap/picpeak/issues/146)) ([821d329](https://github.com/the-luap/picpeak/commit/821d3296ea4b6bde499e5497d258f15ab8dd1dbc))
* use photo dimensions for mosaic aspect ratios ([#146](https://github.com/the-luap/picpeak/issues/146)) ([27ff51e](https://github.com/the-luap/picpeak/commit/27ff51e7a1217848859b47940bc88caa6f1fb20f))

## [3.7.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.6.0-beta.0...v3.7.0-beta.0) (2026-01-28)


### Features

* add justified layout modes and aspect-ratio-aware mosaic ([#146](https://github.com/the-luap/picpeak/issues/146)) ([608bbd5](https://github.com/the-luap/picpeak/commit/608bbd50e7b31d49c7516a00e96f284fa16e2777))
* Add justified layout modes and aspect-ratio-aware mosaic ([#146](https://github.com/the-luap/picpeak/issues/146)) ([ef2ae00](https://github.com/the-luap/picpeak/commit/ef2ae00ff20b754c2f2ed797e18c146d12d7f31a))

## [3.6.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.5.0-beta.0...v3.6.0-beta.0) (2026-01-27)


### Features

* add justified/rows layout mode to masonry gallery ([#146](https://github.com/the-luap/picpeak/issues/146)) ([e081b56](https://github.com/the-luap/picpeak/commit/e081b56a44bf9fdaa3dd225d5dd4dde35bfe83d3))
* add justified/rows layout mode to masonry gallery ([#146](https://github.com/the-luap/picpeak/issues/146)) + security fixes ([cd1d504](https://github.com/the-luap/picpeak/commit/cd1d50474f673b759c2f9401fdbe209a84773e39))


### Bug Fixes

* update packages to fix security vulnerabilities ([8097a0c](https://github.com/the-luap/picpeak/commit/8097a0cb530bd8003597cde81606231efadb0bf5))

## [3.5.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.4.0-beta.0...v3.5.0-beta.0) (2026-01-25)


### Features

* add per-event custom logo upload with bug fixes ([85170b8](https://github.com/the-luap/picpeak/commit/85170b883f504d83f1d862abb3f4e46741074826))
* per-event custom logos, customizable event types, and multiple bug fixes ([4c08160](https://github.com/the-luap/picpeak/commit/4c081601e02888d7ad289acb7847aee9d6f5703f))

## [3.4.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.3.0-beta.0...v3.4.0-beta.0) (2026-01-22)


### Features

* add customizable event types with admin management ([f8881d5](https://github.com/the-luap/picpeak/commit/f8881d5bd62d449fb40917ec8c20f0eb16c1fdad))
* add per-event hero logo customization options ([0790a1d](https://github.com/the-luap/picpeak/commit/0790a1ddad774af89827a0a392e9fae0a945bff2))
* new features and bug fixes for beta release ([151e1bf](https://github.com/the-luap/picpeak/commit/151e1bf50f206ae0571fa044c75b8bc9f0f40120))


### Bug Fixes

* event-specific custom CSS settings not being saved ([dadef81](https://github.com/the-luap/picpeak/commit/dadef81158972d28aa32812203500f77ed08a999)), closes [#136](https://github.com/the-luap/picpeak/issues/136)
* handle null dates in dashboard and gallery pages ([c5a8ffc](https://github.com/the-luap/picpeak/commit/c5a8ffc08cd4c53c37fe4fb9cde8519a68f1f343))
* remove non-functional watermark toggle from Feature Toggles ([d4a15db](https://github.com/the-luap/picpeak/commit/d4a15dbe74d0d70bbe6ff03362dc7337fb8f4c5c))
* resend gallery email fails for events without password ([6b3ead7](https://github.com/the-luap/picpeak/commit/6b3ead747b1395d8ea2b3d135a5ac24db05e2eb8)), closes [#137](https://github.com/the-luap/picpeak/issues/137)

## [3.3.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.2.5-beta.0...v3.3.0-beta.0) (2026-01-21)


### Features

* add original filename preservation and Lightroom export support ([a59f414](https://github.com/the-luap/picpeak/commit/a59f41463f960a3a74ce3933dc7db84ee3a2018d))
* add original filename preservation and Lightroom export support ([9872ad3](https://github.com/the-luap/picpeak/commit/9872ad3aef6488b359c5499a6dc3d8bfbfa48fde))

## [3.2.5-beta.0](https://github.com/the-luap/picpeak/compare/v3.2.4-beta.0...v3.2.5-beta.0) (2026-01-18)


### Bug Fixes

* add STORAGE_PATH to production docker-compose ([cdda709](https://github.com/the-luap/picpeak/commit/cdda70988664a177b351abc6a259ec39664d17ff))
* correct invitation activation validation and add missing translations ([991aa98](https://github.com/the-luap/picpeak/commit/991aa98f98cffd1d7785c272726615325e2c0208)), closes [#129](https://github.com/the-luap/picpeak/issues/129)
* correct invitation email link URL path ([86fa104](https://github.com/the-luap/picpeak/commit/86fa1046d5439cb451feb164175c919c49ca219a)), closes [#129](https://github.com/the-luap/picpeak/issues/129)
* resolve admin invitation flow issues and improve STORAGE_PATH documentation ([41bf6ff](https://github.com/the-luap/picpeak/commit/41bf6ff884d5ef3181f95f3aa4a528434c23947a))


### Documentation

* emphasize importance of STORAGE_PATH in env example ([3397807](https://github.com/the-luap/picpeak/commit/3397807670784e02cbe34a7a60db43c95d64f19c))

## [3.2.4-beta.0](https://github.com/the-luap/picpeak/compare/v3.2.3-beta.0...v3.2.4-beta.0) (2026-01-17)


### Bug Fixes

* correct storage path resolution in multiple files ([#96](https://github.com/the-luap/picpeak/issues/96)) ([0e3674b](https://github.com/the-luap/picpeak/commit/0e3674b2b0325bbcee5aa2c9ff7781da92f612d1))
* correct storage path resolution in multiple files ([#96](https://github.com/the-luap/picpeak/issues/96)) ([3ccb815](https://github.com/the-luap/picpeak/commit/3ccb8154eb40a432aa467fb06b3f216fd0d2c6b4))

## [3.2.3-beta.0](https://github.com/the-luap/picpeak/compare/v3.2.2-beta.0...v3.2.3-beta.0) (2026-01-16)


### Bug Fixes

* add allow_user_uploads to gallery API responses ([691e3ab](https://github.com/the-luap/picpeak/commit/691e3aba09f2148afe902a0bb0139d062634e669))
* mobile upload button not visible in gallery ([#113](https://github.com/the-luap/picpeak/issues/113)) ([cacaffa](https://github.com/the-luap/picpeak/commit/cacaffa5c39f67105c4cfb092ea62157121fb72e))

## [3.2.2-beta.0](https://github.com/the-luap/picpeak/compare/v3.2.1-beta.0...v3.2.2-beta.0) (2026-01-16)


### Bug Fixes

* mobile upload button visibility in gallery ([2a2c23d](https://github.com/the-luap/picpeak/commit/2a2c23d11610e6c81684163eb4ea934a6d6104fb)), closes [#113](https://github.com/the-luap/picpeak/issues/113)
* mobile upload button visibility in gallery ([#113](https://github.com/the-luap/picpeak/issues/113)) ([05a5307](https://github.com/the-luap/picpeak/commit/05a5307e22dc45be4b75b2996ff9fac65dec399d))

## [3.2.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.2.0-beta.0...v3.2.1-beta.0) (2026-01-16)


### Bug Fixes

* mobile upload button visibility in gallery ([df7dbff](https://github.com/the-luap/picpeak/commit/df7dbffbffb180e62af0d2b58326f9de0f515439)), closes [#113](https://github.com/the-luap/picpeak/issues/113)
* mobile upload button visibility in gallery ([#113](https://github.com/the-luap/picpeak/issues/113)) ([6cb4342](https://github.com/the-luap/picpeak/commit/6cb43428d1e703267edeacda9ede050a8c4f8e0c))

## [3.2.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.1.0-beta.0...v3.2.0-beta.0) (2026-01-16)


### Features

* add optional event date and expiration settings ([3079eaa](https://github.com/the-luap/picpeak/commit/3079eaa2e5d1728c2c0f315626cc253e4b08edc2))
* add optional event date and expiration settings ([2151147](https://github.com/the-luap/picpeak/commit/2151147f2d3134448ff32130da44678e2942d73c)), closes [#118](https://github.com/the-luap/picpeak/issues/118)


### Bug Fixes

* checkbox and toggle settings not persisting after page refresh ([808ed1d](https://github.com/the-luap/picpeak/commit/808ed1d2f1164d9fd1114586c68a1f925bf73ddf)), closes [#117](https://github.com/the-luap/picpeak/issues/117)


### Documentation

* add API_URL environment variable to .env.example files ([3e69579](https://github.com/the-luap/picpeak/commit/3e69579f5a171b31a253b2a42bb033bf1b97387d))

## [3.1.0-beta.0](https://github.com/the-luap/picpeak/compare/v3.0.1-beta.0...v3.1.0-beta.0) (2026-01-15)


### Features

* dynamic website title from branding settings ([d29aab7](https://github.com/the-luap/picpeak/commit/d29aab7c70c5777451666fb7d5c7a9729dab684a))
* pre-generate watermarks for instant lightbox loading ([1be974a](https://github.com/the-luap/picpeak/commit/1be974afbb0b7a1bdbdd140327771907a5d3c2ae)), closes [#112](https://github.com/the-luap/picpeak/issues/112)
* pre-generated watermarks and mobile upload button improvements ([c6fdd38](https://github.com/the-luap/picpeak/commit/c6fdd38e842e1a8c0aa9cbab9fc791e6669e402d))


### Bug Fixes

* add lightbox loading spinner and watermark cache invalidation ([050ed37](https://github.com/the-luap/picpeak/commit/050ed378199eb3b15c7c7f243792f68f858803f5))
* lightbox watermark loading, white label translations, and dynamic footer year ([ce8587b](https://github.com/the-luap/picpeak/commit/ce8587b24df3f53a11a74348eff8b5c5b96c5488))
* prevent database migration restart failures ([83a4344](https://github.com/the-luap/picpeak/commit/83a4344a01de4f65c5024fdf2d177a04457ccd2f)), closes [#107](https://github.com/the-luap/picpeak/issues/107)
* show upload button in mobile topbar instead of sidebar ([ae181cf](https://github.com/the-luap/picpeak/commit/ae181cf92fc9c1e85cad7a7b843a4d83cec636ac)), closes [#113](https://github.com/the-luap/picpeak/issues/113)
* watermark thumbnails, custom logo display, and German translations ([ea20446](https://github.com/the-luap/picpeak/commit/ea20446a797a00cf45dbe7bf6f06574a79c4d8a6))

## [3.0.1-beta.0](https://github.com/the-luap/picpeak/compare/v3.0.0-beta.0...v3.0.1-beta.0) (2026-01-15)


### Bug Fixes

* CI workflow fixes for protected branches ([cb01218](https://github.com/the-luap/picpeak/commit/cb012186d93403a1ac4e2d2f5283319603b290d6))
* lightbox watermark loading, white label translations, and dynamic footer year ([3b720ed](https://github.com/the-luap/picpeak/commit/3b720ed56ecd2ded6aec57309f8c408c63a617ef))
* lightbox watermark loading, white label translations, and dynamic footer year ([ce8587b](https://github.com/the-luap/picpeak/commit/ce8587b24df3f53a11a74348eff8b5c5b96c5488))
* lightbox watermark loading, white label translations, and dynamic footer year ([#108](https://github.com/the-luap/picpeak/issues/108)) ([3b720ed](https://github.com/the-luap/picpeak/commit/3b720ed56ecd2ded6aec57309f8c408c63a617ef))

## [2.3.2](https://github.com/the-luap/picpeak/compare/v2.3.1...v2.3.2) (2026-01-15)


### Bug Fixes

* watermark thumbnails, custom logo display, and German translations ([f843e4c](https://github.com/the-luap/picpeak/commit/f843e4c25cef02eef354fd3ee25824e20e4f8fc8))
* watermark thumbnails, custom logo display, and German translations ([ea20446](https://github.com/the-luap/picpeak/commit/ea20446a797a00cf45dbe7bf6f06574a79c4d8a6))

## [2.3.1](https://github.com/the-luap/picpeak/compare/v2.3.0...v2.3.1) (2026-01-15)


### Bug Fixes

* CI workflow fixes for protected branches ([657c205](https://github.com/the-luap/picpeak/commit/657c205a4d8ca49070b69973f4c7a3d1418633af))
* use Release Please extra-files instead of sync-versions job ([fe7d45d](https://github.com/the-luap/picpeak/commit/fe7d45dd122b2dca1b2a21ba5c86d32b9a193074))

## [3.0.0-beta.0](https://github.com/the-luap/picpeak/compare/v2.3.0-beta.0...v3.0.0-beta.0) (2026-01-15)


### ⚠ BREAKING CHANGES

* Deployment now requires external reverse proxy for SSL/HTTPS

### Features

* add Apple Liquid Glass templates, image security settings, and automated releases ([6033461](https://github.com/the-luap/picpeak/commit/6033461be118ce78277ec568e1ef1ceeff7311c8))
* add complete translation support for backup admin page ([e9f92e6](https://github.com/the-luap/picpeak/commit/e9f92e66d08ac7001c31a3ee8f43ee8306bc79a9))
* Add CSS template system with custom gallery styling support ([0da45e6](https://github.com/the-luap/picpeak/commit/0da45e699ad998031aa56a92f2da5ee61a04e285))
* add event management, gallery customization, and release automationFeature/event rename ([40ee671](https://github.com/the-luap/picpeak/commit/40ee67171d41522037bf9d4e7675b62ec564346d))
* add feedback management enhancements ([0064122](https://github.com/the-luap/picpeak/commit/0064122eff12029300ab7f95078b5710c3c2d08c))
* add GitHub Actions workflow for Docker image builds ([4029559](https://github.com/the-luap/picpeak/commit/40295599547b86af7fea3359c7486918d2cd0236))
* add multi-administrator support with RBAC and fix backup/restore for S3 ([892e47d](https://github.com/the-luap/picpeak/commit/892e47d017064d7922536f8e138bbb290a45cdc9))
* **admin:** external media import modal + thumbnail fixes for reference events\n\n- Photos tab: replace inline external folder picker with a modal opened via "Import from External Folder" button next to "Upload Photos"; add info that all pictures in the selected folder will be imported.\n- Admin thumbnails: align list endpoint to /api/admin/photos/:eventId/photos and always return thumbnail_url to trigger on-demand generation; normalize external paths to avoid duplicated folder segments (e.g., individual/individual) that broke resolver; improve thumbnail logging.\n- Use authenticated image fetching on admin feedback pages to prevent 401s in automation.\n- i18n: add backup.external.warning strings; complete German backup/restore coverage; add common keys (notSet, of, up, select, selected).\n- Docs: add Local (npm) setup for EXTERNAL_MEDIA_ROOT in deployment guide.\n\nRefs [#17](https://github.com/the-luap/picpeak/issues/17) – gallery feature request: https://github.com/the-luap/picpeak/issues/17 ([49c7778](https://github.com/the-luap/picpeak/commit/49c77785e7a776890f15c0c541dcd18b74a86c6e))
* **admin:** refine header layout and logo placement ([d64e7d0](https://github.com/the-luap/picpeak/commit/d64e7d08deae7ad1b6f744f447fe546115427942))
* allow admin email updates in UI ([#36](https://github.com/the-luap/picpeak/issues/36)) ([3c2a79a](https://github.com/the-luap/picpeak/commit/3c2a79a31a0f1a44c8ec4f9a87f6fbcea9be651c))
* beta/stable release channels with update notifications and bug fixes ([3c7dc20](https://github.com/the-luap/picpeak/commit/3c7dc2013fc3b57712ddf16db85f495b3cc7bfd7))
* beta/stable release channels with update notifications and bug fixes ([#98](https://github.com/the-luap/picpeak/issues/98)) ([3c7dc20](https://github.com/the-luap/picpeak/commit/3c7dc2013fc3b57712ddf16db85f495b3cc7bfd7))
* completely rewrite GitHub mirror to create new history from target commit ([febacb7](https://github.com/the-luap/picpeak/commit/febacb79ad86d35a222ec86a1e7da65747bbe19a))
* consolidate setup scripts and guides into unified solution ([29a8ff9](https://github.com/the-luap/picpeak/commit/29a8ff914cf838918ab827280e4415afbce5ca8d))
* **docker:** add PUID/PGID and user mapping to avoid bind mount permission issues; feat(setup): prompt for admin email interactively; docs: PUID/PGID in .env.example ([410a33f](https://github.com/the-luap/picpeak/commit/410a33fecf1693cc75816c53ac460ec20089e2a1))
* enhance mirror-to-github workflow with commit-based history filtering ([b4b09c1](https://github.com/the-luap/picpeak/commit/b4b09c16504ca64ce265c7bd0bf0c901dbbd0638))
* **events:** add CSS template selector to event edit page ([6a6c2cd](https://github.com/the-luap/picpeak/commit/6a6c2cd34db26a53b5fb96415650e8136a74e47f))
* exclude Claude contributor from GitHub mirror workflow ([abbcdb1](https://github.com/the-luap/picpeak/commit/abbcdb11136afd8cf4eb21c2103e81d22b9c886f))
* fix analytics dashboard and implement complete Umami integration ([45ce988](https://github.com/the-luap/picpeak/commit/45ce98806d4c87ddce8c400d07cc667bde435d75))
* **gallery/filters:** add Rated and Commented filters (UI + backend).\n\n- UI: add star (Rated) and message (Commented) buttons to feedback filter bars (desktop + mobile)\n- Backend: support filter=rated, commented, and combinations via aggregate counts/queries ([b03760a](https://github.com/the-luap/picpeak/commit/b03760ab01e21feb3578f90d065945d437d03452))
* **gallery:** add quick Like/Favorite actions on thumbnails across layouts ([6368f10](https://github.com/the-luap/picpeak/commit/6368f1027f96107ba64964eb126911bfe185f54a))
* **gallery:** always-visible feedback indicators on grid tiles; fallback image rendering in lightbox/hero; auto-auth from shared-link token; fix external photo resolver\n\n- GridGallery: bottom-left icons for like/rated/comment on every tile\n- Hero layout grid: added same indicators (non-intrusive icons)\n- Lightbox/Hero: add fallbackSrc to display thumbnail if original fails\n- GalleryAuth: auto-store token from /gallery/:slug/:token and hydrate event\n- Backend gallery photo route: use resolvePhotoFilePath for external-media\n\nfix(admin): move photo feedback badges to bottom-right on admin grid tiles\n\nfix(dashboard): add missing i18n keys for activity types + fallback to formatter\n\nfix(admin/feedback): correct thumbnail URL base + robust date parsing\n\nRefs: [#19](https://github.com/the-luap/picpeak/issues/19) ([6948aaa](https://github.com/the-luap/picpeak/commit/6948aaa92afc29609f85cf7fd631095f3e32ad3f))
* **gallery:** compact vertical icon-only feedback filter in PhotoFilterBar; remove wide buttons to prevent overflow\n\n- Desktop: vertical icon stack (All/Grid, Likes, Favorites) outside scroll area\n- Mobile: vertical icon stack below categories\n- Keeps existing category bar layout and count\n\nRefs: [#19](https://github.com/the-luap/picpeak/issues/19) ([465f997](https://github.com/the-luap/picpeak/commit/465f997752fc930ac0a3ae530e9e57a378877d53))
* **i18n:** add translations for settings tabs ([c030e87](https://github.com/the-luap/picpeak/commit/c030e872135b39701ef1f4bbb2f28bcaf4ce7fae))
* implement 4 new features with bug fixes and refactoring plan ([77a4bfd](https://github.com/the-luap/picpeak/commit/77a4bfd49975551bf509354097f280cab3e48c7a))
* implement beta/stable release channels with update notifications ([617e778](https://github.com/the-luap/picpeak/commit/617e778a48e0f0c24fcb8441d00ed2a816f19c03))
* implement comprehensive backup and restore system with S3 support ([f6a79c8](https://github.com/the-luap/picpeak/commit/f6a79c815e3085a56cbe7bac2964dd135f5e88bb))
* implement feedback filter for liked/favorited photos (Issue [#17](https://github.com/the-luap/picpeak/issues/17)) ([41857ec](https://github.com/the-luap/picpeak/commit/41857ec499e2aab4347173cb031db246b9a032f6))
* implement gallery feedback system with version tracking for backups ([dc1419c](https://github.com/the-luap/picpeak/commit/dc1419c051dae44532bfc2b2c2bc00942577dc22))
* implement gallery logo customization (Issue [#17](https://github.com/the-luap/picpeak/issues/17)) ([909e760](https://github.com/the-luap/picpeak/commit/909e760447c76bb35dbffa553a4665edc5ebccd9))
* **lightbox:** keep feedback usable while navigating ([6368f10](https://github.com/the-luap/picpeak/commit/6368f1027f96107ba64964eb126911bfe185f54a)), closes [#19](https://github.com/the-luap/picpeak/issues/19)
* Multi-administrator RBAC, CSS templates & security hardening ([#78](https://github.com/the-luap/picpeak/issues/78)) ([16b3ab0](https://github.com/the-luap/picpeak/commit/16b3ab039ae95f5641dc15a4811eb2b503f1791c))
* **native:** auto-serve SPA when dist exists (unless SERVE_FRONTEND=false); add clear logging; serve index.html for /admin ([fb16b7b](https://github.com/the-luap/picpeak/commit/fb16b7bbb8225192160c08050f1b164c36c8dc74))
* **native:** build frontend and serve SPA from backend (SERVE_FRONTEND); fix Cannot GET /admin on native installs ([9fe10bc](https://github.com/the-luap/picpeak/commit/9fe10bcce2871a48f2409b4936d95c00249deb51))
* **native:** serve built frontend from backend; build frontend during install/update; ensure env flags (SERVE_FRONTEND, FRONTEND_DIR) ([61ad2d6](https://github.com/the-luap/picpeak/commit/61ad2d61c137196c229817989f991e50fa389a6e))
* overhaul public landing page and backup tooling ([2a4d388](https://github.com/the-luap/picpeak/commit/2a4d38813f7ab64a6bbb3a666f3c98a29443488d))
* **select:** add per-tile checkbox selection in Admin grid and all gallery layouts; tile click opens viewer; checkbox toggles selection; auto-enable selection mode; add testids ([9fda54b](https://github.com/the-luap/picpeak/commit/9fda54bd06d37cd8f8f71056bf4f59e158cd8112))
* **setup/docker:** auto-set PUID/PGID from invoking user and chown bind-mount folders; create missing data/events dirs ([0618b78](https://github.com/the-luap/picpeak/commit/0618b78725e85f97f0a4b4e834c17811c033c8f4))
* **setup:** remove --admin-password; print admin credentials from ADMIN_CREDENTIALS.txt; fix ADMIN_URL to avoid /admin/admin; update native service commands ([84d0f63](https://github.com/the-luap/picpeak/commit/84d0f63d36c68532fea83e7087b1afeaa9b82f39))
* support per-gallery password toggle ([5d6c061](https://github.com/the-luap/picpeak/commit/5d6c061f1c4fd20581b1e74fa114c96530b5de53))
* update GitHub mirror workflow to start history from specific commit ([08da01f](https://github.com/the-luap/picpeak/commit/08da01f021788a1b81a3a3aabf120636c4e1a90a))


### Bug Fixes

* add missing route for feedback management page ([517128f](https://github.com/the-luap/picpeak/commit/517128fd99863ea203e39268ffa6c1ff093bcbd0))
* add missing translations and fix BackupHistory useTranslation error ([99e4778](https://github.com/the-luap/picpeak/commit/99e47785e4a53c7ef9f95421413a2704b15b456d))
* Add settings translations and fix manual backup process ([#82](https://github.com/the-luap/picpeak/issues/82)) ([476fcce](https://github.com/the-luap/picpeak/commit/476fcce13f30f9f2d2f98a0c87c25fba09e9eebc))
* **admin/feedback:** use correct event id when rendering photo thumbnails ([4c7b49a](https://github.com/the-luap/picpeak/commit/4c7b49a5f69a3fce4f9a0e837a082b56bb7e47d6)), closes [#19](https://github.com/the-luap/picpeak/issues/19)
* **admin:** prevent category badge overlap in grid ([d64e7d0](https://github.com/the-luap/picpeak/commit/d64e7d08deae7ad1b6f744f447fe546115427942))
* align backend port to 3000 across all configurations ([3a8d53f](https://github.com/the-luap/picpeak/commit/3a8d53f4927f577c4031c4bc3531e08191dc632a))
* Align nginx backend port for production Docker deployments (v2.2.2) ([#88](https://github.com/the-luap/picpeak/issues/88)) ([e0bd19a](https://github.com/the-luap/picpeak/commit/e0bd19a74dd81bdd45be2384820830bd96769e1c))
* auto-convert old date formats to new date-fns syntax ([e1aca6b](https://github.com/the-luap/picpeak/commit/e1aca6b00c5affb914a0db44a6264c8e54fdffd6))
* **backup:** add lastBackup alias and totalBackups for frontend compatibility ([749100c](https://github.com/the-luap/picpeak/commit/749100c92abd2bb123b137e3d3c6bb342b8f5f00))
* **backup:** allow manual backups when automated backups are disabled ([e6dd89e](https://github.com/the-luap/picpeak/commit/e6dd89e969fb7018633159155975bd2bd2fb0409))
* **ci:** add QEMU setup for multi-arch builds and skip for PRs ([0d36a27](https://github.com/the-luap/picpeak/commit/0d36a273bb58ffd0172efacd828e7171d954b41c))
* clear notifications via API ([#35](https://github.com/the-luap/picpeak/issues/35)) ([013be18](https://github.com/the-luap/picpeak/commit/013be18d982986333e2ac24c7ede907de49690bc))
* complete backup page translations and improve UI ([7387a5e](https://github.com/the-luap/picpeak/commit/7387a5e9f90965a6cfb75589b2338bf28263b840))
* complete restore page translations and fix structure ([618e269](https://github.com/the-luap/picpeak/commit/618e2695fdf844cc0ae961b50a9b6eb99bc46a03))
* configure github-release plugin to use GitHub API instead of Gitea ([2624ea6](https://github.com/the-luap/picpeak/commit/2624ea6130a38224597f0c4d3f3d0341c334472f))
* correct GitHub repository path in Drone CI release config ([247e154](https://github.com/the-luap/picpeak/commit/247e154afefd3aef285e459bb7fc39ea460e53e2))
* correct import statements for api in backup JSX files ([30f6780](https://github.com/the-luap/picpeak/commit/30f678048417aeffe6eabefc7bed5e4dc2267f25))
* correct malformed gallery URLs in admin panel View Gallery links ([3074748](https://github.com/the-luap/picpeak/commit/3074748bbc6a8cb8fc0e95d2f24d626f0d0444d0))
* correct password generator function name in reset password route ([65d796b](https://github.com/the-luap/picpeak/commit/65d796b9f09417f85bb3209c5e5fbe597a4bb2d3))
* correct script name in Gitea mirror workflow ([828d6bc](https://github.com/the-luap/picpeak/commit/828d6bc456175007b72998db7116eec993750435))
* **cors:** scope CORS to /api only and avoid throwing on disallowed origins; prevents static asset 500s on native ([90bb21e](https://github.com/the-luap/picpeak/commit/90bb21e38bf1ba97e3fb8185b8d05f1296d745ee))
* critical database connection pool exhaustion issues ([8588133](https://github.com/the-luap/picpeak/commit/8588133a4e35774e46f7c605638758e5b2a4a9e2))
* **db:** improve PostgreSQL connection check in wait-for-db.sh ([e85a68a](https://github.com/the-luap/picpeak/commit/e85a68a386c72c276b4958599b5246e60dfac716))
* display new password after admin password reset ([bd8b885](https://github.com/the-luap/picpeak/commit/bd8b885f7f060160eb852870d143f25ce628f3db))
* Docker Swarm DNS resolution and backup status display (v2.2.3) ([082d8ab](https://github.com/the-luap/picpeak/commit/082d8ab2054416b2a4f9e0438aa2bda0a8f4277e))
* Docker Swarm DNS resolution and backup status display (v2.2.3) ([082d8ab](https://github.com/the-luap/picpeak/commit/082d8ab2054416b2a4f9e0438aa2bda0a8f4277e))
* force github-release plugin to use GitHub API instead of Gitea ([558a966](https://github.com/the-luap/picpeak/commit/558a966f8509ac7b77c732f8cc5855c9f88a4bab))
* **frontend:** add missing externalMedia service and mount admin external-media routes; verify Vite build ([ab324f1](https://github.com/the-luap/picpeak/commit/ab324f192859204a3ea3c129530ccfe8f5a36968))
* gallery thumbnails not loading (404 errors) [#96](https://github.com/the-luap/picpeak/issues/96) ([e3c3c4c](https://github.com/the-luap/picpeak/commit/e3c3c4c951c52de99bd0afd95b08d119153997b4))
* **gallery/filters:** always apply global liked/favorited filters by aggregate counts (ignore guest_id); resolves mismatch between client guest_id and server identifier ([526dcd8](https://github.com/the-luap/picpeak/commit/526dcd8dfc030d86143cee799a88a1004d96b116))
* **gallery/filters:** make feedback filters work globally when no guest_id is provided; remove guest_id from client photos query\n\n- Backend /api/gallery/:slug/photos: if filter present and guest_id missing, filter by like_count/favorite_count\n- Frontend useGalleryPhotos: stop passing random guestId (does not match server guest_identifier)\n\nThis makes Liked/Favorited filters reflect photos with aggregate feedback counts as expected. ([5b2561b](https://github.com/the-luap/picpeak/commit/5b2561b6f1da2665d6092ba954f8ff26df3959a4))
* **gallery/sidebar:** compact icon-only feedback filter in sidebar (vertical, small) to avoid overflow; use GalleryFilter variant=compact ([ff89f96](https://github.com/the-luap/picpeak/commit/ff89f96e31130f75bcd7a406c5d895eac17b65de))
* **gallery:** feedback filter headline + horizontal icons in sidebar (compact variant); ensure sidebar content scrolls (flex-col container) ([3a6d061](https://github.com/the-luap/picpeak/commit/3a6d06192a280ead8bd5d1fbfe06554e63f3346e))
* handle auth errors and JSON parsing in admin panel ([b2ae5f1](https://github.com/the-luap/picpeak/commit/b2ae5f18ad4622ea9cb0b5b593dad19e5d14cf60))
* handle legacy non-JSON logo paths when replacing logo ([0d5ce48](https://github.com/the-luap/picpeak/commit/0d5ce48dccf0c61f210725ffae15dafc5e9f7cab))
* harden gallery downloads and per-gallery auth ([fc1bf53](https://github.com/the-luap/picpeak/commit/fc1bf534129092ca3638e4a4bc47274cd297fa5f))
* implement 9 production enhancements and security fixes ([c584369](https://github.com/the-luap/picpeak/commit/c584369d5d5c33fd794cf82a2aea8089bd10e514))
* improve admin credentials display and configuration ([ad495a9](https://github.com/the-luap/picpeak/commit/ad495a92c46d02849ce0d9176cff43c83c5c4b57))
* improve version bump workflow with better conflict resolution ([c787510](https://github.com/the-luap/picpeak/commit/c7875102c5196a9ef3038c2d5e0ee313fbb2782a))
* JSON serialize favicon and logo URLs for PostgreSQL storage ([b83f427](https://github.com/the-luap/picpeak/commit/b83f4272b584f937fea1f47656182e514b12d980))
* Multi-administrator RBAC, CSS templates & security hardening ([#80](https://github.com/the-luap/picpeak/issues/80)) ([37d4e1c](https://github.com/the-luap/picpeak/commit/37d4e1cb6132346699a90aebfbaec83d84f931f4))
* multiple improvements and CI/CD updates ([bf70567](https://github.com/the-luap/picpeak/commit/bf705674d505b0cb1b82fecc74aa8d95edd50a47))
* **native/http:** disable CSP upgrade-insecure-requests and HSTS unless ENABLE_HSTS=true; prevents HTTPS upgrades on HTTP installs ([24b4a31](https://github.com/the-luap/picpeak/commit/24b4a314a9e97b6c640ca29067e95028a23a8973))
* **native:** correct setup paths to /opt/picpeak/app, update repo URL, add sqlite prod support; docs path fixes ([b992b15](https://github.com/the-luap/picpeak/commit/b992b151d3ca6ccb4a9b2434d94edcdc90ada3b0))
* **native:** remove obsolete workers service; restart only backend; add API request logging and preflight handler; keep static assets outside CORS ([f3604b4](https://github.com/the-luap/picpeak/commit/f3604b438b37e5f2bddf98e79f458bfa2367cb75))
* **nginx:** add Docker DNS resolver for Swarm/dynamic service discovery ([049837f](https://github.com/the-luap/picpeak/commit/049837f9d675ff5a4d93c02e5eb771bf65bc2616))
* **nginx:** Add Docker DNS resolver for Swarm/dynamic service discovery (v2.2.3) ([cc1ddfd](https://github.com/the-luap/picpeak/commit/cc1ddfd42cccac07d5869fe2ee19c25a9ffa50e8))
* **photos:** category changes now persist and display correctly ([#77](https://github.com/the-luap/picpeak/issues/77)) ([d9da98c](https://github.com/the-luap/picpeak/commit/d9da98c355011c247c526b28e6f07b329a632b55))
* **photos:** resolve upload category selection and improve feedback buttons ([#77](https://github.com/the-luap/picpeak/issues/77)) ([856d533](https://github.com/the-luap/picpeak/commit/856d53343c6805706e1498892a29b120938f8547))
* prefer admin token on admin routes ([#23](https://github.com/the-luap/picpeak/issues/23) [#28](https://github.com/the-luap/picpeak/issues/28)) ([d4404e3](https://github.com/the-luap/picpeak/commit/d4404e39bd7953649da02d3e300ffef46573ac97))
* prevent unnecessary image recompression and fix SQLite migration [#95](https://github.com/the-luap/picpeak/issues/95) ([3cdc0ea](https://github.com/the-luap/picpeak/commit/3cdc0ea7152e63cd72124a91394741a6e6904af3))
* remove description field from migration 035 app_settings inserts ([22cc406](https://github.com/the-luap/picpeak/commit/22cc40617f88e1f0a636fc049c78601fc1f38c33))
* remove file requirement from GitHub release in Drone CI ([8335916](https://github.com/the-luap/picpeak/commit/833591681adf29d99a1dfa7c43d5aee7a6cb98ba))
* remove formatBoolean calls from migration 032 - critical production fix ([0502ed3](https://github.com/the-luap/picpeak/commit/0502ed34c9fe76acacc2aecd02151564d109cf0b))
* remove unnecessary publish-manifest job from Docker workflow ([986b101](https://github.com/the-luap/picpeak/commit/986b101040674f2253fcdfda99a9e603535daaa0))
* remove unused formatBoolean import from migration 033 ([1238db5](https://github.com/the-luap/picpeak/commit/1238db58c25e97513c9bdcb5dcc26b1034e9f074))
* remove updated_at field from password reset query ([ed0243e](https://github.com/the-luap/picpeak/commit/ed0243ec398acca26490ef27cbe3cfe5fa9b95a6))
* remove updated_at from app_settings inserts in multiple migrations ([4c42b4c](https://github.com/the-luap/picpeak/commit/4c42b4c60157755b770bea3b78d42fe6abd60afa))
* replace github-release plugin with direct curl API call ([76a466c](https://github.com/the-luap/picpeak/commit/76a466c0776eeabe3eac6a480bd699c2ae5c60bc))
* resolve backend startup errors in development ([f8fb1c3](https://github.com/the-luap/picpeak/commit/f8fb1c3f4b2b5de53182e987a9dfe042704320b9))
* resolve branding display issues and invitation parsing errors ([1931d73](https://github.com/the-luap/picpeak/commit/1931d73b60d3419203cc8b420841abbfc9e14d2d))
* Resolve branding display issues and invitation parsing errors (v2.2.1) ([#86](https://github.com/the-luap/picpeak/issues/86)) ([d7ecf83](https://github.com/the-luap/picpeak/commit/d7ecf83d32ec6608280b96e6cdee48e9a0ad0afa))
* resolve CI/CD version bump race condition ([0bf4764](https://github.com/the-luap/picpeak/commit/0bf4764a0720f6f199442a738a885a2edaae2a4d))
* resolve database connection error for analytics settings ([95939d5](https://github.com/the-luap/picpeak/commit/95939d57e6857646d261b0f049bdda752602caeb))
* resolve date formatting error in event creation ([c51d756](https://github.com/the-luap/picpeak/commit/c51d7565035146cc3f689c0cc4b508b78d9bb5ee))
* resolve development environment issues ([61299a3](https://github.com/the-luap/picpeak/commit/61299a33c4f92730fe8b14f6035f61325d952b94))
* resolve duplicate logger declaration and syntax error in rate limit service ([0fe6d73](https://github.com/the-luap/picpeak/commit/0fe6d738b222555b27cbf8a36f455b1c15c4f4e8))
* resolve feedback validation issues from GitHub issue [#16](https://github.com/the-luap/picpeak/issues/16) ([f26beca](https://github.com/the-luap/picpeak/commit/f26becad1dfa72c62b6ecec491be025644426d67))
* resolve feedback validation issues from GitHub issue [#16](https://github.com/the-luap/picpeak/issues/16) ([67ff415](https://github.com/the-luap/picpeak/commit/67ff4158404347bc7c13dee5b4e13260eb0e743d))
* resolve GitHub issues [#4](https://github.com/the-luap/picpeak/issues/4), [#8](https://github.com/the-luap/picpeak/issues/8), [#9](https://github.com/the-luap/picpeak/issues/9), and [#10](https://github.com/the-luap/picpeak/issues/10) ([934d6dd](https://github.com/the-luap/picpeak/commit/934d6ddc5847f65db6371a4043b764f6d4cd6c8b))
* resolve GitHub mirror workflow cherry-pick failure with merge commits ([d6adde4](https://github.com/the-luap/picpeak/commit/d6adde4e093537aeecf8b190513a1171c3ecc82c))
* resolve language-specific column issues in core migrations ([62617f6](https://github.com/the-luap/picpeak/commit/62617f627f56aedd132fa20528b1d7c7e272c85c))
* resolve migration conflicts and duplicate numbering ([a401fbd](https://github.com/the-luap/picpeak/commit/a401fbdc54f30c18b5aa2440d7b6887ca12e00eb))
* resolve multiple feedback management issues ([ad75818](https://github.com/the-luap/picpeak/commit/ad758185666bf4ac52965f16d1c0e1e052887ac2))
* resolve multiple issues from GitHub issue [#14](https://github.com/the-luap/picpeak/issues/14) ([e91209f](https://github.com/the-luap/picpeak/commit/e91209f7cb38a5b840e74ed6acd8d490ef9d2294))
* resolve port configuration issues and database column mismatch ([6de64a1](https://github.com/the-luap/picpeak/commit/6de64a1df18932badd7bb1b9928d09e9477f0c3f))
* resolve PostgreSQL migration issues for development environment ([ee855a3](https://github.com/the-luap/picpeak/commit/ee855a3502ecd1a5556e378e9995de86e3548de1))
* resolve production UI and API issues ([d5790ad](https://github.com/the-luap/picpeak/commit/d5790ad635596842926a358753932e5c422590d6))
* resolve SIGPIPE error in GitHub mirror workflow file cleanup ([b7c8953](https://github.com/the-luap/picpeak/commit/b7c8953cb4d4a2541dcb38865c8a7beef0edf494))
* resolve translation interpolation issue for download button ([c1e10f1](https://github.com/the-luap/picpeak/commit/c1e10f14a30797c76169c2531de5d04976ee4888))
* **security:** upgrade Alpine base image to fix libpng and c-ares CVEs ([b706eeb](https://github.com/the-luap/picpeak/commit/b706eeb5d332e9618706193976a7241aee53d879))
* **setup/native:** correct repo URL, paths, and systemd for native install; support sqlite in production knex config ([87b8414](https://github.com/the-luap/picpeak/commit/87b8414e449802db6dc9f762453f7672616b83c9))
* **setup/native:** Debian 12 compatibility (reliable RAM detection, sudo-less run_as_user, git safe.directory); ensure SQLite data dir; use user for migrate ([dc482e6](https://github.com/the-luap/picpeak/commit/dc482e614a5fbac44c6570d812669511301a4403))
* **setup/native:** handle forced updates safely by fetch+checkout/reset instead of pull; stable on rewritten histories ([3697344](https://github.com/the-luap/picpeak/commit/3697344cd0add28b4da71c3b33e2ccc0a96f50f9))
* **setup/update:** detect native installs first (/opt/picpeak/app/backend or systemd unit); avoid false docker updates on root ([adf576f](https://github.com/the-luap/picpeak/commit/adf576fbe17f40c13c1d77dd9751f2e9dbf523a1))
* simplify Drone github-release step to avoid shell parsing issues ([94f10e1](https://github.com/the-luap/picpeak/commit/94f10e164502e6848cd720ee5a5c2822abbde46f))
* stabilize uploads and guest feedback filters ([aaaf598](https://github.com/the-luap/picpeak/commit/aaaf59817b3978635d2282c006853e183ab944d4))
* update all deployment guide links in README.md ([6389b9d](https://github.com/the-luap/picpeak/commit/6389b9df3f616c09a9bbbf1a2988764b0c3aeb77))
* update deployment guide with critical URL configuration and nginx port fixes ([1cadce1](https://github.com/the-luap/picpeak/commit/1cadce196bb04a0575d83437618454d4ca5bcdac))
* update form-data and multer to address security vulnerabilities ([7750170](https://github.com/the-luap/picpeak/commit/7750170832dddf81a33c7c2409b37b0b7bc1f290))
* update Gitea mirror workflow to selectively remove scripts ([296430e](https://github.com/the-luap/picpeak/commit/296430e4d7e01a6be031dbb89dd25f563b163a97))
* update GitHub mirror action to support fine-grained personal access tokens ([827eb48](https://github.com/the-luap/picpeak/commit/827eb4819b7da6171d48613963d176399cad80c6))
* use admin API for Umami config in analytics page ([a54a2c0](https://github.com/the-luap/picpeak/commit/a54a2c0fdaa28193d1359da73bc7fb61476e2a58))
* use plugins/gitea-release for Drone CI/CD ([0c783c6](https://github.com/the-luap/picpeak/commit/0c783c66d0dfe8cb637f0db7349ae9637d7bf787))
* use plugins/github-release for Drone CI/CD ([f926cd3](https://github.com/the-luap/picpeak/commit/f926cd3adf513858bc7b291582c7ca2efdf93ff8))
* watermark upload JSON parsing and image quality preservation ([0e3b50d](https://github.com/the-luap/picpeak/commit/0e3b50d1b6a2dc532ebdc0981f81f77722e8f23a))


### Documentation

* add minimum system requirements section to README ([4615a5d](https://github.com/the-luap/picpeak/commit/4615a5d795b415367edf4882628377936b29ab32))
* add PUID/PGID note for Docker bind mounts to avoid permission issues ([0178e71](https://github.com/the-luap/picpeak/commit/0178e71c67f198c6013ece52b0a2da0e2f1a6b2a))
* add transparency note about AI-assisted development ([35e360d](https://github.com/the-luap/picpeak/commit/35e360dcf7ac68833bec81f2e79f4a11a76a0e87))
* add warnings about $ character in Docker Compose passwords ([87d1761](https://github.com/the-luap/picpeak/commit/87d1761091bb97747821aa810a58f3978a59d08f))
* clarify VITE_API_URL usage; remove FRONTEND_API_URL; add storage vars; simplify compose mounts and external DB example (refs [#18](https://github.com/the-luap/picpeak/issues/18)) ([758c085](https://github.com/the-luap/picpeak/commit/758c085467e579e9f6b16df2298747fdddf2b205))
* **compose:** fix backend healthcheck path; remove frontend VITE_API_URL env and document /api proxy (refs [#18](https://github.com/the-luap/picpeak/issues/18)) ([ecbc488](https://github.com/the-luap/picpeak/commit/ecbc48815ded99a052ef057e69427c823cd34ece))
* fix deployment/admin routing and CORS guidance; add AGENTS.md; ignore AGENTS.md (refs [#18](https://github.com/the-luap/picpeak/issues/18)) ([dad1787](https://github.com/the-luap/picpeak/commit/dad1787aad8763637373e8eb87a47728d3d568cc))
* follow-up on PR [#15](https://github.com/the-luap/picpeak/issues/15) — clarify VITE_API_URL usage, compose mounts, and admin routing (refs [#15](https://github.com/the-luap/picpeak/issues/15)) ([e9171c7](https://github.com/the-luap/picpeak/commit/e9171c71159cb41b91a099621bd2d7a7985dd239))
* **readme:** reflect new External Media reference mode and update roadmap (gallery feedback status) ([ee13556](https://github.com/the-luap/picpeak/commit/ee13556c5cb4f24fe88e14fd00b821acf65b11cb))
* replace email addresses with GitHub issue links ([0c989ce](https://github.com/the-luap/picpeak/commit/0c989ce08699ce68b131a9cc4ba4f14e06e3d221))
* update deployment guide with GitHub Container Registry images ([2c9a56f](https://github.com/the-luap/picpeak/commit/2c9a56f217218f0700817d150b3de115e9503baa))


### Code Refactoring

* simplify deployment structure with direct port exposure ([6492cb9](https://github.com/the-luap/picpeak/commit/6492cb9ec8f8b811297aa71c153b9fe6a00e947a))

## [2.3.0](https://github.com/the-luap/picpeak/compare/v2.2.4...v2.3.0) (2026-01-15)


### Features

* beta/stable release channels with update notifications and bug fixes ([3c7dc20](https://github.com/the-luap/picpeak/commit/3c7dc2013fc3b57712ddf16db85f495b3cc7bfd7))
* beta/stable release channels with update notifications and bug fixes ([#98](https://github.com/the-luap/picpeak/issues/98)) ([3c7dc20](https://github.com/the-luap/picpeak/commit/3c7dc2013fc3b57712ddf16db85f495b3cc7bfd7))
* implement beta/stable release channels with update notifications ([617e778](https://github.com/the-luap/picpeak/commit/617e778a48e0f0c24fcb8441d00ed2a816f19c03))


### Bug Fixes

* display new password after admin password reset ([bd8b885](https://github.com/the-luap/picpeak/commit/bd8b885f7f060160eb852870d143f25ce628f3db))
* gallery thumbnails not loading (404 errors) [#96](https://github.com/the-luap/picpeak/issues/96) ([e3c3c4c](https://github.com/the-luap/picpeak/commit/e3c3c4c951c52de99bd0afd95b08d119153997b4))
* prevent unnecessary image recompression and fix SQLite migration [#95](https://github.com/the-luap/picpeak/issues/95) ([3cdc0ea](https://github.com/the-luap/picpeak/commit/3cdc0ea7152e63cd72124a91394741a6e6904af3))
* watermark upload JSON parsing and image quality preservation ([0e3b50d](https://github.com/the-luap/picpeak/commit/0e3b50d1b6a2dc532ebdc0981f81f77722e8f23a))

## [2.2.4](https://github.com/the-luap/picpeak/compare/v2.2.3...v2.2.4) (2026-01-08)


### Bug Fixes

* **backup:** add lastBackup alias and totalBackups for frontend compatibility ([749100c](https://github.com/the-luap/picpeak/commit/749100c92abd2bb123b137e3d3c6bb342b8f5f00))
* Docker Swarm DNS resolution and backup status display (v2.2.3) ([082d8ab](https://github.com/the-luap/picpeak/commit/082d8ab2054416b2a4f9e0438aa2bda0a8f4277e))
* Docker Swarm DNS resolution and backup status display (v2.2.3) ([082d8ab](https://github.com/the-luap/picpeak/commit/082d8ab2054416b2a4f9e0438aa2bda0a8f4277e))

## [2.2.3](https://github.com/the-luap/picpeak/compare/v2.2.2...v2.2.3) (2026-01-08)


### Bug Fixes

* **nginx:** add Docker DNS resolver for Swarm/dynamic service discovery ([049837f](https://github.com/the-luap/picpeak/commit/049837f9d675ff5a4d93c02e5eb771bf65bc2616))
* **nginx:** Add Docker DNS resolver for Swarm/dynamic service discovery (v2.2.3) ([cc1ddfd](https://github.com/the-luap/picpeak/commit/cc1ddfd42cccac07d5869fe2ee19c25a9ffa50e8))

## [2.2.2](https://github.com/the-luap/picpeak/compare/v2.2.1...v2.2.2) (2026-01-08)


### Bug Fixes

* align backend port to 3000 across all configurations ([3a8d53f](https://github.com/the-luap/picpeak/commit/3a8d53f4927f577c4031c4bc3531e08191dc632a))
* Align nginx backend port for production Docker deployments (v2.2.2) ([#88](https://github.com/the-luap/picpeak/issues/88)) ([e0bd19a](https://github.com/the-luap/picpeak/commit/e0bd19a74dd81bdd45be2384820830bd96769e1c))

## [2.2.1](https://github.com/the-luap/picpeak/compare/v2.2.0...v2.2.1) (2026-01-08)


### Bug Fixes

* handle legacy non-JSON logo paths when replacing logo ([0d5ce48](https://github.com/the-luap/picpeak/commit/0d5ce48dccf0c61f210725ffae15dafc5e9f7cab))
* JSON serialize favicon and logo URLs for PostgreSQL storage ([b83f427](https://github.com/the-luap/picpeak/commit/b83f4272b584f937fea1f47656182e514b12d980))
* resolve branding display issues and invitation parsing errors ([1931d73](https://github.com/the-luap/picpeak/commit/1931d73b60d3419203cc8b420841abbfc9e14d2d))
* Resolve branding display issues and invitation parsing errors (v2.2.1) ([#86](https://github.com/the-luap/picpeak/issues/86)) ([d7ecf83](https://github.com/the-luap/picpeak/commit/d7ecf83d32ec6608280b96e6cdee48e9a0ad0afa))

## [2.2.0](https://github.com/the-luap/picpeak/compare/v2.1.1...v2.2.0) (2026-01-08)


### Features

* **i18n:** add translations for settings tabs ([c030e87](https://github.com/the-luap/picpeak/commit/c030e872135b39701ef1f4bbb2f28bcaf4ce7fae))


### Bug Fixes

* Add settings translations and fix manual backup process ([#82](https://github.com/the-luap/picpeak/issues/82)) ([476fcce](https://github.com/the-luap/picpeak/commit/476fcce13f30f9f2d2f98a0c87c25fba09e9eebc))
* **backup:** allow manual backups when automated backups are disabled ([e6dd89e](https://github.com/the-luap/picpeak/commit/e6dd89e969fb7018633159155975bd2bd2fb0409))
* **db:** improve PostgreSQL connection check in wait-for-db.sh ([e85a68a](https://github.com/the-luap/picpeak/commit/e85a68a386c72c276b4958599b5246e60dfac716))

## [2.1.1](https://github.com/the-luap/picpeak/compare/v2.1.0...v2.1.1) (2026-01-07)


### Bug Fixes

* **ci:** add QEMU setup for multi-arch builds and skip for PRs ([0d36a27](https://github.com/the-luap/picpeak/commit/0d36a273bb58ffd0172efacd828e7171d954b41c))
* Multi-administrator RBAC, CSS templates & security hardening ([#80](https://github.com/the-luap/picpeak/issues/80)) ([37d4e1c](https://github.com/the-luap/picpeak/commit/37d4e1cb6132346699a90aebfbaec83d84f931f4))

## [2.1.0](https://github.com/the-luap/picpeak/compare/v2.0.0...v2.1.0) (2026-01-07)


### Features

* add multi-administrator support with RBAC and fix backup/restore for S3 ([892e47d](https://github.com/the-luap/picpeak/commit/892e47d017064d7922536f8e138bbb290a45cdc9))
* **events:** add CSS template selector to event edit page ([6a6c2cd](https://github.com/the-luap/picpeak/commit/6a6c2cd34db26a53b5fb96415650e8136a74e47f))
* Multi-administrator RBAC, CSS templates & security hardening ([#78](https://github.com/the-luap/picpeak/issues/78)) ([16b3ab0](https://github.com/the-luap/picpeak/commit/16b3ab039ae95f5641dc15a4811eb2b503f1791c))


### Bug Fixes

* **photos:** category changes now persist and display correctly ([#77](https://github.com/the-luap/picpeak/issues/77)) ([d9da98c](https://github.com/the-luap/picpeak/commit/d9da98c355011c247c526b28e6f07b329a632b55))
* **photos:** resolve upload category selection and improve feedback buttons ([#77](https://github.com/the-luap/picpeak/issues/77)) ([856d533](https://github.com/the-luap/picpeak/commit/856d53343c6805706e1498892a29b120938f8547))

## [2.0.0](https://github.com/the-luap/picpeak/compare/v1.1.15...v2.0.0) (2026-01-03)


### ⚠ BREAKING CHANGES

* Deployment now requires external reverse proxy for SSL/HTTPS

### Features

* add Apple Liquid Glass templates, image security settings, and automated releases ([6033461](https://github.com/the-luap/picpeak/commit/6033461be118ce78277ec568e1ef1ceeff7311c8))
* add complete translation support for backup admin page ([e9f92e6](https://github.com/the-luap/picpeak/commit/e9f92e66d08ac7001c31a3ee8f43ee8306bc79a9))
* Add CSS template system with custom gallery styling support ([0da45e6](https://github.com/the-luap/picpeak/commit/0da45e699ad998031aa56a92f2da5ee61a04e285))
* add event management, gallery customization, and release automationFeature/event rename ([40ee671](https://github.com/the-luap/picpeak/commit/40ee67171d41522037bf9d4e7675b62ec564346d))
* add feedback management enhancements ([0064122](https://github.com/the-luap/picpeak/commit/0064122eff12029300ab7f95078b5710c3c2d08c))
* add GitHub Actions workflow for Docker image builds ([4029559](https://github.com/the-luap/picpeak/commit/40295599547b86af7fea3359c7486918d2cd0236))
* **admin:** external media import modal + thumbnail fixes for reference events\n\n- Photos tab: replace inline external folder picker with a modal opened via "Import from External Folder" button next to "Upload Photos"; add info that all pictures in the selected folder will be imported.\n- Admin thumbnails: align list endpoint to /api/admin/photos/:eventId/photos and always return thumbnail_url to trigger on-demand generation; normalize external paths to avoid duplicated folder segments (e.g., individual/individual) that broke resolver; improve thumbnail logging.\n- Use authenticated image fetching on admin feedback pages to prevent 401s in automation.\n- i18n: add backup.external.warning strings; complete German backup/restore coverage; add common keys (notSet, of, up, select, selected).\n- Docs: add Local (npm) setup for EXTERNAL_MEDIA_ROOT in deployment guide.\n\nRefs [#17](https://github.com/the-luap/picpeak/issues/17) – gallery feature request: https://github.com/the-luap/picpeak/issues/17 ([49c7778](https://github.com/the-luap/picpeak/commit/49c77785e7a776890f15c0c541dcd18b74a86c6e))
* **admin:** refine header layout and logo placement ([d64e7d0](https://github.com/the-luap/picpeak/commit/d64e7d08deae7ad1b6f744f447fe546115427942))
* allow admin email updates in UI ([#36](https://github.com/the-luap/picpeak/issues/36)) ([3c2a79a](https://github.com/the-luap/picpeak/commit/3c2a79a31a0f1a44c8ec4f9a87f6fbcea9be651c))
* completely rewrite GitHub mirror to create new history from target commit ([febacb7](https://github.com/the-luap/picpeak/commit/febacb79ad86d35a222ec86a1e7da65747bbe19a))
* consolidate setup scripts and guides into unified solution ([29a8ff9](https://github.com/the-luap/picpeak/commit/29a8ff914cf838918ab827280e4415afbce5ca8d))
* **docker:** add PUID/PGID and user mapping to avoid bind mount permission issues; feat(setup): prompt for admin email interactively; docs: PUID/PGID in .env.example ([410a33f](https://github.com/the-luap/picpeak/commit/410a33fecf1693cc75816c53ac460ec20089e2a1))
* enhance mirror-to-github workflow with commit-based history filtering ([b4b09c1](https://github.com/the-luap/picpeak/commit/b4b09c16504ca64ce265c7bd0bf0c901dbbd0638))
* exclude Claude contributor from GitHub mirror workflow ([abbcdb1](https://github.com/the-luap/picpeak/commit/abbcdb11136afd8cf4eb21c2103e81d22b9c886f))
* fix analytics dashboard and implement complete Umami integration ([45ce988](https://github.com/the-luap/picpeak/commit/45ce98806d4c87ddce8c400d07cc667bde435d75))
* **gallery/filters:** add Rated and Commented filters (UI + backend).\n\n- UI: add star (Rated) and message (Commented) buttons to feedback filter bars (desktop + mobile)\n- Backend: support filter=rated, commented, and combinations via aggregate counts/queries ([b03760a](https://github.com/the-luap/picpeak/commit/b03760ab01e21feb3578f90d065945d437d03452))
* **gallery:** add quick Like/Favorite actions on thumbnails across layouts ([6368f10](https://github.com/the-luap/picpeak/commit/6368f1027f96107ba64964eb126911bfe185f54a))
* **gallery:** always-visible feedback indicators on grid tiles; fallback image rendering in lightbox/hero; auto-auth from shared-link token; fix external photo resolver\n\n- GridGallery: bottom-left icons for like/rated/comment on every tile\n- Hero layout grid: added same indicators (non-intrusive icons)\n- Lightbox/Hero: add fallbackSrc to display thumbnail if original fails\n- GalleryAuth: auto-store token from /gallery/:slug/:token and hydrate event\n- Backend gallery photo route: use resolvePhotoFilePath for external-media\n\nfix(admin): move photo feedback badges to bottom-right on admin grid tiles\n\nfix(dashboard): add missing i18n keys for activity types + fallback to formatter\n\nfix(admin/feedback): correct thumbnail URL base + robust date parsing\n\nRefs: [#19](https://github.com/the-luap/picpeak/issues/19) ([6948aaa](https://github.com/the-luap/picpeak/commit/6948aaa92afc29609f85cf7fd631095f3e32ad3f))
* **gallery:** compact vertical icon-only feedback filter in PhotoFilterBar; remove wide buttons to prevent overflow\n\n- Desktop: vertical icon stack (All/Grid, Likes, Favorites) outside scroll area\n- Mobile: vertical icon stack below categories\n- Keeps existing category bar layout and count\n\nRefs: [#19](https://github.com/the-luap/picpeak/issues/19) ([465f997](https://github.com/the-luap/picpeak/commit/465f997752fc930ac0a3ae530e9e57a378877d53))
* implement 4 new features with bug fixes and refactoring plan ([77a4bfd](https://github.com/the-luap/picpeak/commit/77a4bfd49975551bf509354097f280cab3e48c7a))
* implement comprehensive backup and restore system with S3 support ([f6a79c8](https://github.com/the-luap/picpeak/commit/f6a79c815e3085a56cbe7bac2964dd135f5e88bb))
* implement feedback filter for liked/favorited photos (Issue [#17](https://github.com/the-luap/picpeak/issues/17)) ([41857ec](https://github.com/the-luap/picpeak/commit/41857ec499e2aab4347173cb031db246b9a032f6))
* implement gallery feedback system with version tracking for backups ([dc1419c](https://github.com/the-luap/picpeak/commit/dc1419c051dae44532bfc2b2c2bc00942577dc22))
* implement gallery logo customization (Issue [#17](https://github.com/the-luap/picpeak/issues/17)) ([909e760](https://github.com/the-luap/picpeak/commit/909e760447c76bb35dbffa553a4665edc5ebccd9))
* **lightbox:** keep feedback usable while navigating ([6368f10](https://github.com/the-luap/picpeak/commit/6368f1027f96107ba64964eb126911bfe185f54a)), closes [#19](https://github.com/the-luap/picpeak/issues/19)
* **native:** auto-serve SPA when dist exists (unless SERVE_FRONTEND=false); add clear logging; serve index.html for /admin ([fb16b7b](https://github.com/the-luap/picpeak/commit/fb16b7bbb8225192160c08050f1b164c36c8dc74))
* **native:** build frontend and serve SPA from backend (SERVE_FRONTEND); fix Cannot GET /admin on native installs ([9fe10bc](https://github.com/the-luap/picpeak/commit/9fe10bcce2871a48f2409b4936d95c00249deb51))
* **native:** serve built frontend from backend; build frontend during install/update; ensure env flags (SERVE_FRONTEND, FRONTEND_DIR) ([61ad2d6](https://github.com/the-luap/picpeak/commit/61ad2d61c137196c229817989f991e50fa389a6e))
* overhaul public landing page and backup tooling ([2a4d388](https://github.com/the-luap/picpeak/commit/2a4d38813f7ab64a6bbb3a666f3c98a29443488d))
* **select:** add per-tile checkbox selection in Admin grid and all gallery layouts; tile click opens viewer; checkbox toggles selection; auto-enable selection mode; add testids ([9fda54b](https://github.com/the-luap/picpeak/commit/9fda54bd06d37cd8f8f71056bf4f59e158cd8112))
* **setup/docker:** auto-set PUID/PGID from invoking user and chown bind-mount folders; create missing data/events dirs ([0618b78](https://github.com/the-luap/picpeak/commit/0618b78725e85f97f0a4b4e834c17811c033c8f4))
* **setup:** remove --admin-password; print admin credentials from ADMIN_CREDENTIALS.txt; fix ADMIN_URL to avoid /admin/admin; update native service commands ([84d0f63](https://github.com/the-luap/picpeak/commit/84d0f63d36c68532fea83e7087b1afeaa9b82f39))
* support per-gallery password toggle ([5d6c061](https://github.com/the-luap/picpeak/commit/5d6c061f1c4fd20581b1e74fa114c96530b5de53))
* update GitHub mirror workflow to start history from specific commit ([08da01f](https://github.com/the-luap/picpeak/commit/08da01f021788a1b81a3a3aabf120636c4e1a90a))


### Bug Fixes

* add missing route for feedback management page ([517128f](https://github.com/the-luap/picpeak/commit/517128fd99863ea203e39268ffa6c1ff093bcbd0))
* add missing translations and fix BackupHistory useTranslation error ([99e4778](https://github.com/the-luap/picpeak/commit/99e47785e4a53c7ef9f95421413a2704b15b456d))
* **admin/feedback:** use correct event id when rendering photo thumbnails ([4c7b49a](https://github.com/the-luap/picpeak/commit/4c7b49a5f69a3fce4f9a0e837a082b56bb7e47d6)), closes [#19](https://github.com/the-luap/picpeak/issues/19)
* **admin:** prevent category badge overlap in grid ([d64e7d0](https://github.com/the-luap/picpeak/commit/d64e7d08deae7ad1b6f744f447fe546115427942))
* auto-convert old date formats to new date-fns syntax ([e1aca6b](https://github.com/the-luap/picpeak/commit/e1aca6b00c5affb914a0db44a6264c8e54fdffd6))
* clear notifications via API ([#35](https://github.com/the-luap/picpeak/issues/35)) ([013be18](https://github.com/the-luap/picpeak/commit/013be18d982986333e2ac24c7ede907de49690bc))
* complete backup page translations and improve UI ([7387a5e](https://github.com/the-luap/picpeak/commit/7387a5e9f90965a6cfb75589b2338bf28263b840))
* complete restore page translations and fix structure ([618e269](https://github.com/the-luap/picpeak/commit/618e2695fdf844cc0ae961b50a9b6eb99bc46a03))
* configure github-release plugin to use GitHub API instead of Gitea ([2624ea6](https://github.com/the-luap/picpeak/commit/2624ea6130a38224597f0c4d3f3d0341c334472f))
* correct GitHub repository path in Drone CI release config ([247e154](https://github.com/the-luap/picpeak/commit/247e154afefd3aef285e459bb7fc39ea460e53e2))
* correct import statements for api in backup JSX files ([30f6780](https://github.com/the-luap/picpeak/commit/30f678048417aeffe6eabefc7bed5e4dc2267f25))
* correct malformed gallery URLs in admin panel View Gallery links ([3074748](https://github.com/the-luap/picpeak/commit/3074748bbc6a8cb8fc0e95d2f24d626f0d0444d0))
* correct password generator function name in reset password route ([65d796b](https://github.com/the-luap/picpeak/commit/65d796b9f09417f85bb3209c5e5fbe597a4bb2d3))
* correct script name in Gitea mirror workflow ([828d6bc](https://github.com/the-luap/picpeak/commit/828d6bc456175007b72998db7116eec993750435))
* **cors:** scope CORS to /api only and avoid throwing on disallowed origins; prevents static asset 500s on native ([90bb21e](https://github.com/the-luap/picpeak/commit/90bb21e38bf1ba97e3fb8185b8d05f1296d745ee))
* critical database connection pool exhaustion issues ([8588133](https://github.com/the-luap/picpeak/commit/8588133a4e35774e46f7c605638758e5b2a4a9e2))
* force github-release plugin to use GitHub API instead of Gitea ([558a966](https://github.com/the-luap/picpeak/commit/558a966f8509ac7b77c732f8cc5855c9f88a4bab))
* **frontend:** add missing externalMedia service and mount admin external-media routes; verify Vite build ([ab324f1](https://github.com/the-luap/picpeak/commit/ab324f192859204a3ea3c129530ccfe8f5a36968))
* **gallery/filters:** always apply global liked/favorited filters by aggregate counts (ignore guest_id); resolves mismatch between client guest_id and server identifier ([526dcd8](https://github.com/the-luap/picpeak/commit/526dcd8dfc030d86143cee799a88a1004d96b116))
* **gallery/filters:** make feedback filters work globally when no guest_id is provided; remove guest_id from client photos query\n\n- Backend /api/gallery/:slug/photos: if filter present and guest_id missing, filter by like_count/favorite_count\n- Frontend useGalleryPhotos: stop passing random guestId (does not match server guest_identifier)\n\nThis makes Liked/Favorited filters reflect photos with aggregate feedback counts as expected. ([5b2561b](https://github.com/the-luap/picpeak/commit/5b2561b6f1da2665d6092ba954f8ff26df3959a4))
* **gallery/sidebar:** compact icon-only feedback filter in sidebar (vertical, small) to avoid overflow; use GalleryFilter variant=compact ([ff89f96](https://github.com/the-luap/picpeak/commit/ff89f96e31130f75bcd7a406c5d895eac17b65de))
* **gallery:** feedback filter headline + horizontal icons in sidebar (compact variant); ensure sidebar content scrolls (flex-col container) ([3a6d061](https://github.com/the-luap/picpeak/commit/3a6d06192a280ead8bd5d1fbfe06554e63f3346e))
* handle auth errors and JSON parsing in admin panel ([b2ae5f1](https://github.com/the-luap/picpeak/commit/b2ae5f18ad4622ea9cb0b5b593dad19e5d14cf60))
* harden gallery downloads and per-gallery auth ([fc1bf53](https://github.com/the-luap/picpeak/commit/fc1bf534129092ca3638e4a4bc47274cd297fa5f))
* implement 9 production enhancements and security fixes ([c584369](https://github.com/the-luap/picpeak/commit/c584369d5d5c33fd794cf82a2aea8089bd10e514))
* improve admin credentials display and configuration ([ad495a9](https://github.com/the-luap/picpeak/commit/ad495a92c46d02849ce0d9176cff43c83c5c4b57))
* improve version bump workflow with better conflict resolution ([c787510](https://github.com/the-luap/picpeak/commit/c7875102c5196a9ef3038c2d5e0ee313fbb2782a))
* multiple improvements and CI/CD updates ([bf70567](https://github.com/the-luap/picpeak/commit/bf705674d505b0cb1b82fecc74aa8d95edd50a47))
* **native/http:** disable CSP upgrade-insecure-requests and HSTS unless ENABLE_HSTS=true; prevents HTTPS upgrades on HTTP installs ([24b4a31](https://github.com/the-luap/picpeak/commit/24b4a314a9e97b6c640ca29067e95028a23a8973))
* **native:** correct setup paths to /opt/picpeak/app, update repo URL, add sqlite prod support; docs path fixes ([b992b15](https://github.com/the-luap/picpeak/commit/b992b151d3ca6ccb4a9b2434d94edcdc90ada3b0))
* **native:** remove obsolete workers service; restart only backend; add API request logging and preflight handler; keep static assets outside CORS ([f3604b4](https://github.com/the-luap/picpeak/commit/f3604b438b37e5f2bddf98e79f458bfa2367cb75))
* prefer admin token on admin routes ([#23](https://github.com/the-luap/picpeak/issues/23) [#28](https://github.com/the-luap/picpeak/issues/28)) ([d4404e3](https://github.com/the-luap/picpeak/commit/d4404e39bd7953649da02d3e300ffef46573ac97))
* remove description field from migration 035 app_settings inserts ([22cc406](https://github.com/the-luap/picpeak/commit/22cc40617f88e1f0a636fc049c78601fc1f38c33))
* remove file requirement from GitHub release in Drone CI ([8335916](https://github.com/the-luap/picpeak/commit/833591681adf29d99a1dfa7c43d5aee7a6cb98ba))
* remove formatBoolean calls from migration 032 - critical production fix ([0502ed3](https://github.com/the-luap/picpeak/commit/0502ed34c9fe76acacc2aecd02151564d109cf0b))
* remove unnecessary publish-manifest job from Docker workflow ([986b101](https://github.com/the-luap/picpeak/commit/986b101040674f2253fcdfda99a9e603535daaa0))
* remove unused formatBoolean import from migration 033 ([1238db5](https://github.com/the-luap/picpeak/commit/1238db58c25e97513c9bdcb5dcc26b1034e9f074))
* remove updated_at field from password reset query ([ed0243e](https://github.com/the-luap/picpeak/commit/ed0243ec398acca26490ef27cbe3cfe5fa9b95a6))
* remove updated_at from app_settings inserts in multiple migrations ([4c42b4c](https://github.com/the-luap/picpeak/commit/4c42b4c60157755b770bea3b78d42fe6abd60afa))
* replace github-release plugin with direct curl API call ([76a466c](https://github.com/the-luap/picpeak/commit/76a466c0776eeabe3eac6a480bd699c2ae5c60bc))
* resolve backend startup errors in development ([f8fb1c3](https://github.com/the-luap/picpeak/commit/f8fb1c3f4b2b5de53182e987a9dfe042704320b9))
* resolve CI/CD version bump race condition ([0bf4764](https://github.com/the-luap/picpeak/commit/0bf4764a0720f6f199442a738a885a2edaae2a4d))
* resolve database connection error for analytics settings ([95939d5](https://github.com/the-luap/picpeak/commit/95939d57e6857646d261b0f049bdda752602caeb))
* resolve date formatting error in event creation ([c51d756](https://github.com/the-luap/picpeak/commit/c51d7565035146cc3f689c0cc4b508b78d9bb5ee))
* resolve development environment issues ([61299a3](https://github.com/the-luap/picpeak/commit/61299a33c4f92730fe8b14f6035f61325d952b94))
* resolve duplicate logger declaration and syntax error in rate limit service ([0fe6d73](https://github.com/the-luap/picpeak/commit/0fe6d738b222555b27cbf8a36f455b1c15c4f4e8))
* resolve feedback validation issues from GitHub issue [#16](https://github.com/the-luap/picpeak/issues/16) ([f26beca](https://github.com/the-luap/picpeak/commit/f26becad1dfa72c62b6ecec491be025644426d67))
* resolve feedback validation issues from GitHub issue [#16](https://github.com/the-luap/picpeak/issues/16) ([67ff415](https://github.com/the-luap/picpeak/commit/67ff4158404347bc7c13dee5b4e13260eb0e743d))
* resolve GitHub issues [#4](https://github.com/the-luap/picpeak/issues/4), [#8](https://github.com/the-luap/picpeak/issues/8), [#9](https://github.com/the-luap/picpeak/issues/9), and [#10](https://github.com/the-luap/picpeak/issues/10) ([934d6dd](https://github.com/the-luap/picpeak/commit/934d6ddc5847f65db6371a4043b764f6d4cd6c8b))
* resolve GitHub mirror workflow cherry-pick failure with merge commits ([d6adde4](https://github.com/the-luap/picpeak/commit/d6adde4e093537aeecf8b190513a1171c3ecc82c))
* resolve language-specific column issues in core migrations ([62617f6](https://github.com/the-luap/picpeak/commit/62617f627f56aedd132fa20528b1d7c7e272c85c))
* resolve migration conflicts and duplicate numbering ([a401fbd](https://github.com/the-luap/picpeak/commit/a401fbdc54f30c18b5aa2440d7b6887ca12e00eb))
* resolve multiple feedback management issues ([ad75818](https://github.com/the-luap/picpeak/commit/ad758185666bf4ac52965f16d1c0e1e052887ac2))
* resolve multiple issues from GitHub issue [#14](https://github.com/the-luap/picpeak/issues/14) ([e91209f](https://github.com/the-luap/picpeak/commit/e91209f7cb38a5b840e74ed6acd8d490ef9d2294))
* resolve port configuration issues and database column mismatch ([6de64a1](https://github.com/the-luap/picpeak/commit/6de64a1df18932badd7bb1b9928d09e9477f0c3f))
* resolve PostgreSQL migration issues for development environment ([ee855a3](https://github.com/the-luap/picpeak/commit/ee855a3502ecd1a5556e378e9995de86e3548de1))
* resolve production UI and API issues ([d5790ad](https://github.com/the-luap/picpeak/commit/d5790ad635596842926a358753932e5c422590d6))
* resolve SIGPIPE error in GitHub mirror workflow file cleanup ([b7c8953](https://github.com/the-luap/picpeak/commit/b7c8953cb4d4a2541dcb38865c8a7beef0edf494))
* resolve translation interpolation issue for download button ([c1e10f1](https://github.com/the-luap/picpeak/commit/c1e10f14a30797c76169c2531de5d04976ee4888))
* **setup/native:** correct repo URL, paths, and systemd for native install; support sqlite in production knex config ([87b8414](https://github.com/the-luap/picpeak/commit/87b8414e449802db6dc9f762453f7672616b83c9))
* **setup/native:** Debian 12 compatibility (reliable RAM detection, sudo-less run_as_user, git safe.directory); ensure SQLite data dir; use user for migrate ([dc482e6](https://github.com/the-luap/picpeak/commit/dc482e614a5fbac44c6570d812669511301a4403))
* **setup/native:** handle forced updates safely by fetch+checkout/reset instead of pull; stable on rewritten histories ([3697344](https://github.com/the-luap/picpeak/commit/3697344cd0add28b4da71c3b33e2ccc0a96f50f9))
* **setup/update:** detect native installs first (/opt/picpeak/app/backend or systemd unit); avoid false docker updates on root ([adf576f](https://github.com/the-luap/picpeak/commit/adf576fbe17f40c13c1d77dd9751f2e9dbf523a1))
* simplify Drone github-release step to avoid shell parsing issues ([94f10e1](https://github.com/the-luap/picpeak/commit/94f10e164502e6848cd720ee5a5c2822abbde46f))
* stabilize uploads and guest feedback filters ([aaaf598](https://github.com/the-luap/picpeak/commit/aaaf59817b3978635d2282c006853e183ab944d4))
* update all deployment guide links in README.md ([6389b9d](https://github.com/the-luap/picpeak/commit/6389b9df3f616c09a9bbbf1a2988764b0c3aeb77))
* update deployment guide with critical URL configuration and nginx port fixes ([1cadce1](https://github.com/the-luap/picpeak/commit/1cadce196bb04a0575d83437618454d4ca5bcdac))
* update form-data and multer to address security vulnerabilities ([7750170](https://github.com/the-luap/picpeak/commit/7750170832dddf81a33c7c2409b37b0b7bc1f290))
* update Gitea mirror workflow to selectively remove scripts ([296430e](https://github.com/the-luap/picpeak/commit/296430e4d7e01a6be031dbb89dd25f563b163a97))
* update GitHub mirror action to support fine-grained personal access tokens ([827eb48](https://github.com/the-luap/picpeak/commit/827eb4819b7da6171d48613963d176399cad80c6))
* use admin API for Umami config in analytics page ([a54a2c0](https://github.com/the-luap/picpeak/commit/a54a2c0fdaa28193d1359da73bc7fb61476e2a58))
* use plugins/gitea-release for Drone CI/CD ([0c783c6](https://github.com/the-luap/picpeak/commit/0c783c66d0dfe8cb637f0db7349ae9637d7bf787))
* use plugins/github-release for Drone CI/CD ([f926cd3](https://github.com/the-luap/picpeak/commit/f926cd3adf513858bc7b291582c7ca2efdf93ff8))


### Documentation

* add minimum system requirements section to README ([4615a5d](https://github.com/the-luap/picpeak/commit/4615a5d795b415367edf4882628377936b29ab32))
* add PUID/PGID note for Docker bind mounts to avoid permission issues ([0178e71](https://github.com/the-luap/picpeak/commit/0178e71c67f198c6013ece52b0a2da0e2f1a6b2a))
* add transparency note about AI-assisted development ([35e360d](https://github.com/the-luap/picpeak/commit/35e360dcf7ac68833bec81f2e79f4a11a76a0e87))
* add warnings about $ character in Docker Compose passwords ([87d1761](https://github.com/the-luap/picpeak/commit/87d1761091bb97747821aa810a58f3978a59d08f))
* clarify VITE_API_URL usage; remove FRONTEND_API_URL; add storage vars; simplify compose mounts and external DB example (refs [#18](https://github.com/the-luap/picpeak/issues/18)) ([758c085](https://github.com/the-luap/picpeak/commit/758c085467e579e9f6b16df2298747fdddf2b205))
* **compose:** fix backend healthcheck path; remove frontend VITE_API_URL env and document /api proxy (refs [#18](https://github.com/the-luap/picpeak/issues/18)) ([ecbc488](https://github.com/the-luap/picpeak/commit/ecbc48815ded99a052ef057e69427c823cd34ece))
* fix deployment/admin routing and CORS guidance; add AGENTS.md; ignore AGENTS.md (refs [#18](https://github.com/the-luap/picpeak/issues/18)) ([dad1787](https://github.com/the-luap/picpeak/commit/dad1787aad8763637373e8eb87a47728d3d568cc))
* follow-up on PR [#15](https://github.com/the-luap/picpeak/issues/15) — clarify VITE_API_URL usage, compose mounts, and admin routing (refs [#15](https://github.com/the-luap/picpeak/issues/15)) ([e9171c7](https://github.com/the-luap/picpeak/commit/e9171c71159cb41b91a099621bd2d7a7985dd239))
* **readme:** reflect new External Media reference mode and update roadmap (gallery feedback status) ([ee13556](https://github.com/the-luap/picpeak/commit/ee13556c5cb4f24fe88e14fd00b821acf65b11cb))
* replace email addresses with GitHub issue links ([0c989ce](https://github.com/the-luap/picpeak/commit/0c989ce08699ce68b131a9cc4ba4f14e06e3d221))
* update deployment guide with GitHub Container Registry images ([2c9a56f](https://github.com/the-luap/picpeak/commit/2c9a56f217218f0700817d150b3de115e9503baa))


### Code Refactoring

* simplify deployment structure with direct port exposure ([6492cb9](https://github.com/the-luap/picpeak/commit/6492cb9ec8f8b811297aa71c153b9fe6a00e947a))

## [1.2.0](https://github.com/the-luap/picpeak/compare/v1.1.15...v1.2.0) (2026-01-03)

### Features

* **Event Rename**: Safe event renaming with automatic slug updates, old URL redirects via `slug_redirects` table, and optional email notifications to clients
* **Optional Event Fields**: Make customer name, email, and admin email fields optional via admin settings with "(optional)" labels in forms
* **Photo Filtering**: Filter photos by rating, likes, favorites, and comments with a new PhotoFilterPanel component
* **Photo Export**: Export filtered photo selections as ZIP, generate Capture One/Lightroom-compatible XMP sidecar files, or export metadata lists
* **Custom CSS Templates**: 3 customizable CSS template slots with live preview, XSS-safe sanitization, and per-event template assignment
* **Apple Liquid Glass Theme**: Starter CSS template inspired by iOS 26 / macOS Tahoe Liquid Glass design with glass morphism effects, Apple SF Pro fonts, and responsive layout
* **Liquid Glass Dark Theme**: Neon-accented dark glass theme with animated gradient backgrounds
* **Image Security Settings**: Per-event download protection with configurable protection levels (basic, standard, enhanced, maximum), canvas rendering, DevTools detection, and right-click prevention
* **Automated Releases**: Release Please integration for automatic versioning, changelog generation, and GitHub releases that trigger Docker image builds

### Bug Fixes

* **Date Parsing**: Fix event date formatting in slugs (now uses YYYY-MM-DD format correctly)
* **Search Placeholder**: Fix search field placeholder visibility in glass-styled sidebar
* **Vite Proxy**: Fix Vite dev server proxy port configuration
* **Photo Export Button**: Fix export button staying disabled when photos are selected
* **Boolean Parsing**: Fix boolean parsing in publicSettings.js for optional fields
* **Translation Keys**: Add missing `common.optional` translation key in locales

### Security

* Fix critical vulnerabilities and harden application security
* Add CSS sanitizer utility blocking XSS vectors in custom templates
* Implement secure gallery CSS endpoint for template delivery

### Code Refactoring

* Add Photo and Settings service layers for better code organization
* Phase 1 code consolidation with service layer architecture
* Modular settings page with feature-based tab components
* Create photoFilterBuilder utility for query construction
* Add eventRenameService for safe event operations

### Documentation

* Add comprehensive REFACTORING_PLAN.md for codebase improvement roadmap
* Update README roadmap with implemented features (Download Protection, Gallery Templates, Filtering & Export)
* Add test specification documents for all new features

### Database Migrations

* `049_add_slug_redirects.js` - Store old slugs for URL redirects after rename
* `050_add_optional_event_fields_settings.js` - Settings for optional form fields
* `051_add_photo_filter_indexes.js` - Performance indexes for photo filtering
* `052_add_css_templates.js` - CSS template storage with 3 slots
* `053_add_liquid_glass_templates.js` - Apple Liquid Glass and Dark theme starter templates

---

## [1.1.15] - Previous Release

Initial stable release with core functionality.
