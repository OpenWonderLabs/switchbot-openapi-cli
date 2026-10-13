import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatError } from '../lib/error-messages.js';


describe('formatError', () => {

  it('throws for unknown key', () => {
    assert.throws(() => formatError('no-such-key'), Error);
  });
});
