import { describe, it, expect } from 'vitest';
import { detectPlatform } from '~/lib/links';

describe('detectPlatform', () => {
  it('reads the desktop platforms and skips phones', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('macos');
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBeNull();
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 14)')).toBeNull();
    expect(detectPlatform('')).toBeNull();
  });
});
