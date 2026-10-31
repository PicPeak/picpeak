/**
 * Customer detail → Contacts (migration 342).
 *
 * Further people of this customer, each with an own login and own rights. The
 * account holder is not listed as a contact: they stay the customer record
 * above and always have every right.
 *
 * Presets only fill in the rights below them; nothing remembers which one was
 * picked. The server decides what a login may do, this card just edits it.
 */
import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';

import { Button, Card, ErrorState, Input, Switch, useConfirm } from '../common';
import { useMutationWithToast } from '../../hooks';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import {
  customerAdminService,
  type ContactLevel,
  type ContactRights,
  type CustomerContact,
  type CustomerContactInput,
} from '../../services/customerAdmin.service';

const AREAS: { key: keyof ContactRights; levels: ContactLevel[]; labelKey: string; fallback: string }[] = [
  { key: 'galleries', levels: ['none', 'view', 'act'], labelKey: 'customers.contacts.area.galleries', fallback: 'Galleries' },
  { key: 'quotes', levels: ['none', 'view', 'act'], labelKey: 'customers.contacts.area.quotes', fallback: 'Quotes' },
  { key: 'contracts', levels: ['none', 'view', 'act'], labelKey: 'customers.contacts.area.contracts', fallback: 'Contracts' },
  { key: 'bills', levels: ['none', 'view'], labelKey: 'customers.contacts.area.bills', fallback: 'Invoices' },
  { key: 'documents', levels: ['none', 'view', 'act'], labelKey: 'customers.contacts.area.documents', fallback: 'Documents' },
  { key: 'company', levels: ['none', 'act'], labelKey: 'customers.contacts.area.company', fallback: 'Company data' },
];

const NO_RIGHTS: ContactRights = {
  galleries: 'none', quotes: 'none', contracts: 'none', bills: 'none', documents: 'none', company: 'none',
};

const PRESETS: { key: string; labelKey: string; fallback: string; rights: ContactRights }[] = [
  {
    key: 'admin',
    labelKey: 'customers.contacts.preset.admin',
    fallback: 'Admin',
    rights: { galleries: 'act', quotes: 'act', contracts: 'act', bills: 'view', documents: 'act', company: 'act' },
  },
  {
    key: 'accounting',
    labelKey: 'customers.contacts.preset.accounting',
    fallback: 'Accounting',
    rights: { ...NO_RIGHTS, quotes: 'view', contracts: 'view', bills: 'view', documents: 'act', company: 'act' },
  },
  {
    key: 'marketing',
    labelKey: 'customers.contacts.preset.marketing',
    fallback: 'Marketing',
    rights: { ...NO_RIGHTS, galleries: 'view', documents: 'act' },
  },
  {
    key: 'viewer',
    labelKey: 'customers.contacts.preset.viewer',
    fallback: 'Viewer',
    rights: { ...NO_RIGHTS, galleries: 'view', documents: 'view' },
  },
];

interface DraftContact {
  email: string;
  first_name: string;
  last_name: string;
  receivesMail: boolean;
  rights: ContactRights;
}

const emptyDraft = (): DraftContact => ({
  email: '', first_name: '', last_name: '', receivesMail: true, rights: { ...NO_RIGHTS },
});

const toDraft = (contact: CustomerContact): DraftContact => ({
  email: contact.email,
  first_name: contact.firstName || '',
  last_name: contact.lastName || '',
  receivesMail: contact.receivesMail,
  rights: contact.rights,
});

const RightsEditor: React.FC<{
  draft: DraftContact;
  onChange: (next: DraftContact) => void;
}> = ({ draft, onChange }) => {
  const { t } = useTranslation();
  const levelLabel: Record<ContactLevel, string> = {
    none: t('customers.contacts.level.none', 'No access'),
    view: t('customers.contacts.level.view', 'View'),
    act: t('customers.contacts.level.act', 'View and act'),
  };
  const companyLabel = t('customers.contacts.level.edit', 'Edit');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <Button
            key={preset.key}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange({ ...draft, rights: preset.rights })}
          >
            {t(preset.labelKey, preset.fallback)}
          </Button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {AREAS.map((area) => (
          <label key={area.key} className="text-sm text-body">
            <span className="mb-1 block font-medium">{t(area.labelKey, area.fallback)}</span>
            <select
              className="input w-full"
              value={draft.rights[area.key]}
              onChange={(e) => onChange({
                ...draft,
                rights: { ...draft.rights, [area.key]: e.target.value as ContactLevel },
              })}
            >
              {area.levels.map((level) => (
                <option key={level} value={level}>
                  {area.key === 'company' && level === 'act' ? companyLabel : levelLabel[level]}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted">
        {t('customers.contacts.rightsHint', 'A right cannot go beyond what is switched on for this customer under Customer features.')}
        {' '}
        {t('customers.contacts.signerHint', 'Contacts sign a contract only when they are named as a signer on it.')}
      </p>
      <Switch
        checked={draft.receivesMail}
        onChange={(receivesMail) => onChange({ ...draft, receivesMail })}
        label={t('customers.contacts.receivesMail', 'Send a copy of gallery notices and invoices')}
        description={t('customers.contacts.receivesMailHint', 'Only for areas this contact has a right to. The customer keeps getting their own mail.')}
      />
    </div>
  );
};

const contactName = (contact: CustomerContact) => (
  [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.displayName || contact.email
);

interface CustomerContactsCardProps {
  customerId: number;
  /** A passive customer has no portal yet, so its contacts cannot have logins. */
  isPassive: boolean;
  /** Off, no login is handed out, but existing contacts stay manageable. */
  portalEnabled: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export const CustomerContactsCard: React.FC<CustomerContactsCardProps> = ({
  customerId, isPassive, portalEnabled, canCreate, canEdit, canDelete,
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { format: fmtDate } = useLocalizedDate();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<DraftContact>(emptyDraft());

  const queryKey = ['admin-customer-contacts', customerId];
  const { data: contacts, isError, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: () => customerAdminService.listContacts(customerId),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const closeForm = () => { setAdding(false); setEditingId(null); setDraft(emptyDraft()); };
  // The contact being edited can be removed by someone else; the form and its
  // Cancel go with its row, so nothing else could get the card back.
  const editedGone = editingId !== null && !!contacts && !contacts.some((c) => c.id === editingId);
  useEffect(() => {
    if (editedGone) closeForm();
  }, [editedGone]);

  const payload = (): CustomerContactInput => ({
    email: draft.email.trim(),
    first_name: draft.first_name,
    last_name: draft.last_name,
    receivesMail: draft.receivesMail,
    rights: draft.rights,
  });

  const create = useMutationWithToast({
    mutationFn: (invite: boolean) => customerAdminService.createContact(customerId, { ...payload(), invite }),
    successMessage: t('customers.contacts.created', 'Contact added'),
    onSuccess: () => { closeForm(); refresh(); },
  });
  const update = useMutationWithToast({
    mutationFn: () => customerAdminService.updateContact(customerId, editingId as number, payload()),
    successMessage: t('customers.contacts.saved', 'Contact saved'),
    onSuccess: () => { closeForm(); refresh(); },
  });
  const setActive = useMutationWithToast({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) => (
      customerAdminService.updateContact(customerId, id, { isActive })
    ),
    successMessage: t('customers.contacts.saved', 'Contact saved'),
    onSuccess: refresh,
  });
  const remove = useMutationWithToast({
    mutationFn: (id: number) => customerAdminService.deleteContact(customerId, id),
    successMessage: t('customers.contacts.deleted', 'Contact removed'),
    onSuccess: refresh,
  });
  const invite = useMutationWithToast({
    mutationFn: (id: number) => customerAdminService.sendContactInvite(customerId, id),
    successMessage: t('customers.contacts.invited', 'Invitation sent'),
    onSuccess: refresh,
  });
  const reset = useMutationWithToast({
    mutationFn: (id: number) => customerAdminService.sendContactPasswordReset(customerId, id),
    successMessage: t('customers.contacts.resetSent', 'Password reset link sent'),
  });

  const confirmRemove = async (contact: CustomerContact) => {
    const message = t('customers.contacts.deleteConfirm', 'Remove {{name}}? Their login stops working right away.', {
      name: contactName(contact),
    });
    if (await confirm({ message, variant: 'danger', confirmLabel: t('customers.contacts.delete', 'Remove') })) {
      remove.mutate(contact.id);
    }
  };

  const status = (contact: CustomerContact) => {
    if (!contact.isActive) return t('customers.contacts.status.inactive', 'Inactive');
    if (contact.hasLogin) {
      return contact.lastLogin
        ? t('customers.contacts.status.lastLogin', 'Last login {{date}}', { date: fmtDate(contact.lastLogin) })
        : t('customers.contacts.status.login', 'Has a login');
    }
    return contact.invitationPending
      ? t('customers.contacts.status.invited', 'Invited')
      : t('customers.contacts.status.noLogin', 'No login');
  };

  const mayInvite = portalEnabled && !isPassive;
  if (!portalEnabled && (contacts || []).length === 0) return null;

  const form = (
    <div className="space-y-3 rounded-lg border border-line p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Input
          label={t('customers.contacts.email', 'Email')}
          type="email"
          value={draft.email}
          onChange={(e) => setDraft({ ...draft, email: e.target.value })}
        />
        <Input
          label={t('customers.contacts.firstName', 'First name')}
          value={draft.first_name}
          onChange={(e) => setDraft({ ...draft, first_name: e.target.value })}
        />
        <Input
          label={t('customers.contacts.lastName', 'Last name')}
          value={draft.last_name}
          onChange={(e) => setDraft({ ...draft, last_name: e.target.value })}
        />
      </div>
      <RightsEditor draft={draft} onChange={setDraft} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={closeForm}>
          {t('common.cancel', 'Cancel')}
        </Button>
        {editingId !== null ? (
          <Button type="button" size="sm" isLoading={update.isPending} onClick={() => update.mutate()}>
            {t('common.save', 'Save')}
          </Button>
        ) : (
          <>
            <Button type="button" variant="outline" size="sm" isLoading={create.isPending} onClick={() => create.mutate(false)}>
              {t('customers.contacts.saveOnly', 'Save without login')}
            </Button>
            {mayInvite && (
              <Button type="button" size="sm" isLoading={create.isPending} onClick={() => create.mutate(true)}>
                {t('customers.contacts.saveInvite', 'Save and invite')}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <Card padding="lg">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-heading">
          <Users className="h-5 w-5" /> {t('customers.contacts.title', 'Contacts')}
        </h2>
        {canCreate && portalEnabled && !adding && editingId === null && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            {t('customers.contacts.add', 'Add contact')}
          </Button>
        )}
      </div>

      {isPassive && (
        <p className="mb-3 text-sm text-muted">
          {t('customers.contacts.passiveHint', 'Invite this customer to the portal first. Until then, contacts cannot get a login.')}
        </p>
      )}

      {isError && !contacts ? (
        <ErrorState size="inline" onRetry={() => refetch()} retrying={isFetching} />
      ) : (
        <div className="space-y-3">
          {adding && form}
          {(contacts || []).length === 0 && !adding && !isPassive && (
            <p className="text-sm text-muted">
              {t('customers.contacts.empty', 'Only the account holder has access. Add people who need their own login.')}
            </p>
          )}
          {(contacts || []).map((contact) => (editingId === contact.id ? (
            <div key={contact.id}>{form}</div>
          ) : (
            <div
              key={contact.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-3"
            >
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-body">{contactName(contact)}</p>
                <p className="break-words text-xs text-muted">{contact.email} · {status(contact)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {canEdit && !adding && editingId === null && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setEditingId(contact.id); setDraft(toDraft(contact)); }}
                  >
                    {t('common.edit', 'Edit')}
                  </Button>
                )}
                {canCreate && !contact.hasLogin && contact.isActive && mayInvite && (
                  <Button variant="outline" size="sm" isLoading={invite.isPending && invite.variables === contact.id} disabled={invite.isPending} onClick={() => invite.mutate(contact.id)}>
                    {contact.invitationPending
                      ? t('customers.contacts.reinvite', 'Send invitation again')
                      : t('customers.contacts.invite', 'Invite')}
                  </Button>
                )}
                {canCreate && contact.hasLogin && contact.isActive && mayInvite && (
                  <Button variant="outline" size="sm" isLoading={reset.isPending && reset.variables === contact.id} disabled={reset.isPending} onClick={() => reset.mutate(contact.id)}>
                    {t('customers.contacts.resetPassword', 'Reset password')}
                  </Button>
                )}
                {canEdit && (
                  <Button
                    variant="outline"
                    size="sm"
                    isLoading={setActive.isPending && setActive.variables?.id === contact.id}
                    onClick={() => setActive.mutate({ id: contact.id, isActive: !contact.isActive })}
                  >
                    {contact.isActive
                      ? t('customers.contacts.deactivate', 'Deactivate')
                      : t('customers.contacts.reactivate', 'Reactivate')}
                  </Button>
                )}
                {canDelete && (
                  <Button variant="outline" size="sm" onClick={() => { void confirmRemove(contact); }}>
                    {t('customers.contacts.delete', 'Remove')}
                  </Button>
                )}
              </div>
            </div>
          )))}
        </div>
      )}
    </Card>
  );
};
