import assert from 'node:assert/strict';
import test from 'node:test';
import { describeTransportError } from './errors.js';

test('the cause under "fetch failed" is kept, with its code', () => {
  const socket = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  const err = new TypeError('fetch failed', { cause: socket });

  assert.equal(
    describeTransportError(err),
    'fetch failed; caused by: other side closed (UND_ERR_SOCKET)',
  );
});

test('a code already in the message is not repeated', () => {
  const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  const err = new TypeError('fetch failed', { cause: reset });

  assert.equal(describeTransportError(err), 'fetch failed; caused by: read ECONNRESET');
});

test('every address of an AggregateError is named', () => {
  const v6 = Object.assign(new Error('connect ECONNREFUSED ::1:443'), { code: 'ECONNREFUSED' });
  const v4 = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
  const aggregate = Object.assign(new AggregateError([v6, v4], ''), { code: 'ECONNREFUSED' });
  const err = new TypeError('fetch failed', { cause: aggregate });

  assert.equal(
    describeTransportError(err),
    'fetch failed; caused by: ECONNREFUSED: connect ECONNREFUSED ::1:443 | connect ECONNREFUSED 127.0.0.1:443',
  );
});

test('an error without a cause is its message', () => {
  assert.equal(describeTransportError(new Error('fetch failed')), 'fetch failed');
});

test('a non-Error is stringified', () => {
  assert.equal(describeTransportError('boom'), 'boom');
});

test('a cause cycle ends', () => {
  const a = new Error('a');
  const b = new Error('b', { cause: a });
  (a as { cause?: unknown }).cause = b;

  assert.equal(describeTransportError(a), 'a; caused by: b');
});
