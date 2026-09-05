import { assertLoopback, waitForHttp } from 'mcp-integration-harness';

/**
 * From an empty container to a usable CardDAV account.
 *
 * The bootstrap is allowed to do what the server is not: it creates the address
 * books with an extended `MKCOL` over the wire. That asymmetry is deliberate —
 * carddav-mcp has no `mkcol` verb at all, so the suite cannot lean on a
 * capability the server is documented not to have.
 */

export const USER = 'integration';
export const PASSWORD = 'integration-not-a-secret';

/** Two are allowed, one is not: the withheld path stays live for every test. */
export const ALLOWED_BOOKS = ['work', 'private'] as const;
export const FORBIDDEN_BOOK = 'shared';

const AUTH = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

export interface Sandbox {
  url: string;
  /** The environment for the server under test. Nothing else is inherited. */
  env: Record<string, string>;
  /** Path of each address book, keyed by its short name. */
  paths: Record<string, string>;
}

async function dav(
  url: string,
  method: string,
  options: { body?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      Authorization: AUTH,
      ...(options.body === undefined
        ? {}
        : { 'Content-Type': 'application/xml; charset=utf-8' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: options.body }),
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
}

/**
 * The extended `MKCOL` body, RFC 5689.
 *
 * CardDAV has no `MKADDRESSBOOK` verb the way CalDAV has `MKCALENDAR`: the
 * collection is created with an ordinary `MKCOL` carrying a resourcetype that
 * names `addressbook`. Both Radicale and sabre/dav accept this form.
 */
function mkcolBody(name: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:set><D:prop>
    <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
    <D:displayname>${name}</D:displayname>
  </D:prop></D:set>
</D:mkcol>`;
}

/**
 * Removes every card in a collection, leaving the collection itself.
 *
 * This is what makes a second run mean the same as the first. Creating the
 * collections is idempotent on its own — the server says "already there" and
 * the bootstrap accepts that — but their *contents* are not, and the sister
 * server was bitten by exactly this twice: a run against a container somebody
 * left up saw the seeded fixtures plus everything the previous run created, and
 * failed in several places at once. The symptom looks like a broken assertion
 * and is actually stale state, which is the expensive kind of red.
 *
 * DELETE per card rather than dropping and recreating the collection: the book
 * keeps its displayname, so what the tests see is the collection the bootstrap
 * describes and not a bare one.
 */
async function emptyCollection(collection: string): Promise<void> {
  const response = await dav(collection, 'PROPFIND', {
    headers: { Depth: '1' },
    body:
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>',
  });
  if (response.status !== 207) {
    throw new Error(
      `PROPFIND ${collection} answered ${response.status} while emptying it`
    );
  }
  const body = await response.text();
  const hrefs = [...body.matchAll(/<[a-z]*:?href>([^<]+)<\/[a-z]*:?href>/gi)]
    .map((match) => match[1] ?? '')
    .filter((href) => href.endsWith('.vcf'));

  for (const href of hrefs) {
    // The href may be a path or an absolute URL depending on the server; both
    // resolve against the collection, and both stay on the sandbox origin.
    const target = new URL(href, collection).toString();
    const deleted = await dav(target, 'DELETE');
    if (deleted.status >= 400 && deleted.status !== 404) {
      throw new Error(`DELETE ${target} answered ${deleted.status}`);
    }
  }
}

/**
 * Brings the Radicale sandbox to a usable state.
 *
 * `assertLoopback` throws rather than skipping. A skipped test reads as
 * "nothing to do here" at precisely the moment the reason is "this was pointed
 * at something real", and this suite calls every delete the server has.
 */
export async function bootstrapRadicale(
  url = 'http://127.0.0.1:5232'
): Promise<Sandbox> {
  assertLoopback(url);
  await waitForHttp(url, { timeoutSeconds: 120 });

  const home = `${url}/${USER}/`;
  const paths: Record<string, string> = {};

  for (const name of [...ALLOWED_BOOKS, FORBIDDEN_BOOK]) {
    const collection = `${home}${name}/`;
    const response = await dav(collection, 'MKCOL', { body: mkcolBody(name) });
    // Already there is fine on a re-run against a stack somebody forgot to tear
    // down. Radicale says so with 409 and a `resource-must-be-null`
    // precondition rather than the 405 one might expect, which is legal and
    // worth writing down: a bootstrap that only accepted 405 would fail on
    // every second run and look like a broken suite.
    const exists =
      response.status === 409 &&
      /resource-must-be-null/i.test(await response.clone().text());
    if (![201, 405].includes(response.status) && !exists) {
      throw new Error(
        `MKCOL ${collection} answered ${response.status}: ${(
          await response.text()
        ).slice(0, 500)}`
      );
    }
    await emptyCollection(collection);
    paths[name] = `/${USER}/${name}/`;
  }

  return {
    url,
    paths,
    env: {
      CARDDAV_URL: url,
      CARDDAV_USERNAME: USER,
      CARDDAV_PASSWORD: PASSWORD,
      CARDDAV_ADDRESSBOOKS: ALLOWED_BOOKS.join(','),
      // Off by default, and spelled out anyway: the suite exists to drive the
      // write tools, so a stray value in the ambient environment must not be
      // what decides whether they are registered.
      CARDDAV_READ_ONLY: 'false',
    },
  };
}

/**
 * Puts a card into an address book without going through the server under test.
 *
 * Used to seed fixtures the tools then read, and — more importantly — to read a
 * card back afterwards. An assertion that goes through this server's own
 * shaping only proves the server agrees with itself; reading the raw `.vcf` is
 * what proves an X-property, a photo or a group membership really survived a
 * write.
 */
export async function putRaw(
  sandbox: Sandbox,
  book: string,
  name: string,
  vcf: string
): Promise<void> {
  const url = `${sandbox.url}${sandbox.paths[book] ?? ''}${name}`;
  const response = await dav(url, 'PUT', {
    body: vcf,
    headers: { 'Content-Type': 'text/vcard; charset=utf-8' },
  });
  if (response.status >= 400) {
    throw new Error(
      `PUT ${url} answered ${response.status}: ${(await response.text()).slice(0, 500)}`
    );
  }
}

/** Reads a card back as stored, bypassing the server under test. */
export async function getRaw(
  sandbox: Sandbox,
  book: string,
  name: string
): Promise<{ status: number; vcf: string }> {
  const url = `${sandbox.url}${sandbox.paths[book] ?? ''}${name}`;
  const response = await dav(url, 'GET');
  return { status: response.status, vcf: await response.text() };
}

/** Every card name in an address book, straight from the server. */
export async function listRaw(
  sandbox: Sandbox,
  book: string
): Promise<string[]> {
  const url = `${sandbox.url}${sandbox.paths[book] ?? ''}`;
  const response = await dav(url, 'PROPFIND', {
    headers: { Depth: '1' },
    body:
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>',
  });
  const body = await response.text();
  return [...body.matchAll(/<[a-z]*:?href>([^<]+)<\/[a-z]*:?href>/gi)]
    .map((match) => (match[1] ?? '').split('/').filter(Boolean).pop() ?? '')
    .filter((name) => name.endsWith('.vcf'));
}

/** A vCard, built for seeding. */
export function vcard(fields: Record<string, string>, version = '3.0'): string {
  const lines = ['BEGIN:VCARD', `VERSION:${version}`];
  for (const [name, value] of Object.entries(fields)) {
    lines.push(`${name}:${value}`);
  }
  lines.push('END:VCARD');
  return `${lines.join('\r\n')}\r\n`;
}
