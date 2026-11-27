/**
 * A link can open Settings › Email on one template (issue 2618: the website's
 * contact settings link their two mails): ?template=<key> opens the
 * Templates tab with that template; anything else opens as before.
 */
import { describe, expect, it } from 'vitest';
import { initialEmailView } from '../EmailConfigPage';

describe('initialEmailView', () => {
  it('opens the named template', () => {
    expect(initialEmailView(new URLSearchParams('tab=email&template=website_contact_admin'))).toEqual({ tab: 'templates', templateKey: 'website_contact_admin' });
  });
  it('opens as before without one, or with a name that is no template key', () => {
    expect(initialEmailView(new URLSearchParams('tab=email'))).toEqual({ tab: 'smtp', templateKey: 'gallery_created' });
    expect(initialEmailView(new URLSearchParams('template=../x'))).toEqual({ tab: 'smtp', templateKey: 'gallery_created' });
  });
});
