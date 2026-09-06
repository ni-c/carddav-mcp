import type { CardDavApi } from './api.js';
import type { AddressBookEntry } from './books.js';
import { GROUP_PROPS, SUMMARY_PROPS } from './dav-xml.js';
import { buildEntityId } from './entity-id.js';
import { ToolInputError } from './errors.js';
import { listCards, type ResourceDocument } from './entries.js';
import {
  groupModelOf,
  isGroup,
  parseVCard,
  readText,
  versionOf,
  type GroupModel,
  type ICAL,
} from './vcard.js';

/**
 * Groups, and the two incompatible conventions for writing one.
 *
 * A group is an ordinary vCard in an ordinary address book, distinguished only
 * by a property — which means every group tool is a listing with a filter on
 * top, and there is no collection to address. See `groupModelOf` in `vcard.ts`
 * for why there are two conventions and why this server speaks both.
 */

/** A group card, parsed, with the document it came from. */
export interface GroupDocument {
  document: ResourceDocument;
  card: ICAL.Component;
  model: GroupModel;
}

/**
 * Every group in the named address books.
 *
 * Retrieved with `GROUP_PROPS` rather than the whole card: a group's payload is
 * its membership, and pulling the photos of a hundred contacts to find the
 * three groups among them is the kind of thing nobody notices until an address
 * book gets big.
 *
 * A card that fails to parse is skipped rather than fatal. A listing is not the
 * place to surface somebody's decade-old broken export, and the alternative is
 * a tool that answers nothing at all because one card in the book is bad.
 */
export async function listGroups(
  api: CardDavApi,
  books: readonly AddressBookEntry[]
): Promise<{ groups: GroupDocument[]; unreadable: number }> {
  const documents = await listCards(api, books, GROUP_PROPS);
  const groups: GroupDocument[] = [];
  let unreadable = 0;
  for (const document of documents) {
    let card: ICAL.Component;
    try {
      card = parseVCard(document.vcf, 'a card in the address book');
    } catch {
      unreadable += 1;
      continue;
    }
    const model = groupModelOf(card);
    if (model === undefined) continue;
    groups.push({ document, card, model });
  }
  return { groups, unreadable };
}

/** What a member reference resolves to, when the member is in the same book. */
export interface MemberTarget {
  id: string;
  name: string | undefined;
}

/**
 * A UID index for one address book, for resolving group membership.
 *
 * Built with `SUMMARY_PROPS`, so this is one extra REPORT per book and not a
 * fetch of every card. `list_groups` deliberately does not build one — it
 * reports `member_count` and nothing else, and `get_group` is where a caller
 * has said they want the names.
 */
export async function memberIndex(
  api: CardDavApi,
  book: AddressBookEntry
): Promise<Map<string, MemberTarget>> {
  const index = new Map<string, MemberTarget>();
  for (const document of await listCards(api, [book], SUMMARY_PROPS)) {
    let card: ICAL.Component;
    try {
      card = parseVCard(document.vcf, 'a card in the address book');
    } catch {
      continue;
    }
    const uid = readText(card, 'uid');
    if (uid === undefined) continue;
    index.set(uid, {
      id: buildEntityId(book.path, document.resourceName),
      name: readText(card, 'fn'),
    });
  }
  return index;
}

/**
 * Which convention a new group in this book should be written in.
 *
 * The existing groups decide, because a group written in the other convention
 * is invisible to the client the person is actually looking at — Apple Contacts
 * does not read `KIND:group`, and a 4.0-only reader does not read
 * `X-ADDRESSBOOKSERVER-KIND`. Where a book has no groups yet there is nothing
 * to match, so the collection's own vCard version decides: `apple` for a 3.0
 * book, which is both the default and the broader of the two.
 */
export function modelFor(
  existing: readonly GroupDocument[],
  version: string
): GroupModel {
  const models = new Set(existing.map((group) => group.model));
  if (models.size === 1) {
    const [only] = [...models];
    if (only !== undefined) return only;
  }
  // Either no groups at all, or a book that already mixes both. Mixing is the
  // case where following "what is there" has no answer, and picking the wider
  // convention is the least surprising thing to do.
  return version === '4.0' ? 'rfc' : 'apple';
}

/**
 * Refuses an id that turned out to name a contact rather than a group.
 *
 * Both of these are reached from *always-registered* read tools — `get_group`
 * calls this one, `get_contact` calls its twin below — so the way out they
 * suggest may only name a tool that is always there too. They used to list the
 * write tools as well, which under `CARDDAV_READ_ONLY=true`, or under
 * `CARDDAV_ALLOW_TOOLS=essential` (which drops the group surface entirely),
 * sent the model after tools missing from `tools/list`. A model reads that as a
 * broken server rather than as a setting, and it cannot tell the difference.
 */
export function assertGroup(card: ICAL.Component, tool: string): GroupModel {
  const model = groupModelOf(card);
  if (model === undefined) {
    throw new ToolInputError(
      `carddav-mcp: that id names a contact, not a group, so ${tool} cannot ` +
        'act on it. get_contact reads it.'
    );
  }
  return model;
}

/** Refuses an id that turned out to name a group where a contact was meant. */
export function assertNotGroup(card: ICAL.Component, tool: string): void {
  if (isGroup(card)) {
    throw new ToolInputError(
      `carddav-mcp: that id names a group, not a contact, so ${tool} cannot ` +
        'act on it. get_group reads it.'
    );
  }
}

/** The version to use when creating a group card in a book. */
export function groupVersionOf(card: ICAL.Component): string {
  return versionOf(card);
}
