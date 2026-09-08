import { describe, expect, it } from 'vitest';

import { sanitizeShortText, sanitizeText } from '../src/analyze.js';
import { CardDavApi } from '../src/api.js';
import {
  normalisePath,
  resourceUrl,
  stripTrailingSlashes,
} from '../src/books.js';
import { decodeAddressData, parseMultiStatus } from '../src/dav-xml.js';
import { resourceNameOf } from '../src/entries.js';
import { parseVCard, photoInfo } from '../src/vcard.js';
import { ORIGIN, testConfig, USER } from './harness.js';

/**
 * Every function that runs a pattern over text the server or a card author
 * chose, timed at the largest size the code accepts. The pattern this file
 * exists for is the *unanchored suffix* — `/=*$/`, `/[^/]*$/`, `/\/+$/` — which
 * is retried from every position of a run and consumes the run each time:
 * quadratic, and two seconds at 80 000 characters on the thread that serves
 * every request. `analyze.ts` has its own table for the injection heuristics.
 */

const BUDGET_MS = 200;

/** The CDATA markers, spelled here so the test does not import an internal. */
const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

function timed(fn: () => unknown): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

describe('runs in linear time', () => {
  it('base64Bytes on a PHOTO made of padding', () => {
    const card = parseVCard(
      `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nPHOTO;ENCODING=b;TYPE=JPEG:${'='.repeat(800_000)}a\r\nEND:VCARD\r\n`,
      'x'
    );
    expect(timed(() => photoInfo(card))).toBeLessThan(BUDGET_MS);
  });

  it('resourceNameOf on an href with a very long segment', () => {
    const api = new CardDavApi(testConfig());
    const book = { url: `${ORIGIN}/${USER}/work/`, path: `/${USER}/work/` };
    const href = `/${USER}/work/${'a'.repeat(400_000)}/x.vcf`;
    expect(timed(() => resourceNameOf(href, api, book))).toBeLessThan(
      BUDGET_MS
    );
  });

  it('normalisePath and stripTrailingSlashes on a run of slashes', () => {
    const run = `${'/'.repeat(400_000)}a`;
    expect(timed(() => normalisePath(run))).toBeLessThan(BUDGET_MS);
    expect(
      timed(() => stripTrailingSlashes(`/x${'/'.repeat(400_000)}`))
    ).toBeLessThan(BUDGET_MS);
    expect(stripTrailingSlashes('/a///')).toBe('/a');
    expect(normalisePath('/a///')).toBe('/a/');
  });

  it('resourceUrl on the longest name the id layer admits', () => {
    const book = { url: `${ORIGIN}/${USER}/work/`, path: `/${USER}/work/` };
    const name = 'a'.repeat(2048);
    expect(timed(() => resourceUrl(book, name))).toBeLessThan(BUDGET_MS);
  });

  it('parseMultiStatus on a response with a 4 MB href', () => {
    const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/${USER}/work/${'a'.repeat(4_000_000)}/x.vcf</D:href><D:propstat><D:prop><D:getetag>"1"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
    let out: unknown[] = [];
    expect(timed(() => (out = parseMultiStatus(xml, 'x')))).toBeLessThan(2000);
    expect(out).toHaveLength(0);
  });

  it('decodeAddressData on a document made of CDATA openings', () => {
    // The unwrapper walks the document with `indexOf` for exactly this reason.
    // A pattern with `[^\]]*` between the markers would be retried from every
    // position of a run that never closes — the shape this file exists for,
    // on a string whose length the server chooses.
    const openings = CDATA_OPEN.repeat(100_000);
    expect(timed(() => decodeAddressData(openings))).toBeLessThan(BUDGET_MS);
  });

  it('decodeAddressData on half a megabyte of closed sections', () => {
    const sections = `${CDATA_OPEN}a${CDATA_CLOSE}`.repeat(40_000);
    expect(timed(() => decodeAddressData(sections))).toBeLessThan(BUDGET_MS);
  });

  it('the sanitisers on a megabyte of image markers', () => {
    const markers = '!['.repeat(500_000);
    expect(timed(() => sanitizeShortText(markers))).toBeLessThan(BUDGET_MS);
    expect(timed(() => sanitizeText(markers))).toBeLessThan(BUDGET_MS);
    expect(sanitizeShortText(markers).length).toBeLessThanOrEqual(401);
  });
});
