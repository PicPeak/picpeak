# Upload file types and the chunked (large-file) upload API

## One allow-list for every upload path

**Settings → General → Allowed File Types** (`general_allowed_file_types`) is a
comma-separated list of file extensions. The default is:

```
jpg,jpeg,png,webp
```

It is the single source of truth for what PicPeak accepts, on every path:

| Path | Endpoint | How the list is applied |
|------|----------|-------------------------|
| Admin upload (UI and API) | `POST /api/admin/photos/:eventId/upload` | multer `fileFilter` + magic-byte check against the mapped MIME types |
| Admin chunked upload (API) | `POST /api/admin/photos/:eventId/chunked-upload/init` | filename extension must map to an allowed MIME type; see below |
| Guest uploads | `POST /api/gallery/:slug/upload` | same MIME list |
| Admin upload picker | `PhotoUpload` component | `accept=` and the client-side filter are built from the same setting via `/api/public/settings` |

The extension → MIME mapping lives in `backend/src/services/uploadSettings.js`
(`EXTENSION_TO_MIME`). Extensions not in that map are ignored even if listed.

| Extension | MIME | Kind |
|-----------|------|------|
| jpg, jpeg | image/jpeg | image |
| png | image/png | image |
| webp | image/webp | image |
| gif | image/gif | image |
| heic, heif | image/heic, image/heif | image (iPhone) |
| dng | image/x-adobe-dng | image (RAW, preview extracted) |
| mp4, m4v | video/mp4 | video |
| webm | video/webm | video |
| mov | video/quicktime | video |
| avi | video/x-msvideo | video |

## Enabling video

Videos are **not** in the default list. To accept them, add the video
extensions you want to Allowed File Types, for example:

```
jpg,jpeg,png,webp,mp4,mov,webm
```

The separate **Max Video Size (MB)** setting then applies per video file.

## Chunked upload: what changed and why

The chunked endpoints exist for files too large for one multipart request.
The frontend service layer ships a reference client (`uploadLargeFile` in
`frontend/src/services/photos.service.ts`, 10 MB chunks, intended for files
over 100 MB), but the current admin upload screen sends everything through
the multipart endpoint, so in practice these endpoints are used by API
clients and custom integrations. Until this change,
`chunked-upload/init` accepted a client-declared `mimeType`, stored it on the
photo row verbatim, and the gallery routes echoed it as the response
`Content-Type`. A file that decoded as an image but was declared `text/html`
therefore rendered as HTML on the app origin for every gallery guest.

Since this change:

1. **The `mimeType` field in the init body is ignored.** Sending it is still
   accepted for backwards compatibility, but it has no effect.
2. **The MIME type is derived from the filename extension** using the table
   above, and that extension **must be on the Allowed File Types list**, the
   same rule the multipart upload path has always enforced.
3. A file whose extension is not allowed is refused at init with:

   ```json
   HTTP 400
   { "error": "File type not allowed" }
   ```

   The size cap is still checked first, so an over-limit file keeps
   returning `File too large. Maximum size is N MB per file.`
4. Every route that serves a photo resolves the `Content-Type` from the
   extension (images) or a validated `video/*` value (videos), never from the
   stored string as given. See `backend/src/utils/photoContentType.js`.

### What this means for operators

- If your Allowed File Types list is still the default, **chunked video
  uploads through the API now fail with `File type not allowed`** until you
  add the video extensions. The admin UI already filtered videos out
  client-side in that configuration, so only API clients and custom
  integrations are affected.
- Photos and videos uploaded before this change are unaffected on disk. Their
  stored `mime_type` is simply no longer trusted when serving.

### Init request reference

```http
POST /api/admin/photos/:eventId/chunked-upload/init
Authorization: Bearer <admin token>
Content-Type: application/json

{
  "filename": "ceremony.mp4",
  "fileSize": 734003200,
  "totalChunks": 70
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `filename` | yes | Directory components are stripped; the extension selects the MIME type and must be allowed |
| `fileSize` | yes | Checked against Max File Size / Max Video Size before the type check |
| `totalChunks` | yes | The reference client uses 10 MB chunks |
| `mimeType` | no | Ignored since this change |
