import { describe, it, expect } from 'vitest';
import { reportError, withoutQuery } from '~/lib/error-reporting';
import { ApiError } from '~/lib/api';

describe('website error reporting', () => {
  it('drops query strings and fragments from reported URLs', () => {
    expect(withoutQuery('https://pekohub.ai/device?user_code=ABCD-EFGH')).toBe('https://pekohub.ai/device');
    expect(withoutQuery('/authorize?code_challenge=x#top')).toBe('/authorize');
    expect(withoutQuery('https://pekohub.ai/@alice')).toBe('https://pekohub.ai/@alice');
  });

  it('is a no-op while reporting is off', () => {
    expect(() => reportError(new Error('boom'))).not.toThrow();
    expect(() => reportError(new ApiError(404, 'Not found'))).not.toThrow();
  });
});
