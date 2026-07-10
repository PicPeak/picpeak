import { describe, expect, it } from 'vitest';
import { parseFeedbackLimitError } from '../useFeedbackLimitModal';

/**
 * Tests for the error parser that decides when to surface the per-guest
 * limit modal (#655). Hook integration is exercised via the gallery UI;
 * here we pin the contract that drives `handleError`.
 */

describe('parseFeedbackLimitError', () => {
  it('returns null for non-axios errors', () => {
    expect(parseFeedbackLimitError(new Error('boom'))).toBeNull();
    expect(parseFeedbackLimitError(null)).toBeNull();
    expect(parseFeedbackLimitError(undefined)).toBeNull();
    expect(parseFeedbackLimitError({})).toBeNull();
  });

  it('returns null for non-403 axios errors', () => {
    const err = { response: { status: 500, data: { code: 'FAVORITE_LIMIT_REACHED' } } };
    expect(parseFeedbackLimitError(err)).toBeNull();
  });

  it('returns null for 403s without the expected code', () => {
    const err = { response: { status: 403, data: { error: 'Forbidden' } } };
    expect(parseFeedbackLimitError(err)).toBeNull();
    const err2 = { response: { status: 403, data: { code: 'OTHER_FORBIDDEN' } } };
    expect(parseFeedbackLimitError(err2)).toBeNull();
  });

  it('parses FAVORITE_LIMIT_REACHED', () => {
    const err = {
      response: {
        status: 403,
        data: {
          code: 'FAVORITE_LIMIT_REACHED',
          limit: 10,
          current_count: 10,
          feedback_type: 'favorite',
        },
      },
    };
    expect(parseFeedbackLimitError(err)).toEqual({
      feedbackType: 'favorite',
      limit: 10,
      currentCount: 10,
    });
  });

  it('parses LIKE_LIMIT_REACHED', () => {
    const err = {
      response: {
        status: 403,
        data: {
          code: 'LIKE_LIMIT_REACHED',
          limit: 5,
          current_count: 5,
          feedback_type: 'like',
        },
      },
    };
    expect(parseFeedbackLimitError(err)).toEqual({
      feedbackType: 'like',
      limit: 5,
      currentCount: 5,
    });
  });

  it('falls back to the code-implied type when feedback_type is missing', () => {
    const err = {
      response: {
        status: 403,
        data: { code: 'FAVORITE_LIMIT_REACHED', limit: 3, current_count: 3 },
      },
    };
    expect(parseFeedbackLimitError(err)?.feedbackType).toBe('favorite');
  });

  it('treats missing numeric fields as 0 rather than NaN', () => {
    const err = { response: { status: 403, data: { code: 'FAVORITE_LIMIT_REACHED' } } };
    expect(parseFeedbackLimitError(err)).toEqual({
      feedbackType: 'favorite',
      limit: 0,
      currentCount: 0,
    });
  });
});
