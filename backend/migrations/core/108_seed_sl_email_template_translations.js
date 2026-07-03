/**
 * Migration: seed Slovenian (sl) email-template translations.
 *
 * Covers all email templates currently seeded by PicPeak:
 * - gallery delivery templates
 * - administrator account templates
 * - backup/restore notifications
 * - update notifications
 * - customer account templates
 *
 * Idempotent: checks (template_id, language) before inserting so re-runs
 * are safe and do not overwrite rows that an admin may have edited in the UI.
 */

const TRANSLATIONS = {
  admin_invitation: {
    sl: {
      subject: 'Povabljeni ste, da se pridružite PicPeak kot {{role_name}}',
      body_html: `
<h2>Dobrodošli v PicPeak!</h2>

<p>Povabljeni ste, da se pridružite platformi PicPeak za deljenje fotografij kot <strong>{{role_name}}</strong>.</p>

<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Vaša vloga:</strong> {{role_name}}</p>
  <p style="margin: 10px 0 0 0;">Ta vloga vam omogoča upravljanje in administracijo platforme za deljenje fotografij.</p>
</div>

<p>Za sprejem povabila in nastavitev računa kliknite spodnji gumb:</p>

<div style="text-align: center; margin: 30px 0;">
  <a href="{{invite_link}}" style="display: inline-block; padding: 14px 35px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px; font-weight: 600; font-size: 16px;">Sprejmi povabilo</a>
</div>

<div style="background-color: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 15px; border-radius: 4px; margin: 20px 0;">
  <p style="margin: 0;"><strong>Pomembno:</strong> To povabilo poteče dne <strong>{{expires_at}}</strong>. Sprejmite ga pred tem datumom.</p>
</div>

<p>Če tega povabila niste pričakovali ali menite, da je bilo poslano pomotoma, lahko to e-pošto varno prezrete.</p>

<p style="color: #666; font-size: 13px; margin-top: 30px;">
  Če zgornji gumb ne deluje, kopirajte to povezavo v brskalnik:<br>
  <a href="{{invite_link}}" style="color: #5C8762; word-break: break-all;">{{invite_link}}</a>
</p>

<p>Lep pozdrav,<br>
ekipa PicPeak</p>`,
      body_text: 'Dobrodošli v PicPeak!\n\nPovabljeni ste, da se pridružite platformi PicPeak za deljenje fotografij kot {{role_name}}.\n\nVaša vloga: {{role_name}}\nTa vloga vam omogoča upravljanje in administracijo platforme za deljenje fotografij.\n\nZa sprejem povabila in nastavitev računa obiščite povezavo:\n{{invite_link}}\n\nPOMEMBNO: To povabilo poteče dne {{expires_at}}. Sprejmite ga pred tem datumom.\n\nČe tega povabila niste pričakovali ali menite, da je bilo poslano pomotoma, lahko to e-pošto varno prezrete.\n\nLep pozdrav,\nekipa PicPeak',
    },
  },

  admin_password_reset: {
    sl: {
      subject: 'Vaše PicPeak administratorsko geslo je bilo ponastavljeno',
      body_html: `
<h2>Obvestilo o ponastavitvi gesla</h2>

<p>Pozdravljeni <strong>{{username}}</strong>,</p>

<p>Vaše administratorsko geslo za PicPeak je ponastavil sistemski administrator.</p>

<div style="background-color: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
  <h3 style="margin-top: 0;">Vaši novi prijavni podatki:</h3>
  <ul style="list-style: none; padding: 0;">
    <li style="margin-bottom: 10px;"><strong>Uporabniško ime:</strong> {{username}}</li>
    <li style="margin-bottom: 10px;"><strong>Začasno geslo:</strong> <code style="background-color: #e9ecef; padding: 4px 8px; border-radius: 4px; font-family: monospace; font-size: 14px;">{{new_password}}</code></li>
  </ul>
</div>

<div style="background-color: #fee; border: 1px solid #fcc; color: #c33; padding: 20px; border-radius: 8px; margin: 20px 0;">
  <p style="margin: 0; font-weight: bold; font-size: 16px;">Varnostno obvestilo</p>
  <ul style="margin: 10px 0 0 0; padding-left: 20px;">
    <li>To je začasno geslo. Po prijavi ga takoj spremenite.</li>
    <li>Svojega gesla nikoli ne delite z drugimi.</li>
    <li>Če ponastavitve gesla niste pričakovali, se takoj obrnite na sistemskega administratorja.</li>
  </ul>
</div>

<p>Za prijavo v administratorski vmesnik kliknite spodnji gumb:</p>

<div style="text-align: center; margin: 30px 0;">
  <a href="{{admin_login_url}}" style="display: inline-block; padding: 14px 35px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px; font-weight: 600; font-size: 16px;">Prijava</a>
</div>

<p style="color: #666; font-size: 13px;">Po prijavi odprite nastavitve profila in geslo spremenite v varno geslo, ki ga poznate samo vi.</p>

<p>Lep pozdrav,<br>
ekipa PicPeak</p>`,
      body_text: 'Obvestilo o ponastavitvi gesla\n\nPozdravljeni {{username}},\n\nVaše administratorsko geslo za PicPeak je ponastavil sistemski administrator.\n\nVaši novi prijavni podatki:\n- Uporabniško ime: {{username}}\n- Začasno geslo: {{new_password}}\n\nVARNOSTNO OBVESTILO:\n- To je začasno geslo. Po prijavi ga takoj spremenite.\n- Svojega gesla nikoli ne delite z drugimi.\n- Če ponastavitve gesla niste pričakovali, se takoj obrnite na sistemskega administratorja.\n\nZa prijavo v administratorski vmesnik obiščite: {{admin_login_url}}\n\nPo prijavi odprite nastavitve profila in geslo spremenite v varno geslo, ki ga poznate samo vi.\n\nLep pozdrav,\nekipa PicPeak',
    },
  },

  archive_complete: {
    sl: {
      subject: 'Arhiviranje končano: {{event_name}}',
      body_html: `<h2>Arhiviranje je končano</h2>
<p>Spoštovani {{host_name}},</p>
<p>Vaša fotogalerija "{{event_name}}" je bila uspešno arhivirana.</p>
<p><strong>Podrobnosti arhiva:</strong></p>
<ul>
  <li>Število fotografij: {{photo_count}}</li>
  <li>Velikost arhiva: {{archive_size}}</li>
  <li>Datum arhiviranja: {{archive_date}}</li>
</ul>`,
      body_text: 'Arhiviranje je končano\n\nSpoštovani {{host_name}},\n\nVaša fotogalerija "{{event_name}}" je bila uspešno arhivirana.\n\nFotografije: {{photo_count}}\nVelikost: {{archive_size}}\nDatum arhiviranja: {{archive_date}}',
    },
  },

  backup_completed: {
    sl: {
      subject: 'Varnostna kopija uspešno ustvarjena',
      body_html: `<h2>Varnostna kopija je bila uspešno ustvarjena</h2>
<p>Načrtovana varnostna kopija je bila uspešno zaključena.</p>
<p><strong>Povzetek varnostne kopije:</strong></p>
<ul>
  <li>Začetek: {{start_time}}</li>
  <li>Trajanje: {{duration}}</li>
  <li>Število varnostno kopiranih datotek: {{files_count}}</li>
  <li>Skupna velikost: {{total_size}}</li>
  <li>Vrsta varnostne kopije: {{backup_type}}</li>
</ul>`,
      body_text: 'Varnostna kopija je bila uspešno ustvarjena\n\nNačrtovana varnostna kopija je bila uspešno zaključena.\n\nZačetek: {{start_time}}\nTrajanje: {{duration}}\nŠtevilo varnostno kopiranih datotek: {{files_count}}\nSkupna velikost: {{total_size}}\nVrsta varnostne kopije: {{backup_type}}',
    },
  },

  backup_failed: {
    sl: {
      subject: 'Varnostno kopiranje ni uspelo - potrebno je takojšnje ukrepanje',
      body_html: `<h2>Varnostno kopiranje ni uspelo</h2>
<p>Načrtovano varnostno kopiranje ni uspelo in zahteva takojšnjo pozornost.</p>
<p><strong>Podrobnosti napake:</strong></p>
<ul>
  <li>Začetek: {{start_time}}</li>
  <li>Vrsta varnostne kopije: {{backup_type}}</li>
  <li>Napaka: {{error_message}}</li>
</ul>
<p>Preverite sistemske dnevnike za več podrobnosti in čim prej odpravite težavo.</p>`,
      body_text: 'Varnostno kopiranje ni uspelo\n\nNačrtovano varnostno kopiranje ni uspelo in zahteva takojšnjo pozornost.\n\nZačetek: {{start_time}}\nVrsta varnostne kopije: {{backup_type}}\nNapaka: {{error_message}}\n\nPreverite sistemske dnevnike za več podrobnosti.',
    },
  },

  customer_gallery_assigned: {
    sl: {
      subject: 'V vašem računu je na voljo nova galerija',
      body_html: `<h2>Dodeljen vam je bil dostop do novih galerij</h2>
<p>Pozdravljeni {{customer_name}},</p>
{{#if singular}}<p>Fotograf vam je pravkar dodelil dostop do nove galerije v vašem računu:</p>{{/if}}{{#if multiple}}<p>Fotograf vam je pravkar dodelil dostop do {{gallery_count}} novih galerij v vašem računu:</p>{{/if}}
{{gallery_list_html}}
<p style="text-align: center; margin: 30px 0;">
  <a href="{{dashboard_link}}" class="button">Odpri nadzorno ploščo</a>
</p>
<p style="font-size: 13px; color: #666;">Če gumb ne deluje, kopirajte to povezavo v brskalnik:<br>
<span style="word-break: break-all;">{{dashboard_link}}</span></p>`,
      body_text: 'Dodeljen vam je bil dostop do novih galerij\n\nPozdravljeni {{customer_name}},\n\nFotograf vam je pravkar dodelil dostop do {{gallery_count}} nove galerije oziroma novih galerij v vašem računu:\n\n{{gallery_list_text}}\n\nOdpri nadzorno ploščo: {{dashboard_link}}',
    },
  },

  customer_invitation: {
    sl: {
      subject: 'Povabljeni ste k dostopu do svojih fotogalerij',
      body_html: `
<h2>Dobrodošli v svojih fotogalerijah</h2>
<p>Povabljeni ste, da ustvarite uporabniški račun, kjer boste lahko vse svoje galerije dogodkov pregledovali na enem mestu — brez ločenih povezav in gesel.</p>
<div style="text-align: center; margin: 30px 0;">
  <a href="{{invite_link}}" class="button">Nastavi račun</a>
</div>
<p>To povabilo poteče dne {{expires_at}}. Če povezava ne deluje, jo kopirajte v brskalnik:</p>
<p style="word-break: break-all; font-size: 13px; color: #666;">{{invite_link}}</p>
<p>Če tega e-poštnega sporočila niste pričakovali, ga lahko varno prezrete.</p>`,
      body_text: 'Dobrodošli v svojih fotogalerijah\n\nPovabljeni ste, da ustvarite uporabniški račun, kjer boste lahko vse svoje galerije dogodkov pregledovali na enem mestu — brez ločenih povezav in gesel.\n\nNastavi račun: {{invite_link}}\n\nTo povabilo poteče dne {{expires_at}}.\n\nČe tega e-poštnega sporočila niste pričakovali, ga lahko varno prezrete.',
    },
  },

  customer_password_reset: {
    sl: {
      subject: 'Ponastavitev gesla za vaš uporabniški račun',
      body_html: `<p>Pozdravljeni,</p>
<p>Vaš fotograf je sprožil ponastavitev gesla za vaš uporabniški račun.</p>
<p><a href="{{reset_link}}" class="button">Nastavi novo geslo</a></p>
<p>Ta povezava poteče dne {{expires_at}}.</p>
<p>Če tega niste pričakovali, lahko sporočilo prezrete — vaše trenutno geslo bo delovalo še naprej, dokler ne kliknete povezave.</p>`,
      body_text: 'Ponastavitev gesla za vaš uporabniški račun\n\nVaš fotograf je sprožil ponastavitev gesla za vaš uporabniški račun.\n\nNastavi novo geslo: {{reset_link}}\n\nTa povezava poteče dne {{expires_at}}.\n\nČe tega niste pričakovali, lahko sporočilo prezrete — vaše trenutno geslo bo delovalo še naprej, dokler ne kliknete povezave.',
    },
  },

  database_backup_completed: {
    sl: {
      subject: 'Varnostna kopija podatkovne baze uspešno ustvarjena',
      body_html: `<h2>Varnostna kopija podatkovne baze je bila uspešno ustvarjena</h2>
<p>Načrtovano varnostno kopiranje podatkovne baze je bilo uspešno zaključeno.</p>
<p><strong>Povzetek varnostne kopije:</strong></p>
<ul>
  <li>Vrsta varnostne kopije: {{backup_type}}</li>
  <li>Trajanje: {{duration}}</li>
  <li>Velikost datoteke: {{file_size}}</li>
  <li>Razmerje stiskanja: {{compression_ratio}}</li>
  <li>Pot do datoteke: {{file_path}}</li>
</ul>`,
      body_text: 'Varnostna kopija podatkovne baze je bila uspešno ustvarjena\n\nNačrtovano varnostno kopiranje podatkovne baze je bilo uspešno zaključeno.\n\nVrsta varnostne kopije: {{backup_type}}\nTrajanje: {{duration}}\nVelikost datoteke: {{file_size}}\nRazmerje stiskanja: {{compression_ratio}}\nPot do datoteke: {{file_path}}',
    },
  },

  database_backup_failed: {
    sl: {
      subject: 'Varnostno kopiranje podatkovne baze ni uspelo - kritično opozorilo',
      body_html: `<h2>Varnostno kopiranje podatkovne baze ni uspelo</h2>
<p>Načrtovano varnostno kopiranje podatkovne baze ni uspelo in zahteva takojšnjo pozornost.</p>
<p><strong>Podrobnosti napake:</strong></p>
<ul>
  <li>Vrsta varnostne kopije: {{backup_type}}</li>
  <li>Časovni žig: {{timestamp}}</li>
  <li>Napaka: {{error_message}}</li>
</ul>
<p>To je kritična težava, ki lahko vpliva na obnovitev po izpadu. Čim prej jo preverite.</p>`,
      body_text: 'Varnostno kopiranje podatkovne baze ni uspelo\n\nNačrtovano varnostno kopiranje podatkovne baze ni uspelo.\n\nVrsta varnostne kopije: {{backup_type}}\nČasovni žig: {{timestamp}}\nNapaka: {{error_message}}\n\nTo je kritična težava - preverite jo čim prej.',
    },
  },

  expiration_warning: {
    sl: {
      subject: 'Vaša fotogalerija bo kmalu potekla',
      body_html: `<h2>Galerija bo kmalu potekla</h2>
<p>Spoštovani {{host_name}},</p>
<p>Vaša fotogalerija "{{event_name}}" bo potekla čez {{days_remaining}} dni.</p>
<p>Po poteku bo galerija arhivirana in gostom ne bo več dostopna.</p>
<p><a href="{{gallery_link}}">Odpri galerijo</a></p>`,
      body_text: 'Galerija bo kmalu potekla\n\nSpoštovani {{host_name}},\n\nVaša fotogalerija "{{event_name}}" bo potekla čez {{days_remaining}} dni.\n\nGalerija: {{gallery_link}}',
    },
  },

  gallery_created: {
    sl: {
      subject: 'Vaša fotogalerija je pripravljena!',
      body_html: `<h2>Galerija je bila uspešno ustvarjena</h2>
<p>Spoštovani {{host_name}},</p>
<p>Vaša fotogalerija "{{event_name}}" je bila uspešno ustvarjena!</p>
<p><strong>Podrobnosti galerije:</strong></p>
<ul>
  <li>Datum dogodka: {{event_date}}</li>
  <li>Povezava do galerije: <a href="{{gallery_link}}">{{gallery_link}}</a></li>
  <li>Geslo: {{gallery_password}}</li>
  <li>Velja do: {{expiry_date}}</li>
</ul>
<p>Povezavo in geslo lahko delite z gosti, da si bodo lahko ogledali in prenesli fotografije.</p>
{{#if welcome_message}}<p><em>{{welcome_message}}</em></p>{{/if}}`,
      body_text: 'Galerija je bila uspešno ustvarjena\n\nSpoštovani {{host_name}},\n\nVaša fotogalerija "{{event_name}}" je bila uspešno ustvarjena!\n\nPovezava do galerije: {{gallery_link}}\nGeslo: {{gallery_password}}\nVelja do: {{expiry_date}}',
    },
  },

  gallery_expired: {
    sl: {
      subject: 'Vaša fotogalerija je potekla',
      body_html: `<h2>Galerija je potekla</h2>
<p>Spoštovani {{host_name}},</p>
<p>Vaša fotogalerija "{{event_name}}" je potekla in ni več dostopna.</p>
<p>Fotografije so bile arhivirane. Če potrebujete dostop, se obrnite na administratorja na {{admin_email}}.</p>`,
      body_text: 'Galerija je potekla\n\nSpoštovani {{host_name}},\n\nVaša fotogalerija "{{event_name}}" je potekla in ni več dostopna.\n\nKontakt: {{admin_email}}',
    },
  },

  restore_completed: {
    sl: {
      subject: '✅ Obnovitev uspešno zaključena',
      body_html: `<h2>Obnovitev je bila zaključena</h2>
<p>Obnovitev je bila uspešno zaključena.</p>

<h3>Podrobnosti:</h3>
<ul>
  <li><strong>Vrsta obnovitve:</strong> {{restore_type}}</li>
  <li><strong>Trajanje:</strong> {{duration}}</li>
  <li><strong>Obnovljene datoteke:</strong> {{files_restored}}</li>
  <li><strong>Velikost podatkovne baze:</strong> {{database_size}}</li>
</ul>

<p>Preverite, ali aplikacija deluje pravilno in ali so podatki dostopni.</p>`,
      body_text: 'Obnovitev je bila uspešno zaključena\n\nVrsta obnovitve: {{restore_type}}\nTrajanje: {{duration}}\nObnovljene datoteke: {{files_restored}}\nVelikost podatkovne baze: {{database_size}}\n\nPreverite, ali aplikacija deluje pravilno in ali so podatki dostopni.',
    },
  },

  restore_failed: {
    sl: {
      subject: '❌ Obnovitev ni uspela',
      body_html: `<h2>Obnovitev ni uspela</h2>
<p>Obnovitev ni uspela in zahteva pozornost.</p>

<h3>Podrobnosti:</h3>
<ul>
  <li><strong>Vrsta obnovitve:</strong> {{restore_type}}</li>
  <li><strong>Napaka:</strong> {{error_message}}</li>
  <li><strong>Časovni žig:</strong> {{timestamp}}</li>
</ul>

<p>Preverite sistemske dnevnike za več podrobnosti in odpravite težavo pred ponovnim poskusom.</p>`,
      body_text: 'Obnovitev ni uspela\n\nObnovitev ni uspela in zahteva pozornost.\n\nVrsta obnovitve: {{restore_type}}\nNapaka: {{error_message}}\nČasovni žig: {{timestamp}}\n\nPreverite sistemske dnevnike za več podrobnosti in odpravite težavo pred ponovnim poskusom.',
    },
  },

  version_update_available: {
    sl: {
      subject: 'Na voljo je posodobitev PicPeak: različica {{new_version}}',
      body_html: `
<h2>Na voljo je nova različica PicPeak</h2>

<p>Dobra novica! Za vašo namestitev je na voljo nova različica PicPeak.</p>

<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Trenutna različica:</strong> {{current_version}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Nova različica:</strong> {{new_version}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Kanal:</strong> {{channel}}</p>
</div>

<p>Priporočamo, da pred posodobitvijo ustvarite varnostno kopijo podatkovne baze in naloženih datotek.</p>

<div style="text-align: center; margin: 30px 0;">
  <a href="{{release_notes_url}}" style="display: inline-block; padding: 14px 35px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px; font-weight: 600; font-size: 16px;">Ogled opomb ob izdaji</a>
</div>

<p style="color: #666; font-size: 13px;">
  Če gumb ne deluje, kopirajte to povezavo v brskalnik:<br>
  <a href="{{release_notes_url}}" style="color: #5C8762; word-break: break-all;">{{release_notes_url}}</a>
</p>

<p>Lep pozdrav,<br>
ekipa PicPeak</p>`,
      body_text: 'Na voljo je nova različica PicPeak\n\nDobra novica! Za vašo namestitev je na voljo nova različica PicPeak.\n\nTrenutna različica: {{current_version}}\nNova različica: {{new_version}}\nKanal: {{channel}}\n\nPriporočamo, da pred posodobitvijo ustvarite varnostno kopijo podatkovne baze in naloženih datotek.\n\nOpombe ob izdaji: {{release_notes_url}}\n\nLep pozdrav,\nekipa PicPeak',
    },
  },

  version_update_test: {
    sl: {
      subject: '[TEST] PicPeak obvestilo o posodobitvi — preverjanje nastavitev',
      body_html: `<h2>To je testno e-poštno sporočilo</h2>
<p>To sporočilo ste prejeli, ker je administrator na strani za obvestila o posodobitvah
v vaši namestitvi PicPeak kliknil <strong>Pošlji testno e-pošto</strong>.</p>
<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Rezultat:</strong> Nastavitve e-pošte za obvestila o posodobitvah delujejo.</p>
</div>
<p>Če tega testa niste sprožili vi, preverite nedavno administratorsko aktivnost.</p>`,
      body_text: 'To je testno e-poštno sporočilo\n\nTo sporočilo ste prejeli, ker je administrator na strani za obvestila o posodobitvah v vaši namestitvi PicPeak kliknil Pošlji testno e-pošto.\n\nRezultat: Nastavitve e-pošte za obvestila o posodobitvah delujejo.\n\nČe tega testa niste sprožili vi, preverite nedavno administratorsko aktivnost.',
    },
  },
};

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (!(await knex.schema.hasTable('email_template_translations'))) return;

  const rows = await knex('email_templates')
    .whereIn('template_key', Object.keys(TRANSLATIONS))
    .select('id', 'template_key');
  const keyToId = Object.fromEntries(rows.map((r) => [r.template_key, r.id]));

  let inserted = 0;
  let skipped = 0;
  let missing = 0;

  for (const [key, perLocale] of Object.entries(TRANSLATIONS)) {
    const templateId = keyToId[key];
    if (!templateId) {
      missing += 1;
      continue;
    }

    for (const [language, content] of Object.entries(perLocale)) {
      const existing = await knex('email_template_translations')
        .where({ template_id: templateId, language })
        .first();
      if (existing) {
        skipped += 1;
        continue;
      }
      await knex('email_template_translations').insert({
        template_id: templateId,
        language,
        subject: content.subject,
        body_html: content.body_html,
        body_text: content.body_text,
        created_at: new Date(),
        updated_at: new Date(),
      });
      inserted += 1;
    }
  }

  console.log(`107_seed_sl_email_template_translations: inserted=${inserted}, skipped=${skipped}, missing=${missing}`);
};

exports.down = async function(knex) {
  // No-op: an admin may have hand-edited the `sl` rows in the Templates UI
  // after this migration ran, and we cannot reliably distinguish seeded rows
  // from edited rows. Remove them manually if rollback is truly required.
};