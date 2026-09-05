/**
 * The tools this server can register, declared rather than discovered.
 *
 * Declared, because the tool filter has to answer "is this a name you have?"
 * *before* anything is registered — and under `CARDDAV_READ_ONLY` the write
 * tools are never registered at all. Deriving the catalogue from what actually
 * reached `registerTool` would make `CARDDAV_ALLOW_TOOLS=delete_contact` report
 * "unknown tool" in read-only mode, which is the one answer that is wrong: the
 * tool exists, and read-only is suppressing it.
 *
 * This is also the full tool surface, hard-coded on purpose. A tool that
 * appears or disappears by accident is a change to this server's contract, and
 * it has to be a deliberate edit here. `test/tool-filter.test.ts` asserts that
 * these lists and the tools the server really registers are the same set —
 * which is also why that test file must not keep a second copy of the names.
 */

/** Registered always. Every one carries `readOnlyHint: true`. */
export const READ_TOOLS = [
  'export_contacts',
  'get_contact',
  'get_contact_photo',
  'get_group',
  'get_server_info',
  'list_address_books',
  'list_changes',
  'list_contacts',
  'list_groups',
  'search_contacts',
] as const;

/** Registered unless `CARDDAV_READ_ONLY` is set. */
export const WRITE_TOOLS = [
  'create_contact',
  'create_group',
  'delete_contact',
  'delete_group',
  'move_contact',
  'update_contact',
  'update_group',
] as const;

/** Every tool, read-only mode aside. */
export const ALL_TOOLS: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS];

/**
 * What `CARDDAV_ALLOW_TOOLS=essential` selects: find a person, read them, add
 * one, correct one.
 *
 * Six of seventeen. Left out on purpose: everything irreversible (both deletes,
 * moving a card between books), the whole group surface — which is a different
 * job from keeping contacts and carries the one genuine complication in this
 * server — `get_contact_photo` and `export_contacts`, which return payloads
 * rather than answers, `list_changes`, which only makes sense to something
 * keeping its own state, and `get_server_info`, a diagnostic that belongs in
 * the full set rather than in the one a model reaches for first.
 *
 * "The read tools" is already `CARDDAV_READ_ONLY` and would add nothing.
 */
export const ESSENTIAL_TOOLS: readonly string[] = [
  'list_address_books',
  'list_contacts',
  'get_contact',
  'search_contacts',
  'create_contact',
  'update_contact',
];
