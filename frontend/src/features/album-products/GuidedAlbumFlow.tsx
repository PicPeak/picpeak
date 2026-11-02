import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowLeft, ArrowRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '../../components/common';
import { pushDialogLayer } from '../../components/common/Modal';
import { resolveMediaType } from '../../components/gallery/hooks/useGalleryFiltering';
import { api } from '../../config/api';
import { galleryService } from '../../services/gallery.service';
import { lockBodyScroll } from '../../utils/scrollLock';
import type { Photo } from '../../types';
import { AlbumChoiceDetails } from './AlbumChoiceDetails';
import { ColourSwatches, SwatchDot } from './ColourSwatches';
import {
  availableOptions,
  choiceValues,
  ConfigurationPicker,
  pruneValues,
  type ConfigurationValues,
} from './ConfigurationPicker';
import { FormatComparison, SizeOutline, widestOf } from './FormatComparison';
import { errorMessage, isConfirmed, type Attribute, type AttributeRole, type Choice, type Offer, type PhotoRoleKey } from './model';
import { GalleryPhoto, PhotoRolePicker } from './PhotoRolePicker';
import { ProductImage } from './ProductImage';

type Step = 'album' | AttributeRole | 'extras' | PhotoRoleKey | 'review';
const ROLES: AttributeRole[] = ['material', 'colour', 'format', 'size'];
type PhotoSelection = Record<PhotoRoleKey, number[]>;

const photosOf = (choice?: Choice | null): PhotoSelection => ({
  cover: choice?.photoRoles?.find((r) => r.key === 'cover')?.photos.map((p) => p.id) || [],
  poster: choice?.photoRoles?.find((r) => r.key === 'poster')?.photos.map((p) => p.id) || [],
});
const roleLimit = (offer: Offer | undefined, key: PhotoRoleKey) =>
  offer?.product?.guided?.photoRoles.find((r) => r.key === key) || { key, min: 0, max: 0 };
const attributeOf = (offer: Offer | undefined, role: AttributeRole) =>
  offer?.product?.attributes?.find((a) => a.role === role);

const requiredExtras = (attributes: Attribute[], values: ConfigurationValues) => {
  const enabled = pruneValues(attributes, values);
  return attributes.filter((a) => !a.role && a.required && a.id in enabled);
};
const unavailablePhotos = (offer?: Offer) =>
  (offer?.selection?.photoRoles || [])
    .flatMap((r) => r.photos)
    .filter((p) => p.available === false)
    .map((p) => p.id);
function stepReady(step: Step, offer: Offer | undefined, values: ConfigurationValues, chosen: PhotoSelection) {
  if (step === 'album') return !!offer?.product;
  if (step === 'review') return false;
  if (step === 'extras')
    return requiredExtras(offer?.product?.attributes || [], values).every((a) => values[a.id]?.length);
  if (step === 'cover' || step === 'poster') {
    const limit = roleLimit(offer, step);
    const gone = unavailablePhotos(offer);
    return (
      chosen[step].length >= limit.min &&
      chosen[step].length <= limit.max &&
      !chosen[step].some((id) => gone.includes(id))
    );
  }
  const a = attributeOf(offer, step);
  return !!a && !!values[a.id]?.length;
}

function stepsFor(offer: Offer | undefined): Step[] {
  if (!offer?.product) return ['album'];
  return [
    'album',
    ...ROLES,
    ...(offer.product.attributes?.some((a) => !a.role) ? (['extras'] as const) : []),
    ...(roleLimit(offer, 'cover').max > 0 ? (['cover'] as const) : []),
    ...(roleLimit(offer, 'poster').max > 0 ? (['poster'] as const) : []),
    'review',
  ];
}

/**
 * The guided album order (issue 2320): album, material, colour, format, size,
 * the photo roles, then one review with a separate, explicit confirmation.
 * Every step forward saves a draft, so a client can stop and come back; the
 * server repeats every check, this only keeps invalid choices out of reach.
 */
export function GuidedAlbumFlow({
  offers: initial,
  slug,
  startOfferId,
  onClose,
}: {
  offers: Offer[];
  slug: string;
  startOfferId?: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const flowId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [offers, setOffers] = useState(initial);
  // A confirmed album ends the flow; the studio reopens it or nothing does.
  const start =
    offers.find(isConfirmed) ||
    offers.find((o) => o.id === startOfferId) ||
    (offers.length === 1 ? offers[0] : undefined);
  const [offerId, setOfferId] = useState(start?.id || '');
  const offer = offers.find((o) => o.id === offerId);
  const product = offer?.product;
  const attributes = useMemo(() => product?.attributes || [], [product]);
  const [values, setValues] = useState<ConfigurationValues>(() =>
    start?.product?.attributes
      ? pruneValues(start.product.attributes, choiceValues(start.selection))
      : {},
  );
  const [chosen, setChosen] = useState<PhotoSelection>(() => photosOf(start?.selection));
  // A saved draft picks up at its first open step.
  const [step, setStep] = useState<Step>(() =>
    start?.selection
      ? stepsFor(start).find((s) => s === 'review' || !stepReady(s, start, values, chosen)) || 'album'
      : 'album',
  );
  const [name, setName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [gallery, setGallery] = useState<Photo[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(true);
  const [galleryError, setGalleryError] = useState(false);

  const readOnly = !!offer && isConfirmed(offer);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const unlock = lockBodyScroll();
    const layer = pushDialogLayer();
    const onKey = (e: KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && dialog.current) {
        const items = dialog.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      layer.release();
      unlock();
      opener?.focus?.();
    };
  }, []);

  useEffect(() => {
    let active = true;
    galleryService
      .getGalleryPhotos(slug)
      .then((data) => {
        if (!active) return;
        // What the server will take: the studio's hidden photos stay out even
        // for a PIN client, who otherwise sees them, and a video is no print.
        setGallery(data.photos.filter((p) => p.visibility !== 'hidden' && resolveMediaType(p) !== 'video'));
      })
      .catch(() => active && setGalleryError(true))
      .finally(() => active && setGalleryLoading(false));
    return () => {
      active = false;
    };
  }, [slug]);

  // A new step is new content: tell a screen reader, and start at its top.
  useEffect(() => {
    heading.current?.focus();
    if (content.current) content.current.scrollTop = 0;
  }, [step, offerId, readOnly]);

  const steps = stepsFor(offer);
  const position = steps.indexOf(step);
  const one = (a?: Attribute) => (a ? values[a.id]?.[0] : undefined);
  const material = attributeOf(offer, 'material');
  const colour = attributeOf(offer, 'colour');
  const format = attributeOf(offer, 'format');
  const size = attributeOf(offer, 'size');
  const choose = (a: Attribute, id: string) =>
    setValues(pruneValues(attributes, { ...values, [a.id]: [id] }));
  const openOffer = (next: Offer) => {
    setOfferId(next.id);
    setValues(next.product?.attributes ? pruneValues(next.product.attributes, choiceValues(next.selection)) : {});
    setChosen(photosOf(next.selection));
    setError('');
    setConfirming(false);
  };

  const unavailable = unavailablePhotos(offer);
  const ready = (s: Step) => stepReady(s, offer, values, chosen);
  const complete = steps.every((s) => s === 'review' || ready(s));

  const persist = async (commit: boolean) => {
    if (!offer || !product) return false;
    setBusy(true);
    setError('');
    const payload = {
      revision: offer.revision,
      productVersion: product.version,
      values,
      photos: chosen,
      ...(name.trim() ? { name: name.trim() } : {}),
      submit: commit,
    };
    const fingerprint = JSON.stringify(payload);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, id: crypto.randomUUID() };
    try {
      const result = await api.put<Offer>(`/gallery/${slug}/album-products/${offer.id}`, {
        ...payload,
        mutationId: attempt.current.id,
      });
      setOffers((current) =>
        current.map((o) => (o.id === offer.id ? { ...o, ...result.data, product: o.product } : o)),
      );
      attempt.current = null;
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const next = async () => {
    // A submitted, not yet final choice is only ever resubmitted whole.
    if (step !== 'album' && offer?.status === 'draft' && !(await persist(false))) return;
    setStep(steps[position + 1]);
  };
  const back = () => {
    setConfirming(false);
    setError('');
    setStep(steps[Math.max(0, position - 1)]);
  };
  const confirm = async () => {
    if (await persist(true)) setConfirming(false);
  };

  const stepTitle: Record<Step, string> = {
    album: t('albumProducts.stepAlbum', 'Choose your album'),
    material: t('albumProducts.stepMaterial', 'Choose a material'),
    colour: t('albumProducts.stepColour', 'Choose a colour'),
    format: t('albumProducts.stepFormat', 'Compare the formats'),
    size: t('albumProducts.stepSize', 'Choose a size'),
    extras: t('albumProducts.stepExtras', 'A few more details'),
    cover: t('albumProducts.stepCover', 'Choose your cover photo'),
    poster: t('albumProducts.stepPoster', 'Choose your poster photos'),
    review: t('albumProducts.stepReview', 'Review your album'),
  };
  const photoFor = (id: number, alt: string) => (
    <span className="block aspect-square overflow-hidden rounded-lg border border-border-token bg-surface">
      <GalleryPhoto id={id} slug={slug} photo={gallery.find((p) => p.id === id)} alt={alt} />
    </span>
  );
  // The review shows what will be sent, built from this session's choices.
  const preview: Choice | null = offer?.product
    ? {
        schemaVersion: 2,
        productVersion: product?.version || '',
        product: { id: offer.product.id, name: offer.product.name },
        attributes: attributes
          .filter((a) => (values[a.id]?.length || 0) > 0)
          .map((a) => ({
            id: a.id,
            name: a.name,
            addOn: a.addOn,
            role: a.role,
            options: a.options.filter((o) => values[a.id].includes(o.id)),
          })),
        photoRoles: (['cover', 'poster'] as const).map((key) => ({
          key,
          photos: chosen[key].map((id) => ({ id })),
        })),
      }
    : null;

  const body = () => {
    if (readOnly && offer?.selection) {
      return (
        <div className="space-y-4">
          <p role="status" className="rounded-lg border border-border-token bg-surface p-3">
            {offer.status === 'locked'
              ? t('albumProducts.confirmedLocked', 'Your selection is confirmed and locked by the studio.')
              : t('albumProducts.confirmedWaiting', 'Your selection is confirmed. The studio has received it.')}{' '}
            {t('albumProducts.lockedHelp', 'Contact the studio if you need to change this choice.')}
          </p>
          <AlbumChoiceDetails
            choice={offer.selection}
            renderPhoto={(photo) => photoFor(photo.id, t('albumProducts.selectedPhoto', 'Selected photo'))}
          />
        </div>
      );
    }
    switch (step) {
      case 'album':
        return (
          <div className="space-y-6">
            {offers.length > 1 && (
              <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
                {offers.map((o) => {
                  const selected = o.id === offerId;
                  return (
                    <li key={o.id}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => openOffer(o)}
                        className={`block w-full rounded-xl border border-border-token p-2 text-left focus-visible:ring-2 focus-visible:ring-accent ${selected ? 'tile-selected' : ''}`}
                      >
                        <ProductImage slug={slug} imageId={o.product?.heroImageId || null} alt="" />
                        <span className="mt-2 block font-semibold">{o.product?.name || o.selection?.product.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {offer && !product && (
              <p>{t('albumProducts.unavailable', 'The studio is updating this offer. Your saved choice remains on record.')}</p>
            )}
            {product && (
              <div className="grid gap-4 sm:grid-cols-2">
                <ProductImage slug={slug} imageId={product.heroImageId || null} alt={product.name} />
                <div className="space-y-3">
                  <p className="text-xl font-semibold">{product.name}</p>
                  {product.description && <p>{product.description}</p>}
                  <ul className="space-y-2 text-sm">
                    {ROLES.map((role) => {
                      const a = attributeOf(offer, role);
                      return a ? (
                        <li key={role}>
                          <span className="font-semibold">{a.name}: </span>
                          {role === 'colour'
                            ? a.options.map((o) => (
                                <span key={o.id} className="mr-1 inline-flex" title={o.name}>
                                  <SwatchDot hex={o.hex} />
                                  <span className={o.hex ? 'sr-only' : undefined}>{o.name}</span>
                                </span>
                              ))
                            : a.options.map((o) => o.name).join(', ')}
                        </li>
                      ) : null;
                    })}
                  </ul>
                </div>
              </div>
            )}
          </div>
        );
      case 'material':
        return material ? (
          <fieldset disabled={busy}>
            <legend className="sr-only">{material.name}</legend>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {material.options.map((o) => (
                <label
                  key={o.id}
                  className={`flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl border border-border-token p-3 focus-within:ring-2 focus-within:ring-accent ${one(material) === o.id ? 'tile-selected' : ''}`}
                >
                  {o.imageId && <ProductImage slug={slug} imageId={o.imageId} alt="" />}
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`${flowId}-material`}
                      checked={one(material) === o.id}
                      onChange={() => choose(material, o.id)}
                    />
                    {o.name}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null;
      case 'colour':
        return colour ? (
          <ColourSwatches
            name={`${flowId}-colour`}
            legend={colour.name}
            options={availableOptions(colour, values)}
            value={one(colour)}
            onChange={(id) => choose(colour, id)}
            slug={slug}
            disabled={busy}
          />
        ) : null;
      case 'format':
        return format && size ? (
          <FormatComparison
            name={`${flowId}-format`}
            format={format}
            size={size}
            value={one(format)}
            onChange={(id) => choose(format, id)}
            disabled={busy}
          />
        ) : null;
      case 'size': {
        if (!size) return null;
        const sizes = availableOptions(size, values);
        return (
          <fieldset disabled={busy}>
            <legend className="sr-only">{size.name}</legend>
            <div className="grid grid-cols-2 gap-3">
              {sizes.map((o) => (
                <label
                  key={o.id}
                  className={`flex min-w-0 cursor-pointer flex-col gap-3 rounded-xl border border-border-token p-3 focus-within:ring-2 focus-within:ring-accent ${one(size) === o.id ? 'tile-selected' : ''}`}
                >
                  <span className="flex h-24 items-center">
                    <span className="w-full">
                      <SizeOutline size={o} largest={widestOf(sizes)} spread={size.spread} />
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`${flowId}-size`}
                      checked={one(size) === o.id}
                      onChange={() => choose(size, o.id)}
                    />
                    {o.name}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        );
      }
      case 'extras':
        return product ? (
          <ConfigurationPicker
            product={product}
            values={values}
            onChange={setValues}
            disabled={busy}
            slug={slug}
            only={(a) => !a.role}
          />
        ) : null;
      case 'cover':
      case 'poster': {
        const key = step;
        const limit = roleLimit(offer, key);
        return galleryError ? (
          <p role="alert">{t('albumProducts.photosFailed', 'The gallery photos could not be loaded. Close this window and try again.')}</p>
        ) : (
          <PhotoRolePicker
            slug={slug}
            photos={gallery}
            loading={galleryLoading}
            chosen={chosen[key]}
            unavailable={unavailable}
            min={limit.min}
            max={limit.max}
            onChange={(ids) => setChosen({ ...chosen, [key]: ids })}
            disabled={busy}
          />
        );
      }
      case 'review':
        return preview ? (
          <div className="space-y-5">
            <AlbumChoiceDetails
              choice={preview}
              renderPhoto={(photo) => photoFor(photo.id, t('albumProducts.selectedPhoto', 'Selected photo'))}
            />
            <Input
              themed
              label={t('albumProducts.yourName', 'Your name')}
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy || confirming}
            />
            {product?.guided?.clientFinal ? (
              confirming ? (
                <div role="alertdialog" aria-labelledby={`${flowId}-warning`} className="space-y-3 rounded-lg border-2 border-accent p-4">
                  <p id={`${flowId}-warning`} className="flex items-start gap-2 font-semibold">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                    {t('albumProducts.confirmWarning', 'Attention: After confirmation, this selection can no longer be changed.')}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <Button disabled={busy} onClick={confirm}>
                      {busy ? t('common.saving', 'Saving…') : t('albumProducts.confirmFinal', 'Confirm now')}
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                      {t('albumProducts.confirmBack', 'Keep editing')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button disabled={!complete || !name.trim()} onClick={() => setConfirming(true)}>
                  {t('albumProducts.confirmSelection', 'Confirm selection')}
                </Button>
              )
            ) : (
              <Button disabled={busy || !complete || !name.trim()} onClick={() => persist(true)}>
                {busy ? t('common.saving', 'Saving…') : t('albumProducts.submit', 'Submit choice')}
              </Button>
            )}
            {!complete && (
              <p className="text-sm">{t('albumProducts.reviewIncomplete', 'Some steps are still missing. Go back to complete them.')}</p>
            )}
            {offer?.status === 'submitted' && !offer.selection?.clientFinal && (
              <p role="status">{t('albumProducts.submitted', 'Submitted')}</p>
            )}
          </div>
        ) : null;
      default:
        return null;
    }
  };

  const title = readOnly ? t('albumProducts.yourAlbum', 'Your album') : stepTitle[step];
  return createPortal(
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${flowId}-title`}
      className="fixed inset-0 z-50 flex flex-col bg-background text-text-primary"
    >
      <header className="flex items-center gap-3 border-b border-border-token px-4 py-3">
        <div className="min-w-0 flex-1">
          {!readOnly && position >= 0 && (
            <p className="text-sm">
              {t('albumProducts.stepOf', 'Step {{current}} of {{total}}', { current: position + 1, total: steps.length })}
            </p>
          )}
          <h2 id={`${flowId}-title`} ref={heading} tabIndex={-1} className="truncate text-lg font-semibold outline-none">
            {title}
          </h2>
        </div>
        <button type="button" aria-label={t('common.close', 'Close')} className="rounded p-2 focus-visible:ring-2 focus-visible:ring-accent" onClick={onClose}>
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>
      <div ref={content} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
          {body()}
          {error && <p role="alert" className="font-semibold">{error}</p>}
        </div>
      </div>
      {!readOnly && (
        <footer className="flex items-center justify-between gap-3 border-t border-border-token px-4 py-3">
          <Button variant="secondary" disabled={busy || position <= 0} onClick={back} leftIcon={<ArrowLeft className="h-4 w-4" />}>
            {t('common.back', 'Back')}
          </Button>
          {step !== 'review' && (
            <Button disabled={busy || !ready(step)} onClick={next} rightIcon={<ArrowRight className="h-4 w-4" />}>
              {t('common.next', 'Next')}
            </Button>
          )}
        </footer>
      )}
    </div>,
    document.body,
  );
}
