/**
 * Selfie search dialog (issue 2355): nothing is sent until a selfie is chosen
 * and the consent box ticked; matches go to the gallery and close the
 * dialog; no match and server refusals keep it open with a message.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchBySelfie = vi.fn();
let rejectWith: { code?: string } | null = null;
vi.mock('../../../services/gallery.service', () => ({
  galleryService: {
    searchBySelfie: (...args: unknown[]) => {
      if (rejectWith) return Promise.reject(Object.assign(new Error('refused'), { response: { data: rejectWith } }));
      return searchBySelfie(...args);
    },
  },
}));

import { SelfieSearchDialog } from '../SelfieSearchDialog';

const selfie = new File([new Uint8Array([1, 2, 3])], 'me.jpg', { type: 'image/jpeg' });

function setup() {
  const onResult = vi.fn();
  const onClose = vi.fn();
  render(<SelfieSearchDialog open slug="party" onClose={onClose} onResult={onResult} />);
  const submit = screen.getByRole('button', { name: /Find my photos/ });
  const choose = () => fireEvent.change(screen.getByLabelText('Your selfie'), { target: { files: [selfie] } });
  const agree = () => fireEvent.click(screen.getByRole('checkbox'));
  return { onResult, onClose, submit, choose, agree };
}

describe('SelfieSearchDialog', () => {
  beforeEach(() => { searchBySelfie.mockReset(); rejectWith = null; });

  it('says the selfie is not kept before anything is uploaded', () => {
    setup();
    expect(screen.getByText(/deleted right away\. Nothing is saved\./)).toBeInTheDocument();
  });

  it('sits above the Premium/Story control band and Story nav', () => {
    setup();
    expect(screen.getByRole('dialog').parentElement).toHaveClass('z-[70]');
  });

  it('needs a selfie and consent before it searches', () => {
    const { submit, choose, agree } = setup();
    expect(submit).toBeDisabled();
    choose();
    expect(submit).toBeDisabled();
    agree();
    expect(submit).toBeEnabled();
    agree();
    expect(submit).toBeDisabled();
    expect(searchBySelfie).not.toHaveBeenCalled();
  });

  it('hands the matches to the gallery and closes', async () => {
    searchBySelfie.mockResolvedValue([4, 2]);
    const { submit, choose, agree, onResult, onClose } = setup();
    choose();
    agree();
    fireEvent.click(submit);
    await waitFor(() => expect(onResult).toHaveBeenCalledWith([4, 2]));
    expect(searchBySelfie).toHaveBeenCalledWith('party', selfie, true);
    expect(onClose).toHaveBeenCalled();
  });

  it('stays open when nothing matched', async () => {
    searchBySelfie.mockResolvedValue([]);
    const { submit, choose, agree, onResult, onClose } = setup();
    choose();
    agree();
    fireEvent.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent('We found no photos of you');
    expect(onResult).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    ['SELFIE_NO_FACE', 'No face was found'],
    ['SELFIE_SEARCH_RATE_LIMITED', 'Too many searches'],
    ['SELFIE_SEARCH_UNAVAILABLE', 'not available right now'],
    [undefined, 'The search failed'],
  ])('explains a refusal with code %s', async (code, text) => {
    rejectWith = { code };
    const { submit, choose, agree } = setup();
    choose();
    agree();
    fireEvent.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });
});
