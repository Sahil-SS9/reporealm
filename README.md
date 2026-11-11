# RepoRealm

A first-person reading chamber built from a repository's real import graph.
Walk the room, place two portals, carry module-name cubes onto weighted plates,
and cross the physical exit once the complete required answer set is satisfied.
Every fact the chambers ask about comes from static analysis of the repository
you point it at; nothing in that repository is imported, executed or served.

RepoRealm is a Hermes plugin. It registers one read-only tool and one slash
command, exports a single-file offline game, and can serve that export from a
managed loopback server it owns.

> **Candidate status.** This is an unpublished candidate at version `0.3.0`.
> There is no public repository URL, no catalog entry, no PyPI release and no
> built or verified wheel. The rename, manifest, CLI, docs and tests in this
> checkout have not yet been re-run as a suite on the final bytes - a clean
> clone install and the canonical checks are the next gate, not a claim made
> here.

## What the chambers teach

- **Tutorial:** portal placement and crossing before carrying puzzles.
- **The Front Door:** the module named by a particular entry registration.
  Decoys are judged against that registration, not declared non-executable.
- **Dependency Routing:** the complete incoming direct-import set in the
  analysed graph. Rejection copy names the scope: "static direct import
  statements in the analysed file only", which does not rule out transitive or
  dynamic imports.
- **The Guard:** a test module's import reaches the subject. This does **not**
  prove its assertions catch a particular behavioural regression.
- **The Relay (HARD):** the routing facts again, behind a wall - the portal pair
  is the only crossing and both answers must weigh at once.
- **The Weighbridge (HARD):** the door itself carries a plate; a full cube set
  alone leaves it shut until the player stands on the door plate.

Answer sets come from analysis, not a hand-authored quiz table. Room geometry is
deterministic from the payload. An open door needs a physical exit; there is no
timed auto-transition. Not every repository supports every chamber type, and
unsupported or empty inputs say why instead of substituting unrelated questions.

## Requirements

- Hermes `>=0.20.1` (the floor declared in `plugin.yaml`: the earliest released
  upstream whose plugin surface covers everything this plugin uses -
  `manifest_version: 2`, `register_tool(... description, emoji)`,
  `register_command(... args_hint)` and `config_schema`. Release `0.20.0` has
  neither `manifest_version: 2` nor `config_schema`).
- Python 3.11+.
- No Python dependencies. No network access at runtime.
- A WebGL-capable desktop browser (minimum supported layout is 720x560).

## Install as a Hermes plugin (Git directory)

Distribution is the plugin directory: a Git checkout with `plugin.yaml` and
`__init__.py` at its root, installed into the Hermes plugin directory. The
frontend builder (`scripts/build_web.py`) and the game sources (`web/`) are
resolved from that checkout, so there is no wheel to build and nothing is
fetched at runtime.

The public repository URL and its pinned commit do not exist yet, so no
install command is printed here as if it worked. When they do, the catalog form
is `hermes plugins install <repo-url>` (optionally `#subdir` for a monorepo);
until then the supported path is running from a checkout:

```bash
git clone <repo-url> /path/to/reporealm-checkout   # URL pending
cd /path/to/reporealm-checkout
python3 -m reporealm --help                       # native CLI, no install step
```

A directory install has **not** been verified end-to-end on this candidate. The
check that closes it is a clean clone plus `hermes plugins validate` at the
pinned commit, followed by a real `/reporealm` invocation on an unmodified
Hermes - that is QA's gate, and until it runs the honest statement is
"source-tree execution is what has been exercised".

## Use

### In Hermes

| Surface | Effect |
|---|---|
| `/reporealm <repo>` | Analyse the repository, export the game, start a managed loopback server, return the verified URL. |
| `/reporealm <repo> --port N` | Same, on a specific port (default `7788`). |
| `/reporealm status` | List known managed servers and whether each answers its own `/healthz`. |
| `/reporealm stop --port 7788` | Stop one instance, only after matching app/pid/port/fingerprint identity. |
| `/reporealm stop --all` | Stop managed instances - never arbitrary processes. |
| tool `reporealm_chambers` | `{"repo": "/absolute/path"}` returns the `schema_version = 1` payload as JSON, read-only. |

The slash command and the tool call the same backend the CLI uses, so a
behaviour verified by the CLI tests is the behaviour the plugin gets.

### Native CLI (from a checkout)

```bash
python3 -m reporealm analyse /path/to/repo --out payload.json
python3 -m reporealm export  /path/to/repo --out game.html      # offline single file
python3 -m reporealm play    /path/to/repo                      # loopback, foreground
python3 -m reporealm play    /path/to/repo --background         # managed, prints URL
python3 -m reporealm status
python3 -m reporealm stop --port 7788
```

`game.html` is fully self-contained: vendored renderer, game modules, the
repository payload, the poster, the embedded fonts and every licence notice are
inlined. It plays from `file://` and needs no server, bundle step or network.
The repository is never analysed in the browser; export a different repository
through the CLI.

## Safe serving

The managed server binds `127.0.0.1` only and serves a fixed route table
(`/`, `/game.html`, `/payload.json`, `/healthz`) from its generated export
folder. Request paths are never joined onto filesystem paths, so there is no
traversal surface, and repository files, source or historical prototypes are not
served. Responses carry `nosniff`, `no-referrer`, same-origin resource policy and
`X-Frame-Options: DENY`; requests are refused unless `Host` is the bound loopback
authority and `Origin` is absent or matches it exactly.

Health, reuse and stop all check process/port/fingerprint identity, so shutdown
never kills a process it cannot match. If the preferred port is held by another
instance for a different repository, the CLI says so instead of reusing it.

The analyser reads files without importing or executing target repository code,
caps its scan and reports skipped paths or unresolved imports as warnings rather
than inventing graph edges.

## Limitations

- **Static analysis only.** Direct edges cannot rule out transitive or dynamic
  imports and do not prove that a test detects a behavioural regression. JS/TS
  resolution is best-effort; bundler and unresolved patterns are skipped with
  warnings.
- **Not every repository yields every chamber.** Unsupported inputs produce an
  unavailable reason or an honest empty state.
- **Desktop only.** The layout floor is 720x560; there is no mobile or
  responsive certification, and no cross-browser certification.
- **No performance certification.** Deterministic input-driven test runs are not
  a desktop-GPU smoothness or frame-rate verdict.
- **No audio-quality verdict.** Sound is synthesised in code; narration uses the
  browser's local speech synthesis when available, and subtitles work without it.
- **No wheel, PyPI package or catalog install.** Git-directory distribution is the
  target; nothing is published.

## Attribution and licences

RepoRealm is original code (MIT). It borrows mechanics, not assets.

- **three.js r137** (MIT), vendored at `web/vendor/three.min.js` and inlined; no
  CDN at runtime.
- **Portal traversal, aperture fitting and held-object transforms** are adapted
  from `mwpenny/portal64-still-alive` (MIT), rewritten in JavaScript. No Valve
  asset, voice, map, model, texture, logo or name is used.
- **Poster:** the RepoRealm key art at `web/assets/reporealm/RepoRealm.png` is
  owner-supplied artwork, embedded into every export.
- **Type:** Space Grotesk (400, 700) and JetBrains Mono (400), embedded under the
  SIL Open Font License 1.1, with both OFL texts shipped and inlined.

The world art, chamber geometry, signage and sound are generated in code; the
poster and fonts are not. Full notices travel inside every exported page and are
reproduced in `web/NOTICE.md` and `web/vendor/THREE-LICENSE.txt`.

## Documentation

- `docs/PLUGIN-INSTALL.md` - install, verify, run and uninstall, with what is and
  is not yet proven.
- `docs/RELEASE-CANDIDATE.md` - what this candidate changed and the checks that
  still have to run before anything is published.
- `web/NOTICE.md` - third-party notices in full.
- `docs/history/README.md` - historical prototypes and earlier review material.
  Earlier local evidence packets in this checkout describe earlier bytes and are
  history, not acceptance evidence for this candidate.

## Holds

Public release, repository publication, catalog PR, social posting, demo
recording, deployment, live plugin installation and any gateway/config/credential
change stay held until the owner approves them and the QA gate has run.
