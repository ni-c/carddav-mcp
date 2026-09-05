import { assertLoopback, waitForHttp } from 'mcp-integration-harness';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { ALLOWED_BOOKS, FORBIDDEN_BOOK } from './bootstrap.js';

/**
 * From a fresh Baikal container to a usable sabre/dav account.
 *
 * Baikal is the second backend for one reason: it is sabre/dav, and sabre/dav
 * is what the hosted services people actually connect to are built on. It
 * disagrees with Radicale in every place this server had to make a decision —
 * lowercase `d:`/`card:` prefixes instead of a default namespace, hrefs under a
 * `/dav.php/` path prefix,  a `supported-address-data` naming both 3.0
 * and 4.0 where Radicale names only 3.0, `&#13;` for the line endings of the
 * card itself where Radicale writes them raw, its own collation rules for
 * `text-match`, and its own preconditions on an error. The unit tests can *simulate* the prefix
 * difference; only a real one can disagree about the rest.
 *
 * This is not a second copy of the Radicale suite. That one proves coverage —
 * every tool, once, against a real server. This one proves *portability*, so it
 * asserts the differences and skips the rest.
 *
 * **Why the account is written into the database rather than installed.**
 * Baikal ships a web installer: three form posts carrying a CSRF token and a
 * session, followed by a login and a fourth form to create the user. Driving it
 * is possible and is four opportunities for the suite to break on a cosmetic
 * change to an admin page nothing here is testing. The schema, by contrast, is
 * a file in the image (`Core/Resources/Db/SQLite/db.sql`) and PHP with
 * pdo_sqlite is right there. So the account is seeded and the config file
 * written directly — and the *address books* are still created with `MKCOL`
 * over the wire, exactly as on Radicale, because that is the part the server
 * has to interoperate with.
 *
 * Three settings are load-bearing rather than arbitrary:
 *
 * - **`card_enabled: true`.** The sister server sets this to `false`, which is
 *   right for a CalDAV server and would make every request here 404.
 * - `dav_auth_type: Basic`. Baikal's other option is Digest, which this server
 *   deliberately does not implement. Leaving the default here would test
 *   nothing except that a 401 is a 401.
 * - `digesta1` is `md5(user:realm:password)` even under Basic, because sabre
 *   compares against that hash either way. Getting the realm wrong produces a
 *   401 that looks exactly like a wrong password.
 */

const run = promisify(execFile);

export const BAIKAL_URL = 'http://127.0.0.1:8088/dav.php';
export const BAIKAL_USER = 'integration';
export const BAIKAL_PASSWORD = 'integration-not-a-secret';
export const BAIKAL_EMAIL = 'integration@example.net';
const REALM = 'BaikalDAV';

/** The compose service name, for `docker compose exec`. */
const SERVICE = 'baikal';

const COMPOSE = new URL('compose.yml', import.meta.url).pathname;

const AUTH = `Basic ${Buffer.from(`${BAIKAL_USER}:${BAIKAL_PASSWORD}`).toString(
  'base64'
)}`;

/**
 * The PHP that seeds the account, run inside the container.
 *
 * Kept as one script rather than several `exec` calls: each one costs a second
 * of container round trip, and a half-seeded account is a worse failure to read
 * than an unseeded one.
 */
const SEED_PHP = `
$db = new PDO('sqlite:/var/www/baikal/Specific/db/db.sqlite');
// Only on an empty database. Applying the schema twice throws on the first
// CREATE TABLE, which makes a second run against a container somebody left up
// fail in the bootstrap rather than in a test.
$fresh = $db->query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")->fetch();
if ($fresh === false) {
  $db->exec(file_get_contents('/var/www/baikal/Core/Resources/Db/SQLite/db.sql'));
}
$digest = md5('${BAIKAL_USER}:${REALM}:${BAIKAL_PASSWORD}');
$user = $db->prepare('INSERT OR IGNORE INTO users (username, digesta1) VALUES (?, ?)');
$user->execute(['${BAIKAL_USER}', $digest]);
$principal = $db->prepare('INSERT OR IGNORE INTO principals (uri, email, displayname) VALUES (?, ?, ?)');
$principal->execute(['principals/${BAIKAL_USER}', '${BAIKAL_EMAIL}', 'Integration']);
echo "seeded";
`;

/**
 * The admin password hash, which is what marks the instance as *installed*.
 *
 * Not decoration: Baikal decides whether to redirect everything to
 * `/admin/install/` by whether this key is present, so a config without it
 * answers every DAV request with a 302 that looks like a routing problem.
 * Same `md5(user:realm:password)` construction as a DAV user.
 */
const ADMIN_HASH = createHash('md5')
  .update(`admin:${REALM}:${BAIKAL_PASSWORD}`)
  .digest('hex');

const CONFIG_YAML = `database:
  backend: sqlite
  sqlite_file: /var/www/baikal/Specific/db/db.sqlite
system:
  configured_version: 0.10.1
  timezone: UTC
  card_enabled: true
  cal_enabled: false
  invite_from: noreply@example.net
  dav_auth_type: Basic
  auth_realm: ${REALM}
  admin_passwordhash: ${ADMIN_HASH}
  base_uri: ""
`;

async function inContainer(script: string): Promise<string> {
  const { stdout } = await run(
    'docker',
    ['compose', '-f', COMPOSE, 'exec', '-T', SERVICE, 'sh', '-c', script],
    { timeout: 120_000 }
  );
  return stdout;
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

export interface BaikalSandbox {
  url: string;
  env: Record<string, string>;
  /** Path of each address book, keyed by its short name. */
  paths: Record<string, string>;
}

/** Brings the Baikal sandbox to the same state the Radicale one is in. */
export async function bootstrapBaikal(): Promise<BaikalSandbox> {
  assertLoopback(BAIKAL_URL);
  await waitForHttp('http://127.0.0.1:8088/', { timeoutSeconds: 180 });

  // Written with a heredoc whose delimiter is quoted, so the shell expands
  // nothing: the PHP contains `$` on nearly every line.
  const seeded = await inContainer(
    `set -e
cat > /tmp/seed.php <<'PHPEOF'
<?php
${SEED_PHP}
PHPEOF
cat > /var/www/baikal/config/baikal.yaml <<'YAMLEOF'
${CONFIG_YAML}
YAMLEOF
php /tmp/seed.php
chown -R www-data:www-data /var/www/baikal/Specific /var/www/baikal/config
echo " configured"`
  );
  if (!seeded.includes('seeded configured')) {
    throw new Error(
      `Baikal bootstrap did not complete: ${seeded.slice(0, 500)}`
    );
  }

  const paths: Record<string, string> = {};
  for (const name of [...ALLOWED_BOOKS, FORBIDDEN_BOOK]) {
    const collection = `${BAIKAL_URL}/addressbooks/${BAIKAL_USER}/${name}/`;
    const response = await dav(collection, 'MKCOL', {
      body:
        `<?xml version="1.0" encoding="utf-8"?>` +
        `<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">` +
        `<D:set><D:prop>` +
        `<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>` +
        `<D:displayname>${name}</D:displayname>` +
        `</D:prop></D:set></D:mkcol>`,
    });
    // sabre answers an existing collection with 405, where Radicale answers
    // 409 and a `resource-must-be-null` precondition. Both are legal, and the
    // pair is exactly the sort of difference this backend exists to surface.
    if (![201, 405].includes(response.status)) {
      throw new Error(
        `MKCOL ${collection} answered ${response.status}: ${(
          await response.text()
        ).slice(0, 300)}`
      );
    }
    paths[name] = `/dav.php/addressbooks/${BAIKAL_USER}/${name}/`;
    await empty(collection);
  }

  return {
    url: BAIKAL_URL,
    paths,
    env: {
      CARDDAV_URL: BAIKAL_URL,
      CARDDAV_USERNAME: BAIKAL_USER,
      CARDDAV_PASSWORD: BAIKAL_PASSWORD,
      CARDDAV_ADDRESSBOOKS: ALLOWED_BOOKS.join(','),
      CARDDAV_READ_ONLY: 'false',
    },
  };
}

/** Clears a collection, so a second run means what the first one meant. */
async function empty(collection: string): Promise<void> {
  const response = await dav(collection, 'PROPFIND', {
    headers: { Depth: '1' },
    body:
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>',
  });
  if (response.status !== 207) return;
  const body = await response.text();
  for (const match of body.matchAll(
    /<[a-z]*:?href>([^<]+)<\/[a-z]*:?href>/gi
  )) {
    const href = match[1] ?? '';
    if (!href.endsWith('.vcf')) continue;
    await dav(new URL(href, collection).toString(), 'DELETE');
  }
}

/** Puts a card in place without going through the server under test. */
export async function putRawBaikal(
  sandbox: BaikalSandbox,
  book: string,
  name: string,
  vcf: string
): Promise<void> {
  const url = `http://127.0.0.1:8088${sandbox.paths[book] ?? ''}${name}`;
  const response = await dav(url, 'PUT', {
    body: vcf,
    headers: { 'Content-Type': 'text/vcard; charset=utf-8' },
  });
  if (response.status >= 400) {
    throw new Error(
      `PUT ${url} answered ${response.status}: ${(await response.text()).slice(0, 300)}`
    );
  }
}

/** Reads a card back as stored, bypassing the server under test. */
export async function getRawBaikal(
  sandbox: BaikalSandbox,
  book: string,
  name: string
): Promise<{ status: number; vcf: string }> {
  const url = `http://127.0.0.1:8088${sandbox.paths[book] ?? ''}${name}`;
  const response = await dav(url, 'GET');
  return { status: response.status, vcf: await response.text() };
}
