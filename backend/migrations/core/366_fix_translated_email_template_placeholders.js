/**
 * Migration: Repair the nl / pt / ru / fr (and one sl) email-template
 * translations whose placeholders the senders never fill.
 *
 * Migrations 099 (nl/pt/ru/fr) and 108 (sl) seeded these rows with
 * machine-translated copy that invented its own variable names:
 * `{{invitation_link}}` and `{{inviter_name}}` in admin_invitation (the
 * sender passes `invite_link`), a reset-link flow in admin_password_reset
 * (the sender mails a temporary password), `{{backup_path}}`,
 * `{{failed_at}}`, `{{release_url}}` and more in the backup / restore /
 * update notices. safeTemplateReplace leaves an unknown placeholder as
 * literal text, so those mails went out with `{{...}}` in them, and the
 * invitation button pointed at `{{invitation_link}}` — webmail clients
 * resolved that as a relative URL on their own host.
 *
 * Per row:
 *   - Nothing to do when the row uses only placeholders the sender fills
 *     (already fixed by hand, or never affected).
 *   - A row still exactly as 099 / 108 seeded it is replaced with the
 *     corrected copy below, which mirrors the English template.
 *   - A row an admin has edited keeps its wording. Only the placeholders
 *     with a direct equivalent are renamed (invitation_link → invite_link,
 *     release_url → release_notes_url); anything else unknown is logged so
 *     the admin can fix it in the Templates editor.
 *
 * Idempotent and safe to re-run: a repaired row no longer carries an
 * unknown placeholder, so the second pass skips it. That matters because
 * the migration runner re-runs a file whose name is not in the ledger,
 * and the stable twin of this fix has a different number.
 */

const { TRANSLATIONS: SEEDED_099 } = require('./099_seed_missing_email_template_translations');
const { TRANSLATIONS: SEEDED_108 } = require('./108_seed_sl_email_template_translations');

/** The variables each template's sender passes (see the queueEmail calls). */
const SENT_VARIABLES = {
  admin_invitation: ['invite_link', 'role_name', 'expires_at'],
  admin_password_reset: ['username', 'new_password', 'admin_login_url'],
  backup_completed: ['start_time', 'duration', 'files_count', 'total_size', 'backup_type'],
  backup_failed: ['start_time', 'backup_type', 'error_message'],
  database_backup_completed: ['backup_type', 'duration', 'file_size', 'compression_ratio', 'file_path'],
  database_backup_failed: ['backup_type', 'error_message', 'timestamp'],
  restore_completed: ['restore_type', 'duration', 'files_restored', 'backup_id', 'timestamp'],
  restore_failed: ['restore_type', 'error_message', 'timestamp'],
  version_update_available: ['current_version', 'new_version', 'channel', 'release_notes_url', 'admin_url'],
};

/** Placeholder renames that keep an edited row's meaning. */
const RENAMES = {
  invitation_link: 'invite_link',
  release_url: 'release_notes_url',
};

/**
 * A short notice: heading, one sentence, a list of labelled values, and an
 * optional closing sentence. Builds the HTML and plain-text bodies the same
 * way the English backup / restore templates are laid out.
 */
function notice({ subject, title, intro, fields, outro }) {
  const items = fields.map(([label, key]) => `  <li><strong>${label}:</strong> {{${key}}}</li>`).join('\n');
  const lines = fields.map(([label, key]) => `${label}: {{${key}}}`).join('\n');
  return {
    subject,
    body_html: `<h2>${title}</h2>\n<p>${intro}</p>\n<ul>\n${items}\n</ul>${outro ? `\n<p>${outro}</p>` : ''}`,
    body_text: `${title}\n\n${intro}\n\n${lines}${outro ? `\n\n${outro}` : ''}`,
  };
}

const CORRECTED = {
  admin_invitation: {
    nl: {
      subject: 'U bent uitgenodigd om deel te nemen aan PicPeak als {{role_name}}',
      body_html: `<h2>Welkom bij PicPeak</h2>
<p>U bent uitgenodigd om deel te nemen aan het fotodeelplatform PicPeak als <strong>{{role_name}}</strong>.</p>
<p>Klik op de onderstaande knop om de uitnodiging te accepteren en uw account in te stellen:</p>
<p><a href="{{invite_link}}" class="button">Uitnodiging accepteren</a></p>
<p><strong>Belangrijk:</strong> deze uitnodiging verloopt op <strong>{{expires_at}}</strong>.</p>
<p>Als u deze uitnodiging niet verwachtte, kunt u deze e-mail gerust negeren.</p>
<p style="color: #666; font-size: 13px;">Werkt de knop niet? Kopieer deze link naar uw browser:<br><a href="{{invite_link}}" style="word-break: break-all;">{{invite_link}}</a></p>`,
      body_text: `Welkom bij PicPeak\n\nU bent uitgenodigd om deel te nemen aan het fotodeelplatform PicPeak als {{role_name}}.\n\nAccepteer de uitnodiging en stel uw account in via deze link:\n{{invite_link}}\n\nBELANGRIJK: deze uitnodiging verloopt op {{expires_at}}.\n\nAls u deze uitnodiging niet verwachtte, kunt u deze e-mail gerust negeren.`,
    },
    pt: {
      subject: 'Você foi convidado(a) para o PicPeak como {{role_name}}',
      body_html: `<h2>Bem-vindo(a) ao PicPeak</h2>
<p>Você foi convidado(a) para participar da plataforma de partilha de fotos PicPeak como <strong>{{role_name}}</strong>.</p>
<p>Clique no botão abaixo para aceitar o convite e configurar sua conta:</p>
<p><a href="{{invite_link}}" class="button">Aceitar convite</a></p>
<p><strong>Importante:</strong> este convite expira em <strong>{{expires_at}}</strong>.</p>
<p>Se você não esperava este convite, pode ignorar este e-mail com segurança.</p>
<p style="color: #666; font-size: 13px;">Se o botão não funcionar, copie este link para o seu navegador:<br><a href="{{invite_link}}" style="word-break: break-all;">{{invite_link}}</a></p>`,
      body_text: `Bem-vindo(a) ao PicPeak\n\nVocê foi convidado(a) para participar da plataforma de partilha de fotos PicPeak como {{role_name}}.\n\nAceite o convite e configure sua conta neste link:\n{{invite_link}}\n\nIMPORTANTE: este convite expira em {{expires_at}}.\n\nSe você não esperava este convite, pode ignorar este e-mail com segurança.`,
    },
    ru: {
      subject: 'Вас пригласили присоединиться к PicPeak в роли {{role_name}}',
      body_html: `<h2>Добро пожаловать в PicPeak</h2>
<p>Вас пригласили присоединиться к платформе обмена фотографиями PicPeak в роли <strong>{{role_name}}</strong>.</p>
<p>Нажмите кнопку ниже, чтобы принять приглашение и настроить учётную запись:</p>
<p><a href="{{invite_link}}" class="button">Принять приглашение</a></p>
<p><strong>Важно:</strong> срок действия приглашения истекает <strong>{{expires_at}}</strong>.</p>
<p>Если вы не ожидали этого приглашения, просто проигнорируйте это письмо.</p>
<p style="color: #666; font-size: 13px;">Если кнопка не работает, скопируйте эту ссылку в браузер:<br><a href="{{invite_link}}" style="word-break: break-all;">{{invite_link}}</a></p>`,
      body_text: `Добро пожаловать в PicPeak\n\nВас пригласили присоединиться к платформе обмена фотографиями PicPeak в роли {{role_name}}.\n\nПримите приглашение и настройте учётную запись по ссылке:\n{{invite_link}}\n\nВАЖНО: срок действия приглашения истекает {{expires_at}}.\n\nЕсли вы не ожидали этого приглашения, просто проигнорируйте это письмо.`,
    },
    fr: {
      subject: 'Vous avez été invité(e) à rejoindre PicPeak en tant que {{role_name}}',
      body_html: `<h2>Bienvenue sur PicPeak</h2>
<p>Vous avez été invité(e) à rejoindre la plateforme de partage de photos PicPeak en tant que <strong>{{role_name}}</strong>.</p>
<p>Cliquez sur le bouton ci-dessous pour accepter l'invitation et configurer votre compte :</p>
<p><a href="{{invite_link}}" class="button">Accepter l'invitation</a></p>
<p><strong>Important :</strong> cette invitation expire le <strong>{{expires_at}}</strong>.</p>
<p>Si vous n'attendiez pas cette invitation, vous pouvez ignorer cet e-mail en toute sécurité.</p>
<p style="color: #666; font-size: 13px;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br><a href="{{invite_link}}" style="word-break: break-all;">{{invite_link}}</a></p>`,
      body_text: `Bienvenue sur PicPeak\n\nVous avez été invité(e) à rejoindre la plateforme de partage de photos PicPeak en tant que {{role_name}}.\n\nAcceptez l'invitation et configurez votre compte via ce lien :\n{{invite_link}}\n\nIMPORTANT : cette invitation expire le {{expires_at}}.\n\nSi vous n'attendiez pas cette invitation, vous pouvez ignorer cet e-mail en toute sécurité.`,
    },
  },

  admin_password_reset: {
    nl: {
      subject: 'Uw PicPeak-beheerderswachtwoord is opnieuw ingesteld',
      body_html: `<h2>Wachtwoord opnieuw ingesteld</h2>
<p>Hallo <strong>{{username}}</strong>,</p>
<p>Uw beheerderswachtwoord voor PicPeak is opnieuw ingesteld door een systeembeheerder.</p>
<ul>
  <li><strong>Gebruikersnaam:</strong> {{username}}</li>
  <li><strong>Tijdelijk wachtwoord:</strong> <code>{{new_password}}</code></li>
</ul>
<p><strong>Beveiliging:</strong> dit is een tijdelijk wachtwoord. Wijzig het direct na het inloggen en deel het met niemand. Heeft u hier niet om gevraagd, neem dan meteen contact op met uw systeembeheerder.</p>
<p><a href="{{admin_login_url}}" class="button">Nu inloggen</a></p>`,
      body_text: `Wachtwoord opnieuw ingesteld\n\nHallo {{username}},\n\nUw beheerderswachtwoord voor PicPeak is opnieuw ingesteld door een systeembeheerder.\n\nGebruikersnaam: {{username}}\nTijdelijk wachtwoord: {{new_password}}\n\nBEVEILIGING: dit is een tijdelijk wachtwoord. Wijzig het direct na het inloggen en deel het met niemand. Heeft u hier niet om gevraagd, neem dan meteen contact op met uw systeembeheerder.\n\nInloggen: {{admin_login_url}}`,
    },
    pt: {
      subject: 'Sua senha de administrador do PicPeak foi redefinida',
      body_html: `<h2>Senha redefinida</h2>
<p>Olá <strong>{{username}}</strong>,</p>
<p>Sua senha de administrador do PicPeak foi redefinida por um administrador do sistema.</p>
<ul>
  <li><strong>Nome de usuário:</strong> {{username}}</li>
  <li><strong>Senha temporária:</strong> <code>{{new_password}}</code></li>
</ul>
<p><strong>Segurança:</strong> esta é uma senha temporária. Altere-a logo após entrar e não a compartilhe com ninguém. Se você não solicitou esta redefinição, contate imediatamente o administrador do sistema.</p>
<p><a href="{{admin_login_url}}" class="button">Entrar agora</a></p>`,
      body_text: `Senha redefinida\n\nOlá {{username}},\n\nSua senha de administrador do PicPeak foi redefinida por um administrador do sistema.\n\nNome de usuário: {{username}}\nSenha temporária: {{new_password}}\n\nSEGURANÇA: esta é uma senha temporária. Altere-a logo após entrar e não a compartilhe com ninguém. Se você não solicitou esta redefinição, contate imediatamente o administrador do sistema.\n\nEntrar: {{admin_login_url}}`,
    },
    ru: {
      subject: 'Ваш пароль администратора PicPeak был сброшен',
      body_html: `<h2>Пароль сброшен</h2>
<p>Здравствуйте, <strong>{{username}}</strong>!</p>
<p>Системный администратор сбросил ваш пароль администратора PicPeak.</p>
<ul>
  <li><strong>Имя пользователя:</strong> {{username}}</li>
  <li><strong>Временный пароль:</strong> <code>{{new_password}}</code></li>
</ul>
<p><strong>Безопасность:</strong> это временный пароль. Смените его сразу после входа и никому не сообщайте. Если вы не запрашивали сброс, немедленно свяжитесь с системным администратором.</p>
<p><a href="{{admin_login_url}}" class="button">Войти</a></p>`,
      body_text: `Пароль сброшен\n\nЗдравствуйте, {{username}}!\n\nСистемный администратор сбросил ваш пароль администратора PicPeak.\n\nИмя пользователя: {{username}}\nВременный пароль: {{new_password}}\n\nБЕЗОПАСНОСТЬ: это временный пароль. Смените его сразу после входа и никому не сообщайте. Если вы не запрашивали сброс, немедленно свяжитесь с системным администратором.\n\nВход: {{admin_login_url}}`,
    },
    fr: {
      subject: 'Votre mot de passe administrateur PicPeak a été réinitialisé',
      body_html: `<h2>Mot de passe réinitialisé</h2>
<p>Bonjour <strong>{{username}}</strong>,</p>
<p>Votre mot de passe administrateur PicPeak a été réinitialisé par un administrateur système.</p>
<ul>
  <li><strong>Nom d'utilisateur :</strong> {{username}}</li>
  <li><strong>Mot de passe temporaire :</strong> <code>{{new_password}}</code></li>
</ul>
<p><strong>Sécurité :</strong> ce mot de passe est temporaire. Changez-le dès votre connexion et ne le communiquez à personne. Si vous n'avez pas demandé cette réinitialisation, contactez immédiatement votre administrateur système.</p>
<p><a href="{{admin_login_url}}" class="button">Se connecter</a></p>`,
      body_text: `Mot de passe réinitialisé\n\nBonjour {{username}},\n\nVotre mot de passe administrateur PicPeak a été réinitialisé par un administrateur système.\n\nNom d'utilisateur : {{username}}\nMot de passe temporaire : {{new_password}}\n\nSÉCURITÉ : ce mot de passe est temporaire. Changez-le dès votre connexion et ne le communiquez à personne. Si vous n'avez pas demandé cette réinitialisation, contactez immédiatement votre administrateur système.\n\nConnexion : {{admin_login_url}}`,
    },
  },

  backup_completed: {
    nl: notice({
      subject: 'Back-up voltooid',
      title: 'Back-up voltooid',
      intro: 'De geplande back-up is succesvol voltooid.',
      fields: [['Starttijd', 'start_time'], ['Duur', 'duration'], ['Bestanden', 'files_count'], ['Totale grootte', 'total_size'], ['Type back-up', 'backup_type']],
    }),
    pt: notice({
      subject: 'Backup concluído com sucesso',
      title: 'Backup concluído',
      intro: 'O backup agendado foi concluído com sucesso.',
      fields: [['Início', 'start_time'], ['Duração', 'duration'], ['Arquivos copiados', 'files_count'], ['Tamanho total', 'total_size'], ['Tipo de backup', 'backup_type']],
    }),
    ru: notice({
      subject: 'Резервное копирование завершено',
      title: 'Резервное копирование завершено',
      intro: 'Плановое резервное копирование успешно завершено.',
      fields: [['Время начала', 'start_time'], ['Длительность', 'duration'], ['Скопировано файлов', 'files_count'], ['Общий размер', 'total_size'], ['Тип резервной копии', 'backup_type']],
    }),
    fr: notice({
      subject: 'Sauvegarde terminée avec succès',
      title: 'Sauvegarde terminée',
      intro: 'La sauvegarde planifiée s\'est terminée avec succès.',
      fields: [['Début', 'start_time'], ['Durée', 'duration'], ['Fichiers sauvegardés', 'files_count'], ['Taille totale', 'total_size'], ['Type de sauvegarde', 'backup_type']],
    }),
  },

  backup_failed: {
    nl: notice({
      subject: 'Back-up mislukt — actie vereist',
      title: 'Back-up mislukt',
      intro: 'De geplande back-up is mislukt en vereist direct aandacht.',
      fields: [['Starttijd', 'start_time'], ['Type back-up', 'backup_type'], ['Fout', 'error_message']],
      outro: 'Controleer de systeemlogboeken voor meer details en los het probleem zo snel mogelijk op.',
    }),
    pt: notice({
      subject: 'Falha no backup — ação necessária',
      title: 'Falha no backup',
      intro: 'O backup agendado falhou e requer atenção imediata.',
      fields: [['Início', 'start_time'], ['Tipo de backup', 'backup_type'], ['Erro', 'error_message']],
      outro: 'Verifique os logs do sistema para mais detalhes e resolva o problema o quanto antes.',
    }),
    ru: notice({
      subject: 'Ошибка резервного копирования — требуется внимание',
      title: 'Ошибка резервного копирования',
      intro: 'Плановое резервное копирование завершилось ошибкой и требует немедленного внимания.',
      fields: [['Время начала', 'start_time'], ['Тип резервной копии', 'backup_type'], ['Ошибка', 'error_message']],
      outro: 'Проверьте системные журналы и устраните проблему как можно скорее.',
    }),
    fr: notice({
      subject: 'Échec de la sauvegarde — action requise',
      title: 'Échec de la sauvegarde',
      intro: 'La sauvegarde planifiée a échoué et nécessite une attention immédiate.',
      fields: [['Début', 'start_time'], ['Type de sauvegarde', 'backup_type'], ['Erreur', 'error_message']],
      outro: 'Consultez les journaux système pour plus de détails et corrigez le problème au plus vite.',
    }),
  },

  database_backup_completed: {
    nl: notice({
      subject: 'Databaseback-up voltooid',
      title: 'Databaseback-up voltooid',
      intro: 'De geplande databaseback-up is succesvol voltooid.',
      fields: [['Type back-up', 'backup_type'], ['Duur', 'duration'], ['Bestandsgrootte', 'file_size'], ['Compressie', 'compression_ratio'], ['Bestandspad', 'file_path']],
    }),
    pt: notice({
      subject: 'Backup do banco de dados concluído',
      title: 'Backup do banco de dados concluído',
      intro: 'O backup agendado do banco de dados foi concluído com sucesso.',
      fields: [['Tipo de backup', 'backup_type'], ['Duração', 'duration'], ['Tamanho do arquivo', 'file_size'], ['Taxa de compressão', 'compression_ratio'], ['Caminho do arquivo', 'file_path']],
    }),
    ru: notice({
      subject: 'Резервное копирование базы данных завершено',
      title: 'Резервное копирование базы данных завершено',
      intro: 'Плановое резервное копирование базы данных успешно завершено.',
      fields: [['Тип резервной копии', 'backup_type'], ['Длительность', 'duration'], ['Размер файла', 'file_size'], ['Степень сжатия', 'compression_ratio'], ['Путь к файлу', 'file_path']],
    }),
    fr: notice({
      subject: 'Sauvegarde de la base de données terminée',
      title: 'Sauvegarde de la base de données terminée',
      intro: 'La sauvegarde planifiée de la base de données s\'est terminée avec succès.',
      fields: [['Type de sauvegarde', 'backup_type'], ['Durée', 'duration'], ['Taille du fichier', 'file_size'], ['Taux de compression', 'compression_ratio'], ['Chemin du fichier', 'file_path']],
    }),
  },

  database_backup_failed: {
    nl: notice({
      subject: 'Databaseback-up mislukt — kritieke melding',
      title: 'Databaseback-up mislukt',
      intro: 'De geplande databaseback-up is mislukt en vereist direct aandacht.',
      fields: [['Type back-up', 'backup_type'], ['Tijdstip', 'timestamp'], ['Fout', 'error_message']],
      outro: 'Dit kan het herstel na een storing in gevaar brengen. Onderzoek het probleem direct.',
    }),
    pt: notice({
      subject: 'Falha no backup do banco de dados — alerta crítico',
      title: 'Falha no backup do banco de dados',
      intro: 'O backup agendado do banco de dados falhou e requer atenção imediata.',
      fields: [['Tipo de backup', 'backup_type'], ['Data e hora', 'timestamp'], ['Erro', 'error_message']],
      outro: 'Isto pode comprometer a recuperação em caso de desastre. Investigue imediatamente.',
    }),
    ru: notice({
      subject: 'Ошибка резервного копирования базы данных — критично',
      title: 'Ошибка резервного копирования базы данных',
      intro: 'Плановое резервное копирование базы данных завершилось ошибкой и требует немедленного внимания.',
      fields: [['Тип резервной копии', 'backup_type'], ['Время', 'timestamp'], ['Ошибка', 'error_message']],
      outro: 'Это может помешать восстановлению после сбоя. Немедленно выясните причину.',
    }),
    fr: notice({
      subject: 'Échec de la sauvegarde de la base de données — alerte critique',
      title: 'Échec de la sauvegarde de la base de données',
      intro: 'La sauvegarde planifiée de la base de données a échoué et nécessite une attention immédiate.',
      fields: [['Type de sauvegarde', 'backup_type'], ['Horodatage', 'timestamp'], ['Erreur', 'error_message']],
      outro: 'Cela peut compromettre la reprise après sinistre. Examinez le problème immédiatement.',
    }),
  },

  restore_completed: {
    nl: notice({
      subject: '✅ Herstel voltooid',
      title: 'Herstel voltooid',
      intro: 'Een herstelbewerking is succesvol voltooid.',
      fields: [['Type herstel', 'restore_type'], ['Duur', 'duration'], ['Herstelde bestanden', 'files_restored'], ['Back-up-ID', 'backup_id'], ['Tijdstip', 'timestamp']],
      outro: 'Controleer of alle systemen na het herstel correct werken.',
    }),
    pt: notice({
      subject: '✅ Restauração concluída',
      title: 'Restauração concluída',
      intro: 'Uma operação de restauração foi concluída com sucesso.',
      fields: [['Tipo de restauração', 'restore_type'], ['Duração', 'duration'], ['Arquivos restaurados', 'files_restored'], ['ID do backup', 'backup_id'], ['Data e hora', 'timestamp']],
      outro: 'Verifique se todos os sistemas funcionam corretamente após a restauração.',
    }),
    ru: notice({
      subject: '✅ Восстановление завершено',
      title: 'Восстановление завершено',
      intro: 'Операция восстановления успешно завершена.',
      fields: [['Тип восстановления', 'restore_type'], ['Длительность', 'duration'], ['Восстановлено файлов', 'files_restored'], ['ID резервной копии', 'backup_id'], ['Время', 'timestamp']],
      outro: 'Убедитесь, что после восстановления все системы работают корректно.',
    }),
    fr: notice({
      subject: '✅ Restauration terminée',
      title: 'Restauration terminée',
      intro: 'Une opération de restauration s\'est terminée avec succès.',
      fields: [['Type de restauration', 'restore_type'], ['Durée', 'duration'], ['Fichiers restaurés', 'files_restored'], ['ID de sauvegarde', 'backup_id'], ['Horodatage', 'timestamp']],
      outro: 'Vérifiez que tous les systèmes fonctionnent correctement après la restauration.',
    }),
    sl: notice({
      subject: '✅ Obnovitev uspešno zaključena',
      title: 'Obnovitev uspešno zaključena',
      intro: 'Postopek obnovitve je bil uspešno zaključen.',
      fields: [['Vrsta obnovitve', 'restore_type'], ['Trajanje', 'duration'], ['Obnovljene datoteke', 'files_restored'], ['ID varnostne kopije', 'backup_id'], ['Čas', 'timestamp']],
      outro: 'Preverite, ali aplikacija deluje pravilno in ali so podatki dostopni.',
    }),
  },

  restore_failed: {
    nl: notice({
      subject: '❌ Herstel mislukt',
      title: 'Herstel mislukt',
      intro: 'Een herstelbewerking is mislukt en vereist aandacht.',
      fields: [['Type herstel', 'restore_type'], ['Fout', 'error_message'], ['Tijdstip', 'timestamp']],
      outro: 'Controleer de systeemlogboeken voor meer details. Als er vóór het herstel een back-up is gemaakt, kan die voor herstel worden gebruikt.',
    }),
    pt: notice({
      subject: '❌ Falha na restauração',
      title: 'Falha na restauração',
      intro: 'Uma operação de restauração falhou e requer atenção.',
      fields: [['Tipo de restauração', 'restore_type'], ['Erro', 'error_message'], ['Data e hora', 'timestamp']],
      outro: 'Verifique os logs do sistema para mais detalhes. Se um backup foi criado antes da restauração, ele pode ser usado para recuperação.',
    }),
    ru: notice({
      subject: '❌ Ошибка восстановления',
      title: 'Ошибка восстановления',
      intro: 'Операция восстановления завершилась ошибкой и требует внимания.',
      fields: [['Тип восстановления', 'restore_type'], ['Ошибка', 'error_message'], ['Время', 'timestamp']],
      outro: 'Проверьте системные журналы. Если перед восстановлением была создана резервная копия, её можно использовать для отката.',
    }),
    fr: notice({
      subject: '❌ Échec de la restauration',
      title: 'Échec de la restauration',
      intro: 'Une opération de restauration a échoué et nécessite votre attention.',
      fields: [['Type de restauration', 'restore_type'], ['Erreur', 'error_message'], ['Horodatage', 'timestamp']],
      outro: 'Consultez les journaux système pour plus de détails. Si une sauvegarde a été créée avant la restauration, elle peut servir à la récupération.',
    }),
  },

  version_update_available: {
    nl: {
      subject: 'PicPeak-update beschikbaar: versie {{new_version}}',
      body_html: `<h2>Er is een nieuwe versie van PicPeak beschikbaar</h2>
<ul>
  <li><strong>Huidige versie:</strong> {{current_version}}</li>
  <li><strong>Nieuwe versie:</strong> {{new_version}}</li>
  <li><strong>Kanaal:</strong> {{channel}}</li>
</ul>
<p><a href="{{release_notes_url}}" class="button">Release-notities bekijken</a></p>
<p>Log in op het beheerpaneel en klik op de melding „Update beschikbaar" voor instructies voor uw omgeving.</p>
<p><strong>Tip:</strong> maak altijd een back-up van uw database voordat u bijwerkt.</p>`,
      body_text: `Er is een nieuwe versie van PicPeak beschikbaar\n\nHuidige versie: {{current_version}}\nNieuwe versie: {{new_version}}\nKanaal: {{channel}}\n\nRelease-notities: {{release_notes_url}}\n\nLog in op het beheerpaneel en klik op de melding "Update beschikbaar" voor instructies voor uw omgeving.\n\nTIP: maak altijd een back-up van uw database voordat u bijwerkt.`,
    },
    pt: {
      subject: 'Atualização do PicPeak disponível: versão {{new_version}}',
      body_html: `<h2>Uma nova versão do PicPeak está disponível</h2>
<ul>
  <li><strong>Versão atual:</strong> {{current_version}}</li>
  <li><strong>Nova versão:</strong> {{new_version}}</li>
  <li><strong>Canal:</strong> {{channel}}</li>
</ul>
<p><a href="{{release_notes_url}}" class="button">Ver notas da versão</a></p>
<p>Entre no painel de administração e clique na notificação "Atualização disponível" para ver as instruções para o seu ambiente.</p>
<p><strong>Lembrete:</strong> faça sempre um backup do banco de dados antes de atualizar.</p>`,
      body_text: `Uma nova versão do PicPeak está disponível\n\nVersão atual: {{current_version}}\nNova versão: {{new_version}}\nCanal: {{channel}}\n\nNotas da versão: {{release_notes_url}}\n\nEntre no painel de administração e clique na notificação "Atualização disponível" para ver as instruções para o seu ambiente.\n\nLEMBRETE: faça sempre um backup do banco de dados antes de atualizar.`,
    },
    ru: {
      subject: 'Доступно обновление PicPeak: версия {{new_version}}',
      body_html: `<h2>Доступна новая версия PicPeak</h2>
<ul>
  <li><strong>Текущая версия:</strong> {{current_version}}</li>
  <li><strong>Новая версия:</strong> {{new_version}}</li>
  <li><strong>Канал:</strong> {{channel}}</li>
</ul>
<p><a href="{{release_notes_url}}" class="button">Примечания к выпуску</a></p>
<p>Войдите в панель администратора и нажмите на уведомление «Доступно обновление», чтобы увидеть инструкции для вашей среды.</p>
<p><strong>Напоминание:</strong> всегда делайте резервную копию базы данных перед обновлением.</p>`,
      body_text: `Доступна новая версия PicPeak\n\nТекущая версия: {{current_version}}\nНовая версия: {{new_version}}\nКанал: {{channel}}\n\nПримечания к выпуску: {{release_notes_url}}\n\nВойдите в панель администратора и нажмите на уведомление «Доступно обновление», чтобы увидеть инструкции для вашей среды.\n\nНАПОМИНАНИЕ: всегда делайте резервную копию базы данных перед обновлением.`,
    },
    fr: {
      subject: 'Mise à jour PicPeak disponible : version {{new_version}}',
      body_html: `<h2>Une nouvelle version de PicPeak est disponible</h2>
<ul>
  <li><strong>Version actuelle :</strong> {{current_version}}</li>
  <li><strong>Nouvelle version :</strong> {{new_version}}</li>
  <li><strong>Canal :</strong> {{channel}}</li>
</ul>
<p><a href="{{release_notes_url}}" class="button">Voir les notes de version</a></p>
<p>Connectez-vous au panneau d'administration et cliquez sur la notification « Mise à jour disponible » pour les instructions propres à votre environnement.</p>
<p><strong>Rappel :</strong> sauvegardez toujours votre base de données avant de mettre à jour.</p>`,
      body_text: `Une nouvelle version de PicPeak est disponible\n\nVersion actuelle : {{current_version}}\nNouvelle version : {{new_version}}\nCanal : {{channel}}\n\nNotes de version : {{release_notes_url}}\n\nConnectez-vous au panneau d'administration et cliquez sur la notification « Mise à jour disponible » pour les instructions propres à votre environnement.\n\nRAPPEL : sauvegardez toujours votre base de données avant de mettre à jour.`,
    },
  },
};

const PLACEHOLDER = /\{\{\s*(?:#if\s+)?(\w+)\s*\}\}/g;

function placeholdersIn(row) {
  const found = new Set();
  for (const field of [row.subject, row.body_html, row.body_text]) {
    if (typeof field !== 'string') continue;
    for (const m of field.matchAll(PLACEHOLDER)) found.add(m[1]);
  }
  return found;
}

function matchesSeed(row, seed) {
  return Boolean(seed)
    && row.subject === seed.subject
    && row.body_html === seed.body_html
    && row.body_text === seed.body_text;
}

function renamePlaceholders(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (RENAMES[key] ? `{{${RENAMES[key]}}}` : match));
}

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (!(await knex.schema.hasTable('email_template_translations'))) return;

  const templates = await knex('email_templates')
    .whereIn('template_key', Object.keys(CORRECTED))
    .select('id', 'template_key');

  let replaced = 0;
  let renamed = 0;

  for (const { id, template_key: key } of templates) {
    const sent = new Set(SENT_VARIABLES[key]);
    for (const [language, corrected] of Object.entries(CORRECTED[key])) {
      const row = await knex('email_template_translations')
        .where({ template_id: id, language })
        .first();
      if (!row) continue;

      const unknown = [...placeholdersIn(row)].filter((name) => !sent.has(name));
      if (unknown.length === 0) continue;

      const seed = (language === 'sl' ? SEEDED_108 : SEEDED_099)?.[key]?.[language];
      if (matchesSeed(row, seed)) {
        await knex('email_template_translations')
          .where({ id: row.id })
          .update({ ...corrected, updated_at: new Date().toISOString() });
        replaced += 1;
        continue;
      }

      const patch = {
        subject: renamePlaceholders(row.subject),
        body_html: renamePlaceholders(row.body_html),
        body_text: renamePlaceholders(row.body_text),
      };
      const changed = patch.subject !== row.subject
        || patch.body_html !== row.body_html
        || patch.body_text !== row.body_text;
      if (changed) {
        await knex('email_template_translations')
          .where({ id: row.id })
          .update({ ...patch, updated_at: new Date().toISOString() });
        renamed += 1;
      }
      const left = [...placeholdersIn(patch)].filter((name) => !sent.has(name));
      if (left.length > 0) {
        console.warn(
          `366_fix_translated_email_template_placeholders: ${key} (${language}) was edited and still uses `
          + `${left.map((n) => `{{${n}}}`).join(', ')}, which the sender does not fill. Fix it in Settings → Email templates.`,
        );
      }
    }
  }

  console.log(`366_fix_translated_email_template_placeholders: replaced=${replaced}, renamed=${renamed}`);
};

exports.down = async function() {
  // No-op: rolling back would put the unfilled placeholders back.
};

// For the regression test.
exports.CORRECTED = CORRECTED;
exports.SENT_VARIABLES = SENT_VARIABLES;
