/**
 * Customer contacts (migration 342).
 *
 * The additional people of a customer, each with own rights. The account holder
 * stays on customer_accounts and always has every right, so a customer without
 * contacts behaves exactly as one did before.
 *
 * A person is an address. The same address can be a contact at several
 * customers, with one password for all of them (credentialFor). A holder can
 * also be a contact elsewhere, but the customer has to come first: an address
 * that is already a contact does not become a new customer's own. A session
 * works in exactly one customer at a time, and the rights are that customer's.
 *
 * A contact never owns anything. Documents, galleries and invoices stay on the
 * customer account, and a contact's session carries that account's id, so the
 * portal's ownership checks hold without knowing about contacts. Rights only
 * narrow what that session may do.
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { db, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { formatBoolean } = require('../utils/dbCompat');
const { isUniqueViolation } = require('../utils/dbErrors');
const { getBcryptRounds } = require('../utils/passwordValidation');
const { auditedUpdate } = require('./accountingHistory');
const { queueEmail } = require('./emailProcessor');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');
const { capabilityTokenColumns } = require('../utils/capabilityToken');
const { PROTECTED_PENDING_STATUS } = require('../utils/emailQueueEncryption');

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Area -> the levels it offers, lowest first. `act` is what changes something:
// choosing an album, accepting a quote, signing a contract, uploading a
// document, editing the company's data.
const RIGHTS = {
  galleries: ['none', 'view', 'act'],
  quotes: ['none', 'view', 'act'],
  contracts: ['none', 'view', 'act'],
  bills: ['none', 'view'],
  documents: ['none', 'view', 'act'],
  company: ['none', 'act'],
};

const AREAS = Object.keys(RIGHTS);
const FEATURE_OF_AREA = { bills: 'bills' };
const HOLDER_RIGHTS = Object.freeze(
  Object.fromEntries(AREAS.map((area) => [area, RIGHTS[area][RIGHTS[area].length - 1]])),
);

const PERSON_FIELDS = ['salutation', 'first_name', 'last_name', 'display_name', 'phone', 'preferred_language'];

const asFlag = (value) => value === true || value === 1 || value === '1' || value === 't';
// A customer a login can work in: active, and on the portal.
const liveCustomer = (q) => q.where('is_active', formatBoolean(true)).whereNotNull('password_hash');
const normaliseEmail = (email) => String(email || '').trim().toLowerCase();

/** A stored value that is not a level of its area grants nothing. */
function rightsOf(contact) {
  return Object.fromEntries(AREAS.map((area) => {
    const level = contact[`right_${area}`];
    return [area, RIGHTS[area].includes(level) ? level : 'none'];
  }));
}

function hasRight(rights, area, level = 'view') {
  const levels = RIGHTS[area];
  if (!levels || !rights) return false;
  return levels.indexOf(rights[area]) >= Math.max(levels.indexOf(level), 1);
}

/** A customer's effective features, narrowed to what this login may see. */
function applyRights(features, rights) {
  return {
    ...features,
    calendar: !!features.calendar && hasRight(rights, 'galleries'),
    quotes: !!features.quotes && hasRight(rights, 'quotes'),
    bills: !!features.bills && hasRight(rights, 'bills'),
    hoursLogging: !!features.hoursLogging && hasRight(rights, 'bills'),
    contracts: !!features.contracts && hasRight(rights, 'contracts'),
    documents: !!features.documents && hasRight(rights, 'documents'),
  };
}

function rightColumns(rights) {
  const out = {};
  for (const area of AREAS) {
    if (rights?.[area] === undefined) continue;
    if (!RIGHTS[area].includes(rights[area])) {
      throw new ValidationError(`Invalid right for ${area}`);
    }
    out[`right_${area}`] = rights[area];
  }
  return out;
}

function personColumns(input) {
  const out = {};
  for (const field of PERSON_FIELDS) {
    if (input?.[field] === undefined) continue;
    const value = typeof input[field] === 'string' ? input[field].trim().normalize('NFC') : input[field];
    out[field] = value || null;
  }
  return out;
}

/**
 * An address can be a contact at several customers, once at each. It may not
 * be the customer's own holder, and not a passive customer's or an open
 * invitation's: those become a holder with a password of their own later,
 * which would give one person two passwords.
 */
async function assertEmailFree(customerId, email, { exceptContactId = null, trx = db } = {}) {
  const holder = await trx('customer_accounts').whereRaw('LOWER(email) = ?', [email]).first('id', 'password_hash');
  const taken = holder && (holder.id === customerId || !holder.password_hash);
  const contact = await trx('customer_contacts')
    .where('customer_account_id', customerId)
    .whereRaw('LOWER(email) = ?', [email])
    .modify((q) => { if (exceptContactId) q.whereNot('id', exceptContactId); })
    .first('id');
  // An open invitation becomes a customer with this address once accepted.
  const invited = await trx('customer_invitations')
    .whereRaw('LOWER(email) = ?', [email])
    .whereNull('contact_id').whereNull('accepted_at')
    .where('expires_at', '>', new Date())
    .first('id');
  if (taken || contact || invited) throw new ConflictError('This email is already in use', 'email');
}

/** For the customer side of the same rule. */
async function isContactEmail(email, trx = db) {
  return !!(await trx('customer_contacts').whereRaw('LOWER(email) = ?', [normaliseEmail(email)]).first('id'));
}

/** The password of this address: a holder's own, otherwise its login row. */
async function credentialFor(email, trx = db) {
  const address = normaliseEmail(email);
  const holder = await trx('customer_accounts').whereRaw('LOWER(email) = ?', [address])
    .whereNotNull('password_hash').first('id', 'password_hash', 'password_changed_at');
  if (holder) return { kind: 'holder', ...holder };
  const login = await trx('customer_logins').where('email', address)
    .first('id', 'password_hash', 'password_changed_at');
  return login ? { kind: 'login', ...login } : null;
}

async function setPassword(email, passwordHash, trx = db) {
  const credential = await credentialFor(email, trx);
  if (!credential) return 0;
  const columns = { password_hash: passwordHash, password_changed_at: new Date(), updated_at: new Date() };
  if (credential.kind === 'login') return trx('customer_logins').where('id', credential.id).update(columns);
  return auditedUpdate(trx, 'customer_accounts', { id: credential.id }, columns,
    { actor: { type: 'customer', id: credential.id }, source: 'customer.contact.password' });
}

async function addressesWithLogin(emails) {
  const addresses = [...new Set(emails.map(normaliseEmail))];
  if (addresses.length === 0) return new Set();
  const marks = addresses.map(() => '?').join(', ');
  const holders = await db('customer_accounts')
    .whereRaw(`LOWER(email) IN (${marks})`, addresses).whereNotNull('password_hash').select('email');
  const logins = await db('customer_logins').whereIn('email', addresses).select('email');
  return new Set([...holders, ...logins].map((row) => row.email.toLowerCase()));
}

/**
 * Where this address can work: its own customer first, then the customers it
 * is an active contact of. Only customers that are active and on the portal,
 * for the same reason a passive customer's contact gets no invitation.
 */
async function membershipsFor(email) {
  const address = normaliseEmail(email);
  const out = [];
  const holder = await liveCustomer(db('customer_accounts').whereRaw('LOWER(email) = ?', [address])).first();
  if (holder) out.push({ customer: holder, contact: null });
  const contacts = await db('customer_contacts')
    .whereRaw('LOWER(email) = ?', [address])
    .where('is_active', formatBoolean(true))
    .orderBy('created_at', 'asc').orderBy('id', 'asc');
  for (const contact of contacts) {
    const customer = await liveCustomer(db('customer_accounts').where('id', contact.customer_account_id)).first();
    if (customer) out.push({ customer, contact });
  }
  return out;
}

function companyLabel(customer) {
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  return customer.company_name || customer.display_name || name || customer.email;
}

/** For the portal's company switcher. */
async function companiesFor(email) {
  return (await membershipsFor(email)).map(({ customer }) => ({ id: customer.id, name: companyLabel(customer) }));
}

function shape(contact, openInvitation, hasLogin) {
  return {
    id: contact.id,
    customerAccountId: contact.customer_account_id,
    email: contact.email,
    salutation: contact.salutation,
    firstName: contact.first_name,
    lastName: contact.last_name,
    displayName: contact.display_name,
    phone: contact.phone,
    preferredLanguage: contact.preferred_language,
    isActive: asFlag(contact.is_active),
    receivesMail: asFlag(contact.receives_mail),
    hasLogin,
    invitationPending: !!openInvitation,
    lastLogin: contact.last_login || null,
    rights: rightsOf(contact),
  };
}

async function loadContact(customerId, contactId) {
  const contact = await db('customer_contacts')
    .where({ id: contactId, customer_account_id: customerId }).first();
  if (!contact) throw new NotFoundError('Contact', contactId);
  return contact;
}

// Everything that acts on a contact's address or links holds this row, so an
// address change cannot pass a link being made for the old address. One lock
// order on PostgreSQL: contact, then login, then links, then the account.
async function lockContact(trx, customerId, contactId) {
  const contact = await trx('customer_contacts')
    .where({ id: contactId, customer_account_id: customerId }).forUpdate().first();
  if (!contact) throw new NotFoundError('Contact', contactId);
  return contact;
}

async function listContacts(customerId) {
  const contacts = await db('customer_contacts')
    .where('customer_account_id', customerId)
    .orderBy('created_at', 'asc').orderBy('id', 'asc');
  if (contacts.length === 0) return [];
  const open = await db('customer_invitations')
    .whereIn('contact_id', contacts.map((c) => c.id))
    .whereNull('accepted_at')
    .where('expires_at', '>', new Date())
    .select('contact_id');
  const pending = new Set(open.map((row) => row.contact_id));
  const logins = await addressesWithLogin(contacts.map((c) => c.email));
  return contacts.map((c) => shape(c, pending.has(c.id), logins.has(c.email.toLowerCase())));
}

async function shapeOne(customerId, contactId) {
  const contact = await loadContact(customerId, contactId);
  return shape(contact, false, !!(await credentialFor(contact.email)));
}

/**
 * A contact without a login is a person named on the customer; `invite` sends
 * them the link to set a password. Someone who already has a login has nothing
 * to set: the customer appears in their company switcher. A login needs a
 * customer with portal access:
 * "passive" is decided by the account's own password_hash in many places, and
 * a passive customer with working logins would contradict all of them.
 */
async function createContact(customerId, input, adminId) {
  const email = normaliseEmail(input.email);
  if (!email) throw new ValidationError('Email is required');
  const customer = await db('customer_accounts').where('id', customerId).first();
  if (!customer) throw new NotFoundError('Customer', customerId);
  if (!asFlag(customer.is_active)) throw new ValidationError('This customer is inactive');
  await assertEmailFree(customerId, email);
  const invite = input.invite && !(await credentialFor(email));
  if (invite && !customer.password_hash) throw passiveCustomerError();

  const [inserted] = await db('customer_contacts').insert({
    customer_account_id: customerId,
    email,
    ...personColumns(input),
    ...rightColumns(input.rights),
    receives_mail: formatBoolean(input.receivesMail !== false),
    is_active: formatBoolean(true),
    created_by_admin_id: adminId || null,
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('id').catch(conflictOnDuplicate);
  const id = inserted?.id || inserted;

  await logActivity('customer_contact_created',
    { customerId, contactId: id, email }, null, { type: 'admin', id: adminId });
  if (invite) await sendInvitation(customerId, id, adminId);
  return shapeOne(customerId, id);
}

async function updateContact(customerId, contactId, input, adminId) {
  const updates = { ...personColumns(input), ...rightColumns(input.rights) };
  if (input.receivesMail !== undefined) updates.receives_mail = formatBoolean(!!input.receivesMail);
  const email = input.email === undefined ? undefined : normaliseEmail(input.email);
  if (email === '') throw new ValidationError('Email is required');

  await db.transaction(async (trx) => {
    const contact = await lockContact(trx, customerId, contactId);
    const oldAddress = contact.email.toLowerCase();
    const moves = email !== undefined && email !== contact.email;
    const deactivates = input.isActive === false && asFlag(contact.is_active);
    await lockLogins(trx, [oldAddress]);
    const lastUse = !(await usedElsewhere(contact, trx));

    if (moves) {
      await assertEmailFree(customerId, email, { exceptContactId: contactId, trx });
      updates.email = email;
      updates.password_changed_at = new Date();
      // The login follows the person, unless the old address still works
      // elsewhere. Where the new address is already someone, the old login
      // goes: it must not open their customers, and no contact row would lead
      // to it anymore, so nothing could remove it.
      if (lastUse) {
        const oldLogin = trx('customer_logins').where('email', oldAddress);
        const taken = await credentialFor(email, trx)
          || await trx('customer_contacts').whereRaw('LOWER(email) = ?', [email]).whereNot('id', contactId).first('id');
        if (taken) await oldLogin.del();
        else await oldLogin.update({ email, updated_at: new Date() }).catch(conflictOnDuplicate);
      }
      // The old address must not be able to finish setting up this login.
      await trx('customer_invitations').where('contact_id', contactId).whereNull('accepted_at').del();
      await trx('customer_password_resets').where('contact_id', contactId).whereNull('used_at').del();
    }
    if (input.isActive !== undefined) {
      updates.is_active = formatBoolean(!!input.isActive);
      if (!input.isActive) updates.password_changed_at = new Date();
    }
    if (moves || deactivates) await cancelQueuedMail(trx, oldAddress, customerId, { lastUse });
    updates.updated_at = new Date();
    await trx('customer_contacts').where('id', contactId).update(updates).catch(conflictOnDuplicate);
  });

  await logActivity('customer_contact_updated',
    { customerId, contactId, fields: Object.keys(updates).filter((k) => k !== 'updated_at') },
    null, { type: 'admin', id: adminId });
  return shapeOne(customerId, contactId);
}

// Removals of one address at two customers wait for each other here, so the
// later one sees it is the last and takes the login along.
async function lockLogins(trx, emails) {
  await trx('customer_logins').whereIn('email', emails).orderBy('email').forUpdate().select('id');
}

// Is this address still someone apart from this one contact row?
async function usedElsewhere(contact, trx = db) {
  const address = contact.email.toLowerCase();
  const holder = await trx('customer_accounts').whereRaw('LOWER(email) = ?', [address]).first('id');
  const other = await trx('customer_contacts').whereRaw('LOWER(email) = ?', [address])
    .whereNot('id', contact.id).first('id');
  return !!(holder || other);
}

// Unsent mail about this customer must not reach someone who left it. What was
// already sent stays in the log until the customer is erased. Only this
// customer's: the same address can also be a contract's signer or on a
// campaign, and that mail is not the contact's.
async function cancelQueuedMail(trx, email, customerId, { lastUse }) {
  for (const row of await mailAbout(trx, email, customerId, ['pending'])) {
    await trx('email_queue').where({ id: row.id, status: 'pending' }).update({ status: 'cancelled' });
  }
  // Invitation and reset mail names no customer. It leads to this login, so it
  // goes with the last contact row.
  if (lastUse) {
    await trx('email_queue')
      .whereRaw('LOWER(recipient_email) = ?', [email])
      .whereIn('email_type', ['customer_invitation', 'customer_password_reset'])
      .whereIn('status', ['pending', PROTECTED_PENDING_STATUS])
      .update({ status: 'cancelled' });
  }
  // Invoice mail reaches a contact as a CC on the customer's own row.
  const copied = await trx('email_queue')
    .where('status', 'pending')
    .whereRaw('LOWER(CAST(email_data AS TEXT)) LIKE ?', [`%${email}%`])
    .select('id', 'email_data');
  for (const row of copied) {
    let data;
    try {
      data = typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
    } catch (_) {
      continue;
    }
    if (!Array.isArray(data?.cc) || Number(data.__customerAccountId) !== Number(customerId)) continue;
    const cc = data.cc.filter((address) => String(address).toLowerCase() !== email);
    if (cc.length === data.cc.length) continue;
    await trx('email_queue').where('id', row.id)
      .update({ email_data: JSON.stringify({ ...data, cc }) });
  }
}

// Rows queued to this address for this customer (queueEmail's customerAccountId).
async function mailAbout(trx, email, customerId, statuses) {
  const rows = await trx('email_queue')
    .whereRaw('LOWER(recipient_email) = ?', [email])
    .whereIn('status', statuses)
    .select('id', 'status', 'email_data');
  return rows.filter((row) => {
    try {
      const data = typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
      return Number(data?.__customerAccountId) === Number(customerId);
    } catch (_) {
      return false;
    }
  });
}

// Is this address a holder or contact of a customer, or of any but this one?
async function addressAt(trx, address, { customerId, exceptCustomerId }) {
  const scoped = (q, column) => {
    if (customerId !== undefined) q.where(column, customerId);
    if (exceptCustomerId !== undefined) q.whereNot(column, exceptCustomerId);
    return q;
  };
  const holder = await scoped(trx('customer_accounts').whereRaw('LOWER(email) = ?', [address]), 'id').first('id');
  const contact = await scoped(trx('customer_contacts').whereRaw('LOWER(email) = ?', [address]), 'customer_account_id').first('id');
  return !!(holder || contact);
}

/** What erasure must leave of a holder's mail: what is about a customer they still belong to. */
async function mailToKeep(trx, customerId, email) {
  const address = normaliseEmail(email);
  const rows = await trx('email_queue')
    .whereRaw('LOWER(recipient_email) = ?', [address])
    .select('id', 'email_data');
  const keep = [];
  for (const row of rows) {
    let data;
    try {
      data = typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
    } catch (_) {
      continue;
    }
    if (data?.__customerAccountId == null) continue;
    const about = Number(data.__customerAccountId);
    if (about !== Number(customerId) && await addressAt(trx, address, { customerId: about })) keep.push(row.id);
  }
  return keep;
}

/**
 * Erasure of a holder who is a contact elsewhere: their password was on the
 * erased row, and the login there must outlive it. Same changed-at, so their
 * sessions at the other customers stay valid.
 */
async function keepHolderLogin(trx, customer) {
  if (!customer.password_hash) return;
  const email = normaliseEmail(customer.email);
  const elsewhere = await trx('customer_contacts').whereRaw('LOWER(email) = ?', [email]).first('id');
  if (!elsewhere) return;
  await trx('customer_logins').insert({
    email,
    password_hash: customer.password_hash,
    password_changed_at: customer.password_changed_at || null,
    created_at: new Date(),
    updated_at: new Date(),
  }).onConflict('email').ignore();
}

/**
 * Erasure: everything queued about this customer, whoever it went to and
 * whether or not they are still a contact. An address that is still someone
 * elsewhere stays on the row; the content goes either way.
 */
async function redactContactMail(trx, customerId, sentinelEmail) {
  const rows = await trx('email_queue')
    .whereRaw('CAST(email_data AS TEXT) LIKE ?', ['%__customerAccountId%'])
    .whereIn('status', ['pending', 'sent', 'failed', 'cancelled', 'suppressed'])
    .select('id', 'status', 'recipient_email', 'email_data');
  for (const row of rows) {
    let data;
    try {
      data = typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
    } catch (_) {
      continue;
    }
    if (Number(data?.__customerAccountId) !== Number(customerId)) continue;
    const stays = await addressAt(trx, row.recipient_email.toLowerCase(), { exceptCustomerId: customerId });
    await trx('email_queue').where('id', row.id).update({
      recipient_email: stays ? row.recipient_email : sentinelEmail,
      status: row.status === 'pending' ? 'cancelled' : row.status,
      email_data: JSON.stringify({ redacted: true, reason: 'customer_erased' }),
      rendered_html: null,
    });
  }
}

// Foreign keys do not run on SQLite, so a link would outlive its contact.
async function deleteContactLinks(trx, contactIds) {
  if (contactIds.length === 0) return;
  await trx('customer_invitations').whereIn('contact_id', contactIds).del();
  await trx('customer_password_resets').whereIn('contact_id', contactIds).del();
}

async function deleteContact(customerId, contactId, adminId) {
  await db.transaction(async (trx) => {
    const contact = await lockContact(trx, customerId, contactId);
    await lockLogins(trx, [contact.email.toLowerCase()]);
    const lastUse = !(await usedElsewhere(contact, trx));
    await cancelQueuedMail(trx, contact.email.toLowerCase(), customerId, { lastUse });
    await deleteContactLinks(trx, [contactId]);
    await trx('customer_contacts').where('id', contactId).del();
    if (lastUse) await trx('customer_logins').where('email', contact.email.toLowerCase()).del();
  });
  await logActivity('customer_contact_deleted',
    { customerId, contactId }, null, { type: 'admin', id: adminId });
}

// The checks above read first, so two requests at once can both pass them.
function conflictOnDuplicate(err) {
  if (isUniqueViolation(err)) throw new ConflictError('This email is already in use', 'email');
  throw err;
}

// The same refusal the holder's invitation and reset paths make.
async function activeCustomer(trx, customerId) {
  const customer = await trx('customer_accounts').where('id', customerId).first();
  if (!customer) throw new NotFoundError('Customer', customerId);
  if (!asFlag(customer.is_active)) throw new ValidationError('This customer is inactive');
  return customer;
}

function passiveCustomerError() {
  const err = new ValidationError('Invite the customer to the portal first');
  err.code = 'CUSTOMER_PASSIVE';
  return err;
}

async function sendInvitation(customerId, contactId, adminId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const { contact, customer } = await db.transaction(async (trx) => {
    const row = await lockContact(trx, customerId, contactId);
    if (await credentialFor(row.email, trx)) throw new ConflictError('This contact already has a login', 'email');
    if (!asFlag(row.is_active)) throw new ValidationError('This contact is inactive');
    const account = await activeCustomer(trx, customerId);
    if (!account.password_hash) throw passiveCustomerError();

    await trx('customer_invitations').where('contact_id', contactId).whereNull('accepted_at').del();
    await trx('customer_invitations').insert({
      email: row.email,
      ...capabilityTokenColumns(token),
      contact_id: contactId,
      invited_by: adminId,
      expires_at: expiresAt,
      created_at: new Date(),
      prefill_data: JSON.stringify(personColumns(row)),
    });
    return { contact: row, customer: account };
  });

  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  await queueEmail(null, contact.email, 'customer_invitation', {
    invite_link: `${frontendUrl}/customer/invite/${token}`,
    expires_at: expiresAt.toISOString(),
    __language: contact.preferred_language || customer.preferred_language || undefined,
  });
  await logActivity('customer_invitation_created',
    { email: contact.email, customerId, contactId }, null, { type: 'admin', id: adminId });
  return { email: contact.email, expiresAt };
}

/** An invitation row whose contact_id is set; called from acceptInvitation. */
async function acceptInvitation(invitation, { name, password, profile }) {
  const passwordHash = await bcrypt.hash(password, getBcryptRounds());
  const person = personColumns(profile);
  if (name && !person.display_name) person.display_name = String(name).trim().normalize('NFC') || null;

  const contact = await db.transaction(async (trx) => {
    // Only the invited person of a live customer, whose address still is the
    // invited one, and only once.
    const row = await trx('customer_contacts')
      .where({ id: invitation.contact_id, email: invitation.email, is_active: formatBoolean(true) })
      .forUpdate()
      .first();
    const claimed = await trx('customer_invitations')
      .where('id', invitation.id).whereNull('accepted_at')
      .where('expires_at', '>', new Date())
      .update({ accepted_at: new Date().toISOString() });
    if (claimed !== 1) throw new ValidationError('Invalid or expired invitation');

    const customer = row && await trx('customer_accounts')
      .where({ id: row.customer_account_id, is_active: formatBoolean(true) }).first('id');
    if (!customer) throw new ValidationError('Invalid or expired invitation');

    // Invited by two customers, the second acceptance finds the login made.
    if (await credentialFor(row.email, trx)) throw new ConflictError('Email already registered', 'email');
    await trx('customer_contacts').where('id', row.id).update({ ...person, updated_at: new Date() });
    await trx('customer_logins').insert({
      email: row.email.toLowerCase(),
      password_hash: passwordHash,
      created_at: new Date(),
      updated_at: new Date(),
    }).catch(conflictOnDuplicate);
    await trx('customer_invitations').where('id', invitation.id)
      .update({ accepted_customer_id: row.customer_account_id });
    return row;
  });

  await logActivity('customer_invitation_accepted',
    { customerId: contact.customer_account_id, contactId: contact.id, email: contact.email },
    null, { type: 'customer', id: contact.customer_account_id, name: contact.email });
  return { id: contact.customer_account_id, email: contact.email };
}

async function createPasswordReset(customerId, contactId, adminId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
  const { contact, customer } = await db.transaction(async (trx) => {
    const row = await lockContact(trx, customerId, contactId);
    if (!asFlag(row.is_active)) throw new ValidationError('Cannot reset password for an inactive contact');
    const account = await activeCustomer(trx, customerId);
    if (!account.password_hash) throw passiveCustomerError();
    if (!(await credentialFor(row.email, trx))) throw new ValidationError('This contact has no login yet');

    await trx('customer_password_resets').where('contact_id', contactId).whereNull('used_at').del();
    await trx('customer_password_resets').insert({
      ...capabilityTokenColumns(token),
      customer_account_id: customerId,
      contact_id: contactId,
      requested_by_admin_id: adminId || null,
      expires_at: expiresAt,
      created_at: new Date(),
    });
    return { contact: row, customer: account };
  });

  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  await queueEmail(null, contact.email, 'customer_password_reset', {
    reset_link: `${frontendUrl}/customer/reset-password/${token}`,
    expires_at: expiresAt.toISOString(),
    __language: contact.preferred_language || customer.preferred_language || undefined,
  });
  await logActivity('customer_password_reset_requested',
    { customerId, contactId, email: contact.email }, null, { type: 'admin', id: adminId });
  return { email: contact.email, expiresAt };
}

/** The contact a reset row belongs to, if it can still be used. */
async function contactForReset(row) {
  const contact = await db('customer_contacts')
    .where({ id: row.contact_id, is_active: formatBoolean(true) }).first();
  if (!contact) return null;
  const customer = await liveCustomer(db('customer_accounts').where('id', contact.customer_account_id)).first('id');
  return customer ? contact : null;
}

/** A session's right, read fresh: a gallery token does not carry rights. */
async function sessionMayAct(session, area) {
  if (session?.contactId === undefined) return true;
  const contact = await db('customer_contacts').where('id', session.contactId).first();
  return !!contact && hasRight(rightsOf(contact), area, 'act');
}

/** Called from applyPasswordReset for a reset row whose contact_id is set. */
async function applyPasswordReset(row, password) {
  const contact = await contactForReset(row);
  if (!contact) throw new ValidationError('Invalid or expired reset link');
  const passwordHash = await bcrypt.hash(password, getBcryptRounds());
  await db.transaction(async (trx) => {
    const locked = await lockContact(trx, contact.customer_account_id, contact.id);
    if (locked.email !== contact.email) throw new ValidationError('Invalid or expired reset link');
    await lockLogins(trx, [contact.email.toLowerCase()]);
    const claimed = await trx('customer_password_resets')
      .where('id', row.id).whereNull('used_at').where('expires_at', '>', new Date())
      .update({ used_at: new Date().toISOString() });
    if (claimed !== 1) throw new ValidationError('Invalid or expired reset link');
    const updated = await setPassword(contact.email, passwordHash, trx);
    if (updated !== 1) throw new ValidationError('Invalid or expired reset link');
  });
  await logActivity('customer_password_reset_applied',
    { customerId: contact.customer_account_id, contactId: contact.id, email: contact.email },
    null, { type: 'system', id: null, name: 'system' });
  return { email: contact.email };
}

/** Ends every contact session of a customer, as a bump does for the holder. */
async function endSessions(trx, customerId) {
  await trx('customer_contacts').where('customer_account_id', customerId)
    .update({ password_changed_at: new Date(), updated_at: new Date() });
}

/**
 * Contacts who get mail about `area`: a working login, mail switched on, and
 * the right for it. Keyed by nothing else, so a caller adds them to what the
 * customer's own addresses already receive.
 */
async function mailRecipients(customerId, area) {
  if (!customerId) return [];
  const contacts = await db('customer_contacts')
    .where({
      customer_account_id: customerId,
      is_active: formatBoolean(true),
      receives_mail: formatBoolean(true),
    });
  if (contacts.length === 0) return [];
  // Same customers as the switcher: their portal links would not open otherwise.
  if (!(await liveCustomer(db('customer_accounts').where('id', customerId)).first('id'))) return [];
  // A right cannot reach past what is switched on for this customer.
  const feature = FEATURE_OF_AREA[area];
  if (feature) {
    const features = await require('./customerAccountsService').getEffectiveFeaturesForCustomer(Number(customerId));
    if (!features[feature]) return [];
  }
  const logins = await addressesWithLogin(contacts.map((c) => c.email));
  return contacts.filter((c) => logins.has(c.email.toLowerCase()) && hasRight(rightsOf(c), area));
}

/** A notice to contacts comes on top: losing it must not lose the customer's own. */
async function noticeRecipients(customerId, area) {
  try {
    return await mailRecipients(customerId, area);
  } catch (err) {
    logger.warn('Contacts could not be resolved for a notice', { customerId, area, error: err.message });
    return [];
  }
}

/** First in an erasure, before the account: the same order as everything else. */
async function lockForErasure(trx, customerId) {
  const rows = await trx('customer_contacts').where('customer_account_id', customerId)
    .orderBy('id').forUpdate().select('email');
  await lockLogins(trx, rows.map((row) => row.email.toLowerCase()));
}

/**
 * Erasure of the whole customer: the addresses it must also redact. A person
 * who stays at another customer keeps their mail and their login there, also
 * when their password was on the erased row (keepHolderLogin).
 */
async function contactEmailsForErasure(trx, customerId) {
  const rows = await trx('customer_contacts').where('customer_account_id', customerId).select('id', 'email');
  const out = [];
  for (const row of rows) {
    if (!(await usedElsewhere(row, trx))) out.push(row.email.toLowerCase());
  }
  return out;
}

async function deleteAllForErasure(trx, customerId) {
  const rows = await trx('customer_contacts').where('customer_account_id', customerId).select('id');
  await deleteContactLinks(trx, rows.map((row) => row.id));
  const emails = await contactEmailsForErasure(trx, customerId);
  await trx('customer_contacts').where('customer_account_id', customerId).del();
  if (emails.length > 0) await trx('customer_logins').whereIn('email', emails).del();
}

module.exports = {
  RIGHTS,
  AREAS,
  HOLDER_RIGHTS,
  rightsOf,
  hasRight,
  applyRights,
  asFlag,
  isContactEmail,
  conflictOnDuplicate,
  credentialFor,
  setPassword,
  membershipsFor,
  companiesFor,
  listContacts,
  createContact,
  updateContact,
  deleteContact,
  sendInvitation,
  acceptInvitation,
  createPasswordReset,
  contactForReset,
  applyPasswordReset,
  sessionMayAct,
  endSessions,
  mailRecipients,
  noticeRecipients,
  cancelQueuedMail,
  lockForErasure,
  contactEmailsForErasure,
  redactContactMail,
  mailToKeep,
  keepHolderLogin,
  deleteAllForErasure,
};

