import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Switch } from '../../components/common';
import { albumProducts, errorMessage, type GuidedSettings, type PhotoRoleKey, type Product } from './model';
import { ProductImage } from './ProductImage';

const STARTING_POINT: GuidedSettings = {
  clientFinal: true,
  photoRoles: [
    { key: 'cover', min: 1, max: 1 },
    { key: 'poster', min: 1, max: 2 },
  ],
};

/** The product's hero image and, for a guided album, how it is ordered. */
export function GuidedProductFields({
  product,
  onChange,
  onBusy,
}: {
  product: Product;
  onChange: (patch: Partial<Product>) => void;
  onBusy: (delta: number) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const guided = product.guided;
  const role = (key: PhotoRoleKey) =>
    guided?.photoRoles.find((r) => r.key === key) || { key, min: 0, max: 0 };
  const setRole = (key: PhotoRoleKey, patch: { min?: number; max?: number }) =>
    guided &&
    onChange({
      guided: {
        ...guided,
        photoRoles: guided.photoRoles.map((r) => (r.key === key ? { ...r, ...patch } : r)),
      },
    });
  const upload = async (file?: File) => {
    if (!file) return;
    onBusy(1);
    setError('');
    try {
      onChange({ heroImageId: (await albumProducts.upload(file)).id });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      onBusy(-1);
    }
  };
  const poster = role('poster');
  const count = (label: string, value: number, change: (next: number) => void) => (
    <label className="block text-sm">
      {label}
      <input
        type="number"
        min={0}
        max={10}
        className="input w-24"
        value={value}
        onChange={(e) => change(Math.max(0, Math.min(10, Math.trunc(Number(e.target.value)) || 0)))}
      />
    </label>
  );
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-start gap-4">
        <div className="w-32">
          <ProductImage imageId={product.heroImageId || null} alt={product.name} />
        </div>
        <div className="space-y-2">
          <label className="block text-sm">
            {t('products.heroImage', 'Product image (PNG, up to 6 MB)')}
            <input
              type="file"
              accept="image/png"
              className="block w-full mt-1"
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          {product.heroImageId && (
            <Button variant="ghost" onClick={() => onChange({ heroImageId: null })}>
              {t('products.removeHeroImage', 'Remove image')}
            </Button>
          )}
        </div>
      </div>
      <Switch
        label={t('products.guidedAlbum', 'Guided album order')}
        checked={!!guided}
        onChange={(on) => onChange({ guided: on ? STARTING_POINT : undefined })}
      />
      {guided ? (
        <>
          <p className="text-sm text-muted">
            {t(
              'products.guidedHelp',
              'The client goes through album, material, colour, format and size, then picks photos. Its product type needs the four roles, colours tied to the material and sizes tied to the format. It stays hidden until you release it in the gallery.',
            )}
          </p>
          <Switch
            label={t('products.clientFinal', 'The client’s confirmation is final')}
            checked={guided.clientFinal}
            onChange={(clientFinal) => onChange({ guided: { ...guided, clientFinal } })}
          />
          <Switch
            label={t('products.requireCover', 'Require a cover photo')}
            checked={role('cover').min === 1}
            onChange={(on) => setRole('cover', { min: on ? 1 : 0, max: 1 })}
          />
          <div className="flex flex-wrap gap-4">
            {count(t('products.posterMin', 'Poster photos, at least'), poster.min, (min) =>
              setRole('poster', { min, max: Math.max(min, poster.max) }),
            )}
            {count(t('products.posterMax', 'Poster photos, at most'), poster.max, (max) =>
              setRole('poster', { max, min: Math.min(max, poster.min) }),
            )}
          </div>
        </>
      ) : null}
      {error && (
        <p role="alert" className="text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}
