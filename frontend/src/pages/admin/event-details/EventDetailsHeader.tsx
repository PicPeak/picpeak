import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ExternalLink,
  Calendar,
  Archive,
  Edit2,
  Save,
  X,
  AlertTriangle,
  MessageSquare,
  Receipt,
  Type,
  Send
} from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card } from '../../../components/common';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import { eventsService } from '../../../services/events.service';
import { buildShareLinkUrl } from '../../../utils/url';
import { isGalleryPublic } from '../../../utils/accessControl';
import type { FeedbackSettings as FeedbackSettingsType } from '../../../services/feedback.service';
import { safeParseDate } from './utils';

interface EventDetailsHeaderProps {
  event: Event;
  id: string | undefined;
  isEditing: boolean;
  setIsEditing: (editing: boolean) => void;
  handleStartEdit: () => void;
  handleSaveEdit: () => void;
  isSaving: boolean;
  feedbackSettings: FeedbackSettingsType;
  setShowRenameDialog: (show: boolean) => void;
  setShowPublishDialog: (show: boolean) => void;
  isPublishing: boolean;
  onExtendExpiration: (days: number) => void;
  daysUntilExpiration: number | null;
  isExpired: boolean;
  isExpiring: boolean;
}

export const EventDetailsHeader: React.FC<EventDetailsHeaderProps> = ({
  event,
  id,
  isEditing,
  setIsEditing,
  handleStartEdit,
  handleSaveEdit,
  isSaving,
  feedbackSettings,
  setShowRenameDialog,
  setShowPublishDialog,
  isPublishing,
  onExtendExpiration,
  daysUntilExpiration,
  isExpired,
  isExpiring
}) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const { flags } = useFeatureFlags();

  return (
    <>
      {/* Page Header */}
      <div className="mb-6">
        <Button
          variant="outline"
          size="sm"
          leftIcon={<ArrowLeft className="w-4 h-4" />}
          onClick={() => navigate('/admin/events')}
          className="mb-4"
        >
          {t('events.backToEvents')}
        </Button>

        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{event.event_name}</h1>
            <div className="flex items-center gap-4 mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              {event.event_date && (
                <span className="flex items-center">
                  <Calendar className="w-4 h-4 mr-1" />
                  {format(safeParseDate(event.event_date)!, 'PPP')}
                </span>
              )}
              <span className="capitalize">{event.event_type}</span>
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                  isGalleryPublic(event.require_password)
                    ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                    : 'bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300'
                }`}
              >
                {isGalleryPublic(event.require_password) ? t('events.publicAccess', 'Public access') : t('events.passwordProtected', 'Password protected')}
              </span>
              {event.is_draft ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300">
                  {t('events.draft')}
                </span>
              ) : null}
              {event.is_archived ? (
                <span className="text-neutral-500 dark:text-neutral-400 flex items-center">
                  <Archive className="w-4 h-4 mr-1" />
                  {t('events.archived')}
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex gap-2 items-center">
            {!event.is_archived && (
              <>
                {isEditing ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      leftIcon={<X className="w-4 h-4" />}
                      onClick={() => setIsEditing(false)}
                    >
                      {t('common.cancel')}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      leftIcon={<Save className="w-4 h-4" />}
                      onClick={handleSaveEdit}
                      isLoading={isSaving}
                    >
                      {t('events.saveChanges')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      leftIcon={<Edit2 className="w-4 h-4" />}
                      onClick={handleStartEdit}
                    >
                      {t('common.edit')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      leftIcon={<Type className="w-4 h-4" />}
                      onClick={() => setShowRenameDialog(true)}
                    >
                      {t('events.rename.button', 'Rename')}
                    </Button>
                    {feedbackSettings?.feedback_enabled && (
                      <Button
                        variant="outline"
                        size="sm"
                        leftIcon={<MessageSquare className="w-4 h-4" />}
                        onClick={() => navigate(`/admin/events/${id}/feedback`)}
                      >
                        {t('feedback.manage', 'Manage Feedback')}
                      </Button>
                    )}
                    {/* Create a draft invoice for this event — pre-fills the
                        bill editor with the event snapshot + (when exactly
                        one is linked) the customer. Gated on the bills flag. */}
                    {flags.bills && (
                      <Button
                        variant="outline"
                        size="sm"
                        leftIcon={<Receipt className="w-4 h-4" />}
                        onClick={() => {
                          const accts = ((event as { customer_accounts?: Array<{ id: number }> }).customer_accounts) || [];
                          const params = new URLSearchParams({ eventId: String(event.id) });
                          if (event.event_name) params.set('eventName', event.event_name);
                          if (event.event_date) params.set('eventDate', String(event.event_date).slice(0, 10));
                          if (accts.length === 1) params.set('customerAccountId', String(accts[0].id));
                          navigate(`/admin/clients/bills/new?${params.toString()}`);
                        }}
                      >
                        {t('events.createInvoice', 'Create invoice')}
                      </Button>
                    )}
                  </>
                )}
              </>
            )}
            {event.share_link && !isEditing && (
              <a
                href={event.is_draft
                  ? `${buildShareLinkUrl(event.share_link)}${buildShareLinkUrl(event.share_link).includes('?') ? '&' : '?'}preview=${eventsService.getPreviewToken() || ''}`
                  : buildShareLinkUrl(event.share_link)
                }
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-accent hover:opacity-80 border border-accent-dark rounded-lg hover:bg-accent-dark/15 transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                {t('events.viewGallery')}
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Draft Banner */}
      {/* !! — SQLite returns integer booleans; a bare 0 would render as literal "0" */}
      {!!event.is_draft && !event.is_archived && (
        <Card className="p-4 mb-6 border-2 border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 flex-shrink-0 text-yellow-600 dark:text-yellow-400" />
            <div className="flex-1">
              <p className="font-medium text-yellow-900 dark:text-yellow-200">
                {t('events.draft')}
              </p>
              <p className="text-sm mt-1 text-yellow-700 dark:text-yellow-300">
                {t('events.draftBanner')}
              </p>
            </div>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Send className="w-4 h-4" />}
              onClick={() => setShowPublishDialog(true)}
              isLoading={isPublishing}
            >
              {t('events.publishAndNotify')}
            </Button>
          </div>
        </Card>
      )}

      {/* Expiration Warning */}
      {!event.is_archived && (isExpired || isExpiring) && (
        <Card className={`p-4 mb-6 border-2 ${isExpired ? 'border-red-500 bg-red-50' : 'border-orange-500 bg-orange-50'}`}>
          <div className="flex items-start gap-3">
            <AlertTriangle className={`w-5 h-5 flex-shrink-0 ${isExpired ? 'text-red-600' : 'text-orange-600'}`} />
            <div className="flex-1">
              <p className={`font-medium ${isExpired ? 'text-red-900' : 'text-orange-900'}`}>
                {isExpired
                  ? t('events.eventExpiredMessage')
                  : t('events.eventExpiresIn', { days: daysUntilExpiration })
                }
              </p>
              <p className={`text-sm mt-1 ${isExpired ? 'text-red-700' : 'text-orange-700'}`}>
                {isExpired
                  ? t('events.guestsCannotAccessGallery')
                  : t('events.warningEmailsHaveBeenSent')}
              </p>
            </div>
            {!isExpired && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (confirm(t('events.extendExpiration', { days: 7 }) + '?')) {
                    onExtendExpiration(7);
                  }
                }}
              >
                {t('events.extendSevenDays')}
              </Button>
            )}
          </div>
        </Card>
      )}
    </>
  );
};
