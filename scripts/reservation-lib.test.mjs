import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays,
  buildMessage,
  buildEmail,
  buildPaymentDescription,
  computeSendOn,
  daysBetween,
  formatAmountFR,
  formatDateFR,
  isUsableEmail,
  isZeroAmount,
  normalizePhone,
  parseAmountEUR,
  parseFrenchDate,
  planReservation,
  splitName,
} from './reservation-lib.mjs';

// --- dates ----------------------------------------------------------------

test('parses eviivo French dates', () => {
  assert.equal(parseFrenchDate('ven. 14 août 2026'), '2026-08-14');
  assert.equal(parseFrenchDate('sam. 01 août 2026'), '2026-08-01');
  assert.equal(parseFrenchDate('ven. 31 juil. 2026'), '2026-07-31');
  assert.equal(parseFrenchDate('lun. 05 oct. 2026'), '2026-10-05');
  assert.equal(parseFrenchDate('mer. 12 août 2026 (17:30 - 20:30)'), '2026-08-12');
  assert.equal(parseFrenchDate('jeu. 04 févr. 2027'), '2027-02-04');
  assert.equal(parseFrenchDate('01 janv. 2027'), '2027-01-01');
  assert.equal(parseFrenchDate('14/08/2026'), '2026-08-14');
  assert.equal(parseFrenchDate('2026-08-14'), '2026-08-14');
});

test('refuses to guess an unreadable or impossible date', () => {
  assert.throws(() => parseFrenchDate('bientôt'), /unparseable/);
  assert.throws(() => parseFrenchDate(''), /unparseable/);
  assert.throws(() => parseFrenchDate('32 août 2026'), /impossible|unparseable/);
  assert.throws(() => parseFrenchDate('14 foo 2026'), /unknown French month/);
});

test('date arithmetic crosses months and years', () => {
  assert.equal(addDays('2026-08-01', -7), '2026-07-25');
  assert.equal(addDays('2027-01-03', -7), '2026-12-27');
  assert.equal(daysBetween('2026-08-14', '2026-08-15'), 1);
  assert.equal(daysBetween('2026-08-14', '2026-08-14'), 0);
  assert.equal(formatDateFR('2026-08-14'), '14/08/2026');
});

// --- the 7-day rule -------------------------------------------------------

test('sends 7 days before arrival when there is time', () => {
  // Booking example: SOPHIE MICHELI arrives 14/08, booked 24/07.
  assert.equal(computeSendOn('2026-08-14', '2026-07-24'), '2026-08-07');
});

test('sends immediately when arrival is inside the 7-day window', () => {
  // Expedia example: Jean-Sebastien Hall booked 21/07 for arrival 24/07.
  assert.equal(computeSendOn('2026-07-24', '2026-07-21'), '2026-07-21');
  // Exactly 7 days out is still "today", so the guest is never contacted late.
  assert.equal(computeSendOn('2026-07-28', '2026-07-21'), '2026-07-21');
  assert.equal(computeSendOn('2026-07-29', '2026-07-21'), '2026-07-22');
});

test('an arrival already in the past is handled today, not skipped', () => {
  assert.equal(computeSendOn('2026-07-01', '2026-07-24'), '2026-07-24');
});

// --- phones ---------------------------------------------------------------

test('normalizes real guest numbers from the mailbox', () => {
  assert.deepEqual(normalizePhone('+33662242979'), { phone: '+33662242979', valid: true, reason: null });
  assert.deepEqual(normalizePhone('+41795161696'), { phone: '+41795161696', valid: true, reason: null });
  assert.deepEqual(normalizePhone('+352691730330'), { phone: '+352691730330', valid: true, reason: null });
  assert.deepEqual(normalizePhone('+447790977652'), { phone: '+447790977652', valid: true, reason: null });
  assert.deepEqual(normalizePhone('+491707345680'), { phone: '+491707345680', valid: true, reason: null });
  assert.deepEqual(normalizePhone('+393345451295'), { phone: '+393345451295', valid: true, reason: null });
});

test('accepts French national format and tidy separators', () => {
  assert.equal(normalizePhone('0662242979').phone, '+33662242979');
  assert.equal(normalizePhone('06 62 24 29 79').phone, '+33662242979');
  assert.equal(normalizePhone('+33 6 62 24 29 79').phone, '+33662242979');
  assert.equal(normalizePhone('0033662242979').phone, '+33662242979');
});

test('rejects the placeholder numbers the channels inject', () => {
  // Expedia sends this for every guest — texting it would burn money silently.
  const expedia = normalizePhone('+11111111111');
  assert.equal(expedia.valid, false);
  assert.equal(expedia.reason, 'placeholder-phone');

  assert.equal(normalizePhone('+00000000000').valid, false);
  assert.equal(normalizePhone('').valid, false);
  assert.equal(normalizePhone('123').valid, false);
  assert.equal(normalizePhone('n/a').valid, false);
});

test('rejects French landlines, which cannot receive an SMS', () => {
  const landline = normalizePhone('+33470123456');
  assert.equal(landline.valid, false);
  assert.equal(landline.reason, 'landline-not-sms-capable');
  assert.equal(normalizePhone('+3366224297').valid, false); // too short for FR
});

test('refuses to guess a country code', () => {
  assert.equal(normalizePhone('662242979').reason, 'ambiguous-phone');
});

test('recognises usable guest emails including Booking relays', () => {
  assert.ok(isUsableEmail('smiche.810905@guest.booking.com'));
  assert.ok(isUsableEmail('marc.oberson@gmail.com'));
  assert.ok(isUsableEmail('jean.sebastien.hall@gmail.com'));
  assert.equal(isUsableEmail('not-an-email'), false);
  assert.equal(isUsableEmail(''), false);
  assert.equal(isUsableEmail(null), false);
});

// --- names and amounts ----------------------------------------------------

test('splits names and prefers the Réf: last name', () => {
  assert.deepEqual(splitName('SOPHIE MICHELI', 'MICHELI'), {
    fullName: 'SOPHIE MICHELI', firstName: 'Sophie', lastName: 'MICHELI',
  });
  assert.deepEqual(splitName('Marc Oberson'), {
    fullName: 'Marc Oberson', firstName: 'Marc', lastName: 'OBERSON',
  });
  assert.deepEqual(splitName('Catherine di Michele'), {
    fullName: 'Catherine di Michele', firstName: 'Catherine', lastName: 'DI MICHELE',
  });
  assert.equal(splitName('Marie-Alice BOSTEL').firstName, 'Marie-Alice');
  assert.equal(splitName('Jean-Sebastien Hall').lastName, 'HALL');
});

test('parses the "A collecter" amounts from the three platforms', () => {
  assert.equal(parseAmountEUR('€1,22'), '1.22');       // Booking
  assert.equal(parseAmountEUR('€226,82'), '226.82');   // My Web
  assert.equal(parseAmountEUR('€219,62'), '219.62');   // Expedia
  assert.equal(parseAmountEUR('€0,00'), '0.00');
  assert.equal(parseAmountEUR('132.85'), '132.85');
  assert.equal(parseAmountEUR('€1 234,50'.replace(' ', '')), '1234.50');
  assert.equal(parseAmountEUR('€5'), '5.00');
  assert.equal(parseAmountEUR('€5,4'), '5.40');
});

test('refuses to guess an amount', () => {
  assert.throws(() => parseAmountEUR(''), /missing amount/);
  assert.throws(() => parseAmountEUR('à définir'), /unparseable/);
  assert.throws(() => parseAmountEUR(null), /missing amount/);
});

test('zero means nothing to collect', () => {
  assert.ok(isZeroAmount('0.00'));
  assert.equal(isZeroAmount('1.22'), false);
  assert.equal(formatAmountFR('219.62'), '219,62');
});

// --- payment link description --------------------------------------------

test('builds the SumUp description in the owner\'s format', () => {
  assert.equal(
    buildPaymentDescription({ arrivalDate: '2026-08-14', lastName: 'MICHELI' }),
    'Chateau de Charmeil - 14/08/2026 - MICHELI',
  );
});

test('strips accents from the description', () => {
  assert.equal(
    buildPaymentDescription({ arrivalDate: '2026-08-01', lastName: 'Lemière' }),
    'Chateau de Charmeil - 01/08/2026 - LEMIERE',
  );
});

// --- scheduling decisions -------------------------------------------------

const base = {
  firstName: 'Sophie',
  amountEUR: '1.22',
  arrivalDate: '2026-08-14',
  sendOn: '2026-08-07',
  nights: 1,
  paymentLinkUrl: 'https://pay.sumup.com/abc',
  status: 'scheduled',
  reminders: [],
  lastReminderOn: null,
  linkSentOn: null,
};

test('waits until the send date, then sends', () => {
  assert.deepEqual(planReservation(base, '2026-08-06'), { action: 'wait', until: '2026-08-07' });
  assert.deepEqual(planReservation(base, '2026-08-07'), { action: 'send-link' });
  assert.deepEqual(planReservation(base, '2026-08-09'), { action: 'send-link' });
});

test('reminds daily while unpaid, but never twice in a day', () => {
  const sent = { ...base, status: 'link_sent', linkSentOn: '2026-08-07' };
  // No reminder on the day the link went out — that would be two texts at once.
  assert.deepEqual(planReservation(sent, '2026-08-07'), { action: 'none', reason: 'link-sent-today' });
  assert.deepEqual(planReservation(sent, '2026-08-08'), { action: 'remind' });

  const reminded = { ...sent, lastReminderOn: '2026-08-08' };
  assert.deepEqual(planReservation(reminded, '2026-08-08'), { action: 'none', reason: 'reminded-today' });
  assert.deepEqual(planReservation(reminded, '2026-08-09'), { action: 'remind' });
});

test('stops reminding after arrival', () => {
  const sent = { ...base, status: 'link_sent', linkSentOn: '2026-08-07' };
  assert.deepEqual(planReservation(sent, '2026-08-14'), { action: 'remind' });
  assert.deepEqual(planReservation(sent, '2026-08-15'), { action: 'none', reason: 'arrival-passed' });
});

test('leaves paid, zero-amount and flagged reservations alone', () => {
  assert.equal(planReservation({ ...base, status: 'paid_confirmed' }, '2026-08-09').action, 'none');
  assert.equal(planReservation({ ...base, status: 'no_collection' }, '2026-08-09').action, 'none');
  assert.equal(planReservation({ ...base, status: 'needs_attention' }, '2026-08-09').action, 'none');
});

// --- rendering ------------------------------------------------------------

test('renders French messages with no leftover placeholders', () => {
  for (const kind of ['welcome', 'reminder', 'confirmation']) {
    const sms = buildMessage(kind, base);
    assert.ok(!/\{[A-Z_]+\}/.test(sms), `${kind} SMS has an unfilled placeholder`);
    assert.ok(sms.includes('1,22'), `${kind} SMS is missing the amount`);
    assert.ok(sms.includes('Sophie'), `${kind} SMS is missing the first name`);

    const email = buildEmail(kind, base);
    assert.ok(email.subject.length > 0);
    assert.ok(!/\{[A-Z_]+\}/.test(email.body), `${kind} email has an unfilled placeholder`);
  }
});

test('welcome and reminder carry the payment link, confirmation does not', () => {
  assert.ok(buildMessage('welcome', base).includes('https://pay.sumup.com/abc'));
  assert.ok(buildMessage('reminder', base).includes('https://pay.sumup.com/abc'));
  assert.ok(!buildMessage('confirmation', base).includes('pay.sumup.com'));
});

test('messages show the arrival date in French format', () => {
  assert.ok(buildMessage('welcome', base).includes('14/08/2026'));
});
