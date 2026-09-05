# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/carddav-mcp.git && cd carddav-mcp
npm install
npm test          # 370+ tests against an in-memory CardDAV fake, no network
npm run build
```

A minimal dev environment:

```sh
export CARDDAV_URL=http://127.0.0.1:5232
export CARDDAV_USERNAME=integration
export CARDDAV_PASSWORD=integration-not-a-secret
export CARDDAV_ADDRESSBOOKS=work,private
```

## Running the integration suite

The unit tests replace `fetch`, so what they check is that this server speaks
CardDAV the way its author understood it — against a stub written to that same
understanding. Only a real server can disagree, and CardDAV servers disagree a
lot: namespace prefixes, href forms, which preconditions come back on an error,
whether the vCard's own line endings arrive raw or as entities.

```sh
npm run build     # the suites run dist/index.js, not src/
docker compose -f test/integration/compose.yml up -d --wait
npm run test:integration
docker compose -f test/integration/compose.yml down -v
```

There are two suites against two servers, and they answer different questions.

**Radicale is the coverage pass.** One story in order — the contact it creates
is the one the next test changes and the one after that moves and deletes — with
**every tool in the catalogue** called once and the `skipped` list empty. Where
an assertion matters it reads the stored `.vcf` back over plain HTTP rather than
through this server, because a test that only calls `get_contact` proves the
server agrees with itself, which is not the question.

**Baikal is the portability pass**, and it is deliberately not a second copy:
running the same story twice would double the wall clock to re-prove the same
thing. It asserts only where two correct CardDAV servers legitimately differ,
which is where a server that has only ever met one of them is wrong without
knowing it — a `/dav.php` path prefix, lowercase `d:`/`card:` prefixes, entity
decoding in `address-data`, a `supported-address-data` that names two versions
where the other names one, ETag semantics across a different serialiser, and the
`text-match` collation. It found a real parsing bug on its first run, which is
the argument for having it: sabre encodes the vCard's line endings as `&#13;`,
and under the strict entity rule _every card it returned was unparseable_ —
visible only as an empty listing. There is no `expectEveryToolExercised` there,
on purpose.

Both bootstraps create their address books with an extended `MKCOL` over the
wire, which is something this server deliberately cannot do — a suite must not
lean on a capability documented as absent. Baikal's _account_, by contrast, is
seeded straight into its SQLite database rather than installed through the web
wizard: that wizard is three CSRF-carrying form posts and a login, four chances
to break on a cosmetic change to an admin page nothing here tests.

Both then empty each collection before seeding it, so a run against a stack
somebody left up means the same as a run against a fresh one. That is not
hypothetical — the sister server was bitten by it twice, and the symptom reads
like broken code while actually being stale state. Run it twice before believing
it:

```sh
docker compose -f test/integration/compose.yml down -v
docker compose -f test/integration/compose.yml up -d --wait
npm run test:integration && npm run test:integration
```

The containers are throwaways and the compose file binds `127.0.0.1` only. Point
this at nothing whose data matters — the suite calls every delete the server
has, and the harness refuses any backend URL that is not on this machine.

For poking at one tool by hand, the inspector against the same stack:

```sh
docker compose -f test/integration/compose.yml up -d --wait radicale
npx @modelcontextprotocol/inspector --cli node dist/index.js \
  -e CARDDAV_URL=http://127.0.0.1:5232 \
  -e CARDDAV_USERNAME=integration \
  -e CARDDAV_PASSWORD=integration-not-a-secret \
  --method tools/list
```

The `-e` flags are not optional and their position is not either: the inspector
does not pass the ambient environment to the server it spawns, and putting the
flags _before_ the target command shifts its positional parsing so that the
target is lost and it connects to whatever its own catalogue file lists instead.

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  CI runs lint, typecheck, build and the full suite on Node 22 and 24, plus
  `npm audit`, CodeQL and a Trivy scan of the container image.
- **Comments** explain constraints the code cannot show — not what the next line does.
- **Security-sensitive areas** (config parsing, the approval flow, the address book
  allowlist, anything that builds a request URL or an XML body): please describe the
  attack you are defending against, or the one your change might open, in the PR text.
- **Contact data is untrusted input.** An address book is rarely written only by its
  owner. Anything that puts card content into a tool result has to keep it inside the
  nonce fencing, and anything that puts it into text a model treats as instruction — a
  confirmation prompt, an error message — is a bug.
- **The server must not gain the ability to fetch a URL somebody else chose.** A
  `PHOTO` stored as a URI is reported and never retrieved; no tool takes a URL. That
  absence is why `openWorldHint` is `false` everywhere and why there is no SSRF guard
  to get wrong.
- **Writes stay read-modify-write, over a card fetched for the purpose.** Rebuilding
  from the fields this server models silently discards the ones it does not — the
  photo, the `X-` properties some phone wrote. And a card from a _listing_ is
  incomplete by construction: it carries `partial: true`, and the write path must
  keep re-fetching rather than trusting one. Never send `If-Match: *`.
- **The vCard version matters in non-obvious ways.** `VERSION` must be the first
  property or ical.js reads the card under a different grammar than it parsed it
  with, and `REV` has to be spelled per version or it is silently corrupted on one
  and unreadable on the other. Both are commented where they live; please read those
  comments before changing `vcard.ts`.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing — it checks both oxlint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/carddav-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/carddav-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/carddav-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
