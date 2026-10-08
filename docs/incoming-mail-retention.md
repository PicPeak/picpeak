# Incoming-mail capacity and retention

Incoming mail is captured from the configured accounting mailbox and enabled
additional mailboxes. These limits apply before downloading a new message;
they do not delete mail from the IMAP server. Existing per-message and
attachment limits remain in effect.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `EMAIL_INTAKE_INSTALLATION_BYTES` | 2147483648 (2 GiB) | Shared retained-byte budget |
| `EMAIL_INTAKE_MAILBOX_BYTES` | 536870912 (512 MiB) | Per-mailbox retained-byte budget |
| `EMAIL_INTAKE_INSTALLATION_ROWS` | 50000 | Shared received-message row ceiling |
| `EMAIL_INTAKE_MAILBOX_ROWS` | 10000 | Per-mailbox received-message row ceiling |
| `EMAIL_INTAKE_INSTALLATION_PER_HOUR` | 1000 | Shared admission-attempt budget |
| `EMAIL_INTAKE_MAILBOX_PER_HOUR` | 500 | Per-mailbox admission-attempt budget |
| `EMAIL_INTAKE_SENDER_PER_HOUR` | 50 | Sender/mailbox admission-attempt budget |
| `EMAIL_INTAKE_RETENTION_DAYS` | 90 | Captured message and disposable intake-document retention |
| `EMAIL_INTAKE_METADATA_RETENTION_DAYS` | 7 | Body-less error/refusal metadata retention |

Values must be positive integers; invalid values fall back to the finite
defaults. Byte settings accept at most 4 TiB, row/rate settings at most
2147483647, and retention settings at most 36500 days. A sender is an
envelope address, not an authenticated identity: mailbox and installation
budgets also apply when senders rotate addresses.

Admission reserves conservative space for both captured bodies and allowed
attachments. A reservation may refuse a large message even when its eventual
decoded content would be smaller. Parsed content that exceeds its reservation
is refused, not silently truncated. Reservations are shared across replicas;
claims expire after ten minutes and late workers cannot persist their result.
At capacity, a bounded error row is retained only if its metadata/row budget
fits; otherwise only a fixed-size aggregate refusal counter changes. Refused
mail is marked seen but its source is not downloaded. Ordinary Message-ID
dedup remains in place, independently of these budgets.

The byte budgets include UTF-8 body bytes, physical mail-owned attachment
bytes, a 16 KiB allowance per received row and a retained 64 KiB accounting
audit allowance per captured attachment. Identical verified attachment hashes
reuse one physical file; each accounting capture still has its own record.
Shared file bytes are charged once to the mailbox that first retained them.
Accounting history is append-only: its allowance is not released when the
received message expires. Deliberately retained legal/accounting evidence
continues counting, so intake stops rather than overrunning capacity.

The existing one-minute scheduler sweeps bounded batches, also when the
incoming-mail feature is disabled. Retention uses capture time, not a sender's
Date header, and includes archived/trash messages. It removes expired received
rows and only uncurated automated intake documents. Administrative edits,
dispositions, payments, bookings, customer/rebill links and expense/duplicate
references protect accounting records. Expiring a received message never
removes a protected supplier proof. Physical cleanup checks all stored-path
references and removes only tracked, unreferenced files in the mail-owned
namespace; manual uploads and unknown ownership are not swept. Permanent
message deletion immediately frees that message's body charge but does not
delete its accounting proof.

Upgrade backfill counts existing bodies and attachment/audit ownership.
Unmeasured legacy files conservatively block admission until the sweeper
measures them inside the storage root; large estates may require several
sweep batches. Missing or unsafe reference-held files require operator
attention, not optimistic release of their reserved capacity. Keep enough
filesystem headroom for the rest of PicPeak and backups: these are application
retained-byte budgets, not operating-system filesystem quotas. Database
deletion makes pages reusable but does not promise immediate disk shrinkage.

Portable restore replaces the local installation's mail admission state.
Current archives retain their recorded rate windows, reservations and audit
allowances. Older archives rebuild missing ownership and byte charges from
the restored message/document rows in the restore transaction; unknown file
sizes remain conservatively charged until measured by the sweeper.
