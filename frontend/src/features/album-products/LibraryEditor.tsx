import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Input, Switch } from '../../components/common';
import { DecimalInput } from '../../components/common/DecimalInput';
import {
  albumProducts,
  errorMessage,
  type Catalogue,
  type LibraryGroup,
  type ProductType,
  type Attribute,
} from './model';
import { ProductImage } from './ProductImage';
type Update = (updater: (current: Catalogue) => Catalogue) => void;
export function LibraryEditor({
  catalogue,
  update,
  onBusy,
}: {
  catalogue: Catalogue;
  update: Update;
  onBusy: (delta: number) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const library = catalogue.library || [],
    types = catalogue.types || [];
  const groupChange = (id: string, fn: (g: LibraryGroup) => LibraryGroup) =>
    update((c) => ({
      ...c,
      library: (c.library || []).map((g) => (g.id === id ? fn(g) : g)),
    }));
  const typeChange = (id: string, fn: (p: ProductType) => ProductType) =>
    update((c) => ({
      ...c,
      types: (c.types || []).map((p) => (p.id === id ? fn(p) : p)),
    }));
  const attributeChange = (
    typeId: string,
    id: string,
    patch: Partial<Attribute>,
  ) =>
    typeChange(typeId, (p) => ({
      ...p,
      attributes: p.attributes.map((a) =>
        a.id === id ? { ...a, ...patch } : a,
      ),
    }));
  const upload = async (groupId: string, optionId: string, file?: File) => {
    if (!file) return;
    onBusy(1);
    setError('');
    try {
      const image = await albumProducts.upload(file);
      groupChange(groupId, (g) => ({
        ...g,
        options: g.options.map((o) =>
          o.id === optionId ? { ...o, imageId: image.id } : o,
        ),
      }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      onBusy(-1);
    }
  };
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">
        {t('products.optionLibrary', 'Shared option library')}
      </h2>
      <p className="text-sm text-muted">
        {t(
          'products.libraryHelp',
          'Maintain values and images once. Product types reuse them. Deactivate an option to stop offering it; saved agreements keep their copy.',
        )}
      </p>
      {library.map((group) => (
        <Card key={group.id} className="p-4 space-y-3">
          <details>
            <summary className="cursor-pointer font-semibold">
              {group.name}
            </summary>
            <div className="space-y-3 mt-3">
              <Input
                label={t('products.libraryName', 'Library name')}
                value={group.name}
                onChange={(e) =>
                  groupChange(group.id, (g) => ({ ...g, name: e.target.value }))
                }
              />
              {group.options.map((option) => (
                <div
                  key={option.id}
                  className="border border-line rounded-lg p-3 space-y-3"
                >
                  <Input
                    label={t('products.optionName', 'Option name')}
                    value={option.name}
                    onChange={(e) =>
                      groupChange(group.id, (g) => ({
                        ...g,
                        options: g.options.map((o) =>
                          o.id === option.id
                            ? { ...o, name: e.target.value }
                            : o,
                        ),
                      }))
                    }
                  />
                  <Switch
                    label={t('albumProducts.active', 'Active')}
                    checked={option.active}
                    onChange={(active) =>
                      groupChange(group.id, (g) => ({
                        ...g,
                        options: g.options.map((o) =>
                          o.id === option.id ? { ...o, active } : o,
                        ),
                      }))
                    }
                  />
                  {group.kind === 'size' && (
                    <div className="grid grid-cols-3 gap-3">
                      <label htmlFor={`product-width-${option.id}`}>
                        {t('products.width', 'Width')}
                        <DecimalInput
                          id={`product-width-${option.id}`}
                          aria-label={t('products.width', 'Width')}
                          value={option.width || 0}
                          onChange={(width) =>
                            groupChange(group.id, (g) => ({
                              ...g,
                              options: g.options.map((o) =>
                                o.id === option.id ? { ...o, width } : o,
                              ),
                            }))
                          }
                        />
                      </label>
                      <label htmlFor={`product-height-${option.id}`}>
                        {t('products.height', 'Height')}
                        <DecimalInput
                          id={`product-height-${option.id}`}
                          aria-label={t('products.height', 'Height')}
                          value={option.height || 0}
                          onChange={(height) =>
                            groupChange(group.id, (g) => ({
                              ...g,
                              options: g.options.map((o) =>
                                o.id === option.id ? { ...o, height } : o,
                              ),
                            }))
                          }
                        />
                      </label>
                      <label className="text-sm">
                        {t('products.unit', 'Unit')}
                        <select
                          className="input"
                          value={option.unit || 'cm'}
                          onChange={(e) =>
                            groupChange(group.id, (g) => ({
                              ...g,
                              options: g.options.map((o) =>
                                o.id === option.id
                                  ? { ...o, unit: e.target.value as 'cm' }
                                  : o,
                              ),
                            }))
                          }
                        >
                          {['mm', 'cm', 'in'].map((u) => (
                            <option key={u}>{u}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  {option.imageId && (
                    <div className="w-24">
                      <ProductImage
                        imageId={option.imageId}
                        alt={option.name}
                      />
                    </div>
                  )}
                  <label className="block text-sm">
                    {t('albumProducts.optionImage', 'Option image (PNG)')}
                    <input
                      type="file"
                      accept="image/png"
                      className="block w-full mt-1"
                      onChange={(e) => {
                        void upload(group.id, option.id, e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
              ))}
              <Button
                variant="ghost"
                disabled={group.options.length >= 100}
                onClick={() =>
                  groupChange(group.id, (g) => ({
                    ...g,
                    options: [
                      ...g.options,
                      {
                        id: crypto.randomUUID(),
                        name: t('products.newOption', 'New option'),
                        active: true,
                        imageId: null,
                        ...(g.kind === 'size'
                          ? { width: 20, height: 30, unit: 'cm' as const }
                          : {}),
                      },
                    ],
                  }))
                }
              >
                {t('products.addOption', 'Add option')}
              </Button>
            </div>
          </details>
        </Card>
      ))}
      <div className="flex gap-3 flex-wrap">
        {(['choice', 'size', 'colour'] as const).map((kind) => (
          <Button
            key={kind}
            variant="secondary"
            disabled={library.length >= 50}
            onClick={() =>
              update((c) => ({
                ...c,
                library: [
                  ...(c.library || []),
                  {
                    id: crypto.randomUUID(),
                    name: t(`products.newLibrary.${kind}`, kind),
                    kind,
                    options: [],
                  },
                ],
              }))
            }
          >
            {t(`products.addLibrary.${kind}`, `Add ${kind} library`)}
          </Button>
        ))}
      </div>
      <h2 className="text-lg font-semibold">
        {t('products.types', 'Product types')}
      </h2>
      {types.map((type) => (
        <Card key={type.id} className="p-4 space-y-4">
          <Input
            label={t('products.typeName', 'Product type name')}
            value={type.name}
            onChange={(e) =>
              typeChange(type.id, (p) => ({ ...p, name: e.target.value }))
            }
          />
          <Switch
            label={t('albumProducts.active', 'Active')}
            checked={type.active}
            onChange={(active) =>
              typeChange(type.id, (p) => ({ ...p, active }))
            }
          />
          {type.attributes.map((a) => (
            <div
              key={a.id}
              className="p-3 border border-line rounded-lg space-y-3"
            >
              <Input
                label={t('products.attributeName', 'Attribute name')}
                value={a.name}
                onChange={(e) =>
                  attributeChange(type.id, a.id, { name: e.target.value })
                }
              />
              <p className="text-sm text-muted">
                {library.find((g) => g.id === a.groupId)?.name}
              </p>
              <div className="flex gap-4 flex-wrap">
                {(['required', 'multiple', 'addOn'] as const).map((key) => (
                  <Switch
                    key={key}
                    label={t(`products.${key}`, key)}
                    checked={a[key]}
                    onChange={(value) =>
                      attributeChange(type.id, a.id, { [key]: value })
                    }
                  />
                ))}
              </div>
              <fieldset>
                <legend className="text-sm">
                  {t('products.allowedOptions', 'Allowed options')}
                </legend>
                <div className="flex gap-3 flex-wrap">
                  {library
                    .find((g) => g.id === a.groupId)
                    ?.options.map((o) => (
                      <label key={o.id} className="flex gap-2">
                        <input
                          type="checkbox"
                          checked={a.optionIds.includes(o.id)}
                          onChange={(e) =>
                            attributeChange(type.id, a.id, {
                              optionIds: e.target.checked
                                ? [...a.optionIds, o.id]
                                : a.optionIds.filter((id) => id !== o.id),
                            })
                          }
                        />
                        {o.name}
                      </label>
                    ))}
                </div>
              </fieldset>
              {a.dependsOn.map((d, index) => (
                <div key={index} className="space-y-2">
                  <p className="text-sm">
                    {t('products.dependsOn', 'Only available with')}{' '}
                    {type.attributes.find((p) => p.id === d.attributeId)?.name}
                  </p>
                  <div className="flex gap-3 flex-wrap">
                    {library
                      .find(
                        (g) =>
                          g.id ===
                          type.attributes.find((p) => p.id === d.attributeId)
                            ?.groupId,
                      )
                      ?.options.filter((o) =>
                        type.attributes
                          .find((p) => p.id === d.attributeId)
                          ?.optionIds.includes(o.id),
                      )
                      .map((o) => (
                        <label key={o.id}>
                          <input
                            type="checkbox"
                            checked={d.optionIds.includes(o.id)}
                            onChange={(e) =>
                              attributeChange(type.id, a.id, {
                                dependsOn: a.dependsOn.map((dep, i) =>
                                  i === index
                                    ? {
                                        ...dep,
                                        optionIds: e.target.checked
                                          ? [...dep.optionIds, o.id]
                                          : dep.optionIds.filter(
                                              (id) => id !== o.id,
                                            ),
                                      }
                                    : dep,
                                ),
                              })
                            }
                          />{' '}
                          {o.name}
                        </label>
                      ))}
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      attributeChange(type.id, a.id, {
                        dependsOn: a.dependsOn.filter((_, i) => i !== index),
                      })
                    }
                  >
                    {t('products.removeDependency', 'Remove dependency')}
                  </Button>
                </div>
              ))}
              <label className="block text-sm">
                {t('products.addDependency', 'Add dependency')}
                <select
                  className="input"
                  value=""
                  disabled={a.dependsOn.length > 0}
                  onChange={(e) => {
                    const parent = type.attributes.find(
                      (p) => p.id === e.target.value,
                    );
                    if (parent)
                      attributeChange(type.id, a.id, {
                        dependsOn: [
                          ...a.dependsOn,
                          {
                            attributeId: parent.id,
                            optionIds: [...parent.optionIds],
                          },
                        ],
                      });
                  }}
                >
                  <option value="">
                    {t('products.chooseAttribute', 'Choose attribute')}
                  </option>
                  {type.attributes
                    .filter(
                      (p) =>
                        p.id !== a.id &&
                        !a.dependsOn.some((d) => d.attributeId === p.id),
                    )
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              <Button
                variant="ghost"
                onClick={() =>
                  typeChange(type.id, (p) => ({
                    ...p,
                    attributes: p.attributes.filter((attr) => attr.id !== a.id),
                  }))
                }
              >
                {t('products.removeAttribute', 'Remove attribute')}
              </Button>
            </div>
          ))}
          <label className="block text-sm">
            {t('products.addAttribute', 'Add attribute from library')}
            <select
              className="input"
              value=""
              onChange={(e) => {
                const group = library.find((g) => g.id === e.target.value);
                if (group)
                  typeChange(type.id, (p) => ({
                    ...p,
                    attributes: [
                      ...p.attributes,
                      {
                        id: crypto.randomUUID(),
                        name: group.name,
                        groupId: group.id,
                        optionIds: group.options.map((o) => o.id),
                        options: [],
                        required: true,
                        multiple: false,
                        addOn: false,
                        dependsOn: [],
                      },
                    ],
                  }));
              }}
            >
              <option value="">
                {t('products.chooseLibrary', 'Choose library')}
              </option>
              {library
                .filter((g) => g.options.length)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </select>
          </label>
        </Card>
      ))}
      <Button
        variant="secondary"
        disabled={types.length >= 30}
        onClick={() =>
          update((c) => ({
            ...c,
            types: [
              ...(c.types || []),
              {
                id: crypto.randomUUID(),
                name: t('products.newType', 'New product type'),
                active: true,
                attributes: [],
              },
            ],
          }))
        }
      >
        {t('products.addType', 'Add product type')}
      </Button>
      {error && (
        <p role="alert" className="text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}
