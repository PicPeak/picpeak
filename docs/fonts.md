# Self-hosted webfonts

PicPeak ships with a curated set of webfonts baked into the backend image and serves them from your own origin. **No requests go to `fonts.googleapis.com` or any third-party CDN** — guest IPs stay private, which is important for GDPR compliance (LG München 2022).

The font picker in the admin theme customizer is **data-driven**: whatever the backend finds on disk, the picker offers. This page documents the conventions and the workflow for adding your own families.

## What ships out of the box

The Docker image bundles 8 OFL-licensed families at `backend/assets/fonts/`:

- Comic Neue
- IBM Plex Sans
- Inter (the default)
- Jost
- Montserrat
- Noto Sans
- Playfair Display
- Poppins

These appear in the admin theme customizer with no configuration.

## Adding your own font (drop a folder, restart)

You don't need to fork the repo. Place a font folder in your runtime storage volume — the same volume that holds events, thumbnails, etc. — and it appears in the picker after the next backend restart (or within ~30 seconds of being added, whichever comes first).

### 1. Choose where on the host

Bind-mount target inside the container is `/app/storage/fonts/` (the env var `STORAGE_PATH` controls the prefix; defaults to `/app/storage`). On the host, that's wherever your `docker-compose.yml` mounts `${APP_STORAGE}` from — typically `./storage/`.

### 2. Folder layout

```
storage/fonts/
└── <Family-Name>/
    ├── 400.woff2
    ├── 600.woff2
    ├── 700.woff2
    └── meta.json     (optional)
```

Rules:

- **Folder name** = display family name with spaces replaced by hyphens. The scanner turns `Roboto-Slab/` → `Roboto Slab`. Use the exact upstream family name; capitalisation is preserved.
- **File names** are `<weight>.woff2` where `<weight>` is an integer (100-900). Other names are ignored. The picker doesn't expose individual weights, but the runtime injects all available weights in the `@font-face` block so headings (semibold/bold) render correctly.
- **Format** must be `.woff2`. Other formats are ignored. WOFF2 is universally supported and the smallest on the wire.
- **No italics** in v1 (the picker doesn't expose them). Italic files in the folder are silently ignored.
- **`meta.json`** (optional) tells the picker which CSS generic family to fall back to while the font file is loading (and permanently if the file ever 404s). Shape: `{ "generic": "sans-serif" | "serif" | "cursive" | "monospace" }`. Defaults to `sans-serif` if absent. Add this for serif fonts (e.g. Playfair Display) and cursive/display fonts (e.g. Comic Neue, Lobster) so visitors don't briefly see Helvetica during the font fetch.

### 3. Where to download fonts

For Google-Fonts-licensed families, use [google-webfonts-helper](https://gwfh.mranftl.com/fonts):

1. Pick the family.
2. Charsets section → **Latin** only (uncheck others unless you actually need them; Cyrillic alone roughly doubles file size).
3. Styles section → **400, 600, 700** at minimum (these match what the picker uses).
4. Click "Download files" — you'll get a ZIP containing the `.woff2` files plus the family's OFL license.
5. Rename the files to `400.woff2`, `600.woff2`, `700.woff2` and drop them in `storage/fonts/<Family-Name>/`.
6. Keep the OFL license file alongside (the static handler serves anything in the folder, so `/fonts/<Family-Name>/OFL.txt` is publicly available — this satisfies OFL §2's "license must be included with all copies").

For non-Google fonts, ensure you have the right to redistribute. SIL Open Font License (OFL), Apache 2.0, and most "free for commercial use" web licenses allow this.

### 4. Activation

Either:

- **Restart the backend container** (immediate), or
- **Wait ~30 seconds** for the in-memory cache to expire and the next `/api/public/fonts` request to re-scan.

Refresh the admin customizer; the new family appears in the body and heading dropdowns.

> **Note:** The admin customizer caches the fonts list separately for 5 minutes (React Query staleTime). After the backend picks up a new family, hard-reload the customizer page (⌘+Shift+R / Ctrl+Shift+R) to see it immediately, or wait up to 5 minutes for the frontend cache to expire on its own. The two caches serve different purposes — the backend avoids disk hits per request; the frontend avoids network hits per re-render — so we keep them independent and document the worst case rather than try to synchronise them.

## How it works

- **Scanner**: `backend/src/services/fontsService.js` reads two locations and merges them: `backend/assets/fonts/` (bundled) + `STORAGE_PATH/fonts/` (user). User additions override bundled families of the same name. Cached for 30 s.
- **Listing endpoint**: `GET /api/public/fonts` returns `{ fonts: [{ family, weights, generic }, ...] }`.
- **Static serving**: `GET /fonts/<Family-Name>/<weight>.woff2` returns the actual file. Path-traversal protected. `Cache-Control: max-age=7d` — clients revalidate via `If-Modified-Since` after expiry, so replacing a file on disk eventually rolls out without admin action (see "Replacing an existing font" below).
- **Lazy injection**: `frontend/src/contexts/ThemeContext.tsx` watches `theme.fontFamily` / `theme.headingFontFamily` and injects exactly one `@font-face` block per family the page actually uses, into a single `<style id="self-hosted-fonts">` element. Other families are not loaded for that visitor.
- **Bootstrap**: `frontend/src/index.css` ships static `@font-face` blocks for Inter so the very first paint already has the default body font.

## Caveats and edge cases

- **Empty folder** (no `<weight>.woff2` files) → silently skipped, warning in backend logs.
- **Two folders that normalize to the same family** on case-insensitive filesystems (macOS APFS) → second is skipped, warning logged.
- **Weight files with non-numeric names** (e.g. `bold.woff2`, `regular.woff2`) → ignored; family entry still includes its other weights.
- **Removing the `Inter/` folder** → the very-first-paint bootstrap CSS in `index.css` will 404 the font requests; browsers fall back to the next family in `--font-family` (Noto Sans → system-ui). Cosmetic only; no other breakage.
- **Variable fonts** are not supported in v1. Each weight must be a separate file.
- **Italics** are not exposed in the picker.
- **Per-option dropdown previews** (each font name rendered in its own face inside the picker) are not supported in v1. Browser support for styling `<option>` elements is inconsistent — Safari ignores it in the popup entirely, and Chrome/Firefox were unreliable in testing. A future improvement is to replace the native `<select>` with a custom dropdown component or to render a separate "preview text" box below the picker.

### Replacing an existing font

Browsers cache font files for up to 7 days. When you overwrite an existing weight file (e.g. swap your `Inter/400.woff2` for a different cut), some visitors may keep seeing the old face for up to a week, even after a backend restart.

Two ways to roll out a replacement:

1. **Wait it out.** Without `immutable` on the cache header, browsers send `If-Modified-Since` once the 7-day window expires; the backend responds based on file mtime, so the new file gets picked up automatically the next time each client revisits the gallery.
2. **Force-bust the cache by renaming the family folder.** Move `Inter/` → `Inter-v2/` (with the new file inside) and update the affected event themes to use `Inter v2`. The new folder is served from a new URL, so caches don't apply and every client picks up the new face on next page load. This is the right approach when you need an immediate, gallery-wide rollout.

The first option is fine for cosmetic touch-ups; the second is what to do when a font replacement is genuinely urgent.

## License

The bundled fonts are all SIL Open Font License v1.1 (OFL). The license text and per-font copyright notices live at `backend/assets/fonts/LICENSE-OFL.txt` and are publicly served at `/fonts/LICENSE-OFL.txt`.

If you redistribute the PicPeak Docker image, you redistribute these fonts too — you must keep the LICENSE-OFL.txt file accessible. The default static handler does this for you.
