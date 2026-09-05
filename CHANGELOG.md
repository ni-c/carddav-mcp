# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with
     awk, matching "## [x.y.z]". Keep that heading shape exactly. -->
<!-- The docs site includes everything between these markers. Keep the end
     marker last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [Unreleased]

### Added

First release. An MCP server for CardDAV: 17 tools over contacts, groups and
photos, on any server that speaks the standard.

- **17 tools**, 10 read and 7 write. `CARDDAV_READ_ONLY=true` leaves the write
  tools unregistered rather than failing them, so they do not appear in
  `tools/list` at all.
- **A listing is cheap and says so.** `list_contacts` retrieves only the
  summary properties, which is the difference between a few kilobytes and
  several megabytes once inline photos are involved — and every entry it
  returns is marked `partial`, because a card retrieved that way is missing
  everything not asked for. The write path never accepts one: it issues its own
  `GET` for the card it is about to replace, every time.
- **Writes are read-modify-write over the parsed card**, never a document
  rebuilt from the fields this server models. An `X-` property some phone wrote
  in 2014, a photo nobody mentioned and every parameter survive an edit because
  they are never touched. Guarded with `If-Match` from the same read; never
  `If-Match: *`; a weak ETag is refused rather than dropped.
- **Both group conventions.** vCard 4's `KIND:group` with `MEMBER`, and Apple's
  `X-ADDRESSBOOKSERVER-KIND` on top of vCard 3 — which is what Apple Contacts,
  Nextcloud and most of the installed base actually store. Both are read; the
  one written follows whatever the address book already uses, because a group
  in the other convention is invisible in the client the person is looking at.
- **A search is one request, not one per field.** RFC 6352 gives `<C:filter>` a
  `test` attribute defaulting to `anyof`, so several properties are matched in
  a single `addressbook-query`. Whatever comes back is checked again locally,
  because a server that filters only partially is indistinguishable from one
  that matched properly, and the result says which path it took.
- **Birthdays keep the year they have, and no more.** `BDAY:--0415` means "15
  April, year unknown", which is what a phone writes when the year was never
  entered and a large share of real birthdays look like. It is reported as
  `{month, day}` rather than mapped to nothing or given an invented year.
- **`CARDDAV_ADDRESSBOOKS` fences the server to named address books**, enforced
  where an id is decoded rather than at the edge of each tool, so no tool can
  forget it — including a group membership change, which is the one place a
  fenced-off path could otherwise be named. A listing reports how many
  collections it withheld instead of quietly being shorter.
- **Ids are opaque and carry no origin.** The host is rebuilt from
  `CARDDAV_URL` on every decode, so a forged id cannot point this server at
  another server. Every join of a collection URL and a card name is checked on
  the **resolved** path: checking the name for a literal `/` is not the same
  check, because the URL parser normalises `%2E%2E` and treats a backslash as a
  separator.
- **Contacts are treated as text a stranger wrote**, because an address book
  rarely is written only by its owner — cards arrive by import from a phone, by
  sync from a directory, and from anyone with write access to a shared book.
  Names, organisations and notes are fenced with a per-call nonce and marked
  line by line; invisible and directional characters are removed; markdown
  image syntax is defused. Two of the injection shapes reported are specific to
  an address book, and the second is the reason contacts are worth attacking at
  all: a card asserting that somebody's number or account has changed does not
  need the model to run a tool, only to be believed.
- **Nothing this server says quotes card content.** Not the approval dialogs,
  not the error messages. Every value an error repeats is escaped, collapsed to
  one line and cut first, because an error reaches the model in the server's
  own voice, outside any fence.
- **Photos are reported, not delivered.** `get_contact` says a photo is there,
  its type and its size; `get_contact_photo` returns the bytes as an image when
  asked for by name. A photo stored as a URI is reported and never fetched —
  that address was chosen by whoever wrote the card.
- **It never fetches an address somebody else chose.** No tool takes a URL.
  Links returned by the server are pinned to the configured origin and refused
  if they carry credentials or a scheme this server does not speak — checked
  again at the point the credentials would leave the process.
- **`CARDDAV_ALLOW_PLAINTEXT`.** A plain `http://` URL to a host that is not
  loopback refuses to start instead of printing a warning that a stdio
  deployment never shows. The switch lifts the refusal and is read strictly,
  like `CARDDAV_INSECURE_TLS`.
- Bearer or Basic authentication, RFC 6764 discovery from a server root or a
  collection URL, RFC 6578 `sync-collection` as `list_changes`, and a raw vCard
  export that keeps the properties this server does not model — because an
  export that dropped them would be a backup that silently loses data.

<!-- #endregion changelog -->
