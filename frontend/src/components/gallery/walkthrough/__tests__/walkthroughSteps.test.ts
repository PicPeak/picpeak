import { describe, expect, it } from 'vitest';
import { buildWalkthroughSteps, layoutFeedbackActions, MAX_WALKTHROUGH_STEPS, type WalkthroughFeatures } from '../walkthroughSteps';

const none: WalkthroughFeatures = {
  scope: 'guest', hasCategories: false, likes: false, favorites: false, downloads: false,
  people: false, selfie: false, uploads: false,
};
const all: WalkthroughFeatures = {
  scope: 'guest', hasCategories: true, likes: true, favorites: true, downloads: true,
  people: true, selfie: true, uploads: true,
};
const ids = (f: Partial<WalkthroughFeatures>) => buildWalkthroughSteps({ ...none, ...f }).map((s) => s.id);

describe('buildWalkthroughSteps (issue 2551)', () => {
  it('gives a bare gallery the welcome and the help step only', () => {
    expect(ids({})).toEqual(['browse', 'help']);
  });

  it('has no download step while downloads are off', () => {
    expect(ids({ downloads: false, likes: true })).not.toContain('download');
    expect(ids({ downloads: true })).toEqual(['browse', 'download', 'help']);
  });

  it('adds the hide step for the client link only', () => {
    const features = { downloads: true, likes: true };
    expect(ids({ ...features, scope: 'client' })).toEqual(['browse', 'favorites', 'download', 'hide', 'help']);
    expect(ids({ ...features, scope: 'guest' })).toEqual(['browse', 'favorites', 'download', 'help']);
    // A portal customer gets the client tour without hiding.
    expect(ids({ ...features, scope: 'customer' })).toEqual(['browse', 'favorites', 'download', 'help']);
  });

  it('caps at five steps, keeping the most asked-about ones in display order', () => {
    const guest = buildWalkthroughSteps(all);
    expect(guest).toHaveLength(MAX_WALKTHROUGH_STEPS);
    expect(guest.map((s) => s.id)).toEqual(['browse', 'favorites', 'download', 'faces', 'upload']);

    const client = buildWalkthroughSteps({ ...all, scope: 'client' });
    expect(client.map((s) => s.id)).toEqual(['browse', 'favorites', 'download', 'faces', 'hide']);
  });

  it('picks the text variant from the features', () => {
    const byId = (f: Partial<WalkthroughFeatures>) =>
      Object.fromEntries(buildWalkthroughSteps({ ...none, ...f }).map((s) => [s.id, s]));
    expect(byId({ hasCategories: true }).browse.bodyKey).toMatch(/bodyCategories$/);
    expect(byId({ hasCategories: true }).browse.anchors).toEqual(['[data-tour="categories"]']);
    expect(byId({}).browse.anchors).toEqual([]);
    expect(byId({ likes: true }).favorites.bodyKey).toMatch(/bodyLikes$/);
    expect(byId({ favorites: true }).favorites.bodyKey).toMatch(/bodyFavorites$/);
    expect(byId({ likes: true, favorites: true }).favorites.bodyKey).toMatch(/bodyBoth$/);
    expect(byId({ people: true }).faces.bodyKey).toMatch(/faces\.body$/);
    expect(byId({ people: true, selfie: true }).faces.bodyKey).toMatch(/bodySelfie$/);
    expect(byId({ downloads: true }).download.anchors[0]).toBe('[data-tour="download-all"]');
  });

  it('knows Premium has likes but no favourites, every other layout both', () => {
    expect(layoutFeedbackActions('gallery-premium')).toEqual({ likes: true, favorites: false });
    for (const layout of ['grid', 'masonry', 'mosaic', 'timeline', 'carousel', 'gallery-story', 'gallery-folio', undefined]) {
      expect(layoutFeedbackActions(layout)).toEqual({ likes: true, favorites: true });
    }
  });
});
