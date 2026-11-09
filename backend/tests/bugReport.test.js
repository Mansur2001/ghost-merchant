// Bug reports (adapted from the team bug tracker): same fields, same limits, same states, and
// each error names its field so the form can show it inline.
import { describe, test, expect } from '@jest/globals';
import { validateBug, validateTriage, BugError, LIMITS } from '../src/domain/bugReport.js';
import { TEXT } from '../src/domain/push.js';

const err = (fn) => { try { fn(); } catch (e) { return e; } return null; };

describe('validateBug', () => {
  test('title and description required; steps and email optional', () => {
    const ok = validateBug({ title: '  Map is blank ', description: 'No streets on the ride map' });
    expect(ok).toMatchObject({ title: 'Map is blank', repro_steps: null, reporter_email: null, app: 'customer' });
    expect(err(() => validateBug({ description: 'x' })).field).toBe('title');
    expect(err(() => validateBug({ title: 'x' })).field).toBe('description');
  });

  test('the tracker\'s limits: 200 / 5000 / 5000', () => {
    expect(LIMITS).toEqual({ title: 200, description: 5000, reproSteps: 5000 });
    expect(err(() => validateBug({ title: 'x'.repeat(201), description: 'd' })).field).toBe('title');
    expect(err(() => validateBug({ title: 't', description: 'd'.repeat(5001) })).field).toBe('description');
    expect(err(() => validateBug({ title: 't', description: 'd', reproSteps: 's'.repeat(5001) })).field).toBe('reproSteps');
  });

  test('email checked and normalised when given', () => {
    expect(err(() => validateBug({ title: 't', description: 'd', reporterEmail: 'not-an-email' })).field).toBe('reporterEmail');
    expect(validateBug({ title: 't', description: 'd', reporterEmail: ' QA@Example.com ' }).reporter_email).toBe('qa@example.com');
  });

  test('context is clipped and whitelisted; nothing else from the body is kept', () => {
    const b = validateBug({ title: 't', description: 'd', app: 'admin', lang: 'xx', page: 'p'.repeat(100), user_id: 99, status: 'closed' });
    expect(b.app).toBe('customer');
    expect(b.lang).toBeNull();
    expect(b.page).toHaveLength(60);
    expect(b).not.toHaveProperty('user_id');
    expect(b).not.toHaveProperty('status');
  });
});

describe('validateTriage', () => {
  test('the tracker\'s states only', () => {
    expect(validateTriage({ status: 'in_progress' })).toEqual({ status: 'in_progress' });
    expect(err(() => validateTriage({ status: 'done' }))).toBeInstanceOf(BugError);
    expect(err(() => validateTriage({}))).toBeInstanceOf(BugError);
    expect(validateTriage({ note: '  checked on Android 7 ' })).toEqual({ triage_note: 'checked on Android 7' });
  });

  test('the desk notification exists in both languages', () => {
    expect(TEXT.en.op_bug && TEXT.so.op_bug).toBeTruthy();
  });
});
