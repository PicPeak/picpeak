# Incoming-mail capacity and retention

Incoming mail is captured from the configured accounting mailbox and enabled
additional mailboxes. These limits apply before downloading a new message;
they do not delete mail from the IMAP server. Existing per-message and
attachment limits remain in effect.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `EMAIL_INTAKE_INSTALLATION_BYTES` | 2147483648 (2 GiB) | Shared byte budget for the unhandled intake backlog |
| `EMAIL_INTAKE_MAILBOX_BYTES` | 536870912 (512 MiB) | Per-mailbox byte budget for the unhandled intake backlog |
| `EMAIL_INTAKE_INSTALLATION_ROWS` | 50000 | Shared ceiling on unhandled backlog items |
| `EMAIL_INTAKE_MAILBOX_ROWS` | 10000 | Per-mailbox ceiling on unhandled backlog items |
| `EMAIL_INTAKE_INSTALLATION_PER_HOUR` | 1000 | Shared admissions per hour |
| `EMAIL_INTAKE_MAILBOX_PER_HOUR` | 500 | Per-mailbox admissions per hour |
| `EMAIL_INTAKE_SENDER_PER_HOUR` | 50 | Admissions per hour for one sender in one mailbox |
| `EMAIL_INTAKE_RETENTION_DAYS` | unset (keep forever) | Opt-in age limit for captured messages and untouched intake documents |
| `EMAIL_INTAKE_METADATA_RETENTION_DAYS` | 7 | Retention of bare refusal/failure records |

Values must be positive integers; invalid values fall back to the
defaults. Byte settings accept at most 4 TiB, row/rate settings at most
2147483647, and retention settings at most 36500 days. A sender is an
envelope address, not an authenticated identity: mailbox and installation
budgets also apply when senders rotate addresses.

## What the budgets measure

The byte and row budgets bound the **unhandled intake backlog**, not what the
installation keeps:

- the reservation of every message currently being fetched, and
- every captured document nobody has handled yet (status unsorted, duplicate
  or declined, no admin edit, disposition, booking or customer link): its
  physical file plus a 64 KiB accounting-audit allowance. A row ceiling counts
  these documents and the in-flight messages.

Stored message bodies, booked or edited documents, and everything captured
before this ledger existed are kept deliberately and never count. An
installation that already holds more than a budget at upgrade keeps receiving
mail, and booking an invoice frees its share of the budget. The total retained
bytes are still recorded per mailbox, for accounting only.

Admission reserves conservative space for both captured bodies and allowed
attachments. A reservation may refuse a large message even when its eventual
decoded content would be smaller. Parsed content that exceeds its reservation
is refused, not silently truncated. Reservations are shared across replicas;
claims expire after ten minutes and late workers cannot persist their result.
Identical verified attachment hashes reuse one physical file; each accounting
capture still has its own record.

## When a limit is reached

A message refused for capacity or rate is **not** recorded and **not** marked
seen: it stays unread on the mail server and is admitted by a later poll once
the backlog shrinks or the hourly window passes. Its source is not downloaded,
and a waiting message does not use up the hourly budgets. The backend logs one
warning per mailbox, limit and hour that names the environment variable, for
example `Incoming mail for mailbox "accounting" is waiting:
EMAIL_INTAKE_MAILBOX_BYTES (536870912) is reached`. To get mail flowing again,
handle the waiting documents (edit, categorise or book them), or raise the named
limit. A message
over the per-message size limit is different: it can never be admitted, so it
is recorded once as an error and marked seen.

## Retention

Nothing is deleted by age unless `EMAIL_INTAKE_RETENTION_DAYS` is set to a
positive number. Unset or `0` keeps every captured message and document, as
before this feature existed.

When it is set:

- The value must be larger than the 90-day window the poller searches on the
  mail server. A smaller value is raised to 91 days and one warning is logged.
- Retention uses capture time, not a sender's Date header.
- A message is expired only when it is not in the Archived folder and no
  captured document of it still exists. Messages in the inbox and in the
  trash expire.
- An expired message keeps a body-less record (Message-ID, mailbox, capture
  time) that is hidden from every folder, until it is 97 days old. The poller
  recognises it, so a message that is still on the mail server is not imported
  a second time.
- Only uncurated automated intake documents are removed. Administrative
  edits, dispositions, payments, bookings, customer/rebill links and
  expense/duplicate references protect accounting records, and a protected
  document also protects the message it came from.
- Each sweep that removed something logs one info line with the counts.

Independently of that setting, the one-minute scheduler (also while the
incoming-mail feature is disabled):

- turns claims of crashed workers into error records,
- removes error records that never held a sender, subject, body or document
  after `EMAIL_INTAKE_METADATA_RETENTION_DAYS`; the message is then tried
  again if it is still within the lookback window,
- removes tracked files in the mail-owned namespace that no stored-path column
  references any more. Manual uploads and files of unknown ownership are not
  swept. One unreadable or unsafe file is logged and skipped.

Permanent message deletion by an administrator does not delete its accounting
proof.

## Upgrade and restore

Upgrade backfill records existing bodies and attachment ownership with their
measured sizes. A file that cannot be found is recorded with 0 bytes and one
warning; the sweeper corrects the size when the file is there, and a
referenced file that goes missing later is charged 0 bytes with one warning.
None of this pre-existing content counts towards the intake budgets. Keep
enough filesystem headroom for the rest of PicPeak and backups: these are
application budgets, not operating-system filesystem quotas. Database deletion
makes pages reusable but does not promise immediate disk shrinkage.

Portable restore replaces the local installation's mail admission state.
Current archives retain their recorded rate windows, reservations and audit
allowances. Older archives rebuild missing ownership and byte charges from
the restored message/document rows in the restore transaction.
