# Changelog

All notable changes to PicPeak will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.43.1](https://github.com/the-luap/picpeak/compare/v3.43.0...v3.43.1) (2026-05-07)


### Bug Fixes

* **security:** backport 18 dependency CVE patches from beta (3.42.2 stable) ([74eacbc](https://github.com/the-luap/picpeak/commit/74eacbc78f7efd5c499ae1647b716d3234096c39))
* **security:** patch 18 dependency CVEs (axios + transitives + nodemailer + i18next-http-backend) ([37bf894](https://github.com/the-luap/picpeak/commit/37bf894412b4da0f0507dd8f1384e6f101ce14b2))

## [3.43.0](https://github.com/the-luap/picpeak/compare/v3.42.1...v3.43.0) (2026-05-07)


### Features

* add admin dark mode and SEO/robots.txt settings ([9c2a0d2](https://github.com/the-luap/picpeak/commit/9c2a0d272a21dfcace2ec795034e2f1adcba47e0))
* add bulk category editing for photos ([#157](https://github.com/the-luap/picpeak/issues/157)) ([eca36c7](https://github.com/the-luap/picpeak/commit/eca36c70a23f18f937a9f5bddeff855e18f364c3))
* add category hero/cover photo selection ([#163](https://github.com/the-luap/picpeak/issues/163)) ([6c30e2c](https://github.com/the-luap/picpeak/commit/6c30e2c2edd19a24d4f30a9558690bb7e2331b32))
* add configurable upload batch size for reverse proxy compatibility ([#208](https://github.com/the-luap/picpeak/issues/208)) ([02a46e0](https://github.com/the-luap/picpeak/commit/02a46e083d68cfdb355b5a4fe4a8da7d667050b9))
* add COOKIE_SECURE=auto for mixed HTTPS/HTTP deployments ([#298](https://github.com/the-luap/picpeak/issues/298)) ([b1dfbe4](https://github.com/the-luap/picpeak/commit/b1dfbe4c2fe271d8087974d02cf724f04058bdc9))
* add COOKIE_SECURE=auto for mixed HTTPS/HTTP deployments ([#298](https://github.com/the-luap/picpeak/issues/298)) ([15a8ab4](https://github.com/the-luap/picpeak/commit/15a8ab41fd1c94e3397d300b161cd1fdd459ea05))
* add customizable event types with admin management ([f8881d5](https://github.com/the-luap/picpeak/commit/f8881d5bd62d449fb40917ec8c20f0eb16c1fdad))
* add Dutch (nl) locale and fix missing translation keys across all locales ([b54a80d](https://github.com/the-luap/picpeak/commit/b54a80d251bcbb9a126e32eeaef522688bc810c6))
* add Dutch locale and fix missing translation keys ([e32da68](https://github.com/the-luap/picpeak/commit/e32da68cbdfa430d62cbb1057ea418dc6b2f14fb))
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
* add per-gallery thumbnail scale setting ([#172](https://github.com/the-luap/picpeak/issues/172)) ([#251](https://github.com/the-luap/picpeak/issues/251)) ([ee46088](https://github.com/the-luap/picpeak/commit/ee46088985ebbbb81d16e5bac23be2060c94397f))
* add photo cap per event and Portuguese (pt-BR) locale ([1fa222e](https://github.com/the-luap/picpeak/commit/1fa222e9c4c26e525c7899e368988c6b0b08da85))
* add photo cap per event and Portuguese locale ([088de43](https://github.com/the-luap/picpeak/commit/088de43f09f974d444f50452ef1117315c289ebc))
* add quilted layout, fix mosaic, and backfill photo dimensions ([#146](https://github.com/the-luap/picpeak/issues/146)) ([46ed1bc](https://github.com/the-luap/picpeak/commit/46ed1bc276867a25b27bf22cd9b9d7e879a6947b))
* add thumbnail settings UI to admin panel ([3a30fea](https://github.com/the-luap/picpeak/commit/3a30fea862034d64fbc7188fc25292594a9319e2))
* add thumbnail settings UI to admin settings page ([#206](https://github.com/the-luap/picpeak/issues/206)) ([7d6d2f5](https://github.com/the-luap/picpeak/commit/7d6d2f56883a4402f0d97c95b0432a8a783c8024))
* add update instructions dialog, email notifications, and capture date sorting ([50c0990](https://github.com/the-luap/picpeak/commit/50c09904a9434f988ab32a07da5d24db0e02065e)), closes [#181](https://github.com/the-luap/picpeak/issues/181)
* add visual WYSIWYG email template editor ([#229](https://github.com/the-luap/picpeak/issues/229)) ([04a7ea8](https://github.com/the-luap/picpeak/commit/04a7ea80f95d6aeb474b145292e75f45fb85c66d))
* **branding:** 8-token CI palette + force color mode + dark-mode consistency ([8050927](https://github.com/the-luap/picpeak/commit/80509276074b8125b6d676839afabb0b6f89206f))
* **branding:** force color mode (dark or light) site-wide ([5a162fc](https://github.com/the-luap/picpeak/commit/5a162fc8bec47a49cb1bcaa92ff72e197e8d2e42))
* **branding:** inline force color mode with auto-save + clearer palette help text ([67d7d8d](https://github.com/the-luap/picpeak/commit/67d7d8d3fa25ceab0eda02b291f2e220b222f84a))
* **branding:** per-family generic fallback via meta.json ([dcff451](https://github.com/the-luap/picpeak/commit/dcff4515721482e06c2ef1c1eb34f9e12754c07c))
* **branding:** preview each font in its own face in the picker dropdown ([b4f9b65](https://github.com/the-luap/picpeak/commit/b4f9b65f1df4c400f22b28f20e1304ec57279d33))
* **branding:** self-hosted webfonts with filesystem scanner ([d04bf28](https://github.com/the-luap/picpeak/commit/d04bf288084144bf53ef0ba988fa32ed703d7351))
* **branding:** self-hosted webfonts with filesystem scanner ([bac51fe](https://github.com/the-luap/picpeak/commit/bac51fe69a39f85381f445e8da6cd63cf5826fc4))
* **cms:** add external URL toggle for imprint and privacy pages ([b2c8161](https://github.com/the-luap/picpeak/commit/b2c8161a43c2d0b09d6783e791b3f26862254824))
* **cms:** add per-page external URL override — backend ([66423bb](https://github.com/the-luap/picpeak/commit/66423bb65e83b6204509c9a98d783ba8255c3364))
* **cms:** admin UI for external imprint/privacy URL ([a4e3d10](https://github.com/the-luap/picpeak/commit/a4e3d10fb0c97ea07c4b08d16c0947945d8a7576))
* **cms:** redirect legal links to external URL when configured ([c5bba50](https://github.com/the-luap/picpeak/commit/c5bba505ac92b5257f6bb1c069b8bc23ea6a5a1b))
* configurable upload batch size for reverse proxy compatibility ([9b7495e](https://github.com/the-luap/picpeak/commit/9b7495e0054975e66c9b5006c24a9fae63969de4))
* configurable upload batch size for reverse proxy compatibility ([4243363](https://github.com/the-luap/picpeak/commit/424336340bef8e1629490ade154f0ceebb2a71e1))
* customisable 404 + gallery-not-found pages via CMS ([#324](https://github.com/the-luap/picpeak/issues/324)) ([4f77905](https://github.com/the-luap/picpeak/commit/4f77905b87bea474b3d2496350996deaad041230))
* decouple hero header from gallery layouts ([#158](https://github.com/the-luap/picpeak/issues/158)) ([7b8d8bd](https://github.com/the-luap/picpeak/commit/7b8d8bd92ba7a96717bb4d821b38dddc395f701a))
* draft mode, admin branding, and workflow improvements ([dc98206](https://github.com/the-luap/picpeak/commit/dc98206737d1ebe43637319ce8c5b6da2e44c05d))
* draft mode, admin branding, and workflow improvements ([40332a7](https://github.com/the-luap/picpeak/commit/40332a71db6534097940d3f9362b0fe651dba6c7))
* dynamic website title from branding settings ([d29aab7](https://github.com/the-luap/picpeak/commit/d29aab7c70c5777451666fb7d5c7a9729dab684a))
* **email:** expand email palette to 8 tokens + Sync from Branding button ([47b6b39](https://github.com/the-luap/picpeak/commit/47b6b39f3a942aee93b970031d95a952cb769d09))
* **events:** add Photos column to admin events list ([#384](https://github.com/the-luap/picpeak/issues/384)) ([d561db8](https://github.com/the-luap/picpeak/commit/d561db802b04db8fbb38819a22e840532e775ef0))
* **events:** add Photos column to admin events list ([#384](https://github.com/the-luap/picpeak/issues/384)) ([ffb4318](https://github.com/the-luap/picpeak/commit/ffb4318a1f667e273cd59805673b125d2f17699b))
* **events:** bulk delete with password confirmation ([#384](https://github.com/the-luap/picpeak/issues/384)) ([647aea2](https://github.com/the-luap/picpeak/commit/647aea21ae42fe0d089bf45568702617a25b98e4))
* **events:** bulk delete with password confirmation ([#384](https://github.com/the-luap/picpeak/issues/384)) ([48d538f](https://github.com/the-luap/picpeak/commit/48d538f94fd39d9b85ec57c57301a8490b7d4f6d))
* **events:** prefill admin email + admin picker on event creation ([3fe8e61](https://github.com/the-luap/picpeak/commit/3fe8e61bd1175e35dcb61604447e5d9c2e902ec5))
* **events:** prefill admin email + admin picker on event creation ([ee56b67](https://github.com/the-luap/picpeak/commit/ee56b6762f5b2eb9ea42f4abe4dde4356e2e54e6))
* **events:** Sync from Branding button in gallery theme customizer + clarified default inheritance ([bdbe7b8](https://github.com/the-luap/picpeak/commit/bdbe7b80a13b8b215ac544ba9105100e792eeda2))
* **events:** tree view for external media folder picker ([cdd40ac](https://github.com/the-luap/picpeak/commit/cdd40acb4591d4eb8f80a79c69201556eab1bfd0))
* **events:** tree view for external media folder picker ([f927b09](https://github.com/the-luap/picpeak/commit/f927b09c70f3b6a5c81c3726609a29680b96b6fc))
* **frontend:** dedupe /public/settings via shared usePublicSettings hook ([#325](https://github.com/the-luap/picpeak/issues/325)) ([3d4ae4d](https://github.com/the-luap/picpeak/commit/3d4ae4d7e9f9995d93563e8092e05215362afb3b))
* gallery layouts, bulk category editing, and hero header improvements ([7037106](https://github.com/the-luap/picpeak/commit/7037106bff62593bba600d898a781f79f07b459d))
* gallery layouts, hero customization, bulk categories & event types ([d9e00dc](https://github.com/the-luap/picpeak/commit/d9e00dc0dbd7cef0ddb4665e5306c98aac3573e3))
* gallery layouts, hero customization, event types, and UX improvements ([#146](https://github.com/the-luap/picpeak/issues/146), [#155](https://github.com/the-luap/picpeak/issues/155)-163, [#170](https://github.com/the-luap/picpeak/issues/170), [#171](https://github.com/the-luap/picpeak/issues/171)) ([4280444](https://github.com/the-luap/picpeak/commit/4280444d70e73db09e67e18ce25bac75cf499b75))
* **gallery:** decouple header style from layout, add banner option ([1f1a856](https://github.com/the-luap/picpeak/commit/1f1a856083b1966ed4b32a23a14442f1727cecef))
* **gallery:** decouple header style from layout, add banner option ([24d7277](https://github.com/the-luap/picpeak/commit/24d727752c442263a6469e0aefa666454a4c652f))
* **gallery:** decouple header style from layout, add banner option ([aff29c9](https://github.com/the-luap/picpeak/commit/aff29c91bbb250debe74e2a512047ee40e157a34))
* **gallery:** icon-only menu, accent Download CTA ([#386](https://github.com/the-luap/picpeak/issues/386)) ([876b35b](https://github.com/the-luap/picpeak/commit/876b35b4a512f70cfc19561e35ce9d915a599547))
* **gallery:** icon-only menu, accent Download CTA, logo aligned ([#386](https://github.com/the-luap/picpeak/issues/386)) ([de8ad5f](https://github.com/the-luap/picpeak/commit/de8ad5fdd5ce1b9552ca8ca6e405d15c7372a4c8))
* guest selections with per-person identity ([#292](https://github.com/the-luap/picpeak/issues/292)) ([3856ba2](https://github.com/the-luap/picpeak/commit/3856ba25bbce971b07bba4dad19e7bdceca98cab))
* guest selections with per-person identity ([#292](https://github.com/the-luap/picpeak/issues/292)) ([ad4e5a7](https://github.com/the-luap/picpeak/commit/ad4e5a7506bc9217d1223101da0bc112047532a8))
* **i18n:** add Brazilian Portuguese (pt-BR) locale ([375f512](https://github.com/the-luap/picpeak/commit/375f51285b5db9c0dfcc04761d24927282e57796))
* **i18n:** improve pt locale with pt-BR phrasings, remove duplicate pt-BR file ([f25559c](https://github.com/the-luap/picpeak/commit/f25559c0e76776f7cfe8d187e1fea05e751bbafe))
* improve gallery layouts with aspect-ratio-aware masonry and mosaic modes ([#146](https://github.com/the-luap/picpeak/issues/146)) ([aacfcd5](https://github.com/the-luap/picpeak/commit/aacfcd517ea5739e834cf84627b55b3449740a5c))
* improve hero image UX and live preview ([#163](https://github.com/the-luap/picpeak/issues/163), [#158](https://github.com/the-luap/picpeak/issues/158)) ([d63f67a](https://github.com/the-luap/picpeak/commit/d63f67a2afba1b92610382aa1012428ccacb86bd))
* multilingual email templates with translations table ([8c5996e](https://github.com/the-luap/picpeak/commit/8c5996e4ec43b2817d84cc040cfe52878ffb61d5))
* multilingual email templates with translations table ([f50d7c0](https://github.com/the-luap/picpeak/commit/f50d7c0c51aa84a2182e450cd4b6a00777a8f9c0))
* native multi-arch Docker images (Apple Silicon, ARM64 Linux) ([df30618](https://github.com/the-luap/picpeak/commit/df3061893d154152b75b8ab0d07e0b1e0078431d))
* native S3 storage backend ([#328](https://github.com/the-luap/picpeak/issues/328)) + presigned download follow-up ([1b717ce](https://github.com/the-luap/picpeak/commit/1b717ce5ededa343d2fbb7e1c3493b4434743565))
* new features and bug fixes for beta release ([151e1bf](https://github.com/the-luap/picpeak/commit/151e1bf50f206ae0571fa044c75b8bc9f0f40120))
* optional customer phone field gated by global toggle ([#322](https://github.com/the-luap/picpeak/issues/322)) ([be6cb28](https://github.com/the-luap/picpeak/commit/be6cb28c8097d2277c1af2a32cf8bc88ebbc7136))
* original filename in admin UI, update dialog, and security hardening ([3ea9d5b](https://github.com/the-luap/picpeak/commit/3ea9d5b1219980032cbee7a2564c0004948923f5))
* original filename in admin UI, update dialog, security hardening, and bug fixes ([bcf2745](https://github.com/the-luap/picpeak/commit/bcf2745ab64acb968ae4bd0710b28e78c14f340c))
* outbound webhooks for event/photo lifecycle ([#327](https://github.com/the-luap/picpeak/issues/327)) ([c488f48](https://github.com/the-luap/picpeak/commit/c488f481caacf0d63dafc47f509e8de2708bc30f))
* per-event custom logos, customizable event types, and multiple bug fixes ([4c08160](https://github.com/the-luap/picpeak/commit/4c081601e02888d7ad289acb7847aee9d6f5703f))
* photo visibility control with client access ([#172](https://github.com/the-luap/picpeak/issues/172)) ([4a93e4e](https://github.com/the-luap/picpeak/commit/4a93e4e8cbe1b7a23a8be706291a270ccdf5bb55))
* photo visibility control with client access ([#172](https://github.com/the-luap/picpeak/issues/172)) ([e1b6e43](https://github.com/the-luap/picpeak/commit/e1b6e43e524211c913d3d29ade5fc029df12920f))
* pre-generate watermarks for instant lightbox loading ([1be974a](https://github.com/the-luap/picpeak/commit/1be974afbb0b7a1bdbdd140327771907a5d3c2ae)), closes [#112](https://github.com/the-luap/picpeak/issues/112)
* pre-generated watermarks and mobile upload button improvements ([c6fdd38](https://github.com/the-luap/picpeak/commit/c6fdd38e842e1a8c0aa9cbab9fc791e6669e402d))
* pre-zip download all and photo replacement by name ([#312](https://github.com/the-luap/picpeak/issues/312), [#313](https://github.com/the-luap/picpeak/issues/313)) ([d3f1206](https://github.com/the-luap/picpeak/commit/d3f12068164a6bfe6c4a3817ad2fc2e8ed7abf4f))
* pre-zip download all and photo replacement by name ([#312](https://github.com/the-luap/picpeak/issues/312), [#313](https://github.com/the-luap/picpeak/issues/313)) ([e18afd3](https://github.com/the-luap/picpeak/commit/e18afd3e6b0b5a4cdb4873fb227d1b1d2bf35f21))
* presigned download UI + S3 prefix walker auto-importer (follow-ups) ([446d80a](https://github.com/the-luap/picpeak/commit/446d80a4cc5eb0389994e29585b2a98dad373db2))
* public v1 API + token management + OpenAPI docs ([#322](https://github.com/the-luap/picpeak/issues/322)) ([808b15b](https://github.com/the-luap/picpeak/commit/808b15bafbcdab6ea55aff7f0e507153f513a70a))
* register Russian locale and add to language selector ([6f95b8c](https://github.com/the-luap/picpeak/commit/6f95b8c26cd794525e15e45d478f9ead0ec22555))
* S3 storage + webhooks + settings dedupe + backup fixes ([06d54be](https://github.com/the-luap/picpeak/commit/06d54bec4d0afc4a1b9ba6f2449ed7d79f1d3e8f))
* show original filename in admin UI ([#184](https://github.com/the-luap/picpeak/issues/184)) ([0891be1](https://github.com/the-luap/picpeak/commit/0891be197fdb7d92ade5a293b8db0bed26fa6e3a))
* sort photos by capture date with configurable default sort ([#283](https://github.com/the-luap/picpeak/issues/283)) ([8805fa5](https://github.com/the-luap/picpeak/commit/8805fa53e61c6b3672a8f6dad14d2fd17998a451))
* sort photos by capture date with configurable default sort ([#283](https://github.com/the-luap/picpeak/issues/283)) ([633d4a0](https://github.com/the-luap/picpeak/commit/633d4a0f301e355ee9f057347f2f8dee8c5b4163))
* support Apple Silicon natively via multi-arch images ([c282a72](https://github.com/the-luap/picpeak/commit/c282a72bd35db062cec25770a42cf9c803388e44))
* **theme:** expand color settings to 8-token CI palette + alt button ([114aab5](https://github.com/the-luap/picpeak/commit/114aab57771a4bba03a9e5c616c75a37c9b25969))
* **upload:** async photo processing — backend (PR-B part 1) ([851744c](https://github.com/the-luap/picpeak/commit/851744c3c4df7deba8d946b6592fdb5042c52a26))
* **upload:** async photo processing — frontend (PR-B part 2) ([3b827b8](https://github.com/the-luap/picpeak/commit/3b827b80d51269e1a7b9c693396f3cb7a9a48ffc))
* **upload:** async photo processing + fix(auth): /auth/session symmetry (loop fix) ([907bcf1](https://github.com/the-luap/picpeak/commit/907bcf1eb2d44ded149a1caf39ee1cfe63fec994))
* **upload:** two-state UI + temp dir cleanup (PR-A of async processing) ([86dfcc4](https://github.com/the-luap/picpeak/commit/86dfcc4f116a394e7e092ab3e01f3f1d030bb367))
* visual WYSIWYG email template editor ([703c03f](https://github.com/the-luap/picpeak/commit/703c03fbee754a5291b57b885c5e82fbdd3e69e9))
* warn about low thumbnail resolution when selecting beta themes ([ee3f6ae](https://github.com/the-luap/picpeak/commit/ee3f6ae13bf9c9fb3295286e84150e04bf9fbce4))
* warn about low thumbnail resolution with beta themes ([aef9b4e](https://github.com/the-luap/picpeak/commit/aef9b4ed7fc443cbec8890c580759077e05e77b4))
* **webhooks:** enrich event.* payloads with customer contact + share_token ([#341](https://github.com/the-luap/picpeak/issues/341)) ([7ea4801](https://github.com/the-luap/picpeak/commit/7ea4801544fd5cd8bca1907a71b5c4e96ee77649))
* **webhooks:** enrich event.* payloads with customer contact + share_token ([#341](https://github.com/the-luap/picpeak/issues/341)) ([1e69d5f](https://github.com/the-luap/picpeak/commit/1e69d5ff71ac2d1d133b0e40637b437d7cc8bc4f))


### Bug Fixes

* add allow_user_uploads to gallery API responses ([691e3ab](https://github.com/the-luap/picpeak/commit/691e3aba09f2148afe902a0bb0139d062634e669))
* add lightbox loading spinner and watermark cache invalidation ([050ed37](https://github.com/the-luap/picpeak/commit/050ed378199eb3b15c7c7f243792f68f858803f5))
* add STORAGE_PATH to production docker-compose ([cdda709](https://github.com/the-luap/picpeak/commit/cdda70988664a177b351abc6a259ec39664d17ff))
* address beta feedback - gallery layout fixes, Russian locale, email logo ([#249](https://github.com/the-luap/picpeak/issues/249)) ([486239a](https://github.com/the-luap/picpeak/commit/486239aeb9b5f56551d5aa90f0bad3008eedc3bb))
* address bugs and feature requests from discussion [#317](https://github.com/the-luap/picpeak/issues/317) ([6cfff6f](https://github.com/the-luap/picpeak/commit/6cfff6f6a6dbdc5bc1e9fe4fbce5795cdb1855c6))
* address Shannon security assessment findings (37 vulnerabilities) ([#254](https://github.com/the-luap/picpeak/issues/254)) ([23cd9cb](https://github.com/the-luap/picpeak/commit/23cd9cb680eb77b94a97266c3353dfc835f0cc69))
* admin photo feedback filters have no effect ([#293](https://github.com/the-luap/picpeak/issues/293)) ([9ed8a2b](https://github.com/the-luap/picpeak/commit/9ed8a2b1994d139efd100c8fb97e6368655e5530))
* **admin:** tab underlines use accent (not accent-dark) for proper highlight color ([565ae45](https://github.com/the-luap/picpeak/commit/565ae45ca71e46166c8bbfc0eb0b6da92d74f120))
* apply password change fix to regular modal + longer toast delay ([#263](https://github.com/the-luap/picpeak/issues/263)) ([c63bc47](https://github.com/the-luap/picpeak/commit/c63bc47089b4b32c570bdeeb1f82bf722569875f))
* apply password change redirect fix to regular modal too ([#263](https://github.com/the-luap/picpeak/issues/263)) ([147dc28](https://github.com/the-luap/picpeak/commit/147dc28440ca69ed970677fa221dfac00c8e2560))
* apply sort direction in gallery and respect show_feedback_to_guests ([#302](https://github.com/the-luap/picpeak/issues/302), [#303](https://github.com/the-luap/picpeak/issues/303)) ([3716ff5](https://github.com/the-luap/picpeak/commit/3716ff50854766bde588fbd6b9027f8647e59150))
* apply sort direction in gallery view and respect show_feedback_to_guests ([#302](https://github.com/the-luap/picpeak/issues/302), [#303](https://github.com/the-luap/picpeak/issues/303)) ([dffe057](https://github.com/the-luap/picpeak/commit/dffe057772c922ab6a213e25f171157e0c2badf8))
* **auth:** /auth/session must enforce session timeout symmetrically ([#350](https://github.com/the-luap/picpeak/issues/350) recurrence) ([c8e09c2](https://github.com/the-luap/picpeak/commit/c8e09c2a2a7d0920901560317eecd773b83251c0))
* **auth:** /auth/session must enforce session timeout symmetrically ([#350](https://github.com/the-luap/picpeak/issues/350) recurrence) ([b106da1](https://github.com/the-luap/picpeak/commit/b106da1ededa27fc8727f2c0e74a9182e6e9c895))
* **auth:** /auth/session must reject tokens that adminAuth/galleryAuth would reject ([f905f7e](https://github.com/the-luap/picpeak/commit/f905f7e7336c756e73a8c650c9239b171697164a))
* **auth:** /auth/session must verify issuer claim like adminAuth ([#350](https://github.com/the-luap/picpeak/issues/350)) ([83dedbc](https://github.com/the-luap/picpeak/commit/83dedbcd45e34a924594dd83f6e3561f776576fb))
* **auth:** make /auth/session verify the issuer claim like adminAuth ([#350](https://github.com/the-luap/picpeak/issues/350)) ([88a6c6a](https://github.com/the-luap/picpeak/commit/88a6c6a7fba7e1419a021f4870518f0b76ac6494))
* **backup:** cron schedule mapping + manifest format detection + bigint coerce ([ab4095f](https://github.com/the-luap/picpeak/commit/ab4095f5928b1476009cddfd3444d6f5b58b034d))
* **backup:** incremental backups against S3 + jsonb stats parsing ([e232f9f](https://github.com/the-luap/picpeak/commit/e232f9f2cf54aeba1e16d769397428206a0f1801))
* **branding:** admin sidebar uses accent-dark, primary buttons follow CI token ([fc2bce3](https://github.com/the-luap/picpeak/commit/fc2bce3a01f02b2d131ca4ce1c8e81fc9dc62755))
* **branding:** comprehensive sweep — replace remaining primary-* legacy colors with accent tokens ([578a174](https://github.com/the-luap/picpeak/commit/578a1745b8d010eeeb261d3452fd192b1ec7bcf8))
* **branding:** selected-state accent colors, force-mode actually flips galleries, compact color picker layout ([5b410ed](https://github.com/the-luap/picpeak/commit/5b410ed9f87daad8e96345a86897f2a9e9419802))
* **branding:** working tooltips, high-contrast selected states, gallery chrome follows accent ([b19bb0c](https://github.com/the-luap/picpeak/commit/b19bb0c6208744f329cb3e99f4e26a83f191710a))
* checkbox and toggle settings not persisting after page refresh ([808ed1d](https://github.com/the-luap/picpeak/commit/808ed1d2f1164d9fd1114586c68a1f925bf73ddf)), closes [#117](https://github.com/the-luap/picpeak/issues/117)
* **cms:** apply dark mode to CMS editor, public CMS, and admin modals ([d2a10f6](https://github.com/the-luap/picpeak/commit/d2a10f6523655488267d6f68835d7adb46dcf962))
* **cms:** nl/pt/ru i18n + gate external_url in public response ([08d0462](https://github.com/the-luap/picpeak/commit/08d046276bf259e8511b01415141f51b8484f967))
* **cms:** nl/pt/ru i18n + gate external_url in public response ([bce5c1f](https://github.com/the-luap/picpeak/commit/bce5c1f725043965c2499515f18e93e9578bd204))
* correct invitation activation validation and add missing translations ([991aa98](https://github.com/the-luap/picpeak/commit/991aa98f98cffd1d7785c272726615325e2c0208)), closes [#129](https://github.com/the-luap/picpeak/issues/129)
* correct invitation email link URL path ([86fa104](https://github.com/the-luap/picpeak/commit/86fa1046d5439cb451feb164175c919c49ca219a)), closes [#129](https://github.com/the-luap/picpeak/issues/129)
* correct storage path resolution in multiple files ([#96](https://github.com/the-luap/picpeak/issues/96)) ([0e3674b](https://github.com/the-luap/picpeak/commit/0e3674b2b0325bbcee5aa2c9ff7781da92f612d1))
* correct storage path resolution in multiple files ([#96](https://github.com/the-luap/picpeak/issues/96)) ([3ccb815](https://github.com/the-luap/picpeak/commit/3ccb8154eb40a432aa467fb06b3f216fd0d2c6b4))
* database migration restart bug, lightbox loading spinner, and watermark cache invalidation ([7c58749](https://github.com/the-luap/picpeak/commit/7c5874980640ae8c3d1050ce24daeb0a2aeab7a3))
* dedupe parallel admin 401 redirects to /admin/login ([038e84c](https://github.com/the-luap/picpeak/commit/038e84cae7f56a0a1af8c71b85881ca5d320c6e3))
* discussion [#317](https://github.com/the-luap/picpeak/issues/317) issues and [#318](https://github.com/the-luap/picpeak/issues/318) archive crash ([2f2f405](https://github.com/the-luap/picpeak/commit/2f2f405d9bc2831b3bbe2ca7fbf726d61382dc38))
* display welcome message in gallery and fix guest thumbnail URLs ([#306](https://github.com/the-luap/picpeak/issues/306), [#307](https://github.com/the-luap/picpeak/issues/307)) ([b05c36a](https://github.com/the-luap/picpeak/commit/b05c36ac810a557a2ac088ab7bec39bb76f9a2ae))
* display welcome message in gallery and fix guest thumbnail URLs ([#306](https://github.com/the-luap/picpeak/issues/306), [#307](https://github.com/the-luap/picpeak/issues/307)) ([9323bef](https://github.com/the-luap/picpeak/commit/9323befdd99d64b85cca89af24ac1b7034d72eee))
* docker compose v2 syntax and add missing ADMIN_PASSWORD to .env.example ([#189](https://github.com/the-luap/picpeak/issues/189)) ([0817443](https://github.com/the-luap/picpeak/commit/0817443e793e37c770c6a1968ecae4b9464107b0))
* **docker:** install system ffmpeg on Alpine, drop broken bundled binary ([3ab8a64](https://github.com/the-luap/picpeak/commit/3ab8a64a24f1600e674f77d39139e33857b4dfc8))
* **docker:** install system ffmpeg on Alpine, drop broken bundled binary ([96818c7](https://github.com/the-luap/picpeak/commit/96818c7ae8de0d8fd478cd901ea25a3272eee85d))
* dynamic website title from branding settings ([4701edc](https://github.com/the-luap/picpeak/commit/4701edc12ecfab27cb2d1cfb0b4ed4fd53f56cc6))
* **email:** render conditionals, localise password placeholders, fix caller/template variable drift ([0767203](https://github.com/the-luap/picpeak/commit/07672038d4ac31fc601adfb2338104223856ba71))
* **email:** render conditionals, localise password placeholders, fix caller/template variable drift ([e8052ad](https://github.com/the-luap/picpeak/commit/e8052adf1d2f1717652ac5d6b8cd8bcc01787189))
* event-specific custom CSS settings not being saved ([dadef81](https://github.com/the-luap/picpeak/commit/dadef81158972d28aa32812203500f77ed08a999)), closes [#136](https://github.com/the-luap/picpeak/issues/136)
* events search/counters ([#346](https://github.com/the-luap/picpeak/issues/346)), lazy gallery skeleton ([#321](https://github.com/the-luap/picpeak/issues/321)), smooth lightbox swipe ([#348](https://github.com/the-luap/picpeak/issues/348)) ([6229b38](https://github.com/the-luap/picpeak/commit/6229b38bac90cc0c538a72688efae3be77a3bb08))
* events without expiration date incorrectly shown as expired ([c4f16eb](https://github.com/the-luap/picpeak/commit/c4f16eb76c909158abdb63aa4cc22f817f274dc5))
* **events:** admin-set password on reset, full-URL gallery_link in all emails ([0d1f82d](https://github.com/the-luap/picpeak/commit/0d1f82d31a2f9e30bf193496ac203eaf8dfd856b))
* **events:** admin-set password on reset, full-URL gallery_link in all emails ([ff50c74](https://github.com/the-luap/picpeak/commit/ff50c74e1912ccba60f7ccdbead92b76de91388b))
* **events:** coerce expires_in_days to Number before addDays ([e5712d8](https://github.com/the-luap/picpeak/commit/e5712d8ffe2f0ed980e1df5e1263876af7202b76))
* **events:** coerce expires_in_days to Number before addDays ([db29d0e](https://github.com/the-luap/picpeak/commit/db29d0e2788f63cc9eb0a43ec58313387acb0c0d))
* **events:** match scrollbar to theme in external folder tree picker ([bd42ee1](https://github.com/the-luap/picpeak/commit/bd42ee1ce03b8f6e7b011b53f2c71453be931cc6))
* **events:** server-side search/pagination to remove first-100 cap ([#346](https://github.com/the-luap/picpeak/issues/346)) ([a5b20ca](https://github.com/the-luap/picpeak/commit/a5b20ca3fe77df665d4a9744413d7ee4054858f0))
* **events:** show customer phone in event details view ([#331](https://github.com/the-luap/picpeak/issues/331)) ([4c73d22](https://github.com/the-luap/picpeak/commit/4c73d228ed98b8ec05bec2824aee7ce066a184e1))
* **events:** stop mapping branding_logo_position onto hero_logo_position ([af2b062](https://github.com/the-luap/picpeak/commit/af2b0628cb4f79a147366665d35c098012071216))
* **events:** stop mapping branding_logo_position onto hero_logo_position ([ef1c875](https://github.com/the-luap/picpeak/commit/ef1c875f6ec1e02657006cb09cd0b1d868ec2fc0))
* external media dimensions, theme race condition, email color customization ([dfae2c2](https://github.com/the-luap/picpeak/commit/dfae2c2bc6d86378c553cd847b439f7cb53a4f2a))
* floor password_changed_at when comparing against JWT iat ([793e410](https://github.com/the-luap/picpeak/commit/793e410554b461522fbe24014dfd3baa915da2bb))
* **fonts:** drop immutable Cache-Control to allow font replacement rollout ([5703fcb](https://github.com/the-luap/picpeak/commit/5703fcb80680155e3b637dd5fc15c430de963c40))
* **gallery:** default controls to inline for every layout ([045e9ea](https://github.com/the-luap/picpeak/commit/045e9ea4861f33e3e82e31f978ac297c7f7824f6))
* **gallery:** lazy-render skeleton grid for fast loads ([#321](https://github.com/the-luap/picpeak/issues/321) follow-up) ([d9d8137](https://github.com/the-luap/picpeak/commit/d9d81372b80f7d44dca54b7993f52c36574048c9))
* **gallery:** preserve sidebar controlsStyle on banner migration ([05dadff](https://github.com/the-luap/picpeak/commit/05dadff4934ad9b055de8875846c2a7175e16f86))
* **gallery:** single-finger swipe nav in mobile lightbox ([#332](https://github.com/the-luap/picpeak/issues/332)) ([4c8eba0](https://github.com/the-luap/picpeak/commit/4c8eba0cb43635d92a53d90c58b19007136c1c12))
* **gallery:** use ref for swipe-start to avoid stale-closure miss ([#332](https://github.com/the-luap/picpeak/issues/332)) ([fcddfe0](https://github.com/the-luap/picpeak/commit/fcddfe094b2a01963f7b420afa886e7d5dae4390))
* **gallery:** WCAG-safe Download button text + extract HeaderDownloadButton ([#401](https://github.com/the-luap/picpeak/issues/401) follow-ups) ([04e928d](https://github.com/the-luap/picpeak/commit/04e928d7621743d9d99797f0996f8c7aa50e7b2d))
* **gallery:** WCAG-safe Download button text + extract HeaderDownloadButton ([#401](https://github.com/the-luap/picpeak/issues/401) follow-ups) ([0c80abd](https://github.com/the-luap/picpeak/commit/0c80abd57b806b9df01429a093c30c12c80c0601))
* guest feedback flow bugs in Masonry grid and PhotoLightbox ([#292](https://github.com/the-luap/picpeak/issues/292)) ([54badef](https://github.com/the-luap/picpeak/commit/54badefc51b834d55530722f87c81a6ade33e35b))
* guest feedback flow bugs in Masonry grid and PhotoLightbox ([#292](https://github.com/the-luap/picpeak/issues/292)) ([77f07e9](https://github.com/the-luap/picpeak/commit/77f07e9329e47f6ac5040f2e85d2710ebbea3ced))
* handle null dates in dashboard and gallery pages ([c5a8ffc](https://github.com/the-luap/picpeak/commit/c5a8ffc08cd4c53c37fe4fb9cde8519a68f1f343))
* hero header state and preview in admin theme editor ([#158](https://github.com/the-luap/picpeak/issues/158)) ([f554f46](https://github.com/the-luap/picpeak/commit/f554f463b3492346dba067c0980b52ef42dd5e70))
* improve ghost button visibility in admin dark mode ([4912e2b](https://github.com/the-luap/picpeak/commit/4912e2bccf282134d5598a8ac80942ed46d0523c))
* improve password validation errors and event list UX ([#170](https://github.com/the-luap/picpeak/issues/170), [#171](https://github.com/the-luap/picpeak/issues/171)) ([171abb3](https://github.com/the-luap/picpeak/commit/171abb31615484d77cf95a99cb5634afa0160adc))
* improve photo serving, category filters, and upload chunking ([#155](https://github.com/the-luap/picpeak/issues/155), [#156](https://github.com/the-luap/picpeak/issues/156), [#161](https://github.com/the-luap/picpeak/issues/161)) ([fa4c838](https://github.com/the-luap/picpeak/commit/fa4c83812d87cfa63394e51186e320a072929d37))
* increase upload limit to 1GB and fix category filters ([#155](https://github.com/the-luap/picpeak/issues/155), [#156](https://github.com/the-luap/picpeak/issues/156)) ([397d33a](https://github.com/the-luap/picpeak/commit/397d33a95a09e0b0986c3f6cf5965c544992a764))
* issue [#203](https://github.com/the-luap/picpeak/issues/203) file type validation + security CVE fixes ([8017171](https://github.com/the-luap/picpeak/commit/80171713e0ffedda56f7cffb403b25a8d55634d1))
* **lightbox:** mobile toolbar clipping + iOS safe-area + viewport-fit ([#336](https://github.com/the-luap/picpeak/issues/336)) ([42a7ae4](https://github.com/the-luap/picpeak/commit/42a7ae4be8fe7b12104ae036465c9c4117606378))
* **lightbox:** smooth carousel swipe + drop instructional hint ([#348](https://github.com/the-luap/picpeak/issues/348)) ([743086d](https://github.com/the-luap/picpeak/commit/743086d3cb9100fb163bc9d04d968e5b611a1f99))
* mobile lightbox + share previews + customer phone bug triage ([1e40677](https://github.com/the-luap/picpeak/commit/1e4067713ce9a808a7b49319bc262e5c9a6599c6))
* mobile upload button not visible in gallery ([#113](https://github.com/the-luap/picpeak/issues/113)) ([cacaffa](https://github.com/the-luap/picpeak/commit/cacaffa5c39f67105c4cfb092ea62157121fb72e))
* mobile upload button visibility in gallery ([2a2c23d](https://github.com/the-luap/picpeak/commit/2a2c23d11610e6c81684163eb4ea934a6d6104fb)), closes [#113](https://github.com/the-luap/picpeak/issues/113)
* mobile upload button visibility in gallery ([df7dbff](https://github.com/the-luap/picpeak/commit/df7dbffbffb180e62af0d2b58326f9de0f515439)), closes [#113](https://github.com/the-luap/picpeak/issues/113)
* mobile upload button visibility in gallery ([#113](https://github.com/the-luap/picpeak/issues/113)) ([05a5307](https://github.com/the-luap/picpeak/commit/05a5307e22dc45be4b75b2996ff9fac65dec399d))
* mobile upload button visibility in gallery ([#113](https://github.com/the-luap/picpeak/issues/113)) ([6cb4342](https://github.com/the-luap/picpeak/commit/6cb43428d1e703267edeacda9ede050a8c4f8e0c))
* **nginx:** proxy /fonts requests to backend ([e6c03e4](https://github.com/the-luap/picpeak/commit/e6c03e4b6e4ee2ccc3e3cd8b7a54c18f9685c2ba))
* pin npm to v10 in backend Dockerfile ([ddefd3a](https://github.com/the-luap/picpeak/commit/ddefd3a95e5047d4a22aa4b6fef57dfb1c880967))
* pin npm upgrade to v10 in backend Dockerfile ([978e447](https://github.com/the-luap/picpeak/commit/978e4473b5227ee61ad7d17487063eb3284bea36))
* prevent backend crash on archive when admin_email is null ([#318](https://github.com/the-luap/picpeak/issues/318)) ([e4b0f96](https://github.com/the-luap/picpeak/commit/e4b0f961b75952b6907cc2291fa256215c09c80c))
* prevent database migration restart failures ([83a4344](https://github.com/the-luap/picpeak/commit/83a4344a01de4f65c5024fdf2d177a04457ccd2f)), closes [#107](https://github.com/the-luap/picpeak/issues/107)
* remove non-functional watermark toggle from Feature Toggles ([d4a15db](https://github.com/the-luap/picpeak/commit/d4a15dbe74d0d70bbe6ff03362dc7337fb8f4c5c))
* render minimal/none header styles, cap hero height, switch category hero images ([#158](https://github.com/the-luap/picpeak/issues/158), [#162](https://github.com/the-luap/picpeak/issues/162), [#163](https://github.com/the-luap/picpeak/issues/163)) ([bc6c48b](https://github.com/the-luap/picpeak/commit/bc6c48bb2429505c2de3641693a8ff4f623a4951))
* resend gallery email fails for events without password ([6b3ead7](https://github.com/the-luap/picpeak/commit/6b3ead747b1395d8ea2b3d135a5ac24db05e2eb8)), closes [#137](https://github.com/the-luap/picpeak/issues/137)
* resolve admin invitation flow issues and improve STORAGE_PATH documentation ([41bf6ff](https://github.com/the-luap/picpeak/commit/41bf6ff884d5ef3181f95f3aa4a528434c23947a))
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
* revert /api prefix in adminPhotos.js to avoid double-prefix ([094276d](https://github.com/the-luap/picpeak/commit/094276d3cc7117eee30e4bcbce487e54f0eacb29))
* revert /api prefix in adminPhotos.js to avoid double-prefix ([#307](https://github.com/the-luap/picpeak/issues/307)) ([ceb2a09](https://github.com/the-luap/picpeak/commit/ceb2a09f483b4754fda232c5c1f7acb8971aac10))
* **security:** invalidate tokens on password change, enforce session timeout, fix role update ([85a60a2](https://github.com/the-luap/picpeak/commit/85a60a2dc7526aa6b673e2a04e9fdfba7de7117f))
* **security:** invalidate tokens on password change, enforce session timeout, fix role update ([f362239](https://github.com/the-luap/picpeak/commit/f3622396e77ce5d0b0741e439fc554a1dccaca50))
* **security:** resolve all npm audit vulnerabilities ([4272618](https://github.com/the-luap/picpeak/commit/4272618b3f7fcb06aaca14fb724a6a7733251f24))
* **security:** resolve Docker image CVEs for code scanning alerts ([cbecb93](https://github.com/the-luap/picpeak/commit/cbecb9323cf4b80c800326de14f6df73f60147c1))
* **security:** token invalidation on password change, session timeout enforcement ([0a3a537](https://github.com/the-luap/picpeak/commit/0a3a53763c9f3caef9fdceccf9fdbfdefe9bd8bf))
* **security:** token invalidation on password change, session timeout enforcement ([7ca9631](https://github.com/the-luap/picpeak/commit/7ca96315e254eef58d8ecc505f95a5186d2fa2da))
* set JWT iat after password_changed_at to prevent token rejection ([#263](https://github.com/the-luap/picpeak/issues/263)) ([b1d1667](https://github.com/the-luap/picpeak/commit/b1d16670d56e19f7b35e7f2f12f3611fdb3fab58))
* **share:** OG/Twitter-card metadata for gallery share URLs ([#333](https://github.com/the-luap/picpeak/issues/333)) ([5275621](https://github.com/the-luap/picpeak/commit/5275621fcd38f1ec09b54595163ecd5e63614b1a))
* shorten Save button label on email template editor ([7250c42](https://github.com/the-luap/picpeak/commit/7250c427b905ffa3e8696dff607450f5a0b801b8))
* show upload button in mobile topbar instead of sidebar ([ae181cf](https://github.com/the-luap/picpeak/commit/ae181cf92fc9c1e85cad7a7b843a4d83cec636ac)), closes [#113](https://github.com/the-luap/picpeak/issues/113)
* sync backend package-lock.json for security deps ([bb81fa5](https://github.com/the-luap/picpeak/commit/bb81fa5f4b5f1bd927a02470ce80a13c4f53443f))
* sync backend package-lock.json with security dep updates ([03e1989](https://github.com/the-luap/picpeak/commit/03e19893b3532a27aa59e7b834d53c6a2b52b7cd))
* sync header_style DB column with theme editor selections ([#158](https://github.com/the-luap/picpeak/issues/158)) ([2288309](https://github.com/the-luap/picpeak/commit/228830939553fd32c250704bb89a8ce233324d25))
* sync header_style DB column with theme editor selections ([#158](https://github.com/the-luap/picpeak/issues/158)) ([a19e7c4](https://github.com/the-luap/picpeak/commit/a19e7c40a200ff822c947a83349ed07ccf4e1b01))
* theme picker buttons no longer submit the parent form ([#326](https://github.com/the-luap/picpeak/issues/326)) ([2eead52](https://github.com/the-luap/picpeak/commit/2eead523193ccb7f23eb767097ad9698e8312833))
* theme save without Live Preview, Branding default on new events, gallery loading flicker ([#323](https://github.com/the-luap/picpeak/issues/323), [#321](https://github.com/the-luap/picpeak/issues/321)) ([822be9a](https://github.com/the-luap/picpeak/commit/822be9a9b2716f1832a4cb6fccd53602e3cbab51))
* theme-preset match loop ignores extra fields like logoUrl ([#323](https://github.com/the-luap/picpeak/issues/323)) ([b63a877](https://github.com/the-luap/picpeak/commit/b63a8774c4b44733b903736b2ca5a472a884055e))
* **theme:** centralise force-mode enforcement inside ThemeContext so every gallery flips ([21188f4](https://github.com/the-luap/picpeak/commit/21188f48d76dd29bc1251bcc6faf9d6d96c805b5))
* **theme:** kill initial white frame + theme-aware skeleton tiles ([#358](https://github.com/the-luap/picpeak/issues/358) follow-up) ([f529c9e](https://github.com/the-luap/picpeak/commit/f529c9e3d72f0e3496951dfa5d160afda9a1ac51))
* **theme:** kill initial white frame + theme-aware skeleton tiles ([#358](https://github.com/the-luap/picpeak/issues/358) follow-up) ([1a530ae](https://github.com/the-luap/picpeak/commit/1a530aeaa2d61b34d9721a555b71631c7101c58e))
* **theme:** pre-React bootstrap to kill white-flash on dark galleries ([#358](https://github.com/the-luap/picpeak/issues/358)) ([07b41e6](https://github.com/the-luap/picpeak/commit/07b41e691d2e8a71f775c667d805a2f9adc10590))
* **theme:** pre-React bootstrap to kill white-flash on dark galleries ([#358](https://github.com/the-luap/picpeak/issues/358)) ([f81a872](https://github.com/the-luap/picpeak/commit/f81a8728e67b313ac43f55c94fb635abf9beca05))
* update dependencies to resolve code scanning security alerts ([1f524f2](https://github.com/the-luap/picpeak/commit/1f524f23580d2e2a21dbba28cb46aed76e85c475))
* update docker-compose to docker compose and add ADMIN_PASSWORD to .env.example ([#189](https://github.com/the-luap/picpeak/issues/189)) ([a4c6248](https://github.com/the-luap/picpeak/commit/a4c624802b2926a16adcf0472a3041562f9b2f48))
* update packages to fix security vulnerabilities ([8097a0c](https://github.com/the-luap/picpeak/commit/8097a0cb530bd8003597cde81606231efadb0bf5))
* update security policy with private reporting channels ([308e086](https://github.com/the-luap/picpeak/commit/308e08626383bab213ce3eb5563608dff6168ef4))
* update security policy with private reporting channels ([7f77362](https://github.com/the-luap/picpeak/commit/7f7736282f534adf4b9d5331d841a1f0bff7341c))
* update security policy with proper contact email and private reporting ([67b0f32](https://github.com/the-luap/picpeak/commit/67b0f32456d0216e4c685a104c680fa5a5fd578f)), closes [#223](https://github.com/the-luap/picpeak/issues/223)
* use actual photo aspect ratios in masonry columns mode ([#146](https://github.com/the-luap/picpeak/issues/146)) ([8711f96](https://github.com/the-luap/picpeak/commit/8711f967a15f5d57f6ad01bfdbd8d33f9ee96abc))
* use CSS Columns for gap-free mosaic layout ([#146](https://github.com/the-luap/picpeak/issues/146)) ([821d329](https://github.com/the-luap/picpeak/commit/821d3296ea4b6bde499e5497d258f15ab8dd1dbc))
* use photo dimensions for mosaic aspect ratios ([#146](https://github.com/the-luap/picpeak/issues/146)) ([27ff51e](https://github.com/the-luap/picpeak/commit/27ff51e7a1217848859b47940bc88caa6f1fb20f))
* video upload media type, select all, and dimension repair ([#203](https://github.com/the-luap/picpeak/issues/203), [#220](https://github.com/the-luap/picpeak/issues/220), [#180](https://github.com/the-luap/picpeak/issues/180)) ([fc75bcd](https://github.com/the-luap/picpeak/commit/fc75bcdfc38673d6e4dd1cd943cfb4638d3a306c))
* video upload, select all, and dimension repair ([#203](https://github.com/the-luap/picpeak/issues/203), [#220](https://github.com/the-luap/picpeak/issues/220), [#180](https://github.com/the-luap/picpeak/issues/180)) ([a0bb080](https://github.com/the-luap/picpeak/commit/a0bb0805868e742f323b64312c3c5ef8ec408f68))
* wire admin photo feedback filters into grid query ([#293](https://github.com/the-luap/picpeak/issues/293)) ([d4b4dc6](https://github.com/the-luap/picpeak/commit/d4b4dc628f28a303ff1c80ba6d8e5e768217ba51))
* wrap email preview with full styled header/footer template ([9a6d2e8](https://github.com/the-luap/picpeak/commit/9a6d2e8e3a3fab8d7969a8a42e94934c38d88392))
* wrap email preview with full styled header/footer template ([fc0911a](https://github.com/the-luap/picpeak/commit/fc0911acf8b7c8a18d71bb4267f1086acd1e0ca1)), closes [#229](https://github.com/the-luap/picpeak/issues/229)
* wrap test email with standard email template ([#252](https://github.com/the-luap/picpeak/issues/252)) ([954a011](https://github.com/the-luap/picpeak/commit/954a0118bae5770c74f1e811e03b8fc702c70db2))


### Reverts

* **branding:** per-option font preview (defer to follow-up) ([f410207](https://github.com/the-luap/picpeak/commit/f410207b2d7ddf1c9525603c7dcbb7cdfee1729b))


### Documentation

* add API_URL environment variable to .env.example files ([3e69579](https://github.com/the-luap/picpeak/commit/3e69579f5a171b31a253b2a42bb033bf1b97387d))
* add Buy Me a Coffee badge + Support section ([46bc894](https://github.com/the-luap/picpeak/commit/46bc894d917bd55dbd9bafaa64fd38db21488b81))
* add External Media Library section to deployment guide ([#270](https://github.com/the-luap/picpeak/issues/270)) ([2e1c71c](https://github.com/the-luap/picpeak/commit/2e1c71c1ab073e488ac93e35337a2d3955dfef3d))
* add External Media Library section to deployment guide ([#270](https://github.com/the-luap/picpeak/issues/270)) ([f6ca713](https://github.com/the-luap/picpeak/commit/f6ca713a6edc8ba371db790daba05ecb85ea4872))
* clarify file system photo import requires existing event ([#269](https://github.com/the-luap/picpeak/issues/269)) ([5295516](https://github.com/the-luap/picpeak/commit/5295516b67a1d9f035564c5f9a724f25f8d21c78))
* clarify file system photo import requires existing event ([#269](https://github.com/the-luap/picpeak/issues/269)) ([ee0baaf](https://github.com/the-luap/picpeak/commit/ee0baafc59f3588a26172aa8835c12dcaec35d10))
* emphasize importance of STORAGE_PATH in env example ([3397807](https://github.com/the-luap/picpeak/commit/3397807670784e02cbe34a7a60db43c95d64f19c))
* **fonts:** cache rollout, stale-list note, meta.json ([bd0e052](https://github.com/the-luap/picpeak/commit/bd0e052b1a1847718151a16117dacc6c42a2178e))
* move documentation to docs.picpeak.app, drop in-repo copies ([02ed5d4](https://github.com/the-luap/picpeak/commit/02ed5d400736f966283a138dedde2455448067ff))
* move documentation to docs.picpeak.app, drop in-repo copies ([0faf9b3](https://github.com/the-luap/picpeak/commit/0faf9b32816f5f94aa584d2336cdb1e0b7082239))
* **readme:** add Contributors section with @Luca-Timo and @Rekoo-PS ([c60ab74](https://github.com/the-luap/picpeak/commit/c60ab74ae2daabc4b11fea1f1b2df728294b03c8))
* **readme:** add Contributors section with @Luca-Timo and @Rekoo-PS ([dbe0a30](https://github.com/the-luap/picpeak/commit/dbe0a3055bd2c71981cb7d9cf43c2b22b9e3276c))
* rewrite README — shorter, cleaner ([62643f2](https://github.com/the-luap/picpeak/commit/62643f241b51dc1620e30a8c8767f52428c0314c))
* rewrite README — shorter, cleaner, less AI-sounding ([64f6061](https://github.com/the-luap/picpeak/commit/64f606152fde2db9034fa9ffa08cc58623edf646))

## [3.42.1](https://github.com/the-luap/picpeak/compare/v2.6.5...v3.42.1) (2026-05-07)

Stable release promoting the entire `beta` channel to `main`. Brings ~300 commits of features, fixes, and infrastructure improvements that have been baked on the beta channel since v2.6.5. Highlights below; full per-version notes follow in the beta history.

### Major themes since v2.6.5

* **Multi-administrator support with RBAC** — super admin / admin / editor roles, fine-grained permissions
* **Async upload pipeline** — bytes-on-wire returns 202; sharp/ffmpeg/EXIF/watermark/webhooks happen in a background worker pool
* **Self-hosted webfonts** — filesystem-driven scanner, GDPR-compliant, replaces Google Fonts CDN
* **8-token CI palette + force color mode** — full theme customization across admin and public site
* **Native multi-arch Docker images** — Apple Silicon and ARM64 Linux supported natively
* **Native S3 storage backend** — S3 + S3-compatible providers
* **Comprehensive video support** — upload, stream, and play MP4/WebM/MOV alongside photos
* **Outbound webhooks** — event/photo lifecycle push API with HMAC signatures
* **Gallery layout system** — decoupled header style from layout, banner option, theme-aware skeletons, and lazy-loaded folder picker
* **Multilingual email templates** — translations table for EN/DE/NL/PT/RU
* **Bulk operations** — bulk delete with password confirmation, bulk archive
* **Photo dimensions backfill** — true masonry layout with portrait/landscape sizing
* **Customer client access** — separate review/visibility area before the gallery is shared with guests
* **Image security** — devtools detection, watermarking, right-click prevention, secure thumbnails

### Bug fixes (highlights from beta)

* `/auth/session` symmetry fixes for the admin-login redirect-loop family (#350, #355, #363, #398)
* Email template renderer: handle `{{#if}}` conditionals, fix CSS leak in plain-text fallback, gate publish-from-draft password placeholder, gate `external_url` in public response
* Customer email caller/template variable drift across gallery_created, expiration_warning, archive_complete, gallery_expired
* Full-URL `gallery_link` in all email types (was path-only in 3 sites)
* ffmpeg/ffprobe installed via apk for Alpine compatibility (was glibc-bundled binary)
* Theme-aware skeleton tiles, dark theme white-flash on first paint
* Admin events search and counters not bounded to first 100 records (#346)
* Login redirect loop with stale admin cookies (#350) — three rounds of asymmetry fixes

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

---

# Pre-3.x history (main 2.x channel)

## [2.6.5](https://github.com/the-luap/picpeak/compare/v2.6.4...v2.6.5) (2026-04-08)


### Documentation

* rewrite README — shorter, cleaner ([62643f2](https://github.com/the-luap/picpeak/commit/62643f241b51dc1620e30a8c8767f52428c0314c))
* rewrite README — shorter, cleaner, less AI-sounding ([64f6061](https://github.com/the-luap/picpeak/commit/64f606152fde2db9034fa9ffa08cc58623edf646))

## [2.6.4](https://github.com/the-luap/picpeak/compare/v2.6.3...v2.6.4) (2026-04-08)


### Bug Fixes

* sync backend package-lock.json for security deps ([bb81fa5](https://github.com/the-luap/picpeak/commit/bb81fa5f4b5f1bd927a02470ce80a13c4f53443f))
* sync backend package-lock.json with security dep updates ([03e1989](https://github.com/the-luap/picpeak/commit/03e19893b3532a27aa59e7b834d53c6a2b52b7cd))

## [2.6.3](https://github.com/the-luap/picpeak/compare/v2.6.2...v2.6.3) (2026-04-07)


### Documentation

* add External Media Library section to deployment guide ([#270](https://github.com/the-luap/picpeak/issues/270)) ([2e1c71c](https://github.com/the-luap/picpeak/commit/2e1c71c1ab073e488ac93e35337a2d3955dfef3d))
* add External Media Library section to deployment guide ([#270](https://github.com/the-luap/picpeak/issues/270)) ([f6ca713](https://github.com/the-luap/picpeak/commit/f6ca713a6edc8ba371db790daba05ecb85ea4872))

## [2.6.2](https://github.com/the-luap/picpeak/compare/v2.6.1...v2.6.2) (2026-03-16)


### Bug Fixes

* **security:** invalidate tokens on password change, enforce session timeout, fix role update ([85a60a2](https://github.com/the-luap/picpeak/commit/85a60a2dc7526aa6b673e2a04e9fdfba7de7117f))
* **security:** token invalidation on password change, session timeout enforcement ([0a3a537](https://github.com/the-luap/picpeak/commit/0a3a53763c9f3caef9fdceccf9fdbfdefe9bd8bf))

## [2.6.1](https://github.com/the-luap/picpeak/compare/v2.6.0...v2.6.1) (2026-03-11)
