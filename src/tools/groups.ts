import { orderedResourceKey } from 'mcp-approval';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Approver, ConfirmationStore } from 'mcp-approval';

import { escapeInvisible, sanitizeShortText } from '../analyze.js';
import { MAX_MAX_ENTRIES } from '../config.js';
import { boundedLimit } from '../entries.js';
import { parseEntityId } from '../entity-id.js';
import type { AddressBookRegistry } from '../books.js';
import {
  assertGroup,
  duplicateUidNote,
  listGroups,
  memberIndex,
  modelFor,
  type MemberTarget,
} from '../groups.js';
import { notes, shapedGroup, untrustedFields } from '../output-schema.js';
import {
  errorResult,
  ownWordsResult,
  run,
  untrustedResult,
} from '../result.js';
import {
  addressBooksParam,
  addressBookRef,
  cardText,
  confirmTokenParam,
  entityId,
  limitParam,
  shortText,
} from '../schema.js';
import { shapeGroup } from '../shape.js';
import {
  markAsGroup,
  membersOf,
  memberUid,
  setMembers,
  versionOf,
} from '../vcard.js';
import {
  blankCard,
  createCard,
  deleteCard,
  keyPart,
  replaceCard,
} from '../write.js';
import { CREATE, DELETE, READ_ONLY, REPLACE } from './annotations.js';
import {
  applyLimit,
  limitNote,
  loadById,
  resolveBooks,
  type ToolContext,
} from './common.js';

/**
 * The group tools.
 *
 * A group is a vCard with a marker property, not a collection, so all of this
 * is a listing with a filter and a membership list on top. The one genuine
 * complication is that there are two incompatible ways to write a group — see
 * `groupModelOf` in `vcard.ts` — and this server reads both and writes whatever
 * the surrounding address book already uses, because a group written in the
 * other convention is invisible in the client the person is looking at.
 *
 * Membership is stored as UIDs, not as paths. That is what makes it survive a
 * card being moved, and it is also why `create_group` and `update_group` take
 * contact **ids** and translate: an id is what the listing tools hand out, and
 * asking a caller for a UID would mean asking them to open every card first.
 */
export function registerGroupReadTools(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    'list_groups',
    {
      title: 'List contact groups',
      description:
        'Groups in one or more address books, with how many members each has. ' +
        'The members themselves are not resolved here — that is one extra ' +
        'request per book, and get_group is where a caller has said they want ' +
        'the names.',
      inputSchema: z.object({
        address_books: addressBooksParam,
        limit: limitParam,
      }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        groups: z.array(shapedGroup),
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
        const listed = await listGroups(context.api, books);

        // Shaping inside a guard as well, as list_contacts does. A card that
        // parses and then fails to shape is one bad card among many, not a
        // reason to answer nothing; the unparseable ones were already counted
        // and the shaping failures join the same count.
        let unreadable = listed.unreadable;
        const shaped: Record<string, unknown>[] = [];
        for (const group of listed.groups) {
          try {
            shaped.push(
              shapeGroup(
                group.card,
                group.document.book,
                group.document.resourceName,
                group.document.etag,
                () => undefined
              )
            );
          } catch {
            unreadable += 1;
          }
        }
        shaped.sort((left, right) =>
          String(left.name ?? '').localeCompare(String(right.name ?? ''))
        );

        const collected: string[] = [];
        const { shown, dropped } = applyLimit(shaped, limit);
        if (dropped > 0) collected.push(limitNote(dropped, limit));
        if (unreadable > 0) {
          collected.push(
            `${unreadable} card(s) could not be read and were left out.`
          );
        }

        return untrustedResult({
          groups: shown,
          count: shown.length,
          address_books: books.map((book) => book.path),
          ...(collected.length > 0 ? { notes: collected } : {}),
        });
      })
  );

  server.registerTool(
    'get_group',
    {
      title: 'Read one group, with its members',
      description:
        'A group card and the contacts in it, resolved to names and ids where ' +
        'the members live in the same address book. A member this server ' +
        'cannot resolve is still reported, as the reference the card holds.',
      inputSchema: z.object({ id: entityId }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        group: shapedGroup,
        unresolved: z
          .number()
          .int()
          .describe(
            'Members naming something this address book does not contain — a ' +
              'card that was deleted, or a mailto: reference.'
          ),
        notes,
      }),
    },
    async (args) =>
      run(async () => {
        const { registry } = await resolveBooks(context);
        const loaded = await loadById(context, registry, args.id);
        assertGroup(loaded.card, 'get_group');
        const { index, duplicates } = await memberIndex(
          context.api,
          loaded.book
        );

        const shaped = shapeGroup(
          loaded.card,
          loaded.book,
          loaded.entity.resourceName,
          loaded.etag,
          (uid) => index.get(uid)
        );
        const members = (shaped.members ?? []) as Record<string, unknown>[];
        const unresolved = members.filter(
          (member) => member.id === undefined
        ).length;

        const collected: string[] = [];
        if (duplicates > 0) collected.push(duplicateUidNote(duplicates));
        if (unresolved > 0) {
          collected.push(
            `${unresolved} member(s) could not be resolved in this address ` +
              'book. A group can name a contact that has since been deleted, ' +
              'and vCard 4.0 also allows a mailto: member, which is an ' +
              'address rather than a card.'
          );
        }

        return untrustedResult({
          group: shaped,
          unresolved,
          ...(collected.length > 0 ? { notes: collected } : {}),
        });
      })
  );
}

/**
 * The write half, registered only when `CARDDAV_READ_ONLY` is unset.
 *
 * Separate from the read half rather than gated inside one registrar: read-only
 * mode must not *register* a write tool, because a tool that is listed and then
 * refuses is a capability advertised and withdrawn.
 */
export function registerGroupWriteTools(
  server: McpServer,
  context: ToolContext,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'create_group',
    {
      title: 'Create a contact group',
      description:
        'Creates a group card and puts the named contacts in it. The ' +
        'convention follows whatever groups the address book already uses, ' +
        'because a group written the other way is invisible in the client ' +
        'the person is actually looking at.',
      inputSchema: z.object({
        address_book: addressBookRef,
        name: shortText.describe('The group’s display name.'),
        note: cardText.optional(),
        members: z
          .array(entityId)
          .max(500)
          .optional()
          .describe('Contact ids to put in the group.'),
      }),
      annotations: CREATE,
      outputSchema: z.object({
        ...untrustedFields,
        group: shapedGroup,
        created: z.literal(true),
        notes,
      }),
    },
    async (args) =>
      run(async () => {
        const { registry } = await resolveBooks(context);
        const book = registry.resolve(args.address_book);
        const card = blankCard(book);

        const { groups } = await listGroups(context.api, [book]);
        const model = modelFor(groups, versionOf(card));
        markAsGroup(card, model);
        card.updatePropertyWithValue('fn', args.name);
        if (args.note !== undefined) {
          card.updatePropertyWithValue('note', args.note);
        }

        const { index, duplicates } = await memberIndex(context.api, book);
        const { uids, missing } = resolveMembers(
          registry,
          book.path,
          index,
          args.members ?? []
        );
        setMembers(card, model, uids);

        const { resourceName, etag } = await createCard(
          context.api,
          book,
          card
        );

        const collected: string[] = [];
        if (groups.length === 0) {
          collected.push(
            `This address book had no groups yet, so the ${model} convention ` +
              'was chosen from its vCard version. Later groups will follow ' +
              'this one.'
          );
        }
        if (missing.length > 0) {
          collected.push(
            `${missing.length} of the ids given are not in this address book ` +
              'and were left out. A group can only contain cards from the ' +
              'book it lives in.'
          );
        }
        if (duplicates > 0) collected.push(duplicateUidNote(duplicates));

        return untrustedResult({
          group: shapeGroup(card, book, resourceName, etag, (uid) =>
            index.get(uid)
          ),
          created: true as const,
          ...(collected.length > 0 ? { notes: collected } : {}),
        });
      })
  );

  server.registerTool(
    'update_group',
    {
      title: 'Rename a group or change who is in it',
      description:
        'Changes a group’s name or note, and adds or removes members. ' +
        'Removing a member removes the grouping only — the contact itself is ' +
        'untouched. A CardDAV server keeps no version history, so a person is ' +
        'asked first.',
      inputSchema: z.object({
        id: entityId,
        name: shortText.optional(),
        note: cardText.nullable().optional(),
        add_members: z.array(entityId).max(500).optional(),
        remove_members: z.array(entityId).max(500).optional(),
        set_members: z
          .array(entityId)
          .max(500)
          .optional()
          .describe(
            'Replace the membership outright with exactly these contacts. ' +
              'Cannot be combined with add_members or remove_members.'
          ),
        confirm_token: confirmTokenParam,
      }),
      annotations: REPLACE,
      outputSchema: z.object({
        ...untrustedFields,
        group: shapedGroup,
        updated: z.literal(true),
        added: z.number().int(),
        removed: z.number().int(),
        notes,
      }),
    },
    async (args, mcp) =>
      run(async () => {
        const wantsSet = args.set_members !== undefined;
        const wantsDelta =
          args.add_members !== undefined || args.remove_members !== undefined;
        if (wantsSet && wantsDelta) {
          return errorResult(
            'carddav-mcp: pass either set_members or add_members/' +
              'remove_members, not both.'
          );
        }
        if (
          args.name === undefined &&
          args.note === undefined &&
          !wantsSet &&
          !wantsDelta
        ) {
          return errorResult(
            'carddav-mcp: nothing to update — pass a name, a note, or a ' +
              'membership change.'
          );
        }

        const { registry } = await resolveBooks(context);
        const loaded = await loadById(context, registry, args.id, true);
        const model = assertGroup(loaded.card, 'update_group');
        const { index, duplicates } = await memberIndex(
          context.api,
          loaded.book
        );

        const current = membersOf(loaded.card)
          .map((reference) => memberUid(reference))
          .filter((uid): uid is string => uid !== undefined);

        const resolveList = (
          ids: readonly string[] | undefined
        ): { uids: string[]; missing: string[] } =>
          ids === undefined
            ? { uids: [], missing: [] }
            : resolveMembers(registry, loaded.book.path, index, ids);

        const add = resolveList(args.add_members);
        const remove = resolveList(args.remove_members);
        const set = resolveList(args.set_members);

        const next = wantsSet
          ? [...new Set(set.uids)]
          : [
              ...new Set([
                ...current.filter((uid) => !remove.uids.includes(uid)),
                ...add.uids,
              ]),
            ];
        const added = next.filter((uid) => !current.includes(uid)).length;
        const removedCount = current.filter(
          (uid) => !next.includes(uid)
        ).length;

        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what:
              removedCount > 0
                ? `change a group and remove ${removedCount} member(s) from it`
                : 'change a group',
            consequence:
              'A CardDAV server keeps no version history, so the previous ' +
              'name, note and membership cannot be recovered from here. The ' +
              'contacts themselves are not deleted.',
            // Ordered, not a set: `keyPart(name)` and `keyPart(note)` are both
            // spelled `s:<text>`, and under `setResourceKey`'s sort a token
            // for `{name: "Team", note: "internal"}` also executed
            // `{name: "internal", note: "Team"}`.
            resourceKey: orderedResourceKey('update_group', [
              loaded.entity.bookPath,
              loaded.entity.resourceName,
              // The exact membership the write would produce, so a token
              // issued for one change cannot execute a different one. As a
              // JSON array rather than joined: a UID is a string the card
              // chose and may contain the separator.
              JSON.stringify(next.toSorted()),
              // Three states, three distinct spellings. `undefined` used to
              // encode as the empty string and `null` as `' null'`, which made
              // "leave the name alone" and "set the name to empty" the same
              // resource key -- so a token issued for a rename also executed a
              // `note: ""`, and `removeAllProperties('note')` below destroyed a
              // note nothing had warned about.
              keyPart(args.name),
              keyPart(args.note),
            ]),
            token: args.confirm_token,
            toolName: 'update_group',
            title: 'Change this group?',
            hint: 'Tick to change it, leave it to cancel.',
            details: [
              {
                label: 'Address book',
                value: escapeInvisible(loaded.book.path),
              },
              { label: 'Members after', value: String(next.length) },
              { label: 'Added', value: String(added) },
              { label: 'Removed', value: String(removedCount) },
            ],
          }
        );
        if (outcome.decision === 'rejected') return errorResult(outcome.reason);
        if (outcome.decision === 'declined') {
          return errorResult(
            'The user declined. update_group changed nothing.'
          );
        }
        if (outcome.decision === 'pending') return outcome.result;

        if (args.name !== undefined) {
          loaded.card.updatePropertyWithValue('fn', args.name);
        }
        if (args.note !== undefined) {
          loaded.card.removeAllProperties('note');
          if (args.note !== null) {
            loaded.card.updatePropertyWithValue('note', args.note);
          }
        }
        if (wantsSet || wantsDelta) setMembers(loaded.card, model, next);

        const { etag } = await replaceCard(
          context.api,
          loaded.book,
          loaded.entity.resourceName,
          loaded.card,
          loaded.etag
        );

        const missing = [...add.missing, ...remove.missing, ...set.missing];
        const collected: string[] = [];
        if (missing.length > 0) {
          collected.push(
            `${missing.length} of the ids given are not in this address book ` +
              'and were ignored. A group can only contain cards from the book ' +
              'it lives in.'
          );
        }
        if (duplicates > 0) collected.push(duplicateUidNote(duplicates));

        return untrustedResult({
          group: shapeGroup(
            loaded.card,
            loaded.book,
            loaded.entity.resourceName,
            etag,
            (uid) => index.get(uid)
          ),
          updated: true as const,
          added,
          removed: removedCount,
          ...(collected.length > 0 ? { notes: collected } : {}),
        });
      })
  );

  server.registerTool(
    'delete_group',
    {
      title: 'Delete a contact group',
      description:
        'Removes a group card. The contacts that were in it are not touched ' +
        '— only the grouping goes. Cannot be undone.',
      inputSchema: z.object({
        id: entityId,
        confirm_token: confirmTokenParam,
      }),
      annotations: DELETE,
      outputSchema: z.object({
        deleted: z.literal(true),
        id: z.string(),
        address_book: z.string(),
        members_released: z
          .number()
          .int()
          .describe('How many contacts were in the group. None was deleted.'),
      }),
    },
    async (args, mcp) =>
      run(async () => {
        const { registry } = await resolveBooks(context);
        const loaded = await loadById(context, registry, args.id, true);
        assertGroup(loaded.card, 'delete_group');
        const count = membersOf(loaded.card).length;

        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `delete a group of ${count} contact(s)`,
            consequence:
              'The contacts stay in the address book; only the grouping is ' +
              'removed. A CardDAV server has no trash, so the group cannot be ' +
              'recovered from here.',
            resourceKey: orderedResourceKey('delete_group', [
              loaded.entity.bookPath,
              loaded.entity.resourceName,
            ]),
            token: args.confirm_token,
            toolName: 'delete_group',
            title: 'Delete this group?',
            hint: 'Tick to delete it, leave it to cancel.',
            details: [
              {
                label: 'Address book',
                value: escapeInvisible(loaded.book.path),
              },
              { label: 'Members', value: String(count) },
            ],
          }
        );
        if (outcome.decision === 'rejected') return errorResult(outcome.reason);
        if (outcome.decision === 'declined') {
          return errorResult(
            'The user declined. delete_group deleted nothing.'
          );
        }
        if (outcome.decision === 'pending') return outcome.result;

        await deleteCard(
          context.api,
          loaded.book,
          loaded.entity.resourceName,
          loaded.etag
        );
        return ownWordsResult({
          deleted: true as const,
          id: args.id,
          // This server's own words carry no untrusted marker, and the path is
          // the server's string — cleaned, like every other server string
          // that lands in an unmarked answer.
          address_book: sanitizeShortText(loaded.book.path),
          members_released: count,
        });
      })
  );
}

/**
 * Turns contact ids into the UIDs a group card stores.
 *
 * Ids are resolved through the index rather than by fetching each card: a group
 * of two hundred people would otherwise be two hundred GETs. The index is built
 * from one REPORT over the same address book, which is also what enforces the
 * rule that a group may only contain cards from its own book — an id from
 * another book simply is not in the index, and it is reported as missing rather
 * than written as a reference that resolves to nothing.
 *
 * The id is still parsed first, so the address book allowlist applies to it:
 * `parseEntityId` is what performs that check, and skipping it here would make
 * membership the one place a fenced-off path could be named.
 */
function resolveMembers(
  registry: AddressBookRegistry,
  bookPath: string,
  index: Map<string, MemberTarget>,
  ids: readonly string[]
): { uids: string[]; missing: string[] } {
  const uids: string[] = [];
  const missing: string[] = [];
  const byId = new Map<string, string>();
  for (const [uid, target] of index) byId.set(target.id, uid);

  for (const id of ids) {
    // Parsed rather than string-compared, so the address book allowlist
    // applies to a membership change exactly as it applies to everything else.
    // Skipping it here would make membership the one place a fenced-off path
    // could be named.
    const entity = parseEntityId(id, registry);
    const uid = entity.bookPath === bookPath ? byId.get(id) : undefined;
    if (uid === undefined) {
      missing.push(id);
      continue;
    }
    uids.push(uid);
  }
  return { uids, missing };
}
