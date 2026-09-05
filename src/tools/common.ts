import type { CardDavApi } from '../api.js';
import type { AddressBookEntry, AddressBookRegistry } from '../books.js';
import type { Config } from '../config.js';
import type { Discovery } from '../discovery.js';
import { parseEntityId, type EntityId } from '../entity-id.js';
import { ToolInputError } from '../errors.js';
import { loadCard } from '../entries.js';
import type { ICAL } from '../vcard.js';

/**
 * What every tool module is handed.
 *
 * One object rather than four parameters, because the list grew once already
 * and a registrar signature that changes for every new dependency is a
 * signature every module has to be edited for.
 */
export interface ToolContext {
  api: CardDavApi;
  discovery: Discovery;
  config: Config;
}

/** A card, fetched by id, with everything needed to write it back. */
export interface LoadedCard {
  entity: EntityId;
  book: AddressBookEntry;
  card: ICAL.Component;
  vcf: string;
  etag: string | undefined;
}

/**
 * Resolves an id to a card.
 *
 * The allowlist check happens inside `parseEntityId`, which is why the registry
 * is a required argument there: there is no path from an id to a URL that skips
 * the fence.
 *
 * `forWrite` raises the read ceiling and marks intent. A write always comes
 * through here, and this always fetches the whole card — which is what keeps a
 * partially-retrieved listing entry from ever reaching a PUT. See
 * `SUMMARY_PROPS` in `dav-xml.ts`.
 */
export async function loadById(
  context: ToolContext,
  registry: AddressBookRegistry,
  id: string,
  forWrite = false
): Promise<LoadedCard> {
  const entity = parseEntityId(id, registry);
  const book = registry.byPath(entity.bookPath);
  if (book === undefined) {
    throw new ToolInputError(
      'carddav-mcp: that address book is no longer available. Call ' +
        'list_address_books.'
    );
  }
  const { card, vcf, etag } = await loadCard(
    context.api,
    book,
    entity.resourceName,
    forWrite
  );
  return { entity, book, card, vcf, etag };
}

/**
 * The address books a tool should act on.
 *
 * A thin wrapper, and it exists so that no tool ever writes
 * `registry.allowed()` by hand: `resolveMany` given nothing returns the
 * *permitted* books, and that default is the whole fence.
 */
export async function resolveBooks(
  context: ToolContext,
  references?: readonly string[],
  force = false
): Promise<{
  registry: AddressBookRegistry;
  books: readonly AddressBookEntry[];
}> {
  const registry = await context.discovery.registry(force);
  return { registry, books: registry.resolveMany(references) };
}

/**
 * Truncates a list to `limit`, reporting what was left out.
 *
 * Separate from the byte budget in `result.ts`, and both are needed: this one
 * is the caller's stated preference and applies before anything is shaped, the
 * other is the hard ceiling that applies after. A listing that only had the
 * byte budget would hand back four hundred contacts because they happened to
 * fit.
 */
export function applyLimit<T>(
  items: readonly T[],
  limit: number
): { shown: T[]; dropped: number } {
  if (items.length <= limit) return { shown: [...items], dropped: 0 };
  return { shown: items.slice(0, limit), dropped: items.length - limit };
}

/** The note a truncated listing carries, naming what to do about it. */
export function limitNote(dropped: number, limit: number): string {
  return (
    `${dropped} more entr${dropped === 1 ? 'y' : 'ies'} matched than the ` +
    `limit of ${limit}. Raise limit, or narrow the request with ` +
    'search_contacts.'
  );
}
