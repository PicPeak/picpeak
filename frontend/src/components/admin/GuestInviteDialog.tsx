import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Copy, Check, Trash2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button, Input, Loading } from '../common';
import { guestsService, GuestInvite } from '../../services/guests.service';
import { useMutationWithToast } from '../../hooks';

interface GuestInviteDialogProps {
  eventId: number;
  eventName?: string;
  onClose: () => void;
}

/**
 * Admin dialog to create pre-minted invite tokens and list existing ones.
 * Each invite generates a unique URL that the admin can send to a specific
 * guest. Opening the URL auto-registers that guest (single use).
 */
export const GuestInviteDialog: React.FC<GuestInviteDialogProps> = ({ eventId, onClose }) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-guest-invites', eventId],
    queryFn: () => guestsService.listInvites(eventId),
  });

  const createMutation = useMutationWithToast({
    mutationFn: () => guestsService.createInvite(eventId, { name, email: email || undefined }),
    successMessage: t('admin.guests.inviteCreated', 'Invite created'),
    invalidateKeys: [['admin-guest-invites', eventId], ['admin-guests', eventId]],
    onSuccess: () => {
      setName('');
      setEmail('');
    },
    errorMessage: () => t('admin.guests.inviteCreateError', 'Failed to create invite'),
  });

  const revokeMutation = useMutationWithToast({
    mutationFn: (inviteId: number) => guestsService.revokeInvite(eventId, inviteId),
    successMessage: t('admin.guests.inviteRevoked', 'Invite revoked'),
    invalidateKeys: [['admin-guest-invites', eventId]],
    errorMessage: () => t('admin.guests.inviteRevokeError', 'Failed to revoke invite'),
  });

  const copy = (invite: GuestInvite) => {
    navigator.clipboard.writeText(invite.url).then(() => {
      setCopiedId(invite.id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  };

  const invites = data?.invites || [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-16">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white dark:bg-neutral-900 rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-4 border-b border-neutral-200 dark:border-neutral-700 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            {t('admin.guests.invitesTitle', 'Guest invites')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-4">
          {/* Create form */}
          <div className="p-4 bg-neutral-50 dark:bg-neutral-800 rounded">
            <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-3">
              {t('admin.guests.createInvite', 'Create invite')}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
              <Input
                label={t('admin.guests.inviteName', 'Guest name')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Alice"
                required
              />
              <Input
                type="email"
                label={t('admin.guests.inviteEmail', 'Email (optional)')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="alice@example.com"
              />
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => createMutation.mutate()}
              disabled={!name.trim() || createMutation.isPending}
            >
              {createMutation.isPending
                ? t('common.submitting', 'Submitting...')
                : t('admin.guests.generateInvite', 'Generate invite link')}
            </Button>
          </div>

          {/* Existing invites */}
          <div>
            <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-2">
              {t('admin.guests.existingInvites', 'Existing invites')}
            </h3>
            {isLoading ? (
              <Loading size="sm" />
            ) : invites.length === 0 ? (
              <div className="text-sm text-neutral-500 dark:text-neutral-400 text-center py-4">
                {t('admin.guests.noInvites', 'No invites yet')}
              </div>
            ) : (
              <div className="space-y-2">
                {invites.map((invite) => (
                  <div
                    key={invite.id}
                    className="p-3 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm text-neutral-900 dark:text-neutral-100">
                          {invite.guest.name}
                          {invite.guest.email && (
                            <span className="text-neutral-500 dark:text-neutral-400 font-normal ml-2">
                              · {invite.guest.email}
                            </span>
                          )}
                        </div>
                        <div className="text-xs mt-1">
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full font-medium ${
                              invite.status === 'redeemed'
                                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                                : invite.status === 'revoked'
                                ? 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300'
                                : 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                            }`}
                          >
                            {t(`admin.guests.inviteStatus.${invite.status}`, invite.status)}
                          </span>
                        </div>
                        <div className="text-xs text-neutral-500 dark:text-neutral-400 truncate mt-1 font-mono">
                          {invite.url}
                        </div>
                      </div>
                      <div className="flex gap-1">
                        {invite.status === 'pending' && (
                          <>
                            <button
                              type="button"
                              onClick={() => copy(invite)}
                              className="p-1.5 text-neutral-500 hover:text-accent"
                              title={t('admin.guests.copyLink', 'Copy link')}
                            >
                              {copiedId === invite.id ? (
                                <Check className="w-4 h-4 text-green-600" />
                              ) : (
                                <Copy className="w-4 h-4" />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => revokeMutation.mutate(invite.id)}
                              className="p-1.5 text-neutral-500 hover:text-red-600"
                              title={t('admin.guests.revokeInvite', 'Revoke')}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
