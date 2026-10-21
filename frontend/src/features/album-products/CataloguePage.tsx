import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button, Card } from '../../components/common';
import { SettingsSaveBar } from '../../components/admin/SettingsSaveBar';
import { usePermissions } from '../../contexts/PermissionsContext';
import {
  albumProducts,
  errorMessage,
  type Catalogue,
  type Product,
  type Option,
} from './model';
import { ProductImage } from './ProductImage';
const newOption = (): Option => ({
  id: crypto.randomUUID(),
  name: '',
  active: false,
  imageId: null,
});
function ProductEditor({
  product,
  onChange,
  onBusy,
}: {
  product: Product;
  onChange: (update: (current: Product) => Product) => void;
  onBusy: (delta: number) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const change = (
    group: 'models' | 'colours',
    id: string,
    patch: Partial<Option>,
  ) =>
    onChange((current) => ({
      ...current,
      [group]: current[group].map((o) =>
        o.id === id ? { ...o, ...patch } : o,
      ),
    }));
  const upload = async (
    file: File | undefined,
    group: 'models' | 'colours',
    id: string,
  ) => {
    if (!file) return;
    setBusy(true);
    onBusy(1);
    setError('');
    try {
      const image = await albumProducts.upload(file);
      change(group, id, { imageId: image.id });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      onBusy(-1);
    }
  };
  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center gap-3">
        <input
          aria-label={t('albumProducts.productName', 'Product name')}
          className="input flex-1"
          maxLength={100}
          value={product.name}
          onChange={(e) =>
            onChange((current) => ({ ...current, name: e.target.value }))
          }
        />
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={product.active}
            onChange={(e) =>
              onChange((current) => ({ ...current, active: e.target.checked }))
            }
          />
          {t('albumProducts.active', 'Active')}
        </label>
        <Button variant="secondary" onClick={() => setOpen(!open)}>
          {open
            ? t('common.close', 'Close')
            : t('albumProducts.editOptions', 'Edit options')}
        </Button>
      </div>
      {open && (
        <>
          <label className="block">
            {t('common.description', 'Description')}
            <textarea
              className="input w-full"
              maxLength={1000}
              value={product.description}
              onChange={(e) =>
                onChange((current) => ({
                  ...current,
                  description: e.target.value,
                }))
              }
            />
          </label>
          {(['models', 'colours'] as const).map((group) => (
            <fieldset key={group} disabled={busy} className="space-y-3">
              <legend className="font-semibold">
                {group === 'models'
                  ? t('albumProducts.models', 'Models')
                  : t('albumProducts.colours', 'Colours')}
              </legend>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {product[group].map((option) => (
                  <div
                    className="border border-line rounded-lg p-3 space-y-3"
                    key={option.id}
                  >
                    <ProductImage imageId={option.imageId} alt={option.name} />
                    <label className="block">
                      {t('common.name', 'Name')}
                      <input
                        className="input w-full"
                        maxLength={100}
                        value={option.name}
                        onChange={(e) =>
                          change(group, option.id, { name: e.target.value })
                        }
                      />
                    </label>
                    <label className="flex gap-2">
                      <input
                        type="checkbox"
                        checked={option.active}
                        onChange={(e) =>
                          change(group, option.id, { active: e.target.checked })
                        }
                      />
                      {t('albumProducts.active', 'Active')}
                    </label>
                    <label className="block text-sm">
                      {t(
                        'albumProducts.optionImage',
                        'Option image (PNG, up to 6 MB)',
                      )}
                      <input
                        className="block max-w-full"
                        type="file"
                        accept="image/png"
                        onChange={(e) =>
                          upload(e.target.files?.[0], group, option.id)
                        }
                      />
                    </label>
                    {group === 'colours' && (
                      <fieldset>
                        <legend className="text-sm">
                          {t(
                            'albumProducts.compatibleModels',
                            'Available for models (none selected means all)',
                          )}
                        </legend>
                        {product.models.map((model) => (
                          <label key={model.id} className="flex gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={
                                option.modelIds?.includes(model.id) || false
                              }
                              onChange={(e) =>
                                change(group, option.id, {
                                  modelIds: e.target.checked
                                    ? [...(option.modelIds || []), model.id]
                                    : (option.modelIds || []).filter(
                                        (id) => id !== model.id,
                                      ),
                                })
                              }
                            />
                            {model.name ||
                              t('albumProducts.unnamed', 'Unnamed model')}
                          </label>
                        ))}
                      </fieldset>
                    )}
                    <Button
                      variant="secondary"
                      onClick={() =>
                        onChange((current) => ({
                          ...current,
                          [group]: current[group].filter(
                            (o) => o.id !== option.id,
                          ),
                          ...(group === 'models'
                            ? {
                                colours: current.colours.map((c) => ({
                                  ...c,
                                  modelIds: c.modelIds?.filter(
                                    (id) => id !== option.id,
                                  ),
                                })),
                              }
                            : {}),
                        }))
                      }
                    >
                      {t('albumProducts.removeOption', 'Remove option')}
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                variant="secondary"
                disabled={
                  product[group].length >= (group === 'models' ? 20 : 30)
                }
                onClick={() =>
                  onChange((current) => ({
                    ...current,
                    [group]: [
                      ...current[group],
                      {
                        ...newOption(),
                        ...(group === 'colours' ? { modelIds: [] } : {}),
                      },
                    ],
                  }))
                }
              >
                {group === 'models'
                  ? t('albumProducts.addModel', 'Add model')
                  : t('albumProducts.addColour', 'Add colour')}
              </Button>
            </fieldset>
          ))}
          <p className="text-sm text-muted">
            {t(
              'albumProducts.imageRights',
              'Only upload images you have permission to show to your clients. Product images are retained with previous choices.',
            )}
          </p>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
export function AlbumProductCataloguePage() {
  const { t } = useTranslation(),
    { hasPermission } = usePermissions();
  const [saved, setSaved] = useState<Catalogue | null>(null),
    [draft, setDraft] = useState<Catalogue | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [uploads, setUploads] = useState(0);
  const load = () =>
    albumProducts
      .catalogue()
      .then((data) => {
        setSaved(data);
        setDraft(data);
      })
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    let active = true;
    albumProducts
      .catalogue()
      .then((data) => {
        if (active) {
          setSaved(data);
          setDraft(data);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const save = async () => {
    if (!draft || uploads || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await albumProducts.save(draft);
      setSaved(result);
      setDraft(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!hasPermission('products.manage'))
    return (
      <p>
        {t(
          'albumProducts.manageRequired',
          'Catalogue management permission is required.',
        )}
      </p>
    );
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-body">
          {t('albumProducts.catalogue', 'Album product catalogue')}
        </h1>
        <p className="text-muted mt-2">
          {t(
            'albumProducts.catalogueIntro',
            'Maintain the models and colours your clients can choose. Assign products from a gallery’s Overview. Prices are agreed separately.',
          )}
        </p>
      </header>
      <fieldset disabled={busy} className="space-y-6">
        {draft?.products.map((product) => (
          <ProductEditor
            key={product.id}
            product={product}
            onBusy={(delta) => setUploads((count) => count + delta)}
            onChange={(update) =>
              setDraft((current) =>
                current
                  ? {
                      ...current,
                      products: current.products.map((p) =>
                        p.id === product.id ? update(p) : p,
                      ),
                    }
                  : current,
              )
            }
          />
        ))}
      </fieldset>
      {draft && (
        <Button
          variant="secondary"
          disabled={busy || uploads > 0 || draft.products.length >= 20}
          onClick={() =>
            setDraft({
              ...draft,
              products: [
                ...draft.products,
                {
                  id: crypto.randomUUID(),
                  name: '',
                  description: '',
                  active: false,
                  models: [],
                  colours: [],
                },
              ],
            })
          }
        >
          {t('albumProducts.addProduct', 'Add product')}
        </Button>
      )}
      {error && (
        <div role="alert" className="text-danger">
          {error}{' '}
          <Button
            variant="secondary"
            disabled={busy || uploads > 0}
            onClick={load}
          >
            {t('albumProducts.reload', 'Reload saved catalogue')}
          </Button>
        </div>
      )}
      <Link to="/admin/events" className="text-accent underline">
        {t('albumProducts.openGalleries', 'Open galleries')}
      </Link>
      <SettingsSaveBar
        isDirty={JSON.stringify(saved) !== JSON.stringify(draft)}
        isSaving={busy}
        onSave={save}
        onDiscard={() => {
          if (!uploads) setDraft(saved);
        }}
        canSave={!!draft && uploads === 0}
      />
    </div>
  );
}
