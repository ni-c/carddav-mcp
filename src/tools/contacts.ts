import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import { assess, sanitizeShortText } from '../analyze.js';
import {
  SUMMARY_PROPS,
  syncCollectionBody,
  textOf,
  type PropFilter,
} from '../dav-xml.js';
import { ToolInputError } from '../errors.js';
import {
  boundedLimit,
  listCards,
  resourceNameOf,
  searchCards,
} from '../entries.js';
import { buildEntityId } from '../entity-id.js';
import {
  fullContact,
  notes,
  shapedContact,
  untrustedFields,
} from '../output-schema.js';
import {
  errorResult,
  fencedUntrustedResult,
  MAX_RESULT_BYTES,
  ownWordsResult,
  run,
  untrustedResult,
} from '../result.js';
import { fencedTextOf, freeTextOf, shapeFull, shapeSummary } from '../shape.js';
import {
  addressBooksParam,
  addressBookRef,
  entityId,
  limitParam,
  searchField,
} from '../schema.js';
import { MAX_MAX_ENTRIES } from '../config.js';
import { parseVCard, photoBytes, photoInfo, type ICAL } from '../vcard.js';
import { assertNotGroup } from '../groups.js';
import { READ_ONLY } from './annotations.js';
import {
  applyLimit,
  limitNote,
  loadById,
  resolveBooks,
  type ToolContext,
} from './common.js';

/**
 * Ceiling on a photo `get_contact_photo` will hand over.
 *
 * Below the resource ceiling in `api.ts` on purpose: that one bounds what may
 * be read at all, this one bounds what is worth putting into a model's context
 * as base64. A contact photograph past this size is a scan of something rather
 * than a portrait.
 *
 * "Below" has to be read in the right units, and the first value here was not.
 * At 2 MiB this branch was unreachable: the photo is inline base64 inside a
 * card, the card is read under `MAX_RESOURCE_BYTES` (1 MiB), and base64 costs a
 * third on top — so the read refused first and the friendly message below could
 * never fire. Half a mebibyte of image is roughly 683 kB of base64, which
 * leaves room for the rest of the card under that ceiling and makes the refusal
 * this tool documents an outcome that actually happens.
 */
const MAX_PHOTO_BYTES = 512 * 1024;

/**
 * The read tools for contacts.
 *
 * The split between `list_contacts` and `get_contact` is the same one the
 * sister server draws between a listing and a detail view, and here it is worth
 * more: a listing retrieves only `SUMMARY_PROPS`, so a hundred contacts cost a
 * few kilobytes instead of the several megabytes their inline photos would
 * come to. The entries a listing returns are marked `partial` for the same
 * reason, and `write.ts` never accepts one.
 */
export function registerContactTools(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    'list_contacts',
    {
      title: 'List contacts',
      description:
        'Contacts in one or more address books, as short summaries: name, ' +
        'organisation, addresses and phone numbers, and whether a photo is ' +
        'present. Only the summary properties are fetched, so this stays ' +
        'cheap on a large address book — get_contact returns the whole card.',
      inputSchema: z.object({
        address_books: addressBooksParam,
        limit: limitParam,
        include_groups: z
          .boolean()
          .optional()
          .describe(
            'Include group cards in the listing. Off by default: a group is ' +
              'a vCard like any other, and mixing them into a contact list is ' +
              'usually not what was meant. list_groups reads them properly.'
          ),
      }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        contacts: z.array(shapedContact),
        count: z.number().int(),
        address_books: z.array(z.string()),
        notes,
      }),
    },
    async (args) =>
      run(async () => {
        const { books } = await resolveBooks(context, args.address_books);
        const limit = boundedLimit(
          args.limit,
          context.config.maxEntries,
          MAX_MAX_ENTRIES
        );
        const documents = await listCards(context.api, books, SUMMARY_PROPS);

        const collected: string[] = [];
        let unreadable = 0;
        let groupsHidden = 0;
        const shaped: Record<string, unknown>[] = [];
        for (const document of documents) {
          let card: ICAL.Component;
          try {
            card = parseVCard(document.vcf, 'a card in the address book');
          } catch {
            unreadable += 1;
            continue;
          }
          const entry = shapeSummary(
            card,
            document.book,
            document.resourceName,
            document.etag,
            true
          );
          if (entry.is_group === true && args.include_groups !== true) {
            groupsHidden += 1;
            continue;
          }
          shaped.push(entry);
        }

        shaped.sort((left, right) =>
          String(left.formatted_name ?? '').localeCompare(
            String(right.formatted_name ?? '')
          )
        );
        const { shown, dropped } = applyLimit(shaped, limit);
        if (dropped > 0) collected.push(limitNote(dropped, limit));
        if (unreadable > 0) {
          collected.push(
            `${unreadable} card(s) could not be parsed and were left out. ` +
              'They are usually old exports from another client.'
          );
        }
        // Counted rather than merely skipped, for the same reason
        // `list_address_books` counts what the allowlist withheld: an absence
        // nobody explained reads as a non-existence, and "there are no groups
        // in this book" is a different fact from "you did not ask for them".
        if (groupsHidden > 0) {
          collected.push(
            `${groupsHidden} group card(s) are in these address books and were ` +
              'left out. Pass include_groups to list them here, or use ' +
              'list_groups.'
          );
        }

        return untrustedResult({
          contacts: shown,
          count: shown.length,
          address_books: books.map((book) => book.path),
          ...(collected.length > 0 ? { notes: collected } : {}),
        });
      })
  );

  server.registerTool(
    'get_contact',
    {
      title: 'Read one contact in full',
      description:
        'The complete card behind an id: every address, every phone number, ' +
        'the note, the birthday, and the names of any properties this server ' +
        'does not model. The free text comes back inside a fence marking it ' +
        'as somebody else’s writing.',
      inputSchema: z.object({ id: entityId }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        contact: fullContact,
        notes,
      }),
    },
    async (args) =>
      run(async () => {
        const { registry } = await resolveBooks(context);
        const loaded = await loadById(context, registry, args.id);
        assertNotGroup(loaded.card, 'get_contact');
        const shaped = shapeFull(
          loaded.card,
          loaded.book,
          loaded.entity.resourceName,
          loaded.etag
        );
        const signals = assess(freeTextOf(loaded.card));
        return fencedUntrustedResult(
          { contact: shaped },
          fencedTextOf(loaded.card),
          signals.suspicious
        );
      })
  );

  server.registerTool(
    'search_contacts',
    {
      title: 'Find contacts',
      description:
        'Finds contacts whose name, organisation, email address, phone ' +
        'number or note contains a term. One request per address book — ' +
        'CardDAV combines the fields with OR, unlike CalDAV — and the result ' +
        'is checked again here, because some servers filter only partially.',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(512)
          .describe('The term to look for. Matched case-insensitively.'),
        fields: z
          .array(searchField)
          .min(1)
          .max(10)
          .optional()
          .describe(
            'Which vCard properties to match against. Defaults to FN, ' +
              'NICKNAME, EMAIL, TEL and ORG — the fields somebody searches by.'
          ),
        address_books: addressBooksParam,
        limit: limitParam,
      }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        contacts: z.array(shapedContact),
        count: z.number().int(),
        matched_with: z
          .string()
          .describe(
            '"server-filter" when the backend did the filtering, ' +
              '"client-filter" when it cannot and every card was fetched.'
          ),
        collation: z
          .string()
          .optional()
          .describe('Set only when a collation had to be named explicitly.'),
        notes,
      }),
    },
    async (args) =>
      run(async () => {
        const { books } = await resolveBooks(context, args.address_books);
        const limit = boundedLimit(
          args.limit,
          context.config.maxEntries,
          MAX_MAX_ENTRIES
        );
        const fields = args.fields ?? ['FN', 'NICKNAME', 'EMAIL', 'TEL', 'ORG'];
        const filters: PropFilter[] = fields.map((field) => ({
          field,
          term: args.query,
        }));

        const outcome = await searchCards(
          context.api,
          books,
          filters,
          SUMMARY_PROPS
        );

        const shaped: Record<string, unknown>[] = [];
        for (const document of outcome.documents) {
          let card: ICAL.Component;
          try {
            card = parseVCard(document.vcf, 'a card in the search result');
          } catch {
            continue;
          }
          shaped.push(
            shapeSummary(
              card,
              document.book,
              document.resourceName,
              document.etag,
              true
            )
          );
        }

        const collected = [...outcome.notes];
        const { shown, dropped } = applyLimit(shaped, limit);
        if (dropped > 0) collected.push(limitNote(dropped, limit));

        return untrustedResult({
          contacts: shown,
          count: shown.length,
          matched_with: outcome.path,
          ...(outcome.collation === undefined
            ? {}
            : { collation: outcome.collation }),
          ...(collected.length > 0 ? { notes: collected } : {}),
        });
      })
  );

  server.registerTool(
    'get_contact_photo',
    {
      title: 'Fetch a contact’s photo',
      description:
        'Returns the photo stored on a card as an image. Only a photo ' +
        'embedded in the card itself — one stored as a link is reported by ' +
        'get_contact and never fetched, because that address was chosen by ' +
        'whoever wrote the card.',
      inputSchema: z.object({ id: entityId }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        media_type: z.string(),
        bytes: z.number().int(),
        contact_id: z.string(),
      }),
    },
    async (args) =>
      run(async () => {
        const { registry } = await resolveBooks(context);
        const loaded = await loadById(context, registry, args.id);
        const info = photoInfo(loaded.card);
        if (info === undefined) {
          return errorResult('carddav-mcp: this card carries no photo.');
        }
        if (info.storage === 'uri') {
          return errorResult(
            'carddav-mcp: this card stores its photo as a link rather than ' +
              'embedding it, and this server does not follow a link a card ' +
              'names. get_contact reports the address.'
          );
        }
        const photo = photoBytes(loaded.card);
        if (photo === undefined) {
          return errorResult(
            'carddav-mcp: the photo on this card could not be decoded.'
          );
        }
        if (photo.data.byteLength > MAX_PHOTO_BYTES) {
          return errorResult(
            `carddav-mcp: the photo is ${photo.data.byteLength} bytes, past ` +
              `the ${MAX_PHOTO_BYTES}-byte ceiling this tool applies. ` +
              'get_contact reports its size without fetching it.'
          );
        }

        const value = {
          untrusted: true as const,
          source: 'carddav' as const,
          media_type: photo.mediaType,
          bytes: photo.data.byteLength,
          contact_id: args.id,
        };
        return {
          content: [
            // The marker has to reach both channels. With the image block
            // alone, a client that reads only `content` — which is every
            // client that predates structured output — got a stranger's bytes
            // with no framing at all, while `structuredContent` carried the
            // `untrusted` field it never looked at.
            {
              type: 'text' as const,
              text:
                'Untrusted content from an address book: the image below was ' +
                'uploaded by whoever wrote or last edited this card. Its ' +
                `media type was determined from the bytes (${photo.mediaType}), ` +
                'not from what the card claimed.',
            },
            {
              type: 'image' as const,
              data: photo.data.toString('base64'),
              mimeType: photo.mediaType,
            },
          ],
          structuredContent: value,
        };
      })
  );

  server.registerTool(
    'export_contacts',
    {
      title: 'Export contacts as vCard text',
      description:
        'The raw vCard text of one or more contacts, exactly as stored. The ' +
        'only way to see a property this server does not model, and the only ' +
        'way to take a backup of an address book from here.',
      inputSchema: z.object({
        ids: z
          .array(entityId)
          .min(1)
          .max(100)
          .optional()
          .describe('Specific contacts. Leave out to export a whole book.'),
        address_book: addressBookRef
          .optional()
          .describe('Export every card in this address book.'),
        limit: limitParam,
      }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        vcards: z.array(
          z.object({ id: z.string(), vcard: z.string() }).meta({
            additionalProperties: true,
          })
        ),
        count: z.number().int(),
        notes,
      }),
    },
    async (args) =>
      run(async () => {
        if ((args.ids === undefined) === (args.address_book === undefined)) {
          throw new ToolInputError(
            'carddav-mcp: pass either ids or address_book, not both and not ' +
              'neither.'
          );
        }
        const limit = boundedLimit(
          args.limit,
          context.config.maxEntries,
          MAX_MAX_ENTRIES
        );
        const { registry } = await resolveBooks(context);
        const collected: string[] = [];
        const exported: { id: string; vcard: string }[] = [];

        if (args.ids !== undefined) {
          // One GET per id, sequentially, and each one carries its own 30-second
          // timeout and its own 1 MiB read ceiling. Up to a hundred of those is
          // fifty minutes and a hundred megabytes in the worst case, spent
          // fetching cards the budget is about to drop anyway — so stop at the
          // point where the answer can no longer grow. `limit` is the caller's
          // ceiling on entries; `MAX_RESULT_BYTES` is the ceiling on the answer.
          let bytes = 0;
          for (const id of args.ids) {
            if (exported.length >= limit || bytes > MAX_RESULT_BYTES) break;
            const loaded = await loadById(context, registry, id);
            bytes += loaded.vcf.length;
            exported.push({ id, vcard: loaded.vcf });
          }
          const unread = args.ids.length - exported.length;
          if (unread > 0) {
            collected.push(
              `${unread} of the ${args.ids.length} ids were not fetched: the ` +
                'answer was already full. Ask for them in a second call.'
            );
          }
        } else {
          const book = registry.resolve(args.address_book as string);
          // The whole card, not the summary projection: an export that dropped
          // the properties this server does not model would be a backup that
          // silently loses data, which is the one thing an export must not be.
          for (const document of await listCards(context.api, [book])) {
            exported.push({
              id: buildEntityId(book.path, document.resourceName),
              vcard: document.vcf,
            });
          }
        }

        const { shown, dropped } = applyLimit(exported, limit);
        if (dropped > 0) collected.push(limitNote(dropped, limit));

        return untrustedResult(
          {
            vcards: shown,
            count: shown.length,
            ...(collected.length > 0 ? { notes: collected } : {}),
          },
          'Export fewer contacts at a time with `limit`, or name ids.'
        );
      })
  );

  server.registerTool(
    'list_changes',
    {
      title: 'What changed in an address book',
      description:
        'Cards created, changed or deleted since a sync token, using RFC ' +
        '6578. Call it once without a token to get the current token, then ' +
        'again later with it. Not every server implements this — ' +
        'get_server_info reports whether this one does.',
      inputSchema: z.object({
        address_book: addressBookRef,
        sync_token: z
          .string()
          .max(2048)
          .optional()
          .describe(
            'The token from a previous call. Left out, this returns the ' +
              'current token and every card, which is the initial sync.'
          ),
        limit: limitParam,
      }),
      annotations: READ_ONLY,
      // This server's own words: a list of ids and statuses, with no card
      // content in it at all. The marker would mean nothing here.
      outputSchema: z.object({
        address_book: z.string(),
        sync_token: z
          .string()
          .optional()
          .describe('Pass this to the next call.'),
        changed: z.array(
          z
            .object({ id: z.string(), etag: z.string().optional() })
            .meta({ additionalProperties: true })
        ),
        removed: z.array(z.string()).describe('Ids of cards that are gone.'),
        count: z
          .number()
          .int()
          .describe('Entries in this answer, after any limit was applied.'),
        total: z
          .number()
          .int()
          .describe('Entries the server reported, before the limit.'),
        notes,
      }),
    },
    async (args) =>
      run(async () => {
        const { registry } = await resolveBooks(context);
        const book = registry.resolve(args.address_book);
        const { responses, syncToken } = await context.api.syncReport(
          book.url,
          syncCollectionBody(args.sync_token)
        );

        const changed: { id: string; etag?: string }[] = [];
        const removed: string[] = [];
        for (const response of responses) {
          const name = resourceNameOf(response.href, context.api, book);
          if (name === '') continue;
          const id = buildEntityId(book.path, name);
          // A 404 status on a response inside a sync report is how RFC 6578
          // reports a removal — the resource is named so a client can forget
          // it, not because the request failed.
          if (/\b404\b/.test(String(response.status ?? ''))) {
            removed.push(id);
            continue;
          }
          // Through `textOf` like every other property this server reads out
          // of a multistatus, rather than straight off `props`: that is where
          // the entity decoding and the attribute-shaped-value refusal live,
          // and an ETag read raw arrives with its `&quot;` still in it.
          // Cleaned for the same reason every etag in `shape.ts` is: the value
          // is the DAV server's, of no fixed length and no fixed alphabet, and
          // this is the result that carries no untrusted marker — so an
          // unbounded string here is an unmarked one, once per card.
          const etag = sanitizeShortText(textOf(response.props.getetag) ?? '');
          changed.push({
            id,
            ...(etag === '' ? {} : { etag }),
          });
        }

        // The limit spans both lists, because the caller's concern is how much
        // comes back, not which of the two halves it came from. `changed` is
        // served first — a card that still exists is more actionable than the
        // id of one that is gone — and `removed` takes whatever is left.
        //
        // Without this, the documented first call ("call it once without a
        // token") returns one entry per card in the collection. On a company
        // address book that is the whole book, and RFC 6578 puts no ceiling on
        // it: measured at 20 000 entries the answer was 2.97 MB.
        const total = changed.length + removed.length;
        const limit = boundedLimit(
          args.limit,
          context.config.maxEntries,
          MAX_MAX_ENTRIES
        );
        const changedShown = applyLimit(changed, limit);
        const removedShown = applyLimit(
          removed,
          Math.max(0, limit - changedShown.shown.length)
        );
        const dropped = changedShown.dropped + removedShown.dropped;

        const collected: string[] = [];
        if (args.sync_token === undefined) {
          collected.push(
            'No token was passed, so this is an initial synchronisation: ' +
              'every card in the book is reported as changed. Keep the ' +
              'sync_token and pass it next time.'
          );
        }
        if (dropped > 0) {
          collected.push(
            `${dropped} more entr${dropped === 1 ? 'y' : 'ies'} changed than ` +
              `the limit of ${limit}. Raise limit to see them — do **not** ` +
              'keep the sync_token from this call as if it were complete, ' +
              'because the entries left out here will not be reported again.'
          );
        }
        if (syncToken === undefined) {
          collected.push(
            'The server answered without a sync token, so the next call ' +
              'cannot be incremental. That usually means it does not ' +
              'implement RFC 6578.'
          );
        }

        return ownWordsResult(
          {
            address_book: book.path,
            ...(syncToken === undefined ? {} : { sync_token: syncToken }),
            changed: changedShown.shown,
            removed: removedShown.shown,
            count: changedShown.shown.length + removedShown.shown.length,
            total,
            ...(collected.length > 0 ? { notes: collected } : {}),
          },
          'Ask for fewer entries with `limit`, then call again with the same ' +
            'sync_token to pick up the rest.'
        );
      })
  );
}
