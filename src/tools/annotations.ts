/**
 * The annotation blocks every tool declares, written out rather than defaulted.
 *
 * The specification says `destructiveHint` and `openWorldHint` both default to
 * **true**, so an omitted field is the *stronger* claim, not the neutral one: a
 * `create_contact` that says nothing announces itself as destructive and
 * open-world. Every tool in this server therefore names all four.
 *
 * The line this family draws for `destructiveHint`, because the specification
 * only offers "destructive" against "additive only":
 *
 * > Content that a person wrote, replaced with no way back — destructive.
 * > A setting, a state or a marker, changed — not destructive.
 *
 * Whether the backend keeps history is what decides it, not the verb. **CardDAV
 * keeps none**: a PUT replaces the whole resource, there is no version to go
 * back to, and no server in this family's integration suite offers one. So
 * `update_contact` here is destructive, exactly as `update_event` is in the
 * sister server and unlike `update_page` in wikijs-mcp, where the wiki keeps
 * page history. Same verb, opposite answers, decided by what the store
 * remembers rather than by the wording.
 *
 * `idempotentHint` follows the specification's "no additional effect on its
 * **environment**": `delete_contact` is `true`, because deleting the same card
 * twice leaves one thing deleted and the second answer is an answer rather than
 * an effect. Creating is `false`.
 *
 * `openWorldHint` is `false` everywhere in this server, with no exceptions to
 * explain. The hint marks a tool that makes the instance reach an address
 * somebody else chose — the boundary `mcp-internal-hosts` watches — and nothing
 * here does: no tool takes a URL, and a `PHOTO` stored as a URI is reported and
 * never fetched. That is also why there is no `src/hosts.ts`; see the note at
 * the foot of `config.ts`.
 */

/** A tool that only reads. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Adds something new. Two calls make two cards, so not idempotent. */
export const CREATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/**
 * Replaces text a person wrote, with no history behind it.
 *
 * Idempotent all the same: the same arguments twice leave the same state. `REV`
 * moves, but a revision stamp records that a write happened rather than
 * changing anything about the world the next call would see.
 */
export const REPLACE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Removes a card. */
export const DELETE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Moves a card to another address book.
 *
 * Destructive for the reason `move_messages` is in imap-mcp: the content
 * survives but the resource URL does not, so every id naming it stops working.
 * Not idempotent — after the first call the source is gone, and the second call
 * has a different world to act on.
 */
export const MOVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;
