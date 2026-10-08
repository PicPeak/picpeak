# Media processing: ffmpeg, ffprobe, exiftool

PicPeak runs three external tools on uploaded media: `ffprobe` and `ffmpeg`
for videos (metadata, the poster frame, the optional browser-playable copy)
and `exiftool` for RAW/DNG previews. Images themselves are handled by sharp in
its own worker pool, described in `.env.example` under "Image parsing".

Two protections can be put around those tools. **Both are optional.** Where a
host cannot run one, PicPeak says so once in the startup log and processes
media without it. Neither is ever the reason an upload is refused or a photo
fails.

## What each protection does

| | With it | Without it |
| --- | --- | --- |
| **process guard** (`backend/bin/media-process-guard`) | Each tool runs under an address-space, CPU-time and file-size limit, a thread budget, and cannot fork. | Each tool runs as a plain child process in its own process group, with the same timeout (SIGTERM, then SIGKILL to the whole group), the same output caps and the same `-threads` cap. |
| **kernel leases** (`backend/bin/local-process-lease.node`) | A worker holds a kernel lock (`flock`) for as long as it works on a photo. After a crash the lock is free at once, and the photo is put back in the queue without waiting. | A photo left in `processing` is put back by age, as in earlier versions: when its worker has not been heard from for two minutes, or after `UPLOAD_PROCESSOR_STUCK_TIMEOUT_MS` (10 minutes) / `VIDEO_RENDITION_STUCK_TIMEOUT_MS` (2 hours) for a row that predates this mechanism. |

Independently of both, every claim of a photo or video carries an attempt id.
Results are written only while the row still carries that id, and the files an
attempt writes carry it in their name. A worker that was presumed dead and
turns out not to be can therefore neither overwrite nor publish anything. This
needs nothing from the host and is always on.

## Where each protection is available

| Host | process guard | kernel leases |
| --- | --- | --- |
| Official Docker images on Linux (default seccomp profile) | on | on |
| Docker with a custom seccomp profile that denies `ptrace`, or `kernel.yama.ptrace_scope=3` | off | on |
| Docker Desktop (macOS/Windows) | on when the image runs natively; off under CPU emulation (an amd64 image on Apple Silicon), where tracing is not available | on: the lease directory defaults to the container's own `/tmp`, not to a bind mount |
| Storage on NFS, CIFS/SMB or FUSE | on | on, because leases are not kept on the storage path |
| Native Linux install with a C compiler and the Node headers | on after `npm run build:native` | on after `npm run build:native` |
| Native Linux install without a compiler | off | off |
| macOS / Windows development (`npm run dev`) | off | off |

The startup line reads, for example:

```
Media process protections: process guard ON (memory/CPU/thread limits for ffmpeg, ffprobe, exiftool) | kernel leases ON (/tmp/picpeak-media-leases) | host identity: generated (/app/data/media-host-id)
```

and for every protection that is off it gives the reason and what to change.
A guard that stops working while the server runs (the binary was removed,
tracing was denied later) is switched off with one warning, and the job that
found out is run again without it.

## Building the native pieces

```
cd backend && npm run build:native
```

compiles both from `backend/native/` into `backend/bin/`. It needs Linux, a C
compiler (`build-essential` / `build-base`) and the Node headers. The Docker
images do this at build time, and a failure there fails the image build.
`npm install` never runs it, and the native installer (`picpeak-setup.sh`)
only warns when it fails. On macOS and Windows the script does nothing.

## The lease directory

Kernel leases only mean something on a local filesystem, so the addon accepts
ext4, xfs, btrfs, zfs, tmpfs and overlayfs and refuses everything else. The
directory is chosen once at startup:

1. `MEDIA_PROCESS_LEASE_PATH`, if set (absolute path)
2. `<system temp dir>/picpeak-media-leases`
3. `backend/data/media-process-leases`

The first one the addon accepts is used. If none is, kernel leases are off.
The directory does not have to survive a restart: a lease whose file is gone
is simply settled by age. Lease files are removed when their attempt ends,
and leftovers of a crashed process are removed by the queue janitor.

## Host identity

A lease can only say something about a worker on the same machine, so each
attempt records which host it ran on:

1. `MEDIA_PROCESS_HOST_ID`, if set: 16 to 128 characters of `A-Z a-z 0-9 . _ -`.
   Processes on the same host must share it; different hosts must not.
2. `/etc/machine-id`
3. an id generated on first start and kept in `backend/data/media-host-id`
   (the Docker images have no machine-id; `/app/data` is the mounted volume)

Work recorded under a different or unknown host is recovered by age.

## Limits and time budgets

The queue of photos and videos is never refused for capacity: it waits. Two
lanes keep a long job from holding up short ones: transcodes run in one
(`VIDEO_RENDITION_CONCURRENCY`, default 1), probes, poster frames and RAW
previews in the other (`MEDIA_PROCESS_CONCURRENCY`, default 2). Each lane
always runs at least one job, however little memory the host has.

A job's time budget starts when the job starts, not while it waits.

| Setting | Default | Meaning |
| --- | --- | --- |
| `MEDIA_PROCESS_CONCURRENCY` | 2 | Probes, posters and RAW previews running side by side. |
| `MEDIA_PROCESS_QUEUE_LENGTH` | 256 | Beyond this many waiting jobs, an on-demand request (not the queues) is answered 503 with `Retry-After`. |
| `MEDIA_WORKER_MEMORY_MIB` | 2048 | Address-space limit for ffprobe, exiftool and a poster frame under the guard. |
| `MEDIA_FFMPEG_MEMORY_MIB` | none | Address-space limit for a transcode under the guard. Unset = no limit: a multi-threaded encode of a 4K source reserves far more virtual memory than it uses, and no default is known to fit every source. Set one if you want it, and watch the first large video. |
| `MEDIA_FFMPEG_THREADS` | min(CPUs, 4) | `-threads` for ffmpeg. |
| `MEDIA_PROBE_TIMEOUT_MS` | 30000 | One ffprobe run. |
| `MEDIA_RAW_TIMEOUT_MS` | 30000 | One exiftool run. |
| `MEDIA_THUMBNAIL_TIMEOUT_MS` | 60000 | One poster frame. |
| `VIDEO_RENDITION_TIMEOUT_MS` | 3600000 | The least a transcode gets. A longer video gets 20 s per second of video, times the thread count in CPU time. |
| `VIDEO_RENDITION_MAX_TIMEOUT_MS` | 86400000 | The most a transcode gets. |
| `MEDIA_MAX_SNAPSHOT_MIB` | 1024 (at most half the memory) | Private copies of inputs staged at once. A larger file is read where it is. |
| `MEDIA_MAX_VIDEO_PIXELS` | 40000000 | Pixels per frame. |
| `MEDIA_MAX_VIDEO_DIMENSION` | 16384 | Pixels per side. |
| `MEDIA_MAX_VIDEO_STREAMS` | 16 | Streams in the container. |
| `MEDIA_MAX_VIDEO_FPS` | 240 | Frame rate. |
| `MEDIA_MAX_INPUT_MIB` | none | Largest video/RAW file handed to the tools. |
| `MEDIA_MAX_VIDEO_OUTPUT_MIB` | none | Largest browser-playable copy. |
| `MEDIA_MAX_VIDEO_DURATION_SECONDS` | none | Longest video. |
| `MEDIA_MAX_VIDEO_PIXEL_FRAMES` | none | Pixels times frames. |

The four limits marked "none" did not exist in earlier versions and apply only
when set. A video over a limit keeps its original and gets the placeholder
tile with a note, as a video ffmpeg cannot read always did.

## What is retried

"Not now" is never recorded as a failure: a cancelled job, a shutdown, a full
queue, a tool that could not be started. The photo or video goes back to
pending and is due again after a pause that grows with each attempt, up to
five attempts. A shutdown does not count as one. Only a verdict on the media
itself (a broken file, a limit that was set and exceeded, a transcode that ran
out of its own time) is recorded.

Photos and videos that were pending or processing when the server was
upgraded need nothing: they are claimed, or recovered by age, like any other.
