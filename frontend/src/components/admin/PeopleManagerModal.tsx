/**
 * <PeopleManagerModal> — manage the people detected in one gallery (#1074).
 *
 * Merge and split are the two operations that make automatic clustering
 * survive contact with reality. A well-behaved wedding gallery still produces
 * "Anna in daylight" and "Anna at the party" as separate people, and the
 * clustering deliberately errs toward splitting rather than merging (a
 * duplicate entry is an annoyance; a wrong merge puts a stranger into
 * someone's download). That trade only works if merging is easy, which is
 * what this screen is for.
 *
 * Every action here hits an endpoint that already re-checks event ownership
 * and that the ids belong to this gallery — the UI is a convenience, never
 * the control.
 */
import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { X, Check, Merge, Scissors, EyeOff, Ban, Loader2 } from 'lucide-react';

import { Button, Loading } from '../common';
import { api } from '../../config/api';
import { faceCropStyle } from '../gallery/faceCrop';
import { adminFacePreviewUrl } from '../gallery/imageTiers';

interface AdminPerson {
  id: number;
  label: string | null;
  face_count: number;
  total_face_count?: number;
  is_hidden?: boolean;
  is_ignored?: boolean;
  cover: {
    face_id: number;
    photo_id: number;
    bbox: [number, number, number, number];
    photo_width: number | null;
    photo_height: number | null;
  } | null;
}

interface PersonFace {
  id: number;
  photo_id: number;
  bbox: [number, number, number, number];
  photo_width: number | null;
  photo_height: number | null;
  score: number | null;
  blur: number | null;
}

interface PeopleManagerModalProps {
  eventId: number;
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}

/**
 * Square crop of a face, served by the admin thumbnail route (which applies
 * its own auth + event-ownership checks).
 *
 * A plain <img>, deliberately NOT <AuthenticatedImage>. That component
 * attaches whatever gallery token it finds in session storage, and an admin
 * who has also opened one of their own galleries in the same browser then
 * sends a `type: "gallery"` bearer token to an admin route — which rejects
 * it as insufficient permissions, so every thumbnail 403s. The admin routes
 * authenticate from the httpOnly admin_token cookie, which a same-origin
 * <img> sends on its own.
 */
const FaceThumb: React.FC<{
  eventId: number;
  photoId: number;
  bbox?: [number, number, number, number] | null;
  photoWidth?: number | null;
  photoHeight?: number | null;
  size?: number;
  dim?: boolean;
}> = ({ eventId, photoId, bbox, photoWidth, photoHeight, size = 64, dim }) => {
  // Crop to the face rather than showing the centred thumbnail. On a group
  // photo the uncropped version shows whoever stands in the middle, so two
  // different people whose cover is the same photo looked IDENTICAL here —
  // in the manager whose whole job is telling faces apart.
  //
  // COORDINATE SPACE: the bbox is in ORIGINAL image pixels, so it must be
  // scaled against the ORIGINAL dimensions (now supplied by the API), never
  // against the thumbnail's own natural size. Mixing the two renders the
  // wrong region entirely — the box ends up a fraction of its true size and
  // offset toward the top-left.
  const style = faceCropStyle(bbox ? { bbox } : null, photoWidth, photoHeight, size);

  return (
    <span
      className="relative block rounded-full overflow-hidden bg-neutral-100 flex-shrink-0"
      style={{ width: size, height: size, opacity: dim ? 0.4 : 1 }}
    >
      <img
        src={adminFacePreviewUrl(eventId, photoId)}
        alt=""
        loading="lazy"
        style={style || { width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </span>
  );
};

export const PeopleManagerModal: React.FC<PeopleManagerModalProps> = ({
  eventId, open, onClose, onChanged,
}) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<number[]>([]);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [splitting, setSplitting] = useState<AdminPerson | null>(null);
  const [splitFaceIds, setSplitFaceIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const { data, isLoading, refetch } = useQuery<{ people: AdminPerson[] }>({
    queryKey: ['admin-event-people', eventId],
    queryFn: async () => (await api.get(`/admin/events/${eventId}/people`)).data,
    enabled: open,
  });

  const { data: faceData, isLoading: facesLoading } = useQuery<{ faces: PersonFace[] }>({
    queryKey: ['admin-person-faces', eventId, splitting?.id],
    queryFn: async () =>
      (await api.get(`/admin/events/${eventId}/people/${splitting!.id}/faces`)).data,
    enabled: !!splitting,
  });

  const people = useMemo(() => data?.people || [], [data]);

  const after = async (message: string) => {
    await refetch();
    onChanged?.();
    setSelected([]);
    toast.success(message);
  };

  const run = async (fn: () => Promise<void>, successMessage: string) => {
    setBusy(true);
    try {
      await fn();
      await after(successMessage);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('common.saveFailed', { defaultValue: 'Failed' }));
    } finally {
      setBusy(false);
    }
  };

  const toggleSelect = (id: number) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const saveLabel = (person: AdminPerson) => {
    const label = draftLabel.trim();
    setRenaming(null);
    if (label === (person.label || '')) return;
    run(
      async () => {
        await api.patch(`/admin/events/${eventId}/people/${person.id}`, { label: label || null });
      },
      t('admin.people.renamed', { defaultValue: 'Name saved' })
    );
  };

  const doMerge = () => {
    // The first selected person is the target — it keeps its name, which is
    // almost always the one the photographer already bothered to type.
    const [target, ...sources] = selected;
    run(
      async () => {
        await api.post(`/admin/events/${eventId}/people/merge`, {
          source_ids: sources, target_id: target,
        });
      },
      t('admin.people.merged', { count: sources.length, defaultValue: 'People merged' })
    );
  };

  const doSplit = () => {
    if (!splitting || !splitFaceIds.length) return;
    const personId = splitting.id;
    const ids = splitFaceIds;
    setSplitting(null);
    setSplitFaceIds([]);
    run(
      async () => {
        await api.post(`/admin/events/${eventId}/people/${personId}/split`, { face_ids: ids });
      },
      t('admin.people.split', { defaultValue: 'Split into a new person' })
    );
  };

  const setFlag = (person: AdminPerson, field: 'is_hidden' | 'is_ignored', value: boolean) =>
    run(
      async () => {
        await api.patch(`/admin/events/${eventId}/people/${person.id}`, { [field]: value });
      },
      t('admin.people.updated', { defaultValue: 'Updated' })
    );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        className="relative bg-white text-neutral-900 rounded-xl shadow-xl w-full max-w-4xl max-h-[88vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100">
          <div>
            <h2 className="text-lg font-medium text-neutral-900">
              {t('admin.people.title', { defaultValue: 'People in this gallery' })}
            </h2>
            <p className="text-sm text-neutral-500">
              {t('admin.people.subtitle', {
                defaultValue: 'Rename, merge people who were split apart, or hide someone from guests.',
              })}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-2 -m-2 text-neutral-400 hover:text-neutral-600">
            <X size={20} />
          </button>
        </div>

        {/* --- split picker ------------------------------------------------ */}
        {splitting ? (
          <>
            <div className="px-5 py-3 bg-amber-50 border-b border-amber-100 text-sm text-amber-900">
              {t('admin.people.splitHelp', {
                defaultValue: 'Pick the photos that are NOT this person. They become a new entry, and everything else stays.',
              })}
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {facesLoading ? <Loading /> : (
                <div className="grid grid-cols-4 sm:grid-cols-6 gap-3">
                  {(faceData?.faces || []).map((face) => {
                    const picked = splitFaceIds.includes(face.id);
                    return (
                      <button
                        key={face.id}
                        type="button"
                        onClick={() => setSplitFaceIds((p) =>
                          p.includes(face.id) ? p.filter((x) => x !== face.id) : [...p, face.id])}
                        className={`relative rounded-lg overflow-hidden border-2 transition-colors ${
                          picked ? 'border-primary-600' : 'border-transparent hover:border-neutral-300'
                        }`}
                      >
                        <FaceThumb
                          eventId={eventId}
                          photoId={face.photo_id}
                          bbox={face.bbox}
                          photoWidth={face.photo_width}
                          photoHeight={face.photo_height}
                          size={88}
                        />
                        {picked && (
                          <span className="absolute top-1 right-1 bg-primary-600 text-white rounded-full p-0.5">
                            <Check size={12} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-neutral-100">
              <span className="text-sm text-neutral-500">
                {t('admin.people.splitSelected', {
                  count: splitFaceIds.length,
                  defaultValue: `${splitFaceIds.length} selected`,
                })}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => { setSplitting(null); setSplitFaceIds([]); }}>
                  {t('common.cancel', { defaultValue: 'Cancel' })}
                </Button>
                <Button variant="primary" size="sm" disabled={!splitFaceIds.length || busy} onClick={doSplit}>
                  {t('admin.people.doSplit', { defaultValue: 'Split out' })}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* --- people grid --------------------------------------------- */}
            <div className="flex-1 overflow-y-auto p-5">
              {isLoading ? <Loading /> : people.length === 0 ? (
                <p className="text-sm text-neutral-500 text-center py-10">
                  {t('admin.people.empty', { defaultValue: 'No people detected yet.' })}
                </p>
              ) : (
                <div className="space-y-1">
                  {people.map((person) => {
                    const isSelected = selected.includes(person.id);
                    return (
                      <div
                        key={person.id}
                        className={`flex items-center gap-3 p-2 rounded-lg border transition-colors ${
                          isSelected ? 'border-primary-400 bg-primary-50' : 'border-transparent hover:bg-neutral-50'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => toggleSelect(person.id)}
                          aria-pressed={isSelected}
                          aria-label={t('admin.people.select', { defaultValue: 'Select for merging' })}
                          className="flex-shrink-0"
                        >
                          <FaceThumb
                            eventId={eventId}
                            photoId={person.cover?.photo_id ?? 0}
                            bbox={person.cover?.bbox}
                            photoWidth={person.cover?.photo_width}
                            photoHeight={person.cover?.photo_height}
                            dim={person.is_ignored || person.is_hidden}
                          />
                        </button>

                        <div className="flex-1 min-w-0">
                          {renaming === person.id ? (
                            <input
                              autoFocus
                              value={draftLabel}
                              onChange={(e) => setDraftLabel(e.target.value)}
                              onBlur={() => saveLabel(person)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveLabel(person);
                                if (e.key === 'Escape') setRenaming(null);
                              }}
                              placeholder={t('admin.people.namePlaceholder', { defaultValue: 'Add a name' })}
                              className="w-full max-w-xs px-2 py-1 text-sm border border-neutral-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => { setRenaming(person.id); setDraftLabel(person.label || ''); }}
                              className="text-sm text-left text-neutral-900 hover:underline"
                            >
                              {person.label || (
                                <span className="text-neutral-400 italic">
                                  {t('admin.people.unnamed', { defaultValue: 'Add a name' })}
                                </span>
                              )}
                            </button>
                          )}
                          <p className="text-xs text-neutral-500">
                            {t('admin.people.photoCount', {
                              count: person.total_face_count ?? person.face_count,
                              defaultValue: `${person.total_face_count ?? person.face_count} photos`,
                            })}
                            {person.is_hidden && ` · ${t('admin.people.hidden', { defaultValue: 'hidden from guests' })}`}
                            {person.is_ignored && ` · ${t('admin.people.ignored', { defaultValue: 'ignored' })}`}
                          </p>
                        </div>

                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            type="button"
                            disabled={busy}
                            title={t('admin.people.splitAction', { defaultValue: 'Split out photos that are someone else' })}
                            onClick={() => { setSplitting(person); setSplitFaceIds([]); }}
                            className="p-2 text-neutral-400 hover:text-neutral-700 rounded"
                          >
                            <Scissors size={16} />
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            title={t('admin.people.hideAction', { defaultValue: 'Hide from guests' })}
                            onClick={() => setFlag(person, 'is_hidden', !person.is_hidden)}
                            className={`p-2 rounded ${person.is_hidden ? 'text-primary-600' : 'text-neutral-400 hover:text-neutral-700'}`}
                          >
                            <EyeOff size={16} />
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            title={t('admin.people.ignoreAction', { defaultValue: 'Not a real person — ignore' })}
                            onClick={() => setFlag(person, 'is_ignored', !person.is_ignored)}
                            className={`p-2 rounded ${person.is_ignored ? 'text-red-600' : 'text-neutral-400 hover:text-neutral-700'}`}
                          >
                            <Ban size={16} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Merge only becomes available at two, and the wording names the
                target explicitly so nobody has to guess which name survives. */}
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-neutral-100">
              <span className="text-sm text-neutral-500">
                {selected.length > 0
                  ? t('admin.people.selectedCount', {
                    count: selected.length,
                    defaultValue: `${selected.length} selected`,
                  })
                  : t('admin.people.mergeHint', {
                    defaultValue: 'Tap two or more faces to merge them into one person.',
                  })}
              </span>
              <div className="flex gap-2">
                {selected.length > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setSelected([])}>
                    {t('common.clear', { defaultValue: 'Clear' })}
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  disabled={selected.length < 2 || busy}
                  onClick={doMerge}
                  leftIcon={busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Merge className="w-4 h-4" />}
                >
                  {t('admin.people.merge', { defaultValue: 'Merge' })}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default PeopleManagerModal;
