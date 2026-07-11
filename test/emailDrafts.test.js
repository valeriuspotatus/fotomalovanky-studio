import { test } from 'node:test';
import assert from 'node:assert/strict';
import { czPhotos, pickEmailCase, renderEmail } from '../src/emailDrafts.js';

// ---- Czech count agreement --------------------------------------------------

test('czPhotos agrees with the number', () => {
  assert.equal(czPhotos(1), 'fotka');
  assert.equal(czPhotos(3), 'fotky');
  assert.equal(czPhotos(4), 'fotky');
  assert.equal(czPhotos(8), 'fotek');
  assert.equal(czPhotos(12), 'fotek'); // teen exception, not "fotky"
});

// ---- case selection ---------------------------------------------------------

const hold = (reason) => ({ verdict: 'hold', reason });

test('missing photos wins over every other hold', () => {
  const c = pickEmailCase([hold('duplicate-identical'), hold('missing-photos'), hold('unreadable')]);
  assert.equal(c, 'missing');
});

test('each hold maps to its case', () => {
  assert.equal(pickEmailCase([hold('unreadable')]), 'unreadable');
  assert.equal(pickEmailCase([hold('duplicate-identical')]), 'duplicate');
  assert.equal(pickEmailCase([hold('low-resolution')]), 'quality');
});

test('no hold means no email', () => {
  assert.equal(pickEmailCase([{ verdict: 'warn', reason: 'blurry' }]), null);
  assert.equal(pickEmailCase([]), null);
});

// ---- rendering --------------------------------------------------------------

test('the missing-photos draft carries the counts and the reply instruction', () => {
  const mail = renderEmail('missing', { order: '1523', expected: 8, uploaded: 5, missing: 3 });
  assert.match(mail.subject, /1523/);
  assert.match(mail.body, /8 fotek/);
  assert.match(mail.body, /sešlo 5/);
  assert.match(mail.body, /odpovědí na tento e-mail s fotkou v příloze/);
  assert.match(mail.body, /David\nFotomalovánky\.cz$/);
});

test('a known surname makes the greeting formal; an unknown one stays neutral', () => {
  assert.match(renderEmail('missing', { order: '1', surname: 'Hofbauer' }).body, /^Dobrý den, paní\/pane Hofbauer,/);
  assert.match(renderEmail('missing', { order: '1' }).body, /^Dobrý den,/);
});

test('drafts obey the no-em-dash style rule', () => {
  for (const c of ['missing', 'unreadable', 'duplicate', 'quality']) {
    assert.doesNotMatch(renderEmail(c, { order: '1', expected: 8, uploaded: 5, missing: 3 }).body, /—/);
  }
});

test('the recipient is filled from the order when known', () => {
  assert.equal(renderEmail('missing', { order: '1', email: 'a@b.cz' }).to, 'a@b.cz');
  assert.equal(renderEmail('missing', { order: '1' }).to, '');
});

test('an unknown case renders nothing rather than a broken email', () => {
  assert.equal(renderEmail('nope', { order: '1' }), null);
});
