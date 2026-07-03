/**
 * Migration: Re-apply email-template backfills that earlier deployed
 * versions of 098 / 099 missed.
 *
 * Why a separate migration? Knex tracks migrations by filename — once
 * 098 / 099 were recorded as applied in `knex_migrations`, editing
 * them doesn't re-run on subsequent deploys. The first deployed
 * versions of those migrations didn't include:
 *   - the `subcategory` column population (added later)
 *   - the `customer_password_reset` category override (added later)
 *   - the en/de/nl/pt/ru/fr translation rows for
 *     `customer_password_reset` and `version_update_test` (both
 *     inserted after 075 ran, so they sat in legacy columns only
 *     and showed empty in the Templates editor — the AI translations
 *     were added to 099 after its first deploy).
 *
 * This migration is append-only (no schema change beyond defensive
 * column checks) and re-applies all the affected data:
 *   1. Sets category / subcategory / feature_flag on every known
 *      template_key.
 *   2. Seeds missing translation rows for the two post-075
 *      templates across all six locales.
 *
 * Idempotent throughout: skips translation inserts that already
 * exist, and the category writes are no-ops when values already match.
 */

const TEMPLATE_METADATA = {
  // Core / Galleries — gallery delivery lifecycle.
  gallery_created:               { category: 'core',      subcategory: 'gallery', feature_flag: null },
  expiration_warning:            { category: 'core',      subcategory: 'gallery', feature_flag: null },
  gallery_expired:               { category: 'core',      subcategory: 'gallery', feature_flag: null },
  archive_complete:              { category: 'core',      subcategory: 'gallery', feature_flag: null },
  // Core / Admin — admin account lifecycle.
  admin_invitation:              { category: 'core',      subcategory: 'admin',   feature_flag: null },
  admin_password_reset:          { category: 'core',      subcategory: 'admin',   feature_flag: null },
  // Core / Backup — database + file backups + restores.
  database_backup_completed:     { category: 'core',      subcategory: 'backup',  feature_flag: null },
  database_backup_failed:        { category: 'core',      subcategory: 'backup',  feature_flag: null },
  restore_completed:             { category: 'core',      subcategory: 'backup',  feature_flag: null },
  restore_failed:                { category: 'core',      subcategory: 'backup',  feature_flag: null },
  backup_completed:              { category: 'core',      subcategory: 'backup',  feature_flag: null },
  backup_failed:                 { category: 'core',      subcategory: 'backup',  feature_flag: null },
  // Core / System — version-update notifications.
  version_update_available:      { category: 'core',      subcategory: 'system',  feature_flag: null },
  version_update_test:           { category: 'core',      subcategory: 'system',  feature_flag: null },
  // Customers — customer-portal lifecycle.
  customer_invitation:           { category: 'customers', subcategory: null,      feature_flag: 'customerPortal' },
  customer_password_reset:       { category: 'customers', subcategory: null,      feature_flag: 'customerPortal' },
};

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;

  // Defensive: if migration 098 didn't run for some reason on this
  // install (a fork, a partial copy, etc.) make sure the columns
  // exist before we try to write to them. Idempotent — these are
  // no-ops if the column already exists.
  const cols = await knex('email_templates').columnInfo();
  if (!cols.category) {
    await knex.schema.alterTable('email_templates', (t) => {
      t.string('category', 32).notNullable().defaultTo('core');
    });
  }
  if (!cols.subcategory) {
    await knex.schema.alterTable('email_templates', (t) => {
      t.string('subcategory', 32).nullable();
    });
  }
  if (!cols.feature_flag) {
    await knex.schema.alterTable('email_templates', (t) => {
      t.string('feature_flag', 64).nullable();
    });
  }

  let updated = 0;
  for (const [key, meta] of Object.entries(TEMPLATE_METADATA)) {
    const result = await knex('email_templates')
      .where({ template_key: key })
      .update({
        category: meta.category,
        subcategory: meta.subcategory,
        feature_flag: meta.feature_flag,
      });
    if (result > 0) updated += 1;
  }
  console.log(`100_backfill_email_template_subcategory: updated ${updated} template rows`);

  // ── Translation backfill ──────────────────────────────────────────
  // customer_password_reset (migration 092) and version_update_test
  // (migration 087) were inserted AFTER migration 075 ran, so they
  // have content in legacy subject_*/body_html_* columns but zero
  // rows in `email_template_translations`. The Templates editor
  // reads exclusively from the translations table → shows them as
  // 0/6 empty until we seed them. Migration 099 added these rows on
  // initial deploy, but the earlier-shipped version of 099 didn't
  // include them, so instances that ran it then-and-now still have
  // empty editors. Re-seed defensively here, skipping any
  // (template_id, language) pair that already exists.
  if (!(await knex.schema.hasTable('email_template_translations'))) return;

  const TRANSLATIONS = {
    customer_password_reset: {
      en: {
        subject: 'Reset your customer account password',
        body_html: `<p>Hello,</p>
<p>Your photographer has triggered a password reset for your customer account.</p>
<p><a href="{{reset_link}}" class="button">Set a new password</a></p>
<p>This link expires on {{expires_at}}.</p>
<p>If you didn't expect this, you can ignore the message — your current password keeps working until you click the link.</p>`,
        body_text: `Reset your customer account password\n\nYour photographer has triggered a password reset for your customer account.\n\nSet a new password: {{reset_link}}\n\nThis link expires on {{expires_at}}.\n\nIf you didn't expect this, you can ignore the message — your current password keeps working until you click the link.`,
      },
      de: {
        subject: 'Passwort für dein Kundenkonto zurücksetzen',
        body_html: `<p>Hallo,</p>
<p>Dein Fotograf hat einen Passwort-Reset für dein Kundenkonto ausgelöst.</p>
<p><a href="{{reset_link}}" class="button">Neues Passwort festlegen</a></p>
<p>Dieser Link läuft am {{expires_at}} ab.</p>
<p>Wenn du diese Anfrage nicht erwartet hast, kannst du diese Nachricht ignorieren — dein aktuelles Passwort funktioniert weiter, bis du den Link anklickst.</p>`,
        body_text: `Passwort für dein Kundenkonto zurücksetzen\n\nDein Fotograf hat einen Passwort-Reset für dein Kundenkonto ausgelöst.\n\nNeues Passwort festlegen: {{reset_link}}\n\nDieser Link läuft am {{expires_at}} ab.\n\nWenn du diese Anfrage nicht erwartet hast, kannst du diese Nachricht ignorieren — dein aktuelles Passwort funktioniert weiter, bis du den Link anklickst.`,
      },
      nl: {
        subject: 'Wachtwoord van uw klantaccount opnieuw instellen',
        body_html: `<p>Hallo,</p>
<p>Uw fotograaf heeft een wachtwoordreset voor uw klantaccount aangevraagd.</p>
<p><a href="{{reset_link}}" class="button">Nieuw wachtwoord instellen</a></p>
<p>Deze link verloopt op {{expires_at}}.</p>
<p>Heeft u deze aanvraag niet verwacht? U kunt dit bericht negeren — uw huidige wachtwoord blijft werken totdat u op de link klikt.</p>`,
        body_text: `Wachtwoord opnieuw instellen\n\nUw fotograaf heeft een wachtwoordreset voor uw klantaccount aangevraagd.\n\nNieuw wachtwoord instellen: {{reset_link}}\n\nDeze link verloopt op {{expires_at}}.\n\nHeeft u deze aanvraag niet verwacht? U kunt dit bericht negeren — uw huidige wachtwoord blijft werken totdat u op de link klikt.`,
      },
      pt: {
        subject: 'Redefina a senha da sua conta de cliente',
        body_html: `<p>Olá,</p>
<p>Seu fotógrafo iniciou uma redefinição de senha para sua conta de cliente.</p>
<p><a href="{{reset_link}}" class="button">Definir nova senha</a></p>
<p>Este link expira em {{expires_at}}.</p>
<p>Se você não esperava esta solicitação, pode ignorar a mensagem — sua senha atual continuará funcionando até você clicar no link.</p>`,
        body_text: `Redefinir senha\n\nSeu fotógrafo iniciou uma redefinição de senha para sua conta de cliente.\n\nDefinir nova senha: {{reset_link}}\n\nEste link expira em {{expires_at}}.\n\nSe você não esperava esta solicitação, pode ignorar a mensagem — sua senha atual continuará funcionando até você clicar no link.`,
      },
      ru: {
        subject: 'Сброс пароля вашей клиентской учётной записи',
        body_html: `<p>Здравствуйте!</p>
<p>Ваш фотограф инициировал сброс пароля для вашей клиентской учётной записи.</p>
<p><a href="{{reset_link}}" class="button">Задать новый пароль</a></p>
<p>Срок действия ссылки истекает {{expires_at}}.</p>
<p>Если вы не ожидали этого письма, можете его проигнорировать — ваш текущий пароль продолжит работать, пока вы не перейдёте по ссылке.</p>`,
        body_text: `Сброс пароля\n\nВаш фотограф инициировал сброс пароля для вашей клиентской учётной записи.\n\nЗадать новый пароль: {{reset_link}}\n\nСрок действия ссылки истекает {{expires_at}}.\n\nЕсли вы не ожидали этого письма, можете его проигнорировать — ваш текущий пароль продолжит работать, пока вы не перейдёте по ссылке.`,
      },
      fr: {
        subject: 'Réinitialisez le mot de passe de votre compte client',
        body_html: `<p>Bonjour,</p>
<p>Votre photographe a déclenché une réinitialisation de mot de passe pour votre compte client.</p>
<p><a href="{{reset_link}}" class="button">Définir un nouveau mot de passe</a></p>
<p>Ce lien expire le {{expires_at}}.</p>
<p>Si vous n'attendiez pas cette demande, vous pouvez ignorer ce message — votre mot de passe actuel continue de fonctionner jusqu'à ce que vous cliquiez sur le lien.</p>`,
        body_text: `Réinitialiser le mot de passe\n\nVotre photographe a déclenché une réinitialisation de mot de passe pour votre compte client.\n\nDéfinir un nouveau mot de passe : {{reset_link}}\n\nCe lien expire le {{expires_at}}.\n\nSi vous n'attendiez pas cette demande, vous pouvez ignorer ce message — votre mot de passe actuel continue de fonctionner jusqu'à ce que vous cliquiez sur le lien.`,
      },
    },
    version_update_test: {
      en: {
        subject: '[TEST] PicPeak Update Notification — configuration check',
        body_html: `<h2>This is a test email</h2>
<p>You are receiving this message because an administrator clicked
<strong>Send Test Email</strong> on the Update Notifications page of your
PicPeak installation.</p>
<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Installed version:</strong> {{current_version}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Channel:</strong> {{channel}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Recipient address:</strong> {{recipient_email}}</p>
</div>
<p>If you can read this email, your SMTP configuration and the recipient
list are working correctly. When a real new version becomes available,
PicPeak will send a separate notification with release notes and update
instructions.</p>
<p style="color: #666; font-size: 13px; margin-top: 30px;">No action is required.
You may safely delete this message.</p>`,
        body_text: `This is a test email\n\nYou are receiving this message because an administrator clicked "Send Test Email" on the Update Notifications page of your PicPeak installation.\n\nInstalled version: {{current_version}}\nChannel: {{channel}}\nRecipient address: {{recipient_email}}\n\nIf you can read this email, your SMTP configuration and the recipient list are working correctly. When a real new version becomes available, PicPeak will send a separate notification with release notes and update instructions.\n\nNo action is required. You may safely delete this message.`,
      },
      de: {
        subject: '[TEST] PicPeak Update-Benachrichtigung — Konfigurationsprüfung',
        body_html: `<h2>Dies ist eine Test-E-Mail</h2>
<p>Sie erhalten diese Nachricht, weil ein Administrator auf der Seite
„Update-Benachrichtigungen" Ihrer PicPeak-Installation auf
<strong>Test-E-Mail senden</strong> geklickt hat.</p>
<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Installierte Version:</strong> {{current_version}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Kanal:</strong> {{channel}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Empfänger-Adresse:</strong> {{recipient_email}}</p>
</div>
<p>Wenn Sie diese E-Mail lesen können, funktionieren Ihre SMTP-Konfiguration
und die Empfängerliste korrekt. Sobald eine echte neue Version verfügbar
ist, sendet PicPeak eine separate Benachrichtigung mit Versionshinweisen
und Update-Anweisungen.</p>
<p style="color: #666; font-size: 13px; margin-top: 30px;">Es ist keine Aktion
erforderlich. Sie können diese Nachricht gefahrlos löschen.</p>`,
        body_text: `Dies ist eine Test-E-Mail\n\nSie erhalten diese Nachricht, weil ein Administrator auf der Seite „Update-Benachrichtigungen" Ihrer PicPeak-Installation auf „Test-E-Mail senden" geklickt hat.\n\nInstallierte Version: {{current_version}}\nKanal: {{channel}}\nEmpfänger-Adresse: {{recipient_email}}\n\nWenn Sie diese E-Mail lesen können, funktionieren Ihre SMTP-Konfiguration und die Empfängerliste korrekt. Sobald eine echte neue Version verfügbar ist, sendet PicPeak eine separate Benachrichtigung mit Versionshinweisen und Update-Anweisungen.\n\nEs ist keine Aktion erforderlich. Sie können diese Nachricht gefahrlos löschen.`,
      },
      nl: {
        subject: '[TEST] PicPeak-update-melding — configuratiecontrole',
        body_html: `<h2>Dit is een test-e-mail</h2>
<p>U ontvangt dit bericht omdat een beheerder op de pagina
"Update-meldingen" van uw PicPeak-installatie op
<strong>Test-e-mail verzenden</strong> heeft geklikt.</p>
<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Geïnstalleerde versie:</strong> {{current_version}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Kanaal:</strong> {{channel}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Ontvangeradres:</strong> {{recipient_email}}</p>
</div>
<p>Als u deze e-mail kunt lezen, werken uw SMTP-configuratie en de ontvangerslijst correct. Wanneer er een echte nieuwe versie beschikbaar komt, stuurt PicPeak een aparte melding met release-notities en update-instructies.</p>
<p style="color: #666; font-size: 13px; margin-top: 30px;">Geen actie vereist. U kunt dit bericht veilig verwijderen.</p>`,
        body_text: `Dit is een test-e-mail\n\nU ontvangt dit bericht omdat een beheerder op de pagina "Update-meldingen" van uw PicPeak-installatie op "Test-e-mail verzenden" heeft geklikt.\n\nGeïnstalleerde versie: {{current_version}}\nKanaal: {{channel}}\nOntvangeradres: {{recipient_email}}\n\nAls u deze e-mail kunt lezen, werken uw SMTP-configuratie en de ontvangerslijst correct.\n\nGeen actie vereist.`,
      },
      pt: {
        subject: '[TESTE] Notificação de atualização do PicPeak — verificação',
        body_html: `<h2>Este é um e-mail de teste</h2>
<p>Você está recebendo esta mensagem porque um administrador clicou em
<strong>Enviar e-mail de teste</strong> na página "Notificações de
atualização" da sua instalação do PicPeak.</p>
<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Versão instalada:</strong> {{current_version}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Canal:</strong> {{channel}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Endereço do destinatário:</strong> {{recipient_email}}</p>
</div>
<p>Se você consegue ler este e-mail, sua configuração SMTP e a lista de destinatários estão funcionando corretamente. Quando uma nova versão real estiver disponível, o PicPeak enviará uma notificação separada com notas de versão e instruções de atualização.</p>
<p style="color: #666; font-size: 13px; margin-top: 30px;">Nenhuma ação é necessária. Você pode excluir esta mensagem com segurança.</p>`,
        body_text: `Este é um e-mail de teste\n\nVocê está recebendo esta mensagem porque um administrador clicou em "Enviar e-mail de teste" na página "Notificações de atualização" da sua instalação do PicPeak.\n\nVersão instalada: {{current_version}}\nCanal: {{channel}}\nEndereço do destinatário: {{recipient_email}}\n\nSe você consegue ler este e-mail, sua configuração SMTP está funcionando corretamente.\n\nNenhuma ação é necessária.`,
      },
      ru: {
        subject: '[ТЕСТ] Уведомление об обновлениях PicPeak — проверка',
        body_html: `<h2>Это тестовое письмо</h2>
<p>Вы получили это сообщение, потому что администратор нажал
<strong>Отправить тестовое письмо</strong> на странице
«Уведомления об обновлениях» вашей установки PicPeak.</p>
<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Установленная версия:</strong> {{current_version}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Канал:</strong> {{channel}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Адрес получателя:</strong> {{recipient_email}}</p>
</div>
<p>Если вы видите это письмо, значит ваша конфигурация SMTP и список получателей работают корректно. Когда станет доступна новая версия, PicPeak отправит отдельное уведомление с примечаниями к выпуску и инструкциями по обновлению.</p>
<p style="color: #666; font-size: 13px; margin-top: 30px;">Никаких действий не требуется. Можете безопасно удалить это сообщение.</p>`,
        body_text: `Это тестовое письмо\n\nВы получили это сообщение, потому что администратор нажал «Отправить тестовое письмо» на странице «Уведомления об обновлениях» вашей установки PicPeak.\n\nУстановленная версия: {{current_version}}\nКанал: {{channel}}\nАдрес получателя: {{recipient_email}}\n\nЕсли вы видите это письмо, ваша конфигурация SMTP работает корректно.\n\nНикаких действий не требуется.`,
      },
      fr: {
        subject: '[TEST] Notification de mise à jour PicPeak — vérification',
        body_html: `<h2>Ceci est un e-mail de test</h2>
<p>Vous recevez ce message parce qu'un administrateur a cliqué sur
<strong>Envoyer un e-mail de test</strong> sur la page « Notifications
de mise à jour » de votre installation PicPeak.</p>
<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Version installée :</strong> {{current_version}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Canal :</strong> {{channel}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Adresse du destinataire :</strong> {{recipient_email}}</p>
</div>
<p>Si vous pouvez lire cet e-mail, votre configuration SMTP et la liste des destinataires fonctionnent correctement. Lorsqu'une nouvelle version réelle sera disponible, PicPeak enverra une notification distincte avec les notes de version et les instructions de mise à jour.</p>
<p style="color: #666; font-size: 13px; margin-top: 30px;">Aucune action n'est requise. Vous pouvez supprimer ce message en toute sécurité.</p>`,
        body_text: `Ceci est un e-mail de test\n\nVous recevez ce message parce qu'un administrateur a cliqué sur « Envoyer un e-mail de test » sur la page « Notifications de mise à jour » de votre installation PicPeak.\n\nVersion installée : {{current_version}}\nCanal : {{channel}}\nAdresse du destinataire : {{recipient_email}}\n\nSi vous pouvez lire cet e-mail, votre configuration SMTP fonctionne correctement.\n\nAucune action n'est requise.`,
      },
    },
  };

  const keyRows = await knex('email_templates')
    .whereIn('template_key', Object.keys(TRANSLATIONS))
    .select('id', 'template_key');
  const keyToId = Object.fromEntries(keyRows.map((r) => [r.template_key, r.id]));

  let inserted = 0;
  let skipped = 0;
  for (const [key, perLocale] of Object.entries(TRANSLATIONS)) {
    const templateId = keyToId[key];
    if (!templateId) continue;
    for (const [language, content] of Object.entries(perLocale)) {
      const existing = await knex('email_template_translations')
        .where({ template_id: templateId, language })
        .first();
      if (existing) { skipped += 1; continue; }
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
  console.log(`100_backfill_email_template_subcategory: translation rows inserted=${inserted}, skipped=${skipped}`);
};

exports.down = async function() {
  // No-op. This migration is a data backfill — rolling it back would
  // require restoring the previous values, which we don't track.
  // Migration 098's down handler still owns dropping the columns.
};
