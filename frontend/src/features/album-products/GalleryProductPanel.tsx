import {
  ConfigurationPicker,
  ChoiceSummary,
  choiceValues,
  pruneValues,
} from './ConfigurationPicker';
import { formatMoneyMinor } from '../../utils/money';
import { Button, Input } from '../../components/common';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../config/api';
import { albumProducts, CHOOSE_ALBUM, errorMessage, isConfirmed, type Offer } from './model';
import { ProductImage } from './ProductImage';
import { GuidedAlbumFlow } from './GuidedAlbumFlow';
// What can still change follows the product: a guided draft stays in the plain
// form once the studio turns guiding off. What can't is shown as it was made.
const isGuided = (offer: Offer) =>
  offer.product && !isConfirmed(offer)
    ? !!offer.product.guided
    : !!offer.product?.guided || !!offer.selection?.photoRoles;
/** The entry to a released album. The portal's deep link opens it directly. */
function GuidedAlbumEntry({
  offers,
  slug,
  onClosed,
}: {
  offers: Offer[];
  slug: string;
  onClosed: () => void;
}) {
  const { t } = useTranslation();
  const [link] = useState(() =>
    new URLSearchParams(window.location.search).get('album'),
  );
  const [open, setOpen] = useState(
    () => link === CHOOSE_ALBUM || offers.some((o) => o.id === link),
  );
  // The link has done its work: leave it in the URL and closing would reopen.
  const close = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('album');
    window.history.replaceState(window.history.state, '', url);
    setOpen(false);
    onClosed();
  };
  const confirmed = offers.find(isConfirmed);
  // A view-only portal login sees a confirmed album, but can't make one.
  const viewOnly = !confirmed && offers.every((o) => o.readOnly);
  return (
    <section
      aria-label={t('albumProducts.yourAlbum', 'Your album')}
      className="max-w-7xl mx-auto px-4 py-4 text-text-primary"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-token bg-surface p-4">
        <div className="min-w-0">
          <h3 className="font-semibold">
            {t('albumProducts.yourAlbum', 'Your album')}
          </h3>
          <p className="text-sm">
            {confirmed
              ? t('albumProducts.entryConfirmed', 'Your selection is confirmed.')
              : viewOnly
                ? t('albumProducts.readOnlyHelp', 'Your login can view this choice but not make it.')
                : t(
                    'albumProducts.entryOpen',
                    'Choose your album, its look and your cover and poster photos.',
                  )}
          </p>
        </div>
        {!viewOnly && <Button onClick={() => setOpen(true)}>
          {confirmed
            ? t('albumProducts.viewSelection', 'View your selection')
            : offers.some((o) => o.selection)
              ? t('albumProducts.continueSelection', 'Continue your selection')
              : t('albumProducts.startSelection', 'Configure your album')}
        </Button>}
      </div>
      {open && !viewOnly && (
        <GuidedAlbumFlow
          offers={offers}
          slug={slug}
          startOfferId={link}
          onClose={close}
        />
      )}
    </section>
  );
}
function ProductChoice({
  initial,
  slug,
  onRefresh,
}: {
  initial: Offer;
  slug: string;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const [offer, setOffer] = useState(initial),
    [values, setValues] = useState(
      initial.product?.attributes
        ? pruneValues(
            initial.product.attributes,
            choiceValues(initial.selection),
          )
        : choiceValues(initial.selection),
    ),
    [model, setModel] = useState(initial.selection?.model?.id || ''),
    [colour, setColour] = useState(initial.selection?.colour?.id || ''),
    [name, setName] = useState(''),
    [saving, setBusy] = useState(false),
    [error, setError] = useState('');
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const product = offer.product,
    locked = offer.status === 'locked',
    busy = saving || !!offer.readOnly;
  const submit = async (commit: boolean) => {
    setBusy(true);
    setError('');
    const payload = {
        revision: offer.revision,
        productVersion: product?.version,
        ...(product?.attributes
          ? { values }
          : { modelId: model, colourId: colour }),
        name,
        submit: commit,
      },
      fingerprint = JSON.stringify(payload);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, id: crypto.randomUUID() };
    try {
      const result = await api.put<Offer>(
        `/gallery/${slug}/album-products/${offer.id}`,
        { ...payload, mutationId: attempt.current.id },
      );
      setOffer((current) => ({
        ...current,
        ...result.data,
        product,
        needsReview: false,
      }));
      attempt.current = null;
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="rounded-lg border p-4 space-y-4 border-border-token">
      <h3 className="text-xl font-semibold">
        {product?.name || offer.selection?.product.name}
      </h3>
      {product?.description && <p>{product.description}</p>}
      {product?.heroImageId && (
        <div className="max-w-xs">
          <ProductImage slug={slug} imageId={product.heroImageId} alt={product.name} />
        </div>
      )}
      {offer.selection && (
        <p role="status">
          {t('albumProducts.savedChoice', 'Saved choice')}:{' '}
          <ChoiceSummary choice={offer.selection} /> —{' '}
          {offer.status === 'locked'
            ? t('albumProducts.locked', 'Locked by the studio')
            : offer.status === 'submitted'
              ? t('albumProducts.submitted', 'Submitted')
              : t('albumProducts.draft', 'Draft')}
        </p>
      )}
      {offer.needsReview && (
        <p role="status">
          {t(
            'products.needsReview',
            'Your selected options changed. Please review and submit your choice again.',
          )}
        </p>
      )}
      {!locked && offer.readOnly && (
        <p>
          {t(
            'albumProducts.readOnlyHelp',
            'Your login can view this choice but not make it.',
          )}
        </p>
      )}
      {locked && (
        <>
          <p>
            {t(
              'albumProducts.lockedHelp',
              'Contact the studio if you need to change this choice.',
            )}
          </p>
          {offer.selection?.attributes ? (
            <div className="grid grid-cols-2 gap-4 max-w-md">
              {offer.selection.attributes
                .flatMap((a) => a.options)
                .filter((o) => o.imageId)
                .map((o) => (
                  <ProductImage
                    key={o.id}
                    slug={slug}
                    imageId={o.imageId}
                    alt={o.name}
                  />
                ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 max-w-md">
              <ProductImage
                slug={slug}
                imageId={offer.selection?.model?.imageId || null}
                alt={offer.selection?.model?.name || ''}
              />
              <ProductImage
                slug={slug}
                imageId={offer.selection?.colour?.imageId || null}
                alt={offer.selection?.colour?.name || ''}
              />
            </div>
          )}
        </>
      )}
      {!locked && product && (
        <>
          {product.attributes ? (
            <div className="space-y-3">
              {offer.pricing && (
                <p className="text-sm">
                  {t(
                    'products.informationalPrice',
                    'Indicative base price; the studio confirms the final price when locking your choice.',
                  )}{' '}
                  {formatMoneyMinor(
                    offer.pricing.baseUnitPriceMinor,
                    offer.pricing.currency,
                  )}
                </p>
              )}
              <ConfigurationPicker
                product={product}
                values={values}
                onChange={setValues}
                disabled={busy}
                slug={slug}
                surcharges={offer.pricing?.surcharges}
                currency={offer.pricing?.currency}
              />
            </div>
          ) : (
            <>
              {' '}
              <fieldset disabled={busy} className="space-y-3">
                <legend className="font-semibold">
                  {t('albumProducts.chooseModel', 'Choose a model')}
                </legend>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {(product.models || []).map((option) => (
                    <label
                      key={option.id}
                      className={`block border border-border-token rounded-lg p-2 cursor-pointer min-w-0 ${model === option.id ? 'tile-selected' : ''}`}
                    >
                      <ProductImage
                        slug={slug}
                        imageId={option.imageId}
                        alt={option.name}
                      />
                      <span className="flex items-center gap-2 mt-2">
                        <input
                          type="radio"
                          aria-label={option.name}
                          name={`model-${offer.id}`}
                          value={option.id}
                          checked={model === option.id}
                          onChange={() => {
                            setModel(option.id);
                            const selected = product.colours?.find(
                              (o) => o.id === colour,
                            );
                            if (
                              selected?.modelIds?.length &&
                              !selected.modelIds.includes(option.id)
                            )
                              setColour('');
                          }}
                        />
                        {option.name}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset disabled={busy || !model} className="space-y-3">
                <legend className="font-semibold">
                  {t('albumProducts.chooseColour', 'Choose a colour')}
                </legend>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {(product.colours || [])
                    .filter(
                      (o) => !o.modelIds?.length || o.modelIds.includes(model),
                    )
                    .map((option) => (
                      <label
                        key={option.id}
                        className={`block border border-border-token rounded-lg p-2 cursor-pointer min-w-0 ${colour === option.id ? 'tile-selected' : ''}`}
                      >
                        <ProductImage
                          slug={slug}
                          imageId={option.imageId}
                          alt={option.name}
                        />
                        <span className="flex items-center gap-2 mt-2">
                          <input
                            type="radio"
                            aria-label={option.name}
                            name={`colour-${offer.id}`}
                            value={option.id}
                            checked={colour === option.id}
                            onChange={() => setColour(option.id)}
                          />
                          {option.name}
                        </span>
                      </label>
                    ))}
                </div>
              </fieldset>
            </>
          )}
          <Input
            themed
            label={t('albumProducts.yourName', 'Your name')}
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
          <p className="text-sm">
            {t(
              'albumProducts.noCharge',
              'This records your choice only. Your studio confirms the price separately. You can change your choice until the studio locks it.',
            )}
          </p>
          <div className="flex gap-3 flex-wrap">
            <Button
              variant="secondary"
              disabled={
                busy ||
                offer.status === 'submitted' ||
                !name.trim() ||
                (!product.attributes && (!model || !colour))
              }
              onClick={() => submit(false)}
            >
              {t('albumProducts.saveDraft', 'Save draft')}
            </Button>
            <Button
              disabled={
                busy ||
                !name.trim() ||
                (!product.attributes && (!model || !colour))
              }
              onClick={() => submit(true)}
            >
              {saving
                ? t('common.saving', 'Saving…')
                : t('albumProducts.submit', 'Submit choice')}
            </Button>
          </div>
        </>
      )}
      {!locked && !product && (
        <p>
          {t(
            'albumProducts.unavailable',
            'The studio is updating this offer. Your saved choice remains on record.',
          )}
        </p>
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          <button className="underline" onClick={onRefresh}>
            {t('albumProducts.reloadChoices', 'Reload current choices')}
          </button>
        </p>
      )}
    </article>
  );
}
/** `className` wraps the panel when it has anything to show, never an empty box. */
export function GalleryProductPanel({ slug, className }: { slug: string; className?: string }) {
  const { t } = useTranslation();
  const [offers, setOffers] = useState<Offer[]>([]),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    albumProducts
      .client(slug)
      .then((data) => {
        if (active) {
          setOffers(data);
          setError('');
        }
      })
      .catch((e) => {
        if (active && e.response?.status !== 403)
          setError(
            t(
              'albumProducts.loadFailed',
              'Product choices are temporarily unavailable.',
            ),
          );
      });
    return () => {
      active = false;
    };
  }, [slug, reload, t]);
  if (!offers.length && !error) return null;
  const guided = offers.filter(isGuided),
    classic = offers.filter((offer) => !isGuided(offer));
  return (
    <div className={className}>
      {guided.length > 0 && (
        <GuidedAlbumEntry
          key={reload}
          offers={guided}
          slug={slug}
          onClosed={() => setReload(reload + 1)}
        />
      )}
      {(classic.length > 0 || error) && (
        <details
          aria-label={t('products.clientTitle', 'Your product choices')}
          className="max-w-7xl mx-auto px-4 py-6 space-y-4 text-text-primary bg-background"
        >
          <summary className="cursor-pointer text-lg font-semibold">
            {t('products.clientTitle', 'Your product choices')}
          </summary>
          {classic.map((offer) => (
            <ProductChoice
              key={`${offer.id}-${reload}`}
              initial={offer}
              slug={slug}
              onRefresh={() => setReload(reload + 1)}
            />
          ))}
          {error && (
            <p role="status">
              {error}{' '}
              <button className="underline" onClick={() => setReload(reload + 1)}>
                {t('common.retry', 'Try again')}
              </button>
            </p>
          )}
        </details>
      )}
    </div>
  );
}
