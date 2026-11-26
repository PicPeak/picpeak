import type { Brief, BriefField } from '../../../services/briefs.service';

export const field = (patch: Partial<BriefField> & Pick<BriefField, 'id' | 'label' | 'type'>): BriefField => ({
  labels: {}, visibleDefault: true, source: 'occasion', value: null, visible: null, fromProject: false, ...patch,
});

export const projectBrief = (patch: Partial<Brief> = {}): Brief => ({
  occasion: 'wedding',
  fields: [
    field({ id: 1, label: "Bride's name", labels: { de: 'Name der Braut' }, type: 'short_text', value: 'Anna' }),
    field({ id: 2, label: 'Wedding date', type: 'project_date', value: '2027-06-12', fromProject: true }),
    field({ id: 3, label: 'Bride pickup', type: 'place_time', value: { place: 'Hotel Rose', address: '', time: '09:30' } }),
    field({ id: 4, label: 'Internal remark', type: 'long_text', visibleDefault: false, source: 'global' }),
    field({ id: 9, label: "Groom's name", type: 'short_text', value: 'Ben', source: 'removed', visibleDefault: false }),
  ],
  sharedArrangements: 'Coffee at 9.',
  notifiedAt: null,
  pendingChanges: [],
  hasCustomer: true,
  ...patch,
});
