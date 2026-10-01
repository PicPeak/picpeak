/**
 * Public client-upload page for PicTransfer (#997, reshaped in #1544).
 *
 * Token-only, no auth: either a file request's 64-hex token or the short
 * read-aloud code that can be issued alongside it. Reached via
 * /transfer-upload/:token.
 *
 * The server tells us the upload policy, so unsupported files are named and
 * dropped here rather than being carried all the way up only to fail the whole
 * batch on arrival.
 *
 * Like the recipient download page, styling reads the branding theme CSS
 * variables (`--color-*`) rather than Tailwind `dark:` utilities — a public
 * page never gets the admin `.dark` class, so the branding theme (applied by
 * GlobalThemeProvider) is what must drive colours and light/dark here.
 */
import React, { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { UploadCloud, CheckCircle, AlertCircle, X, File as FileIcon } from 'lucide-react';

import { Button, Loading } from '../../components/common';
import { transfersService } from '../../services/transfers.service';

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Would the server accept this file?
 *
 * Mirrors validateTransferFileType: accept-all short-circuits, then a listed
 * extension is a match on its own, and only then is the MIME consulted. The
 * order matters and is the server's — the browser's `file.type` is a guess
 * (Windows sends `application/x-zip-compressed` for a .zip, and .dng/.psd
 * routinely arrive as `application/octet-stream` or empty), so the extension
 * the admin typed into Settings is the more reliable signal.
 */
function isAccepted(
  file: File,
  info: { accept_all: boolean; allowed_mime: string[]; allowed_extensions: string[] },
): boolean {
  if (info.accept_all) return true;
  const ext = extensionOf(file.name);
  if (ext && info.allowed_extensions.includes(ext)) return true;
  const mime = (file.type || '').toLowerCase().split(';')[0].trim();
  return !!mime && info.allowed_mime.includes(mime);
}

export const TransferUploadPage: React.FC = () => {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['transfer-upload-info', token],
    queryFn: () => transfersService.getUploadInfo(token as string),
    enabled: !!token,
    retry: false,
  });

  const muted = { color: 'var(--color-muted-text)' } as const;

  const wrap = (children: React.ReactNode) => (
    <div
      className="flex min-h-screen items-center justify-center p-4"
      style={{ backgroundColor: 'var(--color-background)', color: 'var(--color-text)' }}
    >
      <div
        className="w-full max-w-lg rounded-lg border shadow-sm"
        style={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-surface-border)' }}
      >
        {children}
      </div>
    </div>
  );

  if (isLoading) return wrap(<div className="p-6"><Loading /></div>);

  if (isError || !data) {
    return wrap(
      <div className="p-8 text-center">
        <AlertCircle className="mx-auto mb-3 h-12 w-12" style={muted} />
        <h1 className="text-xl font-semibold">{t('transfers.upload.unavailableTitle', 'Upload link unavailable')}</h1>
        <p className="mt-2" style={muted}>{t('transfers.upload.unavailableBody', 'This upload link is invalid or has expired.')}</p>
      </div>,
    );
  }

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const incoming = Array.from(list);

    // Drop what the server would refuse, and say which — one unsupported file
    // used to fail the entire batch with a generic message.
    const accepted = incoming.filter((f) => isAccepted(f, data));
    const rejected = incoming.filter((f) => !isAccepted(f, data));
    if (rejected.length) {
      toast.error(t(
        'transfers.upload.typeRejected',
        'Not an accepted file type: {{names}}',
        { names: rejected.map((f) => f.name).join(', ') },
      ));
    }

    // Same for oversized files: named here, rather than after the upload.
    const maxBytes = data.max_size_mb * 1024 * 1024;
    const withinSize = accepted.filter((f) => f.size <= maxBytes);
    const tooBig = accepted.filter((f) => f.size > maxBytes);
    if (tooBig.length) {
      toast.error(t(
        'transfers.upload.tooBigNamed',
        'Too large (max {{mb}} MB): {{names}}',
        { mb: data.max_size_mb, names: tooBig.map((f) => f.name).join(', ') },
      ));
    }
    if (!withinSize.length) return;

    setFiles((prev) => {
      const merged = [...prev, ...withinSize];
      if (merged.length > data.max_files) {
        toast.warn(t(
          'transfers.upload.toomany',
          'Only the first {{count}} files can be uploaded at once.',
          { count: data.max_files },
        ));
      }
      return merged.slice(0, data.max_files);
    });
  };

  const handleUpload = async () => {
    if (!files.length) return;
    setUploading(true);
    setProgress(0);
    try {
      const result = await transfersService.upload(token as string, files, setProgress);
      // The server filters independently of us, so it can still drop a file the
      // page admitted (a type whose MIME the browser guessed differently).
      if (result.rejected_files?.length) {
        toast.warn(t(
          'transfers.upload.someRejected',
          'These files were not accepted: {{names}}',
          { names: result.rejected_files.join(', ') },
        ));
      }

      // Files whose bytes or row did not land are NOT uploaded, whatever the
      // 201 says. Keep them on screen so retrying is one click, and do not
      // show the "thank you" screen over a partial failure.
      const failed = result.failed_files || [];
      if (failed.length) {
        toast.error(t(
          'transfers.upload.someFailed',
          'These files could not be stored. Please try them again: {{names}}',
          { names: failed.join(', ') },
        ));
        setFiles((prev) => prev.filter((f) => failed.includes(f.name)));
        setProgress(0);
        return;
      }

      setDone(true);
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        || t('transfers.upload.failed', 'Upload failed. Please try again.');
      toast.error(msg);
    } finally {
      setUploading(false);
    }
  };

  if (done) {
    return wrap(
      <div className="p-8 text-center">
        <CheckCircle className="mx-auto mb-3 h-12 w-12 text-green-500" />
        <h1 className="text-xl font-semibold">{t('transfers.upload.doneTitle', 'Thank you!')}</h1>
        <p className="mt-2" style={muted}>{t('transfers.upload.doneBody', 'Your files were uploaded successfully.')}</p>
        <Button className="mt-5" variant="outline" onClick={() => { setDone(false); setFiles([]); setProgress(0); }}>
          {t('transfers.upload.uploadMore', 'Upload more')}
        </Button>
      </div>,
    );
  }

  return wrap(
    <div className="p-6">
      <div className="mb-5 text-center">
        <UploadCloud className="mx-auto mb-2 h-10 w-10" style={{ color: 'var(--color-accent)' }} />
        <h1 className="text-2xl font-bold">{data.title}</h1>
        {data.message && <p className="mt-2 whitespace-pre-line" style={muted}>{data.message}</p>}
        <p className="mt-2 text-sm" style={muted}>
          {t('transfers.upload.limits', 'Up to {{files}} files, {{mb}} MB each', { files: data.max_files, mb: data.max_size_mb })}
        </p>
        <p className="mt-1 text-xs" style={muted}>
          {data.accept_all
            ? t('transfers.upload.anyType', 'Any file type is accepted.')
            : t('transfers.upload.acceptedTypes', 'Accepted: {{types}}', {
              types: data.allowed_extensions.join(', ') || data.allowed_mime.join(', '),
            })}
        </p>
      </div>

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex w-full flex-col items-center justify-center rounded-lg border-2 border-dashed py-10 transition hover:opacity-80"
        style={{ borderColor: 'var(--color-surface-border)', color: 'var(--color-muted-text)' }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
      >
        <UploadCloud className="mb-2 h-8 w-8" />
        <span className="text-sm">{t('transfers.upload.dropzone', 'Click to choose files or drag them here')}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => { addFiles(e.target.files); if (inputRef.current) inputRef.current.value = ''; }}
      />

      {files.length > 0 && (
        <ul className="mt-4 border-t" style={{ borderColor: 'var(--color-surface-border)' }}>
          {files.map((f, idx) => (
            <li
              key={`${f.name}-${idx}`}
              className="flex items-center justify-between border-b py-2 text-sm"
              style={{ borderColor: 'var(--color-surface-border)' }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileIcon className="h-4 w-4 shrink-0" style={muted} />
                <span className="truncate">{f.name}</span>
              </span>
              <span className="flex shrink-0 items-center gap-3" style={muted}>
                <span>{formatBytes(f.size)}</span>
                {!uploading && (
                  <button onClick={() => setFiles((prev) => prev.filter((_, i) => i !== idx))} className="rounded p-1 hover:opacity-70">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {uploading && (
        <div className="mt-4 h-2 w-full overflow-hidden rounded-full" style={{ backgroundColor: 'var(--color-surface-border)' }}>
          <div className="h-full transition-all" style={{ width: `${progress}%`, backgroundColor: 'var(--color-accent-dark)' }} />
        </div>
      )}

      <Button
        className="mt-5 w-full"
        size="lg"
        leftIcon={<UploadCloud className="h-5 w-5" />}
        onClick={handleUpload}
        disabled={files.length === 0}
        isLoading={uploading}
      >
        {t('transfers.upload.send', 'Upload {{count}} files', { count: files.length })}
      </Button>
    </div>,
  );
};
