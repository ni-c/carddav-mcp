# vhs script for the demo GIF: `vhs docs/demo.tape` writes public/demo.gif
#
# Prerequisites:
#   * vhs installed (https://github.com/charmbracelet/vhs)
#   * the server built (npm run build)
#   * a CardDAV server at 127.0.0.1:5232 with a few cards in it:
#       docker compose -f test/integration/compose.yml up -d radicale
#       node docs/seed-demo.mjs
#     A handful of contacts and one group, which is what makes the summary
#     listing and the group resolution visible in a few lines of output.
#
# Rules learned the hard way:
#   * inside Hide blocks use vhs's own `Sleep`, never the shell's — shell sleep
#     blocks and the tape ends before any output is recorded
#   * the inspector CLI does not pass the ambient environment to the server it
#     spawns, so every variable goes on the command line with `-e KEY=VALUE`
#   * and those `-e` flags go AFTER the target command, not before it. Before it
#     they shift the positional parsing, the target is lost, and the inspector
#     silently connects to whatever server its catalogue file lists instead —
#     which produced a very confusing recording of somebody else's tools
#   * vhs cannot express a backslash-escaped quote inside a Type string, so any
#     jq filter here uses `@tsv` rather than string interpolation
#   * start from the running server, do not record the setup
#   * run it from the REPOSITORY ROOT, `vhs docs/demo.tape` — the commands below
#     say `dist/index.js`, and the Output path is relative to the same place.
#     Running it from docs/ produces a GIF of MODULE_NOT_FOUND, which is a thing
#     that has happened
#
# Width is 1200 on purpose: VitePress caps an image at max-width 100% and does
# nothing else, so a recording narrower than the 1152px content column renders at
# its natural size and stops short of the right edge, next to a diagram that
# fills it. custom.css pins the width regardless; being oversized is the belt.

Output docs/public/demo.gif

Set FontSize 16
Set Width 1200
Set Height 640
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
Type "alias carddav='npx -y @modelcontextprotocol/inspector --cli node dist/index.js -e CARDDAV_URL=http://127.0.0.1:5232 -e CARDDAV_USERNAME=integration -e CARDDAV_PASSWORD=integration-not-a-secret --method tools/call'" Enter
# One real call inside the Hide block, and a generous Sleep after it. The first
# `npx` of a session fetches and starts the inspector, which takes seconds — and
# vhs types on a timer rather than waiting for a prompt, so without this the
# demo commands queue up as input behind it and the recording ends before the
# shell has run any of them. The result looks like a terminal that echoes and
# does nothing.
Type "carddav --tool-name list_address_books > /dev/null 2>&1" Enter
Sleep 25s
Type "clear" Enter
Sleep 1s
Show

Type "# who is in the address book" Enter
Sleep 800ms
Type "carddav --tool-name list_contacts | jq -r '.structuredContent.contacts[] | [.formatted_name, .organization] | @tsv'" Enter
Sleep 8s

Type "" Enter
Type "# find one, and read the card in full" Enter
Sleep 800ms
Type "carddav --tool-name search_contacts --tool-arg query=hopper | jq -r '.structuredContent.contacts[] | [.formatted_name, .emails[0].value] | @tsv'" Enter
Sleep 8s

Type "" Enter
Type "# a group, with its members resolved" Enter
Sleep 800ms
Type "carddav --tool-name list_groups | jq -r '.structuredContent.groups[] | [.name, .member_count] | @tsv'" Enter
Sleep 8s
