'use strict';

/**
 * Migration 357: backup restore tests.
 *
 * A backup run being "completed" with a valid manifest signature does not
 * prove it restores. backupVerificationService fetches a restore point back
 * from its destination, hashes the dump and the files against the manifest,
 * and loads the dump into a throwaway database (the restore drill). Each
 * check is one row here, so a failure is on record and never only logged.
 *
 *   backup_verifications
 *     backup_run_id            the file backup tested (null for a DB-only one)
 *     database_backup_run_id   the database-only dump tested
 *     level                    deep | drill: the highest level that ran
 *     status                   running | passed | warning | failed | skipped
 *     skip_reason              why a skipped test did not run
 *     checks                   JSON [{ name, result, detail }]
 *     full                     every file hashed, not business-docs + sample
 *     sample_percent           share of the other files hashed
 *     triggered_by             backup | schedule | admin
 *     triggered_by_admin_id    the admin for triggered_by = admin
 *
 * The `backupRestoreTest` feature flag (off by default) gates all of it.
 * The schedule settings (backup_verify_*) are read with their defaults when
 * absent, so nothing is seeded into app_settings.
 *
 * Additive and idempotent.
 */

const TEMPLATE_KEY = 'backup_verification_failed';

// en and de are reviewed; the other languages are machine-suggested and
// flagged for native review.
const TRANSLATIONS = {
  en: {
    subject: 'Backup restore test failed',
    body_html: `<h2>A backup failed its restore test</h2>
<p>PicPeak tried to restore a backup into a throwaway database and to check its files. The test failed, so this backup may not restore.</p>
<ul>
  <li>Backup: {{backup_label}}</li>
  <li>Tested: {{checked_at}}</li>
  <li>Test: {{verification_level}}</li>
</ul>
<p><strong>Failed checks:</strong></p>
<p>{{failed_checks}}</p>
<p>Open Backup &rarr; Integrity in the admin area for the full result, and run a new backup once the cause is fixed.</p>`,
    body_text: `A backup failed its restore test

PicPeak tried to restore a backup into a throwaway database and to check its files. The test failed, so this backup may not restore.

Backup: {{backup_label}}
Tested: {{checked_at}}
Test: {{verification_level}}

Failed checks:
{{failed_checks}}

Open Backup > Integrity in the admin area for the full result, and run a new backup once the cause is fixed.`,
  },
  de: {
    subject: 'Wiederherstellungstest eines Backups fehlgeschlagen',
    body_html: `<h2>Ein Backup hat den Wiederherstellungstest nicht bestanden</h2>
<p>PicPeak hat versucht, ein Backup in eine Wegwerf-Datenbank wiederherzustellen und seine Dateien zu prüfen. Der Test ist fehlgeschlagen, das Backup lässt sich möglicherweise nicht wiederherstellen.</p>
<ul>
  <li>Backup: {{backup_label}}</li>
  <li>Geprüft: {{checked_at}}</li>
  <li>Test: {{verification_level}}</li>
</ul>
<p><strong>Fehlgeschlagene Prüfungen:</strong></p>
<p>{{failed_checks}}</p>
<p>Das vollständige Ergebnis finden Sie im Adminbereich unter Backup &rarr; Integrität. Erstellen Sie ein neues Backup, sobald die Ursache behoben ist.</p>`,
    body_text: `Ein Backup hat den Wiederherstellungstest nicht bestanden

PicPeak hat versucht, ein Backup in eine Wegwerf-Datenbank wiederherzustellen und seine Dateien zu prüfen. Der Test ist fehlgeschlagen, das Backup lässt sich möglicherweise nicht wiederherstellen.

Backup: {{backup_label}}
Geprüft: {{checked_at}}
Test: {{verification_level}}

Fehlgeschlagene Prüfungen:
{{failed_checks}}

Das vollständige Ergebnis finden Sie im Adminbereich unter Backup > Integrität. Erstellen Sie ein neues Backup, sobald die Ursache behoben ist.`,
  },
  es: {
    subject: 'La prueba de restauración de una copia de seguridad ha fallado',
    body_html: `<h2>Una copia de seguridad no superó la prueba de restauración</h2>
<p>PicPeak intentó restaurar una copia de seguridad en una base de datos temporal y comprobar sus archivos. La prueba falló, por lo que es posible que esta copia no se pueda restaurar.</p>
<ul>
  <li>Copia de seguridad: {{backup_label}}</li>
  <li>Comprobada: {{checked_at}}</li>
  <li>Prueba: {{verification_level}}</li>
</ul>
<p><strong>Comprobaciones fallidas:</strong></p>
<p>{{failed_checks}}</p>
<p>Abra Copia de seguridad &rarr; Integridad en el área de administración para ver el resultado completo y cree una nueva copia cuando haya corregido la causa.</p>`,
    body_text: `Una copia de seguridad no superó la prueba de restauración

PicPeak intentó restaurar una copia de seguridad en una base de datos temporal y comprobar sus archivos. La prueba falló, por lo que es posible que esta copia no se pueda restaurar.

Copia de seguridad: {{backup_label}}
Comprobada: {{checked_at}}
Prueba: {{verification_level}}

Comprobaciones fallidas:
{{failed_checks}}

Abra Copia de seguridad > Integridad en el área de administración para ver el resultado completo y cree una nueva copia cuando haya corregido la causa.`,
  },
  fr: {
    subject: 'Échec du test de restauration d\'une sauvegarde',
    body_html: `<h2>Une sauvegarde a échoué à son test de restauration</h2>
<p>PicPeak a tenté de restaurer une sauvegarde dans une base de données temporaire et de vérifier ses fichiers. Le test a échoué : cette sauvegarde risque de ne pas pouvoir être restaurée.</p>
<ul>
  <li>Sauvegarde : {{backup_label}}</li>
  <li>Testée : {{checked_at}}</li>
  <li>Test : {{verification_level}}</li>
</ul>
<p><strong>Vérifications en échec :</strong></p>
<p>{{failed_checks}}</p>
<p>Ouvrez Sauvegarde &rarr; Intégrité dans l'administration pour le résultat complet, puis lancez une nouvelle sauvegarde une fois la cause corrigée.</p>`,
    body_text: `Une sauvegarde a échoué à son test de restauration

PicPeak a tenté de restaurer une sauvegarde dans une base de données temporaire et de vérifier ses fichiers. Le test a échoué : cette sauvegarde risque de ne pas pouvoir être restaurée.

Sauvegarde : {{backup_label}}
Testée : {{checked_at}}
Test : {{verification_level}}

Vérifications en échec :
{{failed_checks}}

Ouvrez Sauvegarde > Intégrité dans l'administration pour le résultat complet, puis lancez une nouvelle sauvegarde une fois la cause corrigée.`,
  },
  nl: {
    subject: 'Hersteltest van een back-up mislukt',
    body_html: `<h2>Een back-up is gezakt voor de hersteltest</h2>
<p>PicPeak heeft geprobeerd een back-up in een tijdelijke database terug te zetten en de bestanden te controleren. De test is mislukt, dus deze back-up kan mogelijk niet worden hersteld.</p>
<ul>
  <li>Back-up: {{backup_label}}</li>
  <li>Getest: {{checked_at}}</li>
  <li>Test: {{verification_level}}</li>
</ul>
<p><strong>Mislukte controles:</strong></p>
<p>{{failed_checks}}</p>
<p>Open Back-up &rarr; Integriteit in het beheergedeelte voor het volledige resultaat en maak een nieuwe back-up zodra de oorzaak is opgelost.</p>`,
    body_text: `Een back-up is gezakt voor de hersteltest

PicPeak heeft geprobeerd een back-up in een tijdelijke database terug te zetten en de bestanden te controleren. De test is mislukt, dus deze back-up kan mogelijk niet worden hersteld.

Back-up: {{backup_label}}
Getest: {{checked_at}}
Test: {{verification_level}}

Mislukte controles:
{{failed_checks}}

Open Back-up > Integriteit in het beheergedeelte voor het volledige resultaat en maak een nieuwe back-up zodra de oorzaak is opgelost.`,
  },
  pt: {
    subject: 'O teste de restauro de uma cópia de segurança falhou',
    body_html: `<h2>Uma cópia de segurança falhou o teste de restauro</h2>
<p>O PicPeak tentou restaurar uma cópia de segurança numa base de dados temporária e verificar os seus ficheiros. O teste falhou, por isso esta cópia poderá não ser restaurável.</p>
<ul>
  <li>Cópia de segurança: {{backup_label}}</li>
  <li>Testada: {{checked_at}}</li>
  <li>Teste: {{verification_level}}</li>
</ul>
<p><strong>Verificações falhadas:</strong></p>
<p>{{failed_checks}}</p>
<p>Abra Cópia de segurança &rarr; Integridade na área de administração para ver o resultado completo e crie uma nova cópia depois de corrigir a causa.</p>`,
    body_text: `Uma cópia de segurança falhou o teste de restauro

O PicPeak tentou restaurar uma cópia de segurança numa base de dados temporária e verificar os seus ficheiros. O teste falhou, por isso esta cópia poderá não ser restaurável.

Cópia de segurança: {{backup_label}}
Testada: {{checked_at}}
Teste: {{verification_level}}

Verificações falhadas:
{{failed_checks}}

Abra Cópia de segurança > Integridade na área de administração para ver o resultado completo e crie uma nova cópia depois de corrigir a causa.`,
  },
  ru: {
    subject: 'Тест восстановления резервной копии не пройден',
    body_html: `<h2>Резервная копия не прошла тест восстановления</h2>
<p>PicPeak попытался восстановить резервную копию во временную базу данных и проверить её файлы. Тест не пройден, поэтому эту копию, возможно, не удастся восстановить.</p>
<ul>
  <li>Резервная копия: {{backup_label}}</li>
  <li>Проверена: {{checked_at}}</li>
  <li>Тест: {{verification_level}}</li>
</ul>
<p><strong>Неудачные проверки:</strong></p>
<p>{{failed_checks}}</p>
<p>Откройте «Резервное копирование &rarr; Целостность» в админ-панели, чтобы увидеть полный результат, и создайте новую копию после устранения причины.</p>`,
    body_text: `Резервная копия не прошла тест восстановления

PicPeak попытался восстановить резервную копию во временную базу данных и проверить её файлы. Тест не пройден, поэтому эту копию, возможно, не удастся восстановить.

Резервная копия: {{backup_label}}
Проверена: {{checked_at}}
Тест: {{verification_level}}

Неудачные проверки:
{{failed_checks}}

Откройте «Резервное копирование > Целостность» в админ-панели, чтобы увидеть полный результат, и создайте новую копию после устранения причины.`,
  },
  sl: {
    subject: 'Preizkus obnovitve varnostne kopije ni uspel',
    body_html: `<h2>Varnostna kopija ni prestala preizkusa obnovitve</h2>
<p>PicPeak je poskušal obnoviti varnostno kopijo v začasno bazo podatkov in preveriti njene datoteke. Preizkus ni uspel, zato te kopije morda ni mogoče obnoviti.</p>
<ul>
  <li>Varnostna kopija: {{backup_label}}</li>
  <li>Preverjeno: {{checked_at}}</li>
  <li>Preizkus: {{verification_level}}</li>
</ul>
<p><strong>Neuspešna preverjanja:</strong></p>
<p>{{failed_checks}}</p>
<p>Za celoten rezultat odprite Varnostne kopije &rarr; Celovitost v skrbniškem delu in ustvarite novo kopijo, ko odpravite vzrok.</p>`,
    body_text: `Varnostna kopija ni prestala preizkusa obnovitve

PicPeak je poskušal obnoviti varnostno kopijo v začasno bazo podatkov in preveriti njene datoteke. Preizkus ni uspel, zato te kopije morda ni mogoče obnoviti.

Varnostna kopija: {{backup_label}}
Preverjeno: {{checked_at}}
Preizkus: {{verification_level}}

Neuspešna preverjanja:
{{failed_checks}}

Za celoten rezultat odprite Varnostne kopije > Celovitost v skrbniškem delu in ustvarite novo kopijo, ko odpravite vzrok.`,
  },
};

async function seedTemplate(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  const existing = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (existing) return;

  const cols = await knex('email_templates').columnInfo();
  const en = TRANSLATIONS.en;
  const row = {
    template_key: TEMPLATE_KEY,
    variables: JSON.stringify(['backup_label', 'checked_at', 'verification_level', 'failed_checks']),
  };
  if ('category' in cols) row.category = 'core';
  if ('subcategory' in cols) row.subcategory = 'backup';
  if ('feature_flag' in cols) row.feature_flag = 'backupRestoreTest';
  if ('created_at' in cols) row.created_at = new Date().toISOString();
  if ('updated_at' in cols) row.updated_at = new Date().toISOString();
  // Pre-075 installs keep content in per-language columns.
  for (const col of Object.keys(cols)) {
    if (col === 'subject' || /^subject_[a-z]{2,3}$/i.test(col)) row[col] = en.subject;
    else if (col === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(col)) row[col] = en.body_html;
    else if (col === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(col)) row[col] = en.body_text;
  }

  const inserted = await knex('email_templates').insert(row).returning('id');
  const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  if (templateId && await knex.schema.hasTable('email_template_translations')) {
    for (const [language, content] of Object.entries(TRANSLATIONS)) {
      await knex('email_template_translations').insert({
        template_id: templateId,
        language,
        subject: content.subject,
        body_html: content.body_html,
        body_text: content.body_text,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('backup_verifications'))) {
    await knex.schema.createTable('backup_verifications', (t) => {
      t.increments('id').primary();
      t.integer('backup_run_id').unsigned().references('id').inTable('backup_runs').onDelete('CASCADE');
      t.integer('database_backup_run_id').unsigned().references('id').inTable('database_backup_runs').onDelete('CASCADE');
      t.string('level', 16).notNullable().defaultTo('deep');
      t.string('status', 16).notNullable().defaultTo('running');
      t.string('skip_reason', 64);
      t.text('checks');
      t.boolean('full').notNullable().defaultTo(false);
      t.integer('sample_percent');
      t.string('triggered_by', 16).notNullable();
      t.integer('triggered_by_admin_id').unsigned().references('id').inTable('admin_users').onDelete('SET NULL');
      t.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('completed_at');
      t.index(['backup_run_id', 'id']);
      t.index(['database_backup_run_id', 'id']);
      t.index(['status', 'completed_at']);
    });
  }

  if (await knex.schema.hasTable('feature_flags')) {
    const flag = await knex('feature_flags').where({ key: 'backupRestoreTest' }).first();
    if (!flag) await knex('feature_flags').insert({ key: 'backupRestoreTest', value: false });
  }

  await seedTemplate(knex);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('backup_verifications');
  if (await knex.schema.hasTable('feature_flags')) {
    await knex('feature_flags').where({ key: 'backupRestoreTest' }).del();
  }
  if (await knex.schema.hasTable('email_templates')) {
    // SQLite does not enforce 075's cascade: the translations go first.
    const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first('id');
    if (template && await knex.schema.hasTable('email_template_translations')) {
      await knex('email_template_translations').where({ template_id: template.id }).del();
    }
    await knex('email_templates').where({ template_key: TEMPLATE_KEY }).del();
  }
};
