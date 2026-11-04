# Graceful degradation

When something PicPeak depends on has a problem, only the features that need it pause. Guests keep viewing and downloading wherever possible, and security checks are never weakened.

Find it under **Settings → Health**. A banner appears across the admin area while a feature is actually paused.

## What is checked

Every 15 seconds PicPeak checks:

| Dependency | What it checks |
| --- | --- |
| Database | A simple query answers in time |
| Storage | The storage location or S3 bucket answers, and a local location can be written to |
| Disk space | Free space under `STORAGE_PATH`, relative to its size. On S3 this is the local disk used for staging, and it is left out when that directory does not exist |
| Temporary space for ZIP builds | Free space in the temporary directory (`/tmp`, or `TMPDIR`), where ZIP downloads are built. Only shown when it is a different disk from `STORAGE_PATH`, as in Docker, where `/tmp` is on the container's own layer |
| Email sending | The mail queue's last pass, and whether the mail server or webhook is currently unreachable |
| Face recognition service | Only while the feature is on |
| Photo processing queue | The oldest photo has not waited more than 30 minutes |
| Server load | CPU, memory and event loop delay of the container |

Each dependency is **healthy**, **degraded** or **down**. One failed check changes nothing. Two failures in a row mean degraded and four mean down. A check that takes over 3 seconds, or runs past its 5-second limit, needs four in a row to count as degraded, because a burst of uploads or ZIP downloads can slow one on a healthy disk or fill the S3 connection pool. Slowness alone never counts as down. A check still running when the next one is due counts as a failure, so a hung mount still goes down. Coming back takes about two minutes of better readings, so a flapping network share does not reopen uploads every few seconds.

The public `/health` endpoint does not use these states, on purpose: Docker restarting the app cannot repair a share or a mail server.

The status page shows a short reason, such as "check failed". The full error, which can name a path or a host, is in the server log.

**Limit on local storage:** the storage check confirms that the `STORAGE_PATH` directory exists and can be read and written. It does not tell a mounted share from the empty directory a lost mount leaves behind. If a share drops that way, storage still reads healthy, disk space measures the disk underneath, and uploads go to that disk. Point `STORAGE_PATH` at a directory inside the share rather than at the mount point, so a lost mount leaves no such directory and the check fails.

## What pauses

| Situation | New uploads | Running uploads | Viewing, single downloads | New ZIP builds | Finished ZIPs |
| --- | --- | --- | --- | --- | --- |
| Storage slow or failing at times | Paused | Finish | On | On | On |
| Disk nearly full | Paused | Finish if space allows | On | Paused | On |
| Storage down | Paused | Fail, and the file can be uploaded again | Unavailable until it returns | Paused | Unavailable until it returns |
| Temporary space nearly full | On | Finish | On | Paused | On |
| Critical memory | On | Finish | On | Paused | On |

"Disk nearly full" means less than 10% free, or less than 20 GB on large disks. Below 3% or 5 GB it counts as down.

"New uploads" covers gallery, admin, API and transfer uploads, the manual external import, watched folders and the S3 auto-importer. A watched folder catches up after the pause. A transfer without files, and the first import when a gallery is created, are not paused. A transfer with files is refused when its first file arrives, before anything is written, and one that started while uploads were open finishes. "New ZIP builds" covers gallery and transfer downloads, the API, and background rebuilds of a gallery's cached ZIP. A ZIP that is finished or already building stays available. A background rebuild waiting for its turn checks again when its turn comes. Admin exports and scheduled archiving are not paused.

Visitors see a short message that the feature is paused for a moment, and the admin uploader waits about four minutes for the pause to end, then stops the rest of the batch. A plain download link shows a short paused page. The refused request answers `503` with `code: CAPABILITY_UNAVAILABLE` and `Retry-After`, and does not name the dependency. A direct **Download all** link that needs a new build fails as a browser download.

This mail handling is always on, in observe mode too. While the mail server or webhook cannot be reached at all, email waits and retries every 5 minutes without using up its attempts, and **Email sending** shows as degraded. Three days after an email was first held back it goes back to the normal limit of three attempts, so it shows up under failed emails. That time is kept on each email, so a restart or other emails getting through do not start it again. A retry by hand starts it again, along with the attempts. While email is held back, the email queue card shows the last error. A temporary answer about one recipient, such as greylisting, uses an attempt and waits 5 minutes. So does a connection lost at a point where the server may already hold the message, so it can never be sent more than three times. A delayed email can go out outside business hours.

## Observe mode and enforcement

A new installation **observes**. PicPeak works out what it would pause and shows it as **Would pause**, and logs `Would pause ...` when a request would have been refused, but pauses nothing. Background work keeps its full speed. Tick **Pause features automatically** once those logs look right for your setup.

An admin can also pause **New uploads** or **ZIP downloads** by hand, in either mode, for example before maintenance on a share. **Check again now** runs the checks immediately, and a dependency that answers well recovers at once on the server that handled the click.

Changing these settings, and checking again, needs the `system.manage` permission and is written to the activity log.

## Slowing background work

Previews, face recognition, tagging and video work slow down when the server is busy, so galleries stay fast. In observe mode the status page only says this would happen.

- **Slow background work above** (default 70% CPU): when the average of two readings, 15 seconds apart, is above this, or the event loop stays delayed, work steps down one level.
- **Speed up again below** (default 50% CPU): when that average is below this and the event loop is calm, it steps back up one level. Each step needs two new readings.

| Level | Photo workers | Bulk work (faces, tags, video, rendition refresh, regeneration) |
| --- | --- | --- |
| Normal | All | Full speed |
| Reduced | Half | Short pause between items |
| Minimum | One | Longer pause between items |
| Paused (critical memory only) | None | Long pause between items |

High CPU alone never stops photo processing, because on a small server previews are often the load itself. Previews a guest is waiting for are not slowed, and they go ahead of queued background work. Admin regeneration pauses at most 2 seconds per photo.

`UPLOAD_PROCESSOR_CONCURRENCY` stays the upper limit. The governor can lower the number of workers and never raises it.

CPU and memory come from the container's cgroup limits when there are any. Without a memory reading, such as on a Mac outside Docker, memory limits simply do not apply. `PICPEAK_CGROUP_ROOT` overrides where the cgroup files are read, for tests.

## What never degrades

These are not on the list of things that can pause, and nothing in this feature can skip them:

- Login, permissions, CSRF and rate limits
- Gallery passwords, expiry and revoked access
- Invoices, contracts and signing
- Document scanning: a file nobody could scan stays unavailable
- Watermarks: a missing preview either fails or goes through the normal watermark checks, and is never replaced by an unprotected file

If one of these cannot do its job, the request is refused. There is no "force on" for a paused feature.

## Several replicas

Each process keeps its own view and its own load level. Replicas check the same dependencies, so they agree within a few checks, and a load level reflects the replica that measured it. After **Check again now**, other replicas recover on their own within about two minutes.
