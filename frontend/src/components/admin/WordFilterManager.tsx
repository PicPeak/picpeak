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
import { Card, Button, Input, Loading } from '../common';
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
  const queryClient = useQueryClient();
  
  const [newWord, setNewWord] = useState('');
  const [newSeverity, setNewSeverity] = useState<'low' | 'moderate' | 'high' | 'block'>('moderate');
  const [searchTerm, setSearchTerm] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editWord, setEditWord] = useState('');
  const [editSeverity, setEditSeverity] = useState<'low' | 'moderate' | 'high' | 'block'>('moderate');

  // Fetch word filters
  const { data: filters = [], isLoading } = useQuery({
    queryKey: ['word-filters'],
    queryFn: () => feedbackService.getWordFilters()
  });

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

  const handleDelete = (id: number) => {
    if (confirm(t('settings.moderation.confirmDelete', 'Are you sure you want to delete this word filter?'))) {
      deleteMutation.mutate(id);
    }
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'low':
        return <Shield className="w-4 h-4 text-blue-500" />;
      case 'moderate':
        return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
      case 'high':
        return <XCircle className="w-4 h-4 text-orange-500" />;
      case 'block':
        return <XCircle className="w-4 h-4 text-red-600" />;
      default:
        return <Shield className="w-4 h-4 text-gray-500" />;
    }
  };

  const getSeverityBadgeClass = (severity: string) => {
    switch (severity) {
      case 'low':
        return 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300';
      case 'moderate':
        return 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-800 dark:text-yellow-300';
      case 'high':
        return 'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-300';
      case 'block':
        return 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300';
      default:
        return 'bg-neutral-100 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-300';
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
          <div className="mb-6">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
              {t('settings.moderation.wordFilters', 'Word Filters')}
            </h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {t('settings.moderation.description', 'Manage words that should be filtered or blocked in comments')}
            </p>
          </div>

          {/* Add new filter */}
          <div className="mb-6 p-4 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
            <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100 dark:text-neutral-100 mb-3">
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
                className="px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
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
              leftIcon={<Search className="w-5 h-5 text-neutral-400" />}
            />
          </div>

          {/* Filters list */}
          <div className="space-y-2">
            {filteredFilters.length === 0 ? (
              <div className="text-center py-8 text-neutral-500 dark:text-neutral-400">
                {searchTerm ? 
                  t('settings.moderation.noMatchingFilters', 'No matching filters found') : 
                  t('settings.moderation.noFilters', 'No word filters configured yet')
                }
              </div>
            ) : (
              filteredFilters.map((filter: WordFilter) => (
                <div
                  key={filter.id}
                  className={`flex items-center justify-between p-3 rounded-lg border ${
                    filter.is_active ? 'border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800' : 'border-neutral-100 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 opacity-60'
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
                          className="px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
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
                          className="w-4 h-4 text-accent rounded focus:ring-primary-500"
                        />
                        <span className="font-medium text-neutral-900 dark:text-neutral-100">{filter.word}</span>
                        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${getSeverityBadgeClass(filter.severity)}`}>
                          {getSeverityIcon(filter.severity)}
                          {filter.severity}
                        </span>
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
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
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
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">
            {t('settings.moderation.severityLevels', 'Severity Levels')}
          </h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-start gap-3">
              {getSeverityIcon('low')}
              <div>
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{t('settings.moderation.severityLow', 'Low')}: </span>
                <span className="text-neutral-600 dark:text-neutral-400">
                  {t('settings.moderation.lowDescription', 'Word is flagged for review but not automatically blocked')}
                </span>
              </div>
            </div>
            <div className="flex items-start gap-3">
              {getSeverityIcon('moderate')}
              <div>
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{t('settings.moderation.severityModerate', 'Moderate')}: </span>
                <span className="text-neutral-600 dark:text-neutral-400">
                  {t('settings.moderation.moderateDescription', 'Comment requires manual approval before being visible')}
                </span>
              </div>
            </div>
            <div className="flex items-start gap-3">
              {getSeverityIcon('high')}
              <div>
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{t('settings.moderation.severityHigh', 'High')}: </span>
                <span className="text-neutral-600 dark:text-neutral-400">
                  {t('settings.moderation.highDescription', 'Comment is automatically hidden and requires admin review')}
                </span>
              </div>
            </div>
            <div className="flex items-start gap-3">
              {getSeverityIcon('block')}
              <div>
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{t('settings.moderation.severityBlock', 'Block')}: </span>
                <span className="text-neutral-600 dark:text-neutral-400">
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