import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import { sanitizeShortText } from '../analyze.js';
import { describeAllowlistEntry, MAX_ADDRESS_BOOKS } from '../books.js';
import { addressbookQueryBody, syncCollectionBody } from '../dav-xml.js';
import { notes, shapedAddressBook, untrustedFields } from '../output-schema.js';
import { ownWordsResult, run, untrustedResult } from '../result.js';
import { shapeAddressBook } from '../shape.js';
import { READ_ONLY } from './annotations.js';
import type { ToolContext } from './common.js';

/**
 * The two tools that describe the connection rather than its contents.
 *
 * Both take no address book argument, and both are guarded by **filtering what
 * they print** rather than by resolving anything: they never turn a caller's
 * string into a URL, so there is nothing to bypass. `list_address_books`
 * reports how many entries `CARDDAV_ADDRESSBOOKS` withheld, because a listing
 * that silently omits books teaches the reader they do not exist — and then a
 * perfectly correct id from another source looks like a bug.
 */
/** Cap on a server-chosen URL shown for information. */
const MAX_URL_CHARS = 512;

/** How many home sets `get_server_info` lists. Real accounts have one. */
const MAX_HOMES = 16;

export function registerBookTools(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    'list_address_books',
    {
      title: 'List the address books',
      description:
        'Every address book this server may use, with the id to pass to the ' +
        'other tools. Always asks the server rather than answering from a ' +
        'cache — being current is this tool’s whole job.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        address_books: z.array(shapedAddressBook),
        count: z.number().int(),
        withheld: z
          .number()
          .int()
          .describe(
            'Address books CARDDAV_ADDRESSBOOKS is keeping out of sight. ' +
              'Reported so their absence does not read as their non-existence.'
          ),
        notes,
      }),
    },
    async () =>
      run(async () => {
        const registry = await context.discovery.registry(true);
        const principal = await context.discovery.principal();
        const allowed = registry.allowed();
        const unmatched = registry.unmatched();

        const collected = [...principal.notes];
        if (unmatched.length > 0) {
          // Described, not quoted: this note reaches the model, and an entry
          // that matches nothing is what a pasted credential looks like.
          collected.push(
            `CARDDAV_ADDRESSBOOKS names ${unmatched.length} entr` +
              `${unmatched.length === 1 ? 'y' : 'ies'} that match no address ` +
              `book: ${unmatched.map(describeAllowlistEntry).join(', ')}. ` +
              'Check the spelling — an entry that matches nothing narrows ' +
              'this server for no reason.'
          );
        }
        if (registry.truncated > 0) {
          collected.push(
            `The server reported ${registry.truncated} more address book(s) ` +
              `than the ${MAX_ADDRESS_BOOKS} this server keeps; they are not ` +
              'listed and cannot be addressed. Narrow the account, or name ' +
              'the books that matter in CARDDAV_ADDRESSBOOKS.'
          );
        }

        return untrustedResult({
          address_books: allowed.map(shapeAddressBook),
          count: allowed.length,
          withheld: registry.withheld(),
          ...(collected.length > 0 ? { notes: collected } : {}),
        });
      })
  );

  server.registerTool(
    'get_server_info',
    {
      title: 'What the connected CardDAV server can do',
      description:
        'Reports the DAV compliance tokens, which vCard versions each address ' +
        'book accepts, and whether the optional features this server relies ' +
        'on actually work here. The first thing to run when something behaves ' +
        'differently than expected — CardDAV implementations differ more than ' +
        'the specification suggests.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      // No untrusted marker: every field here is either a protocol token or
      // this server's own probe result. A marker on everything is a marker on
      // nothing. That only holds if the two fields that are *not* tokens —
      // the principal and home URLs, which are hrefs the server chose — are
      // cleaned like the header tokens are: a path segment of
      // `![leak](https://attacker/x.png)` survives `new URL()` intact.
      outputSchema: z.object({
        url: z.string(),
        principal: z.string().optional(),
        homes: z.array(z.string()),
        dav_compliance: z
          .array(z.string())
          .describe('The DAV: header tokens, lowercased.'),
        allowed_methods: z.array(z.string()),
        address_book_count: z.number().int(),
        withheld: z.number().int(),
        features: z.object({
          addressbook_query: z
            .boolean()
            .describe('Whether server-side search works at all.'),
          sync_collection: z
            .boolean()
            .describe('Whether list_changes can be used against this server.'),
        }),
        notes,
      }),
    },
    async () =>
      run(async () => {
        const principal = await context.discovery.principal();
        const registry = await context.discovery.registry();
        const allowed = registry.allowed();
        const collected = [...principal.notes];

        let dav: string[] = [];
        let allow: string[] = [];
        try {
          const options = await context.api.options(`${context.api.url}/`);
          dav = options.dav;
          allow = options.allow;
        } catch {
          collected.push(
            'The server did not answer OPTIONS at the configured URL, so the ' +
              'compliance tokens are unknown. That is common behind a proxy ' +
              'and does not by itself mean anything is wrong.'
          );
        }

        // Probed rather than inferred from the compliance tokens. A server can
        // advertise `addressbook` and still refuse a filtered query, and the
        // point of this tool is to answer "does it actually work here".
        const probe = allowed[0];
        const features = {
          addressbook_query:
            probe === undefined
              ? dav.includes('addressbook')
              : await works(() =>
                  context.api.report(
                    probe.url,
                    1,
                    addressbookQueryBody(['UID'])
                  )
                ),
          sync_collection:
            probe === undefined
              ? dav.includes('sync-collection')
              : await works(() =>
                  context.api.syncReport(probe.url, syncCollectionBody())
                ),
        };
        if (probe === undefined) {
          collected.push(
            'No address book was available to probe, so the feature report is ' +
              'based on the advertised compliance tokens rather than on a ' +
              'real request.'
          );
        }

        return ownWordsResult({
          url: context.api.url,
          ...(principal.url === undefined
            ? {}
            : { principal: sanitizeShortText(principal.url, MAX_URL_CHARS) }),
          homes: principal.homes
            .slice(0, MAX_HOMES)
            .map((home) => sanitizeShortText(home, MAX_URL_CHARS)),
          dav_compliance: dav,
          allowed_methods: allow,
          address_book_count: allowed.length,
          withheld: registry.withheld(),
          features,
          ...(collected.length > 0 ? { notes: collected } : {}),
        });
      })
  );
}

/**
 * Whether a probe request succeeded.
 *
 * A refusal from the server is the answer, not a failure of this tool — the
 * whole point is to report what the backend will not do. A transport failure is
 * treated the same way, deliberately: `get_server_info` is what somebody runs
 * *because* something is wrong, and it should describe the situation rather
 * than become another thing that errors.
 */
async function works(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch {
    return false;
  }
}
