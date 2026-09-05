#!/usr/bin/env node
/**
 * Puts a handful of contacts into the throwaway Radicale, for `demo.tape`.
 *
 * Separate from the integration bootstrap on purpose: that one starts from an
 * empty book and builds its fixtures as it goes, so what it leaves behind
 * depends on which tests ran. A recording wants a fixed cast.
 *
 * Loopback only, and it says so rather than assuming — this writes and deletes
 * without asking, and pointing it at anything real would be a bad afternoon.
 */
const URL_BASE = process.env.CARDDAV_URL ?? 'http://127.0.0.1:5232';
const USER = 'integration';
const PASSWORD = 'integration-not-a-secret';
const BOOK = 'work';

if (!/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/.test(URL_BASE)) {
  console.error(`refusing to seed ${URL_BASE}: loopback only`);
  process.exit(1);
}

const AUTH = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

function card(fields) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  for (const [name, value] of Object.entries(fields)) {
    lines.push(`${name}:${value}`);
  }
  lines.push('END:VCARD');
  return `${lines.join('\r\n')}\r\n`;
}

const PEOPLE = {
  'ada.vcf': card({
    UID: 'demo-ada',
    FN: 'Ada Lovelace',
    N: 'Lovelace;Ada;;;',
    ORG: 'Analytical Engines',
    'EMAIL;TYPE=WORK': 'ada@example.net',
    'TEL;TYPE=CELL': '+44 20 7946 0100',
  }),
  'grace.vcf': card({
    UID: 'demo-grace',
    FN: 'Grace Hopper',
    N: 'Hopper;Grace;;;',
    ORG: 'US Navy',
    'EMAIL;TYPE=WORK': 'grace@example.net',
  }),
  'alan.vcf': card({
    UID: 'demo-alan',
    FN: 'Alan Turing',
    N: 'Turing;Alan;;;',
    ORG: 'National Physical Laboratory',
    'EMAIL;TYPE=WORK': 'alan@example.net',
  }),
  'pioneers.vcf': card({
    UID: 'demo-pioneers',
    FN: 'Computing Pioneers',
    'X-ADDRESSBOOKSERVER-KIND': 'group',
    'X-ADDRESSBOOKSERVER-MEMBER': 'urn:uuid:demo-ada',
  }),
};

async function dav(path, method, body, contentType) {
  const response = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      Authorization: AUTH,
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    ...(body === undefined ? {} : { body }),
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  return response;
}

const collection = `/${USER}/${BOOK}/`;
const made = await dav(
  collection,
  'MKCOL',
  '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">' +
    '<D:set><D:prop>' +
    '<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>' +
    '<D:displayname>Work</D:displayname>' +
    '</D:prop></D:set></D:mkcol>',
  'application/xml; charset=utf-8'
);
if (![201, 405, 409].includes(made.status)) {
  console.error(`MKCOL answered ${made.status}`);
  process.exit(1);
}

for (const [name, vcf] of Object.entries(PEOPLE)) {
  const put = await dav(
    `${collection}${name}`,
    'PUT',
    vcf,
    'text/vcard; charset=utf-8'
  );
  if (put.status >= 400) {
    console.error(`PUT ${name} answered ${put.status}`);
    process.exit(1);
  }
}

console.error(`seeded ${Object.keys(PEOPLE).length} cards into ${collection}`);
