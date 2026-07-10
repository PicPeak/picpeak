# Live Slideshow ("Diashow")

The Live Slideshow is a dedicated, token-only, **fullscreen** URL for an event that **auto-picks-up newly uploaded photos while it runs** — designed for a projector or screen at a live event (weddings, concerts, parties). Guests at the venue watch the photos appear in near real time; the photographer keeps culling and uploading from the back of the room.

It is separate from the normal guest gallery: its own link, no gallery password, no chrome — just the photos.

## Table of contents

- [Enable the feature](#enable-the-feature)
- [Create a slideshow link](#create-a-slideshow-link)
- [Run it on a projector](#run-it-on-a-projector)
- [Global defaults (Settings → Slideshow)](#global-defaults-settings--slideshow)
- [Per-event options](#per-event-options)
- [How live updates work](#how-live-updates-work)
- [Good to know](#good-to-know)

## Enable the feature

Live Slideshow is **off by default**. Turn it on under **Settings → Features → Live Slideshow**. While it's off, no slideshow UI appears and any existing slideshow link returns "not active".

## Create a slideshow link

1. Open the event, find the **Live Slideshow** card.
2. Click **Generate slideshow link**. This mints a unique link of the form:

   ```
   https://your-host/gallery/<event-slug>/show/<token>
   ```

3. **Copy** it (or **Regenerate** to rotate the token and kill the old link, or **Disable** to remove it). The link is a secret — the token *is* the access; there is no separate password.

The link only shows **published, non-hidden** photos — the same set guests see.

## Run it on a projector

Open the link on the machine driving the projector. You'll see a **▶ Start slideshow** splash. Click it once — browsers only allow fullscreen in response to a click — and it goes fullscreen and starts cycling. From then on it runs unattended: cursor hides, it loops at the end, and shows a "Waiting for photos…" screen if the event has none yet.

## Global defaults (Settings → Slideshow)

The picpeak-wide look and feel lives in one place: **Settings → Slideshow**. These apply to every slideshow.

- **Default style for new slideshows** — the transition, display time, transition speed and color filter that **new events inherit**. Each event can still override these.
  - Transitions: **Crossfade, Cut, Slide, Ken Burns, Dip to white, Dip to black**.
  - Color filters: None, Black & White, Sepia, Warm, Cool, Vignette.
- **Image fit** — **Fill screen (crop)** or **Black bars (no crop)**. Use black bars if your set is portrait-heavy and you don't want faces cropped. *(Live — applies to running slideshows immediately.)*
- **Watermark** — overlay a logo in a corner, TV-station-ident style.
  - **Logo**: your light logo, dark-mode logo, favicon, or the event's own logo (shown with a live preview).
  - **Style**: **White** (recolors a dark/transparent logo white) or **Original colours** (for a logo that already has its own colours/box).
  - **Position**, **opacity**, and **size**.
  *(Live — applies immediately.)*

## Per-event options

On the event's Live Slideshow card you can:

- Generate / copy / regenerate / disable the link.
- Override the **display style** (transition, timing, color filter) for this event.
- Override the **watermark**: **Use global default**, **On**, or **Off** — e.g. turn the watermark off for one sensitive event without changing your global setting.

## How live updates work

While a slideshow is running it polls a lightweight endpoint every few seconds:

- **New uploads are appended quietly** at the end — the current slide is never interrupted or skipped.
- **Settings changes apply live** — change the display time, transition, image fit or watermark and the running projector picks it up within a few seconds. No need to regenerate the link or restart.
- **Disabling the feature (or the link) kills it** — turning off the **Live Slideshow** feature flag, or disabling/regenerating the link, makes the projector stop on its next poll.

## Good to know

- **The token is the secret.** Anyone with the link can view the slideshow — **published photos only**: a slideshow link is display-only and cannot download, upload, or post feedback. Rotate it with **Regenerate** if it leaks; **Disable** removes it entirely.
- **Regenerate / Disable is not instant revocation.** A running projector stops within one poll, but the browser session it already opened keeps working for **up to 12 hours** on the old token (there's no token-revocation list — same as gallery passwords). For a hard cut-off, also turn the **Live Slideshow** feature flag off, which denies every link immediately.
- **Fullscreen needs the first click.** The ▶ splash exists because browsers require a user gesture to enter fullscreen — unavoidable, and harmless for a projector.
- **Slideshow views don't pollute analytics.** The projector is excluded from your event's visitor view/download counts.
- **Turning the feature off suspends, doesn't destroy.** Existing links stop working while the flag is off and resume when you turn it back on — the token isn't deleted.
