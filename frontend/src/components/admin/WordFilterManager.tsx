import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { 
  Plus, 
  Trash2, 
  Shield, 
  AlertTriangle, 
  XCircle,
  Edit2,
  Save,
  X,
  Search
} from 'lucide-react';
import { toast } from 'react-toastify';
import { Card, Button, Input, Loading, useConfirm, Badge, EmptyState, ErrorState, type BadgeTone } from '../common';
import { feedbackService } from '../../services/feedback.service';
import { useMutationWithToast } from '../../hooks';

interface WordFilter {
  id: number;
  word: string;
  severity: 'low' | 'moderate' | 'high' | 'block';
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export const WordFilterManager: React.FC = () => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  
  const [newWord, setNewWord] = useState('');
  const [newSeverity, setNewSeverity] = useState<'low' | 'moderate' | 'high' | 'block'>('moderate');
  const [searchTerm, setSearchTerm] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editWord, setEditWord] = useState('');
  const [editSeverity, setEditSeverity] = useState<'low' | 'moderate' | 'high' | 'block'>('moderate');

  // Fetch word filters
  const { data: filtersData, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['word-filters'],
    queryFn: () => feedbackService.getWordFilters()
  });
  const filters = filtersData ?? [];

  // Add word filter mutation
  const addMutation = useMutation({
    mutationFn: (data: { word: string; severity: string }) => 
      feedbackService.addWordFilter(data.word, data.severity),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['word-filters'] });
      toast.success(t('settings.moderation.filterAdded', 'Word filter added successfully'));
      setNewWord('');
      setNewSeverity('moderate');
    },
    onError: (error: any) => {
      if (error.response?.status === 409) {
        toast.error(t('settings.moderation.filterExists', 'This word filter already exists'));
      } else {
        toast.error(t('settings.moderation.addError', 'Failed to add word filter'));
      }
    }
  });

  // Update word filter mutation
  const updateMutation = useMutationWithToast({
    mutationFn: ({ id, updates }: { id: number; updates: Partial<WordFilter> }) =>
      feedbackService.updateWordFilter(id, updates),
    invalidateKeys: [['word-filters']],
    successMessage: t('settings.moderation.filterUpdated', 'Word filter updated successfully'),
    onSuccess: () => {
      setEditingId(null);
    },
    errorMessage: () => t('settings.moderation.updateError', 'Failed to update word filter')
  });

  // Delete word filter mutation
  const deleteMutation = useMutationWithToast({
    mutationFn: (id: number) => feedbackService.deleteWordFilter(id),
    invalidateKeys: [['word-filters']],
    successMessage: t('settings.moderation.filterDeleted', 'Word filter deleted successfully'),
    errorMessage: () => t('settings.moderation.deleteError', 'Failed to delete word filter')
  });

  const handleAdd = () => {
    if (!newWord.trim()) {
      toast.error(t('settings.moderation.wordRequired', 'Please enter a word to filter'));
      return;
    }
    addMutation.mutate({ word: newWord.trim(), severity: newSeverity });
  };

  const handleEdit = (filter: WordFilter) => {
    setEditingId(filter.id);
    setEditWord(filter.word);
    setEditSeverity(filter.severity);
  };

  const handleSaveEdit = () => {
    if (!editWord.trim()) {
      toast.error(t('settings.moderation.wordRequired', 'Please enter a word to filter'));
      return;
    }
    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        updates: { word: editWord.trim(), severity: editSeverity }
      });
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditWord('');
    setEditSeverity('moderate');
  };

  const handleToggleActive = (filter: WordFilter) => {
    updateMutation.mutate({
      id: filter.id,
      updates: { is_active: !filter.is_active }
    });
  };

  const handleDelete = async (id: number) => {
    const ok = await confirm({
      message: t('settings.moderation.confirmDelete', 'Delete this word filter? Comments are no longer checked against it. This cannot be undone.'),
      variant: 'danger',
      confirmLabel: t('settings.moderation.deleteAction', 'Delete filter'),
    });
    if (ok) deleteMutation.mutate(id);
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'low':
        return <Shield className="w-4 h-4 text-info" />;
      case 'moderate':
        return <AlertTriangle className="w-4 h-4 text-warning" />;
      case 'high':
        return <XCircle className="w-4 h-4 text-danger" />;
      case 'block':
        return <XCircle className="w-4 h-4 text-danger-text" />;
      default:
        return <Shield className="w-4 h-4 text-muted" />;
    }
  };

  const getSeverityTone = (severity: string): BadgeTone => {
    switch (severity) {
      case 'low':
        return 'info';
      case 'moderate':
        return 'warning';
      case 'high':
        return 'danger';
      case 'block':
        return 'danger';
      default:
        return 'neutral';
    }
  };

  const filteredFilters = filters.filter((filter: WordFilter) =>
    filter.word.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (isLoading) {
    return (
      <Card>
        <div className="p-6">
          <Loading text={t('settings.moderation.loading', 'Loading word filters...')} />
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <div className="p-6">
          {/* No title here — this component IS the Settings → Moderation
              tab, and the Settings shell already renders that section
              heading (icon + label + divider). A second H2 stacked
              directly under it (QA warning). */}
          <div className="mb-6">
            <p className="text-sm text-soft">
              {t('settings.moderation.description', 'Manage words that should be filtered or blocked in comments')}
            </p>
          </div>

          {/* Add new filter */}
          <div className="mb-6 p-4 bg-subtle rounded-lg">
            <h3 className="text-sm font-medium text-heading mb-3">
              {t('settings.moderation.addFilter', 'Add New Filter')}
            </h3>
            <div className="flex gap-3">
              <Input
                type="text"
                value={newWord}
                onChange={(e) => setNewWord(e.target.value)}
                placeholder={t('settings.moderation.enterWord', 'Enter word to filter')}
                className="flex-1"
                onKeyPress={(e) => e.key === 'Enter' && handleAdd()}
              />
              <select
                value={newSeverity}
                onChange={(e) => setNewSeverity(e.target.value as any)}
                className="px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="low">{t('settings.moderation.severityLow', 'Low')}</option>
                <option value="moderate">{t('settings.moderation.severityModerate', 'Moderate')}</option>
                <option value="high">{t('settings.moderation.severityHigh', 'High')}</option>
                <option value="block">{t('settings.moderation.severityBlock', 'Block')}</option>
              </select>
              <Button
                variant="primary"
                leftIcon={<Plus className="w-4 h-4" />}
                onClick={handleAdd}
                isLoading={addMutation.isPending}
              >
                {t('common.add', 'Add')}
              </Button>
            </div>
          </div>

          {/* Search */}
          <div className="mb-4">
            <Input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={t('settings.moderation.searchFilters', 'Search filters...')}
              leftIcon={<Search className="w-5 h-5 text-faint" />}
            />
          </div>

          {/* Filters list */}
          <div className="space-y-2">
            {isError && !filtersData ? (
              <ErrorState
                title={t('settings.moderation.loadFailed', 'Could not load the word filters')}
                onRetry={() => refetch()}
                retrying={isFetching}
                size="inline"
              />
            ) : filteredFilters.length === 0 ? (
              <EmptyState
                title={searchTerm ?
                  t('settings.moderation.noMatchingFilters', 'No matching filters found') :
                  t('settings.moderation.noFilters', 'No word filters configured yet')
                }
                size="inline"
              />
            ) : (
              filteredFilters.map((filter: WordFilter) => (
                <div
                  key={filter.id}
                  className={`flex items-center justify-between p-3 rounded-lg border ${
                    filter.is_active ? 'border-line bg-panel' : 'border-line bg-shell opacity-60'
                  }`}
                >
                  {editingId === filter.id ? (
                    <>
                      <div className="flex items-center gap-3 flex-1">
                        <Input
                          type="text"
                          value={editWord}
                          onChange={(e) => setEditWord(e.target.value)}
                          className="flex-1 max-w-xs"
                        />
                        <select
                          value={editSeverity}
                          onChange={(e) => setEditSeverity(e.target.value as any)}
                          className="px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading focus:outline-none focus:ring-2 focus:ring-accent"
                        >
                          <option value="low">{t('settings.moderation.severityLow', 'Low')}</option>
                          <option value="moderate">{t('settings.moderation.severityModerate', 'Moderate')}</option>
                          <option value="high">{t('settings.moderation.severityHigh', 'High')}</option>
                          <option value="block">{t('settings.moderation.severityBlock', 'Block')}</option>
                        </select>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          leftIcon={<Save className="w-4 h-4" />}
                          onClick={handleSaveEdit}
                          isLoading={updateMutation.isPending}
                        >
                          {t('common.save', 'Save')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          leftIcon={<X className="w-4 h-4" />}
                          onClick={handleCancelEdit}
                        >
                          {t('common.cancel', 'Cancel')}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={filter.is_active}
                          onChange={() => handleToggleActive(filter)}
                          className="w-4 h-4 text-accent rounded focus:ring-accent"
                        />
                        <span className="font-medium text-heading">{filter.word}</span>
                        <Badge tone={getSeverityTone(filter.severity)} icon={getSeverityIcon(filter.severity)}>
                          {filter.severity}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          leftIcon={<Edit2 className="w-4 h-4" />}
                          onClick={() => handleEdit(filter)}
                        >
                          {t('common.edit', 'Edit')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          leftIcon={<Trash2 className="w-4 h-4" />}
                          onClick={() => handleDelete(filter.id)}
                          isLoading={deleteMutation.isPending}
                          className="text-danger-text hover:bg-danger-soft"
                        >
                          {t('common.delete', 'Delete')}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </Card>

      {/* Severity explanation */}
      <Card>
        <div className="p-6">
          <h3 className="text-sm font-semibold text-heading mb-3">
            {t('settings.moderation.severityLevels', 'Severity Levels')}
          </h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-start gap-3">
              {getSeverityIcon('low')}
              <div>
                <span className="font-medium text-heading">{t('settings.moderation.severityLow', 'Low')}: </span>
                <span className="text-soft">
                  {t('settings.moderation.lowDescription', 'Word is flagged for review but not automatically blocked')}
                </span>
              </div>
            </div>
            <div className="flex items-start gap-3">
              {getSeverityIcon('moderate')}
              <div>
                <span className="font-medium text-heading">{t('settings.moderation.severityModerate', 'Moderate')}: </span>
                <span className="text-soft">
                  {t('settings.moderation.moderateDescription', 'Comment requires manual approval before being visible')}
                </span>
              </div>
            </div>
            <div className="flex items-start gap-3">
              {getSeverityIcon('high')}
              <div>
                <span className="font-medium text-heading">{t('settings.moderation.severityHigh', 'High')}: </span>
                <span className="text-soft">
                  {t('settings.moderation.highDescription', 'Comment is automatically hidden and requires admin review')}
                </span>
              </div>
            </div>
            <div className="flex items-start gap-3">
              {getSeverityIcon('block')}
              <div>
                <span className="font-medium text-heading">{t('settings.moderation.severityBlock', 'Block')}: </span>
                <span className="text-soft">
                  {t('settings.moderation.blockDescription', 'Comment is rejected immediately and cannot be submitted')}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </>
  );
};