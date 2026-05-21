import { describe, it, expect } from 'vitest';
import * as utils from '../../src/auth/utils.js';

describe('auth/utils public surface', () => {
  it('does not export getFreePort (dead code removed)', () => {
    expect((utils as Record<string, unknown>)['getFreePort']).toBeUndefined();
  });

  it('exports SECURITY_HEADERS with expected keys', () => {
    expect(utils.SECURITY_HEADERS).toHaveProperty('X-Content-Type-Options');
    expect(utils.SECURITY_HEADERS).toHaveProperty('X-Frame-Options');
  });

  it('exports escapeHtml that escapes < > & " \'', () => {
    expect(utils.escapeHtml('<script>&"\'</script>')).toBe(
      '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;',
    );
  });
});
