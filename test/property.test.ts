import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildEntityId,
  parseEntityId,
  type AddressBookLookup,
} from '../src/entity-id.js';
import { decodeAddressData } from '../src/dav-xml.js';
import { AddressBookNotAllowedError, ToolInputError } from '../src/errors.js';
import { redactUnparsedUrl, redactUrlCredentials } from '../src/redact.js';
import { resourceNameFor } from '../src/vcard.js';

/**
 * Properties, as opposed to the examples in the other files.
 *
 * Two of the functions here carry a history in their own comments, and both
 * histories are of a value that reached somewhere it should not have. That is
 * the argument for stating them over every input rather than over the handful
 * that were tried: the case that got through was, both times, one nobody had
 * written down.
 */

const RUNS = { numRuns: 500 };

const ALLOWED = '/tester/contacts/';
const KNOWN = '/tester/shared/';

const books: AddressBookLookup = {
  allows: (path) => path === ALLOWED,
  knows: (path) => path === ALLOWED || path === KNOWN,
};

/**
 * A resource name the scheme is meant to carry. The exclusions mirror the
 * decoder's rules, so a change to one side without the other shows up as a
 * failing round trip rather than as a silently narrower test.
 */
const resourceName = fc.string({ minLength: 1, unit: 'binary' }).filter(
  (name) =>
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.startsWith('.') &&
    !/%2e/i.test(name) &&
    ![...name].some((c) => {
      const code = c.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || c === '?' || c === '#';
    })
);

describe('entity ids round trip and refuse everything else', () => {
  it('an id decodes back to the book and resource it was built from', () => {
    fc.assert(
      fc.property(resourceName, (name) => {
        const decoded = parseEntityId(buildEntityId(ALLOWED, name), books);
        expect(decoded.bookPath).toBe(ALLOWED);
        expect(decoded.resourceName).toBe(name);
      }),
      RUNS
    );
  });

  /**
   * Totality: an arbitrary string is either a valid id or a typed refusal.
   *
   * The argument arrives from the model, and every other guarantee in the
   * module — the allowlist, the path checks — is only reachable if the decoder
   * never fails in some third way, such as a `TypeError` out of `Buffer.from`.
   */
  it('an arbitrary string either decodes or raises a typed error', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (candidate) => {
        try {
          const decoded = parseEntityId(candidate, books);
          expect(decoded.bookPath).toBe(ALLOWED);
          expect(decoded.resourceName.length).toBeGreaterThan(0);
        } catch (error) {
          expect(
            error instanceof ToolInputError ||
              error instanceof AddressBookNotAllowedError
          ).toBe(true);
        }
      }),
      RUNS
    );
  });

  /**
   * The base64url decode is one-to-one. `Buffer.from(…, 'base64url')` ignores
   * characters outside the alphabet and accepts a truncated group, so without
   * the re-encode check two different ids could name the same address book —
   * an allowlist bypass rather than a cosmetic issue.
   */
  it('no mutated id decodes to an allowed address book', () => {
    const valid = buildEntityId(ALLOWED, 'a1b2c3.vcf');
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: valid.length - 1 }),
        fc.constantFrom('=', '+', '/', ' ', '\n', '\0', 'ä'),
        (index, injected) => {
          const mutated =
            valid.slice(0, index) + injected + valid.slice(index + 1);
          fc.pre(mutated !== valid);
          expect(() => parseEntityId(mutated, books)).toThrow();
        }
      ),
      RUNS
    );
  });

  it('a book outside the allowlist is refused by name, not by 404', () => {
    fc.assert(
      fc.property(resourceName, (name) => {
        expect(() => parseEntityId(buildEntityId(KNOWN, name), books)).toThrow(
          AddressBookNotAllowedError
        );
      }),
      RUNS
    );
  });

  /**
   * A generated resource name is always addressable, which is what lets the
   * write path use it without escaping: it is derived from a fresh UUID rather
   * than from the caller's data, so it carries nothing about the person.
   */
  it('a generated resource name always survives the round trip', () => {
    fc.assert(
      fc.property(fc.uuid(), (uid) => {
        const name = resourceNameFor(uid);
        expect(
          parseEntityId(buildEntityId(ALLOWED, name), books).resourceName
        ).toBe(name);
      }),
      RUNS
    );
  });
});

describe('credential redaction', () => {
  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (value) => {
        const once = redactUrlCredentials(value);
        expect(redactUrlCredentials(once)).toBe(once);
      }),
      RUNS
    );
  });

  it('publishes no fragment of a password, wherever its @ falls', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{3,12}$/),
        fc.stringMatching(/^[A-Za-z0-9]{3,10}$/),
        fc.stringMatching(/^[A-Za-z0-9]{3,10}$/),
        fc.stringMatching(/^[a-z]{3,12}(\.[a-z]{2,6})+$/),
        (user, head, tail, host) => {
          // The fragment must not occur in what legitimately survives — the
          // host, and the fixed `https://***@…/dav` around it: a password of
          // `htt` is a substring of `https`, and the property is about the
          // redaction, not about the alphabet.
          const expected = `https://***@${host}/dav`;
          fc.pre(!expected.includes(head) && !expected.includes(tail));
          const redacted = redactUrlCredentials(
            `https://${user}:${head}@${tail}@${host}/dav`
          );
          expect(redacted).toBe(expected);
          expect(redacted).not.toContain(head);
          expect(redacted).not.toContain(tail);
        }
      ),
      RUNS
    );
  });
});

describe('an unparsed URL hides by default', () => {
  /**
   * The property the comment on `redactUnparsedUrl` was written for.
   *
   * The old rule revealed by default and hid by exception, which inverted the
   * one place it must not be inverted: a bearer token pasted into `CARDDAV_URL`
   * instead of `CARDDAV_TOKEN` contains neither `@` nor `?`, so `ghp_…`, `sk-…`,
   * `xoxb-…`, a JWT and a Fastmail app password all fell through the sieve and
   * went verbatim into the MCP host's log file.
   *
   * Stated as: nothing but the scheme survives. Generated over token shapes
   * that look nothing like a URL, which is exactly what the old rule let past.
   */
  it('no part of a pasted secret survives beyond its scheme', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.stringMatching(/^ghp_[A-Za-z0-9]{20,36}$/),
          fc.stringMatching(/^sk-[A-Za-z0-9]{20,40}$/),
          fc.stringMatching(/^xoxb-[0-9]{6,12}-[A-Za-z0-9]{10,20}$/),
          fc.stringMatching(/^[A-Za-z0-9_-]{12,30}\.[A-Za-z0-9_-]{12,30}$/),
          fc.stringMatching(/^[a-z]{16,32}$/)
        ),
        (secret) => {
          const redacted = redactUnparsedUrl(secret);
          expect(redacted).not.toContain(secret);
          for (let start = 0; start + 6 <= secret.length; start += 3) {
            expect(redacted).not.toContain(secret.slice(start, start + 6));
          }
        }
      ),
      RUNS
    );
  });

  /**
   * What is left is the shape, which is what a wrong value is usually wrong
   * about — and a length, which tells a typo from a paste.
   */
  it('reports the scheme when there is one and says so when there is not', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('https://', 'http://', ''),
        fc.stringMatching(/^[a-z0-9.]{5,40}$/),
        (scheme, rest) => {
          const redacted = redactUnparsedUrl(`${scheme}${rest}`);
          expect(redacted).toContain(`${rest.length} characters`);
          if (scheme === '') expect(redacted).toContain('no scheme');
          else expect(redacted.startsWith(scheme)).toBe(true);
        }
      ),
      RUNS
    );
  });

  it('never throws, whatever the operator typed', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (value) => {
        expect(() => redactUnparsedUrl(value)).not.toThrow();
      }),
      RUNS
    );
  });
});

/**
 * The property the Open-Xchange dialect broke.
 *
 * A CDATA section is a way of carrying text through XML unaltered, so
 * unwrapping one has to give back exactly what the server put in — including
 * the sequences that force it to split the section, which are the ones a
 * hand-written example is least likely to try. Stating it over every string is
 * the point: the card that got through was a card nobody had written down.
 */
/** How a server has to write one; `]]>` cannot appear inside a section. */
function wrapCdata(value: string): string {
  return `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

describe('a CDATA section carries any text a server puts in it', () => {
  it('unwraps to what was wrapped, whatever the card said', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        expect(decodeAddressData(wrapCdata(text))).toBe(text.trim());
      }),
      RUNS
    );
  });

  it('leaves entity references inside a section untouched', () => {
    // Inside CDATA `&amp;` is five characters and the card means them. This is
    // why the decoder runs on the segments outside the sections only.
    fc.assert(
      fc.property(
        fc.constantFrom('&amp;', '&#13;', '&#0;', '&lt;', '&#x0A;'),
        (entity) => {
          expect(decodeAddressData(wrapCdata(`NOTE:${entity}`))).toBe(
            `NOTE:${entity}`
          );
        }
      ),
      RUNS
    );
  });

  it('never throws, whatever a hostile server sends', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (value) => {
        expect(() => decodeAddressData(value)).not.toThrow();
      }),
      RUNS
    );
  });
});
