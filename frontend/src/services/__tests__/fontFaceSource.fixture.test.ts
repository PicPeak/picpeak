/**
 * A font file's @font-face source is built on the server (the website's
 * pages, renderer.js) and here (the admin and the galleries). Both are held
 * to one list of cases, so they cannot drift apart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fontFaceSource, type FontDefinition } from '../fonts.service';

interface Case { name: string; family: string; weight: number; formats?: FontDefinition['formats']; versions?: FontDefinition['versions']; src: string }
const cases: Case[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../backend/__tests__/fixtures/fontFaceSources.json'), 'utf8'));

describe('fontFaceSource', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(fontFaceSource(c.family, c.weight, c.formats, c.versions)).toBe(c.src);
  });
});
