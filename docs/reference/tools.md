# Tool reference

All 17 tools: 10 read, 7 write.
With `CARDDAV_READ_ONLY=true` the write tools are not registered at all —
they do not appear in `tools/list`.

All 17 are registered unless you say otherwise. `CARDDAV_ALLOW_TOOLS`
and `CARDDAV_DENY_TOOLS` narrow the list to the ones you want, and
`CARDDAV_ALLOW_TOOLS=essential` selects the 6 marked **essential**
below — see [choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

👤 marks a tool that **asks a person** before it acts, through MCP
elicitation — a dialog the model cannot answer on its behalf. Where the
client cannot show one, it falls back to a two-call `confirm_token` bound
to the exact target and expiring after five minutes, and says which of the
two it was. `ELICITATION=false` takes that fallback deliberately; it never
removes the guard. See [Asking a person](/guide/approval).

Every tool declares all four MCP annotations — `readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`. They are a hint a
client may ignore; the dialog is enforced here and cannot be, which is why
the two lists are not the same one.

Every tool also declares an `outputSchema` and answers in both channels at
once — the same object as `structuredContent`, and as JSON in a text block.
Every answer built from address book content additionally carries
`untrusted: true` and `source: "carddav"` as **fields**, so a client can
check rather than notice. Two tools deliberately do not: `get_server_info`
and `list_changes` return this server's own words — protocol tokens, ids
and counts, with no card content in them at all. A marker on everything
would be a marker on nothing.

## Read tools

### `list_address_books`

**List the address books** — read-only, **essential**

Every address book this server may use, with the id to pass to the other tools. Always asks the server rather than answering from a cache — being current is this tool’s whole job.

Takes no parameters.

### `get_server_info`

**What the connected CardDAV server can do** — read-only

Reports the DAV compliance tokens, which vCard versions each address book accepts, and whether the optional features this server relies on actually work here. The first thing to run when something behaves differently than expected — CardDAV implementations differ more than the specification suggests.

Takes no parameters.

### `list_contacts`

**List contacts** — read-only, **essential**

Contacts in one or more address books, as short summaries: name, organisation, addresses and phone numbers, and whether a photo is present. Only the summary properties are fetched, so this stays cheap on a large address book — get_contact returns the whole card.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `address_books` | string[] | no | Which address books to look in. Leave it out for every address book this server may see. |
| `limit` | integer | no | How many entries to return. Defaults to CARDDAV_MAX_CONTACTS, at most 500. |
| `include_groups` | boolean | no | Include group cards in the listing. Off by default: a group is a vCard like any other, and mixing them into a contact list is usually not what was meant. list_groups reads them properly. |

### `get_contact`

**Read one contact in full** — read-only, **essential**

The complete card behind an id: every address, every phone number, the note, the birthday, and the names of any properties this server does not model. The free text comes back inside a fence marking it as somebody else’s writing.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from list_contacts, search_contacts, list_groups or list_changes. |

### `search_contacts`

**Find contacts** — read-only, **essential**

Finds contacts whose name, organisation, email address, phone number or note contains a term. One request per address book — CardDAV combines the fields with OR, unlike CalDAV — and the result is checked again here, because some servers filter only partially.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | The term to look for. Matched case-insensitively. |
| `fields` | `"FN"` \| `"N"` \| `"NICKNAME"` \| `"EMAIL"` \| `"TEL"` \| `"ORG"` \| `"TITLE"` \| `"NOTE"` \| `"CATEGORIES"` \| `"UID"`[] | no | Which vCard properties to match against. Defaults to FN, NICKNAME, EMAIL, TEL and ORG — the fields somebody searches by. |
| `address_books` | string[] | no | Which address books to look in. Leave it out for every address book this server may see. |
| `limit` | integer | no | How many entries to return. Defaults to CARDDAV_MAX_CONTACTS, at most 500. |

### `get_contact_photo`

**Fetch a contact’s photo** — read-only

Returns the photo stored on a card as an image. Only a photo embedded in the card itself — one stored as a link is reported by get_contact and never fetched, because that address was chosen by whoever wrote the card. The media type is decided from the bytes, never from what the card claims: JPEG, PNG, GIF and WebP are handed over, and bytes that are none of those are refused with a sentence rather than delivered under a generic label.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from list_contacts, search_contacts, list_groups or list_changes. |

### `export_contacts`

**Export contacts as vCard text** — read-only

The raw vCard text of one or more contacts, exactly as stored. The only way to see a property this server does not model, and the only way to take a backup of an address book from here.

This is the one tool whose two channels differ on purpose. `structuredContent` carries the cards byte for byte — that is the backup. The text block is a rendering of the same cards for reading, inside the nonce fence with every line datamarked: invisible characters are removed and markdown image markers are broken there, so a `NOTE` carrying `![…](https://…)` cannot make a client fetch a URL when it renders the answer. The first line of the text block says so. Injection shapes found in the exported cards are reported as a warning above the fence.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ids` | string[] | no | Specific contacts. Leave out to export a whole book. |
| `address_book` | string | no | Export every card in this address book. |
| `limit` | integer | no | How many entries to return. Defaults to CARDDAV_MAX_CONTACTS, at most 500. |

### `list_changes`

**What changed in an address book** — read-only

Cards created, changed or deleted since a sync token, using RFC 6578. Call it once without a token to get the current token, then again later with it. Not every server implements this — get_server_info reports whether this one does.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `address_book` | string | yes | An address book id from list_address_books — its collection path. A full URL or the final path segment work too. |
| `sync_token` | string | no | The token from a previous call. Left out, this returns the current token and every card, which is the initial sync. |
| `limit` | integer | no | How many entries to return. Defaults to CARDDAV_MAX_CONTACTS, at most 500. |

### `list_groups`

**List contact groups** — read-only

Groups in one or more address books, with how many members each has. The members themselves are not resolved here — that is one extra request per book, and get_group is where a caller has said they want the names.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `address_books` | string[] | no | Which address books to look in. Leave it out for every address book this server may see. |
| `limit` | integer | no | How many entries to return. Defaults to CARDDAV_MAX_CONTACTS, at most 500. |

### `get_group`

**Read one group, with its members** — read-only

A group card and the contacts in it, resolved to names and ids where the members live in the same address book. A member this server cannot resolve is still reported, as the reference the card holds.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from list_contacts, search_contacts, list_groups or list_changes. |

## Write tools

### `create_contact`

**Add a contact** — write, **essential**

Adds a card to an address book. The UID and the file name are generated here. The vCard version follows what the address book accepts — 3.0 unless it says otherwise, because that is what phones and desktop clients read completely.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `address_book` | string | yes | An address book id from list_address_books — its collection path. A full URL or the final path segment work too. |
| `formatted_name` | unknown | no | FN, the display name. Derived from the name parts when left out on create. Null removes it, which no valid card may be without. |
| `given_name` | unknown | no |  |
| `family_name` | unknown | no |  |
| `additional_names` | unknown | no |  |
| `name_prefix` | unknown | no | Dr, Prof. |
| `name_suffix` | unknown | no | Jr, PhD. |
| `nickname` | unknown | no |  |
| `organization` | unknown | no |  |
| `department` | unknown | no |  |
| `title` | unknown | no | Job title. |
| `role` | unknown | no |  |
| `emails` | unknown | no |  |
| `phones` | unknown | no |  |
| `urls` | unknown | no |  |
| `instant_messaging` | unknown | no |  |
| `addresses` | unknown | no |  |
| `birthday` | unknown | no |  |
| `anniversary` | unknown | no |  |
| `note` | unknown | no |  |
| `categories` | unknown | no |  |
| `raw_vcard` | string | no | A complete vCard to store as-is, instead of the fields above. For properties this server does not model. |

### `update_contact` 👤

**Change a contact** — write, destructive, **essential**

Changes the fields named and leaves everything else exactly as it was — including properties this server does not model. Guarded by the card’s ETag, so a change made elsewhere in the meantime is refused rather than overwritten. A CardDAV server keeps no version history, so a person is asked first.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from list_contacts, search_contacts, list_groups or list_changes. |
| `formatted_name` | unknown | no | FN, the display name. Derived from the name parts when left out on create. Null removes it, which no valid card may be without. |
| `given_name` | unknown | no |  |
| `family_name` | unknown | no |  |
| `additional_names` | unknown | no |  |
| `name_prefix` | unknown | no | Dr, Prof. |
| `name_suffix` | unknown | no | Jr, PhD. |
| `nickname` | unknown | no |  |
| `organization` | unknown | no |  |
| `department` | unknown | no |  |
| `title` | unknown | no | Job title. |
| `role` | unknown | no |  |
| `emails` | unknown | no |  |
| `phones` | unknown | no |  |
| `urls` | unknown | no |  |
| `instant_messaging` | unknown | no |  |
| `addresses` | unknown | no |  |
| `birthday` | unknown | no |  |
| `anniversary` | unknown | no |  |
| `note` | unknown | no |  |
| `categories` | unknown | no |  |
| `raw_vcard` | string | no | Replace the whole card with this one. Unlike the named fields, this does not merge — anything not in it is gone. |
| `confirm_token` | string | no | Only for a client that cannot show a dialog: the token from this tool’s own previous refusal, quoted back to confirm. |

### `delete_contact` 👤

**Delete a contact** — write, destructive

Removes a card. Cannot be undone — a CardDAV server has no trash and no version history. Guarded by the card’s ETag, so a card changed since it was read is refused rather than deleted blind. A group card is refused, before anybody is asked: `delete_group` is the tool for that, and the two stay separable in `CARDDAV_DENY_TOOLS` only because this one cannot reach a group.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from list_contacts, search_contacts, list_groups or list_changes. |
| `confirm_token` | string | no | Only for a client that cannot show a dialog: the token from this tool’s own previous refusal, quoted back to confirm. |

### `move_contact` 👤

**Move a contact to another address book** — write, destructive

Copies a card into another address book and removes it from the first. The id changes, because an id names a card in a collection. There is no transaction behind this: the copy is verified before the original is removed.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from list_contacts, search_contacts, list_groups or list_changes. |
| `destination` | string | yes | The address book to move the card into. |
| `confirm_token` | string | no | Only for a client that cannot show a dialog: the token from this tool’s own previous refusal, quoted back to confirm. |

### `create_group`

**Create a contact group** — write

Creates a group card and puts the named contacts in it. The convention follows whatever groups the address book already uses, because a group written the other way is invisible in the client the person is actually looking at.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `address_book` | string | yes | An address book id from list_address_books — its collection path. A full URL or the final path segment work too. |
| `name` | string | yes | The group’s display name. |
| `note` | string | no |  |
| `members` | string[] | no | Contact ids to put in the group. |

### `update_group` 👤

**Rename a group or change who is in it** — write, destructive

Changes a group’s name or note, and adds or removes members. Removing a member removes the grouping only — the contact itself is untouched. A CardDAV server keeps no version history, so a person is asked first.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from list_contacts, search_contacts, list_groups or list_changes. |
| `name` | string | no |  |
| `note` | unknown | no |  |
| `add_members` | string[] | no |  |
| `remove_members` | string[] | no |  |
| `set_members` | string[] | no | Replace the membership outright with exactly these contacts. Cannot be combined with add_members or remove_members. |
| `confirm_token` | string | no | Only for a client that cannot show a dialog: the token from this tool’s own previous refusal, quoted back to confirm. |

### `delete_group` 👤

**Delete a contact group** — write, destructive

Removes a group card. The contacts that were in it are not touched — only the grouping goes. Cannot be undone.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | An id from list_contacts, search_contacts, list_groups or list_changes. |
| `confirm_token` | string | no | Only for a client that cannot show a dialog: the token from this tool’s own previous refusal, quoted back to confirm. |
