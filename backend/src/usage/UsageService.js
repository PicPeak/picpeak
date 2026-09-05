'use strict';
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { getStoragePath } = require('../config/storage');
const { formatBoolean } = require('../utils/dbCompat');
const {
  ConflictError,
  ValidationError,
  ServiceUnavailableError
} = require('../utils/errors');
const {
  generateIdentity,
  makePacket,
  signPacket,
  verifyEnvelope,
  digest,
  canonical,
  FEATURE_KEYS,
  LEGACY_FEATURE_KEYS,
  CATALOG,
  CURRENT_SCHEMA_VERSION,
  CURRENT_CONSENT_VERSION,
  featureKeysFor,
  observesUse,
  LAYOUTS
} = require('./protocol.cjs');

// The collector this installation reports to. Declared once rather than
// inline, because it is a deployment choice: self-hosters point
// USAGE_COLLECTOR_URL at their own collector, and the admin UI links to
// whatever is configured rather than to this default. Kept out of the wire
// contract — `schema.cjs` is vendored byte-identical with picpeak-usage and
// its `$id` is a schema identity, not a delivery address.
const DEFAULT_COLLECTOR_URL = 'https://usage.picpeak.app';

const FLAG_MAP = {
  crm: 'clients',
  crm_quotes: 'quotes',
  crm_invoices: 'bills',
  crm_contracts: 'contracts',
  crm_projects: 'projects',
  crm_calendar: 'calendar',
  crm_hours: 'hoursLogging',
  customer_portal: 'customerPortal',
  accounting: 'accounting',
  workflows: 'workflows',
  newsletters: 'newsletters',
  face_recognition: 'faces',
  whatsapp: 'whatsapp'
};
const SETTING_KEYS = [
  'oidc_enabled',
  'oidc_issuer_url',
  'oidc_client_id',
  'backup_enabled',
  'database_backup_enabled',
  'backup_destination_type',
  'backup_s3_bucket',
  'theme_config',
  'general_custom_css',
  'general_public_site_custom_css'
];
const truth = (value) => value === true || value === 1 || value === '1';

// `events.color_theme` holds either a theme object or the NAME of a preset —
// the admin theme picker stores names, and eventTypeService seeds them too
// (`theme_preset: 'corporateTimeline'`). Reading only `value.galleryLayout`
// therefore reported `grid` for every preset-themed install.
//
// Only the layout each name maps to is duplicated here, not the presets
// themselves; frontend/src/types/theme.types.ts stays the source of truth. A
// name this map does not know reports `other` rather than a confident `grid`,
// so a preset added on the frontend degrades to "something else" instead of
// quietly inflating the grid count.
const PRESET_LAYOUTS = {
  default: 'grid',
  elegantWedding: 'grid',
  modernMasonry: 'masonry',
  birthdayFun: 'carousel',
  corporateTimeline: 'timeline',
  artisticMosaic: 'mosaic',
  darkClassic: 'grid',
  darkElegant: 'grid',
  darkModern: 'masonry',
  galleryPremium: 'gallery-premium',
  galleryStory: 'gallery-story'
};

function resolveLayout(value) {
  const named =
    typeof value === 'string'
      ? PRESET_LAYOUTS[value]
      : value && typeof value === 'object'
        ? value.galleryLayout
        : null;
  if (!named) return typeof value === 'string' ? 'other' : 'grid';
  return LAYOUTS.includes(named) ? named : 'other';
}
const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch (_) {
    return value;
  }
};

class UsageService {
  schemaVersion(state) {
    return state?.consent_version === CURRENT_CONSENT_VERSION
      ? CURRENT_SCHEMA_VERSION : 'usage.v1';
  }
  constructor(db, options = {}) {
    this.db = db;
    this.fetch = options.fetch || global.fetch;
    this.now = options.now || (() => Date.now());
    this.version = options.version || require('../../package.json').version;
    this.secret =
      options.secret ||
      process.env.USAGE_ENCRYPTION_KEY ||
      process.env.JWT_SECRET;
    // Falls back to the default whenever nothing usable is configured —
    // unset, empty, or whitespace. Deployments that template the variable in
    // (docker-compose writes USAGE_COLLECTOR_URL=${USAGE_COLLECTOR_URL:-...})
    // can hand over an empty string, and that must mean "use the default",
    // not "no collector". A value that is present but malformed is NOT
    // silently replaced: quietly retargeting a self-hoster's collector at
    // ours would send their reports somewhere they did not choose.
    const configured = (options.endpoint ?? process.env.USAGE_COLLECTOR_URL ?? '').trim();
    this.endpoint = configured || DEFAULT_COLLECTOR_URL;
    this.bindingPath =
      options.bindingPath || path.join(getStoragePath(), 'usage-instance.key');
    this.encKey = null;
  }

  collectorUrl() {
    const url = new URL(this.endpoint);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          loopback &&
          process.env.NODE_ENV !== 'production'
        ))
    ) {
      throw new ValidationError('Invalid usage collector URL');
    }
    return url.origin;
  }
  key() {
    if (!this.secret || this.secret.length < 32)
      throw new ServiceUnavailableError(
        'Usage signing-key encryption is not configured'
      );
    if (!this.encKey)
      this.encKey = crypto.scryptSync(
        this.secret,
        'picpeak-product-usage-v1',
        32
      );
    return this.encKey;
  }
  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data]
      .map((v) => v.toString('base64url'))
      .join('.');
  }
  decrypt(value) {
    try {
      const [iv, tag, data] = value
        .split('.')
        .map((v) => Buffer.from(v, 'base64url'));
      const cipher = crypto.createDecipheriv('aes-256-gcm', this.key(), iv);
      cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(data), cipher.final()]).toString(
        'utf8'
      );
    } catch (error) {
      // The signing key is encrypted with USAGE_ENCRYPTION_KEY, which defaults
      // to JWT_SECRET — so rotating JWT_SECRET, the correct response to a
      // suspected compromise, makes this key unreadable. Without a name of its
      // own that surfaced as a generic DELIVERY_FAILED that retried forever,
      // and it silently blocks the DELETE packet too: participation could
      // never be withdrawn from the collector. Tagged so the operator is told
      // what actually happened.
      const failure = new Error('Usage signing key cannot be decrypted');
      failure.code = 'SIGNING_KEY_UNREADABLE';
      throw failure;
    }
  }
  async binding(create = false) {
    if (create) {
      await fs.mkdir(path.dirname(this.bindingPath), { recursive: true });
      try {
        await fs.writeFile(
          this.bindingPath,
          crypto.randomBytes(32).toString('hex'),
          { flag: 'wx', mode: 0o600 }
        );
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    try {
      return digest(await fs.readFile(this.bindingPath));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async state() {
    return this.db('product_usage_state').where({ id: 1 }).first();
  }
  async status() {
    const state = await this.state();
    // Reported, not thrown. status() used to call collectorUrl() bare, so a
    // misconfigured USAGE_COLLECTOR_URL — a bare hostname, a path, a query, or
    // http in production — failed this request outright. The settings page
    // renders one generic failure when its status query errors, so the
    // operator saw "the operation could not be completed" with no cause AND
    // no way to reach their own state: they could not read the status or even
    // withdraw, because every control on that tab is behind this call.
    let collectorUrl = null;
    let collectorError = null;
    try {
      collectorUrl = this.collectorUrl();
    } catch {
      collectorError = 'INVALID_COLLECTOR_URL';
    }
    return {
      status: state.status,
      notice_dismissed: Boolean(state.notice_dismissed),
      installation_id: state.installation_id,
      collector_url: collectorUrl,
      collector_error: collectorError,
      schema_version: this.schemaVersion(state),
      available_schema_version: CURRENT_SCHEMA_VERSION,
      consent_version: state.consent_version || 'usage-consent.v1',
      consent_update_available: state.status === 'active' && this.schemaVersion(state) !== CURRENT_SCHEMA_VERSION,
      last_report_date: state.last_report_date,
      last_error: state.last_error,
      pending_action: state.pending_packet
        ? JSON.parse(state.pending_packet).action
        : null,
      last_packet: state.last_packet ? JSON.parse(state.last_packet) : null,
      privacy_receipts: state.privacy_receipts
        ? JSON.parse(state.privacy_receipts)
        : {},
      feedback_preferences: state.feedback_preferences
        ? JSON.parse(state.feedback_preferences)
        : { name: '' }
    };
  }

  async locked(fn) {
    const token = crypto.randomUUID();
    const updated = await this.db('product_usage_state')
      .where({ id: 1 })
      .where('lease_until', '<=', this.now())
      .update({ lease_token: token, lease_until: this.now() + 60000 });
    if (!updated)
      throw new ConflictError('Usage operation is already in progress');
    try {
      return await fn(await this.state());
    } finally {
      await this.db('product_usage_state')
        .where({ id: 1, lease_token: token })
        .update({ lease_token: null, lease_until: 0 });
    }
  }

  async dismiss() {
    await this.db('product_usage_state')
      .where({ id: 1 })
      .update({ notice_dismissed: formatBoolean(true) });
    return this.status();
  }
  async enable(consent) {
    if (!['usage-consent.v1', CURRENT_CONSENT_VERSION].includes(consent))
      throw new ValidationError('Explicit usage consent is required');
    // Read BEFORE the lease, deliberately. locked() claims the lease and then
    // reads the row in a second statement; a /disable completing between
    // those two would be adopted as this activation's own baseline and
    // silently absorbed. Taking the baseline first inverts that: every
    // increment from this point on — including one in that gap — is later
    // than the value the claim tests for, so the claim fails and the
    // withdrawal wins. An increment from BEFORE this read is a withdrawal the
    // operator already completed, and a deliberate opt-in afterwards should
    // not be vetoed by it.
    const cancelSeq = Number((await this.state())?.cancel_seq || 0);
    await this.locked(async (state) => {
      if (state.status !== 'disabled')
        throw new ConflictError(
          'Finish the current participation before rejoining'
        );
      this.collectorUrl();
      const identity = generateIdentity();
      const pending = makePacket(identity, 'register', 0, {
        consent_version: consent
      }, this.schemaVersion({ consent_version: consent }));
      // Identity generation and the binding file are the slow part, and the
      // row still reads `disabled` throughout — which is why /disable could
      // not see an activation in flight and its conditional update matched
      // nothing.
      const instanceBinding = await this.binding(true);

      // The claim itself carries the check. Re-reading the flag and then
      // updating would only move the window rather than close it: this is one
      // conditional UPDATE, so a /disable that lands first makes it match no
      // rows and the registration is never sent.
      const claimed = await this.db('product_usage_state')
        .where({ id: 1, status: 'disabled', cancel_seq: cancelSeq })
        .update({
          status: 'activation_pending',
          consent_version: consent,
          notice_dismissed: formatBoolean(true),
          installation_id: identity.installation_id,
          public_key: identity.public_key,
          private_key_encrypted: this.encrypt(identity.private_key),
          instance_binding: instanceBinding,
          sequence: 0,
          pending_packet: JSON.stringify(pending),
          last_error: null
        });
      // Withdrawn while activating. Participation stays off and nothing was
      // registered, so there is nothing to delete remotely either.
      if (!claimed) return;

      await this.deliver(await this.state());
    });
    return this.status();
  }

  async disable() {
    // Counted unconditionally and first, because the interesting case is the
    // one where there is seemingly nothing to stop: while /enable is still
    // generating an identity the row reads `disabled`, so the conditional
    // update below matches nothing and the lease conflict from tick() is
    // swallowed — the admin was told participation was off while the
    // activation went on to complete. enable() claims its state only if this
    // counter is unchanged, so a withdrawal landing in that window wins.
    await this.db('product_usage_state')
      .where({ id: 1 })
      .increment('cancel_seq', 1);

    // Stop collection before waiting for an in-flight send. The sender checks
    // state again before delivery and preserves this stop after its response.
    await this.db('product_usage_state')
      .where({ id: 1 })
      .whereNot({ status: 'disabled' })
      .update({
        status: 'deletion_pending',
        feedback_preferences: null,
        pending_packet: null,
        last_packet: null,
        last_receipt: null,
        last_report_date: null
      });
    await this.db('product_usage_markers').delete();
    try {
      await this.tick();
    } catch (error) {
      // A sender may still own the lease. Collection is already stopped and
      // the next admin activity retries deletion after that sender finishes.
      if (error.code !== 'CONFLICT') throw error;
    }
    return this.status();
  }

  async post(pathname, body, maxResponseBytes = 65536) {
    const response = await this.fetch(`${this.collectorUrl()}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    });
    if (Number(response.headers.get('content-length') || 0) > maxResponseBytes)
      throw new ServiceUnavailableError('Invalid collector response');
    let raw = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxResponseBytes)
        throw new ServiceUnavailableError('Invalid collector response');
      raw += decoder.decode(chunk, { stream: true });
    }
    raw += decoder.decode();
    const value = JSON.parse(raw);
    if (!response.ok) {
      const error = new Error('Collector rejected operation');
      error.code = value.error;
      throw error;
    }
    return value;
  }
  async deliver(state) {
    const packet = JSON.parse(state.pending_packet);
    if (
      packet.action !== 'delete' &&
      (await this.state()).status === 'deletion_pending'
    )
      return null;
    try {
      if (
        packet.action !== 'delete' &&
        state.instance_binding !== (await this.binding())
      ) {
        await this.db('product_usage_state')
          .where({ id: 1 })
          // Never over an opt-out. A withdrawal that arrived while this
          // binding lookup was in flight would otherwise be replaced by
          // identity_conflict, and tick() stops there — so the deletion the
          // operator asked for would never be sent. The collector-conflict
          // handler below already guards the same way.
          .whereNot({ status: 'deletion_pending' })
          .update({
            status: 'identity_conflict',
            last_error: 'INSTANCE_COPY_DETECTED'
          });
        return null;
      }
      const envelope = signPacket(
        packet,
        {
          public_key: state.public_key,
          private_key: this.decrypt(state.private_key_encrypted)
        },
        new Date(this.now())
      );
      // Last check before anything leaves. The guard at the top of this
      // method runs before the binding lookup above, which is asynchronous —
      // so a withdrawal that COMPLETED during it would previously still have
      // had its registration or report dispatched afterwards. This is not
      // about an already-in-flight request; it is about not starting one.
      if (
        packet.action !== 'delete' &&
        (await this.state()).status === 'deletion_pending'
      )
        return null;
      const receipt = await this.post('/api/envelopes', envelope);
      if (
        receipt.packet_id !== packet.packet_id ||
        receipt.installation_id !== packet.installation_id ||
        receipt.packet_digest !== digest(canonical(packet)) ||
        receipt.action !== packet.action ||
        receipt.sequence !== packet.sequence ||
        receipt.status !== (packet.action === 'delete' ? 'deleted' : 'accepted')
      ) {
        throw new Error('Invalid collector receipt');
      }
      if (packet.action === 'delete') {
        await fs.unlink(this.bindingPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await this.db('product_usage_markers').delete();
        await this.db('product_usage_state')
          .where({ id: 1 })
          .update({
            status: 'disabled',
            installation_id: null,
            public_key: null,
            private_key_encrypted: null,
            instance_binding: null,
            pending_packet: null,
            last_packet: null,
            last_receipt: null,
            privacy_receipts: JSON.stringify({
              last_deletion: {
                receipt_version: 'local-audit.v1',
                kind: 'deletion',
                receipt_id: crypto.randomUUID(),
                confirmed_at: new Date(this.now()).toISOString(),
                status: 'collector-confirmed',
                scope: [
                  'reports',
                  'snapshots',
                  'feedback',
                  'votes',
                  'sessions',
                  'operations',
                  'registration'
                ]
              }
            }),
            last_report_date: null,
            last_error: null,
            sequence: 0,
            feedback_preferences: null
          });
      } else {
        const storedReceipt = { ...receipt };
        delete storedReceipt.session_token;
        const update = {
          sequence: packet.sequence,
          pending_packet: null,
          last_error: null,
          last_receipt: JSON.stringify(storedReceipt)
        };
        if (packet.action === 'report') {
          update.last_packet = JSON.stringify(envelope);
          update.last_report_date = packet.payload.report_date;
        }
        // Activation goes in with the acknowledgement, not after it. Split
        // across two writes, a failure or a stop between them left the row
        // `activation_pending` with pending_packet already cleared — and
        // tick() has nothing to retry from there, so the installation was
        // registered with the collector but permanently stuck locally.
        // Still guarded on activation_pending, so a withdrawal that arrived
        // first is not overwritten.
        const ack = this.db('product_usage_state').where({ id: 1 });
        if (packet.action === 'register') {
          update.status = 'active';
          // Precisely activation_pending, not merely "not withdrawing" —
          // this write is the one that turns participation on.
          ack.where({ status: 'activation_pending' });
        } else {
          ack.whereNot({ status: 'deletion_pending' });
        }
        if (packet.action === 'consent') {
          // Upgrade and reset the observation period atomically. A late receipt
          // must never re-enable collection after an intervening opt-out.
          await this.db.transaction(async (tx) => {
            const upgraded = await tx('product_usage_state')
              .where({ id: 1, status: 'active', installation_id: packet.installation_id })
              .update({ ...update, consent_version: CURRENT_CONSENT_VERSION });
            if (upgraded) await tx('product_usage_markers').delete();
          });
        } else {
          await ack.update(update);
        }
        await this.db('product_usage_state')
          .where({ id: 1, status: 'deletion_pending' })
          .update({ sequence: packet.sequence, pending_packet: null });
      }
      return receipt;
    } catch (error) {
      const rejected = [
        'INVALID_PACKET',
        'INVALID_REPORT_DATE',
        'INVALID_PUBLICATION_CONSENT',
        'REQUEST_NOT_FOUND',
        'FEEDBACK_CONFLICT'
      ].includes(error.code);
      if (rejected && ['feedback', 'vote', 'session'].includes(packet.action)) {
        await this.db('product_usage_state')
          .where({ id: 1 })
          .whereNot({ status: 'deletion_pending' })
          .update({ pending_packet: null, last_error: 'REQUEST_REJECTED' });
        return null;
      }
      const conflict = [
        'SEQUENCE_CONFLICT',
        'IDENTITY_CONFLICT',
        'IDENTITY_REVOKED',
        'NOT_REGISTERED',
        'PACKET_CONFLICT'
      ].includes(error.code);
      const code = conflict
        ? error.code
        : error.code === 'SIGNING_KEY_UNREADABLE'
          ? 'SIGNING_KEY_UNREADABLE'
          : 'DELIVERY_FAILED';
      await this.db('product_usage_state')
        .where({ id: 1 })
        .update({ last_error: code });
      if (conflict && packet.action !== 'delete') {
        await this.db('product_usage_state')
          .where({ id: 1 })
          .whereNot({ status: 'deletion_pending' })
          .update({ status: 'identity_conflict' });
      }
      return null;
    }
  }

  async tick() {
    await this.locked(async (state) => {
      if (state.status === 'disabled') return;
      if (state.status === 'deletion_pending') {
        const packet = makePacket(state, 'delete', Number(state.sequence), {}, this.schemaVersion(state));
        state.pending_packet = JSON.stringify(packet);
        await this.db('product_usage_state')
          .where({ id: 1 })
          .update({ pending_packet: state.pending_packet });
        await this.deliver(state);
        return;
      }
      if (state.status === 'identity_conflict') return;
      if (state.pending_packet) {
        await this.deliver(state);
        state = await this.state();
      }
      if (state.status !== 'active' || state.pending_packet) return;
      if (
        state.last_report_date ===
        new Date(this.now()).toISOString().slice(0, 10)
      )
        return;
      const payload = await this.snapshot(this.schemaVersion(state));
      const packet = makePacket(
        state,
        'report',
        Number(state.sequence) + 1,
        payload,
        this.schemaVersion(state)
      );
      state.pending_packet = JSON.stringify(packet);
      // Only while still active. /disable clears pending_packet and moves the
      // status without taking the lease, so an unconditional write here could
      // put a report back into the outbox after the withdrawal had emptied
      // it — and deliver() would then leave it there, since it declines to
      // send anything but the delete.
      const enqueued = await this.db('product_usage_state')
        .where({ id: 1, status: 'active' })
        .update({ pending_packet: state.pending_packet });
      if (!enqueued) return;
      await this.deliver(state);
    });
    return this.status();
  }

  async markUsed(features, { destinationBackup = false, legacyFeatures } = {}) {
    let allowed = [...new Set([...features, ...(legacyFeatures || [])])].filter((f) =>
      FEATURE_KEYS.includes(f)
    );
    if (!allowed.length) return;
    // Single-transaction status check prevents opt-out racing a late marker.
    await this.db.transaction(async (tx) => {
      const query = tx('product_usage_state').where({ id: 1 });
      if (this.db.client.config.client === 'pg') query.forUpdate();
      const state = await query.first();
      if (!state || state.status !== 'active') return;
      const version = this.schemaVersion(state);
      if (legacyFeatures) allowed = version === 'usage.v1' ? legacyFeatures : features;
      allowed = allowed.filter((feature) => featureKeysFor(version).includes(feature) && observesUse(feature, version));
      if (!allowed.length) return;
      // Only when the operation actually writes to the configured backup
      // destination. Deriving this from "a backup ran while S3 is configured"
      // marked S3 as USED for a local database backup or a .picpeak export,
      // which the middleware also counts as `backup` — so merely configuring
      // S3 and downloading a local export claimed S3 was in use.
      if (destinationBackup && allowed.includes('backup')) {
        const destination = await tx('app_settings')
          .where({ setting_key: 'backup_destination_type' })
          .first();
        if (destination && parse(destination.setting_value) === 's3') {
          allowed.push('s3_storage');
          if (version === CURRENT_SCHEMA_VERSION) allowed.push('s3_backups');
        }
      }
      await tx('product_usage_markers')
        .insert([...new Set(allowed)].map((feature) => ({ feature })))
        .onConflict('feature')
        .ignore();
    });
  }

  async snapshot(version) {
    version = version || this.schemaVersion(await this.state());
    const rows = await this.db('app_settings')
      .whereIn('setting_key', SETTING_KEYS)
      .select('setting_key', 'setting_value');
    const settings = Object.fromEntries(
      rows.map((r) => [r.setting_key, parse(r.setting_value)])
    );
    const flagRows = await this.db('feature_flags')
      .whereIn('key', version === CURRENT_SCHEMA_VERSION
        ? [...new Set([...Object.values(FLAG_MAP), 'incomingMail', ...Object.values(CATALOG.features).map((f) => f.flag).filter(Boolean)])]
        : Object.values(FLAG_MAP))
      .select('key', 'value');
    const flags = Object.fromEntries(
      flagRows.map((r) => [r.key, truth(r.value)])
    );
    const used = new Set(
      await this.db('product_usage_markers').pluck('feature')
    );
    const features = Object.fromEntries(
      LEGACY_FEATURE_KEYS.map((key) => [
        key,
        { configured: Boolean(flags[FLAG_MAP[key]]), used: used.has(key) }
      ])
    );
    features.oauth.configured =
      truth(settings.oidc_enabled) &&
      Boolean(settings.oidc_issuer_url && settings.oidc_client_id);
    // Either kind counts. The middleware records /backup/* and
    // /database-backup/* under the same capability, so reading only
    // backup_enabled reported `used: true, configured: false` for an install
    // whose only backup is the scheduled database one.
    features.backup.configured =
      truth(settings.backup_enabled) || truth(settings.database_backup_enabled);
    features.s3_storage.configured =
      (settings.backup_destination_type === 's3' &&
        Boolean(settings.backup_s3_bucket)) ||
      (process.env.STORAGE_BACKEND === 's3' &&
        Boolean(
          process.env.STORAGE_S3_BUCKET &&
            process.env.STORAGE_S3_ACCESS_KEY &&
            process.env.STORAGE_S3_SECRET_KEY
        ));
    features.share_mounts.configured = Boolean(
      await this.db('events')
        .whereNotNull('external_path')
        .whereNot('external_path', '')
        .select('id')
        .first()
    );
    features.smtp.configured =
      Boolean(
        await this.db('email_configs')
          .whereNotNull('smtp_host')
          .whereNot('smtp_host', '')
          .select('id')
          .first()
      ) ||
      Boolean(
        await this.db('mail_accounts')
          .whereNotNull('smtp_host')
          .whereNot('smtp_host', '')
          .select('id')
          .first()
      );
    features.whatsapp.configured =
      features.whatsapp.configured &&
      Boolean(
        await this.db('whatsapp_configs')
          .where({ enabled: formatBoolean(true) })
          .whereNot('phone_number_id', '')
          .whereNot('access_token', '')
          .select('id')
          .first()
      );
    const theme = settings.theme_config || {};
    // An enabled template applied to an event is gallery styling by the same
    // definition as the settings fields — the Custom CSS tab is where both are
    // authored. Existence only; template contents are never read.
    const appliedTemplate = await this.db('css_templates')
      .where('is_enabled', formatBoolean(true))
      .whereIn(
        'id',
        this.db('events').whereNotNull('css_template_id').select('css_template_id')
      )
      .select('id')
      .first();
    features.custom_css.configured = Boolean(
      settings.general_custom_css ||
        settings.general_public_site_custom_css ||
        theme.customCss ||
        appliedTemplate
    );
    // Read only the theme field, never event names, IDs, sizes, counts, or photos.
    const themes = await this.db('events').distinct('color_theme');
    const layouts = new Set();
    // An event with no theme of its own renders with the global one.
    const inheritedLayout = resolveLayout(theme);
    for (const row of themes) {
      const value = parse(row.color_theme);
      if (row.color_theme === null || row.color_theme === '') {
        layouts.add(inheritedLayout);
      } else {
        layouts.add(resolveLayout(value));
      }
      if (value && typeof value === 'object' && value.customCss)
        features.custom_css.configured = true;
    }
    // Applied CSS is already a capability in use; no visitor observation is
    // needed. Remember its presence as a coarse lifetime marker after consent.
    if (features.custom_css.configured) {
      await this.markUsed(['custom_css']);
      features.custom_css.used = true;
    }
    const now = new Date(this.now()).toISOString();
    const expanded = version === CURRENT_SCHEMA_VERSION
      ? await require('./expandedSnapshot').expandSnapshot(this.db, { features, flags, used, now: this.now() })
      : features;
    return {
      picpeak_version: this.version,
      report_date: now.slice(0, 10),
      generated_at: now,
      features: expanded,
      gallery_layouts: [...layouts].sort()
    };
  }

  async preview() {
    const state = await this.state();
    if (state.status !== 'active')
      throw new ConflictError('Usage participation is not active');
    return this.snapshot();
  }
  async command(action, payload) {
    let receipt;
    await this.locked(async (state) => {
      if (state.status !== 'active')
        throw new ConflictError('Usage participation is not active');
      if (state.pending_packet)
        throw new ConflictError('Retry the pending usage operation first');
      if (!['feedback', 'vote', 'session', 'consent'].includes(action))
        throw new ValidationError('Invalid usage action');
      if (action === 'consent' && state.consent_version === CURRENT_CONSENT_VERSION)
        throw new ConflictError('Usage consent is already current');
      const packet = makePacket(
        state,
        action,
        Number(state.sequence) + 1,
        payload,
        action === 'consent' ? CURRENT_SCHEMA_VERSION : this.schemaVersion(state)
      );
      // Validate the complete packet before storing an un-sendable operation.
      verifyEnvelope(
        signPacket(
          packet,
          {
            public_key: state.public_key,
            private_key: this.decrypt(state.private_key_encrypted)
          },
          new Date(this.now())
        ),
        this.now()
      );
      state.pending_packet = JSON.stringify(packet);
      // Same guard as the report enqueue in tick(): a command captured while
      // active must not restore its payload — feedback body and name
      // included — into the outbox that /disable has just cleared.
      const enqueued = await this.db('product_usage_state')
        .where({ id: 1, status: 'active' })
        .update({ pending_packet: state.pending_packet });
      if (!enqueued)
        throw new ConflictError('Usage participation is not active');
      receipt = await this.deliver(state);
    });
    const state = await this.status();
    return {
      delivered: Boolean(receipt),
      queued: Boolean(state.pending_action),
      receipt,
      state
    };
  }
  async preferences(value) {
    if (
      !value ||
      Object.keys(value).some((k) => k !== 'name') ||
      typeof value.name !== 'string' ||
      value.name.length > 80
    )
      throw new ValidationError('Invalid feedback preferences');
    const updated = await this.db('product_usage_state')
      .where({ id: 1, status: 'active' })
      .update({
        feedback_preferences: JSON.stringify({ name: value.name.trim() })
      });
    if (!updated) throw new ConflictError('Usage participation is not active');
    return this.status();
  }
  async export() {
    const state = await this.state();
    if (!state.installation_id) throw new ConflictError('No usage identity');
    // Own-data export includes the complete retained history, not a truncated
    // packet subset. The acceptance/receipt path above stays strictly bounded.
    const result = await this.post(
      '/api/participant/lookup',
      { installation_id: state.installation_id },
      Infinity
    );
    // Only the last export during this participation is retained locally.
    // Do not restore audit state if opt-out/identity replacement happened while
    // the export was in flight. The downloaded file carries the full receipt.
    const receipts = state.privacy_receipts
      ? JSON.parse(state.privacy_receipts)
      : {};
    await this.db('product_usage_state')
      .where({
        id: 1,
        status: 'active',
        installation_id: state.installation_id
      })
      .update({
        privacy_receipts: JSON.stringify({
          ...receipts,
          last_export: {
            receipt_version: 'local-audit.v1',
            kind: 'export',
            receipt_id: crypto.randomUUID(),
            confirmed_at: new Date(this.now()).toISOString(),
            report_count: Array.isArray(result.packets)
              ? result.packets.length
              : 0,
            scope: ['unique accepted usage reports']
          }
        })
      });
    return result;
  }
}
module.exports = { UsageService, FLAG_MAP };
