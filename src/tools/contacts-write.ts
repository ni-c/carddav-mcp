import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Approver, ConfirmationStore } from 'mcp-approval';

import { escapeInvisible, sanitizeShortText } from '../analyze.js';
import { notes, shapedContact, untrustedFields } from '../output-schema.js';
import {
  errorResult,
  ownWordsResult,
  run,
  untrustedResult,
} from '../result.js';
import { shapeFull } from '../shape.js';
import {
  addressBookRef,
  addressInput,
  cardText,
  confirmTokenParam,
  dateInput,
  entityId,
  rawVCard,
  shortText,
  typedInput,
} from '../schema.js';
import { assertNotGroup } from '../groups.js';
import { readText } from '../vcard.js';
import {
  applyFields,
  blankCard,
  cardFromRaw,
  changeDigest,
  changedFieldNames,
  createCard,
  deleteCard,
  hasAnyField,
  orderedResourceKey,
  replaceCard,
  textDigest,
  type ContactFields,
} from '../write.js';
import { CREATE, DELETE, MOVE, REPLACE } from './annotations.js';
import { loadById, resolveBooks, type ToolContext } from './common.js';

/**
 * The write tools for contacts.
 *
 * Three of the four ask a person first. `create_contact` does not: it adds
 * something that was not there, nothing is lost if it turns out to be wrong,
 * and `delete_contact` is one call away. The other three all destroy something
 * — CardDAV keeps no history, so an overwritten card is gone in the same sense
 * a deleted one is.
 *
 * **No text out of a card ever reaches a confirmation dialog.** Not the name,
 * not the organisation, not the note. That text is read by a model at the
 * moment it is deciding whether to proceed, which makes it the highest-value
 * place in the whole server to put an instruction. The dialogs name the address
 * book path and counts this server computed, and nothing else; a test asserts a
 * hostile card's `FN` never appears in a prompt.
 */
export function registerContactWriteTools(
  server: McpServer,
  context: ToolContext,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  const fieldSchema = {
    formatted_name: shortText
      .nullable()
      .optional()
      .describe(
        'FN, the display name. Derived from the name parts when left out on ' +
          'create. Null removes it, which no valid card may be without.'
      ),
    given_name: shortText.nullable().optional(),
    family_name: shortText.nullable().optional(),
    additional_names: shortText.nullable().optional(),
    name_prefix: shortText.nullable().optional().describe('Dr, Prof.'),
    name_suffix: shortText.nullable().optional().describe('Jr, PhD.'),
    nickname: shortText.nullable().optional(),
    organization: shortText.nullable().optional(),
    department: shortText.nullable().optional(),
    title: shortText.nullable().optional().describe('Job title.'),
    role: shortText.nullable().optional(),
    emails: z.array(typedInput).max(50).nullable().optional(),
    phones: z.array(typedInput).max(50).nullable().optional(),
    urls: z.array(typedInput).max(50).nullable().optional(),
    instant_messaging: z.array(typedInput).max(50).nullable().optional(),
    addresses: z.array(addressInput).max(20).nullable().optional(),
    birthday: dateInput.nullable().optional(),
    anniversary: dateInput.nullable().optional(),
    note: cardText.nullable().optional(),
    categories: z.array(shortText).max(50).nullable().optional(),
  };

  server.registerTool(
    'create_contact',
    {
      title: 'Add a contact',
      description:
        'Adds a card to an address book. The UID and the file name are ' +
        'generated here. The vCard version follows what the address book ' +
        'accepts — 3.0 unless it says otherwise, because that is what phones ' +
        'and desktop clients read completely.',
      inputSchema: z.object({
        address_book: addressBookRef,
        ...fieldSchema,
        raw_vcard: rawVCard
          .optional()
          .describe(
            'A complete vCard to store as-is, instead of the fields above. ' +
              'For properties this server does not model.'
          ),
      }),
      annotations: CREATE,
      outputSchema: z.object({
        ...untrustedFields,
        contact: shapedContact,
        created: z.literal(true),
        notes,
      }),
    },
    async (args) =>
      run(async () => {
        const { registry } = await resolveBooks(context);
        const book = registry.resolve(args.address_book);
        const fields = pickFields(args);

        let card;
        let collected: string[] = [];
        if (args.raw_vcard !== undefined) {
          if (hasAnyField(fields)) {
            return errorResult(
              'carddav-mcp: pass either raw_vcard or the named fields, not ' +
                'both. A raw card is the whole card; mixing the two leaves it ' +
                'unclear which wins.'
            );
          }
          card = cardFromRaw(args.raw_vcard);
        } else {
          if (!hasAnyField(fields)) {
            return errorResult(
              'carddav-mcp: nothing to create — pass at least a name.'
            );
          }
          card = blankCard(book);
          collected = applyFields(card, fields).notes;
        }

        const { resourceName, etag } = await createCard(
          context.api,
          book,
          card
        );
        return untrustedResult({
          contact: shapeFull(card, book, resourceName, etag),
          created: true as const,
          ...(collected.length > 0 ? { notes: collected } : {}),
        });
      })
  );

  server.registerTool(
    'update_contact',
    {
      title: 'Change a contact',
      description:
        'Changes the fields named and leaves everything else exactly as it ' +
        'was — including properties this server does not model. Guarded by ' +
        'the card’s ETag, so a change made elsewhere in the meantime is ' +
        'refused rather than overwritten. A CardDAV server keeps no version ' +
        'history, so a person is asked first.',
      inputSchema: z.object({
        id: entityId,
        ...fieldSchema,
        raw_vcard: rawVCard
          .optional()
          .describe(
            'Replace the whole card with this one. Unlike the named fields, ' +
              'this does not merge — anything not in it is gone.'
          ),
        confirm_token: confirmTokenParam,
      }),
      annotations: REPLACE,
      outputSchema: z.object({
        ...untrustedFields,
        contact: shapedContact,
        updated: z.literal(true),
        changed_fields: z.array(z.string()),
        notes,
      }),
    },
    async (args, mcp) =>
      run(async () => {
        const { registry } = await resolveBooks(context);
        const fields = pickFields(args);
        if (args.raw_vcard === undefined && !hasAnyField(fields)) {
          return errorResult(
            'carddav-mcp: nothing to update — name at least one field, or ' +
              'pass raw_vcard.'
          );
        }
        if (args.raw_vcard !== undefined && hasAnyField(fields)) {
          return errorResult(
            'carddav-mcp: pass either raw_vcard or the named fields, not ' +
              'both. A raw card replaces the whole thing; the named fields ' +
              'merge into it, and the two cannot both be what was meant.'
          );
        }

        // Read before asking, so the dialog describes the card that actually
        // exists rather than what the id claims about it.
        const loaded = await loadById(context, registry, args.id, true);
        assertNotGroup(loaded.card, 'update_contact');
        // Parsed before anybody is asked: a raw card that does not parse, or
        // that turns out to be a group, is refused without spending a dialog
        // on it — and the person is asked about the card that will be written.
        const replacement =
          args.raw_vcard === undefined
            ? undefined
            : cardFromRaw(args.raw_vcard);

        const changed =
          args.raw_vcard === undefined
            ? changedFieldNames(fields)
            : ['the whole card'];
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what:
              args.raw_vcard === undefined
                ? `replace ${changed.length} field(s) on a contact`
                : 'replace a contact card in full',
            consequence:
              'A CardDAV server keeps no version history, so the previous ' +
              'values cannot be recovered from here.' +
              (args.raw_vcard === undefined
                ? ''
                : ' Every property not in the new card is removed, including ' +
                  'any photo.'),
            resourceKey: orderedResourceKey('update_contact', [
              loaded.entity.bookPath,
              loaded.entity.resourceName,
              args.raw_vcard === undefined
                ? changeDigest(fields)
                : `raw:${textDigest(args.raw_vcard)}`,
            ]),
            token: args.confirm_token,
            toolName: 'update_contact',
            title: 'Change this contact?',
            hint: 'Tick to change it, leave it to cancel.',
            details: [
              {
                label: 'Address book',
                value: escapeInvisible(loaded.book.path),
              },
              { label: 'Fields', value: changed.join(', ') },
            ],
          }
        );
        if (outcome.decision === 'rejected') return errorResult(outcome.reason);
        if (outcome.decision === 'declined') {
          return errorResult(
            'The user declined. update_contact changed nothing.'
          );
        }
        if (outcome.decision === 'pending') return outcome.result;

        let collected: string[] = [];
        let card = loaded.card;
        if (replacement === undefined) {
          collected = applyFields(card, fields).notes;
        } else {
          card = replacement;
          // The UID is the card's identity in every group that references it,
          // so a replacement keeps the one already stored rather than the one
          // the caller happened to paste. Otherwise every group naming this
          // person quietly loses them.
          const uid = readText(loaded.card, 'uid');
          if (uid !== undefined) {
            card.updatePropertyWithValue('uid', uid);
            collected.push(
              'The stored UID was kept rather than the one in raw_vcard, so ' +
                'any group referring to this contact still finds it.'
            );
          }
        }

        const { etag } = await replaceCard(
          context.api,
          loaded.book,
          loaded.entity.resourceName,
          card,
          loaded.etag
        );
        return untrustedResult({
          contact: shapeFull(
            card,
            loaded.book,
            loaded.entity.resourceName,
            etag
          ),
          updated: true as const,
          changed_fields: changed,
          ...(collected.length > 0 ? { notes: collected } : {}),
        });
      })
  );

  server.registerTool(
    'delete_contact',
    {
      title: 'Delete a contact',
      description:
        'Removes a card. Cannot be undone — a CardDAV server has no trash and ' +
        'no version history. Guarded by the card’s ETag, so a card changed ' +
        'since it was read is refused rather than deleted blind.',
      inputSchema: z.object({
        id: entityId,
        confirm_token: confirmTokenParam,
      }),
      annotations: DELETE,
      outputSchema: z.object({
        deleted: z.literal(true),
        id: z.string(),
        address_book: z.string(),
      }),
    },
    async (args, mcp) =>
      run(async () => {
        const { registry } = await resolveBooks(context);
        const loaded = await loadById(context, registry, args.id, true);
        // A group is refused here, as `update_contact` and `move_contact`
        // refuse one. This tool used to delete a group card too, with an
        // honest dialog — and that made `delete_group` a capability that
        // `CARDDAV_DENY_TOOLS=delete_group` did not remove, because the
        // catalogue lists the two as separable and they were not.
        assertNotGroup(loaded.card, 'delete_contact');

        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: 'permanently delete a contact',
            consequence:
              'A CardDAV server has no trash. The card cannot be recovered ' +
              'from here.',
            resourceKey: orderedResourceKey('delete_contact', [
              loaded.entity.bookPath,
              loaded.entity.resourceName,
            ]),
            token: args.confirm_token,
            toolName: 'delete_contact',
            title: 'Delete this contact?',
            hint: 'Tick to delete it, leave it to cancel.',
            details: [
              {
                label: 'Address book',
                value: escapeInvisible(loaded.book.path),
              },
            ],
          }
        );
        if (outcome.decision === 'rejected') return errorResult(outcome.reason);
        if (outcome.decision === 'declined') {
          return errorResult(
            'The user declined. delete_contact deleted nothing.'
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
          // Own words, no untrusted marker: the path is the server's string
          // and is cleaned like every other one that lands in such an answer.
          address_book: sanitizeShortText(loaded.book.path),
        });
      })
  );

  server.registerTool(
    'move_contact',
    {
      title: 'Move a contact to another address book',
      description:
        'Copies a card into another address book and removes it from the ' +
        'first. The id changes, because an id names a card in a collection. ' +
        'There is no transaction behind this: the copy is verified before the ' +
        'original is removed.',
      inputSchema: z.object({
        id: entityId,
        destination: addressBookRef.describe(
          'The address book to move the card into.'
        ),
        confirm_token: confirmTokenParam,
      }),
      annotations: MOVE,
      outputSchema: z.object({
        ...untrustedFields,
        contact: shapedContact,
        moved: z.literal(true),
        previous_id: z.string(),
        notes,
      }),
    },
    async (args, mcp) =>
      run(async () => {
        const { registry } = await resolveBooks(context);
        const loaded = await loadById(context, registry, args.id, true);
        // Membership is stored as UIDs and resolved only within the group's
        // own book, so a group moved elsewhere arrives with every member
        // unresolvable — under a dialog that said "move a contact".
        assertNotGroup(loaded.card, 'move_contact');
        const destination = registry.resolve(args.destination);

        if (destination.path === loaded.book.path) {
          return errorResult(
            'carddav-mcp: the card is already in that address book.'
          );
        }
        // Validated before anybody is asked, so an approval is not spent on a
        // call that was going to be refused anyway.
        if (destination.readOnly) {
          return errorResult(
            `carddav-mcp: ${destination.path} is read-only for this account, ` +
              'so nothing can be moved into it.'
          );
        }

        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: 'move a contact to another address book',
            consequence:
              'The card is copied and then the original is deleted, with no ' +
              'transaction around the pair. Its id changes, so any id held ' +
              'from an earlier listing stops working.',
            // Ordered: with a set, an approval to move `x.vcf` from Work to
            // Private also authorised moving a card of that name from Private
            // to Work.
            resourceKey: orderedResourceKey('move_contact', [
              loaded.entity.bookPath,
              loaded.entity.resourceName,
              destination.path,
            ]),
            token: args.confirm_token,
            toolName: 'move_contact',
            title: 'Move this contact?',
            hint: 'Tick to move it, leave it to cancel.',
            details: [
              { label: 'From', value: escapeInvisible(loaded.book.path) },
              { label: 'To', value: escapeInvisible(destination.path) },
            ],
          }
        );
        if (outcome.decision === 'rejected') return errorResult(outcome.reason);
        if (outcome.decision === 'declined') {
          return errorResult('The user declined. move_contact moved nothing.');
        }
        if (outcome.decision === 'pending') return outcome.result;

        // Copy first. If the create fails the original is untouched, which is
        // the failure everybody would rather have: two copies is a mess a
        // person can fix, none is data loss.
        const { resourceName, etag } = await createCard(
          context.api,
          destination,
          loaded.card
        );

        const collected: string[] = [];
        try {
          await deleteCard(
            context.api,
            loaded.book,
            loaded.entity.resourceName,
            loaded.etag
          );
        } catch (error) {
          collected.push(
            'The copy succeeded but the original could not be removed, so ' +
              'the contact now exists in both address books. Delete the one ' +
              `at ${loaded.book.path} by hand. The server said: ` +
              `${error instanceof Error ? error.message : String(error)}`
          );
        }

        return untrustedResult({
          contact: shapeFull(loaded.card, destination, resourceName, etag),
          moved: true as const,
          previous_id: args.id,
          ...(collected.length > 0 ? { notes: collected } : {}),
        });
      })
  );
}

/**
 * The contact fields out of a tool's arguments.
 *
 * Written out rather than derived by omitting the non-field keys, so that a new
 * argument on a tool cannot accidentally become a field, and a new field that
 * is not listed here fails a test rather than being silently ignored.
 */
function pickFields(args: Record<string, unknown>): ContactFields {
  const out: ContactFields = {};
  const copy = <K extends keyof ContactFields>(key: K): void => {
    if (Object.hasOwn(args, key) && args[key] !== undefined) {
      out[key] = args[key] as ContactFields[K];
    }
  };
  copy('formatted_name');
  copy('given_name');
  copy('family_name');
  copy('additional_names');
  copy('name_prefix');
  copy('name_suffix');
  copy('nickname');
  copy('organization');
  copy('department');
  copy('title');
  copy('role');
  copy('emails');
  copy('phones');
  copy('urls');
  copy('instant_messaging');
  copy('addresses');
  copy('birthday');
  copy('anniversary');
  copy('note');
  copy('categories');
  return out;
}
