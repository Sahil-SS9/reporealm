# RepoRealm - install, verify and run

This is the product installation note for the `reporealm` Hermes plugin
(version `0.3.0`). It describes the supported distribution (a Git-directory
plugin), how to verify an install honestly, and how to remove it again.

## What "installed" means here

RepoRealm ships as a **plugin directory**: a checkout whose root holds
`plugin.yaml` and `__init__.py`, plus the frontend the backend needs
(`scripts/build_web.py`, `web/`). Hermes loads the root `__init__.py` and calls
`register(ctx)`, which registers exactly two surfaces:

- tool `reporealm_chambers` (toolset `reporealm`), read-only analysis;
- slash command `/reporealm`.

No wheel is built or shipped. `pyproject.toml` carries the project metadata and
the `reporealm` console script, but a wheel would not contain the frontend the
exporter resolves from the checkout, so an installed-distribution asset path is
**unverified** and is not offered as a supported route.

## Requirements

| Requirement | Value |
|---|---|
| Hermes | `>=0.20.1` (declared in `plugin.yaml`) |
| Python | 3.11+ |
| Python dependencies | none (`python_dependencies: []`) |
| Runtime network access | none (the game and analyser are offline) |
| Browser | WebGL-capable desktop browser, layout floor 720x560 |

`0.20.1` is the floor because it is the earliest released Hermes whose plugin
surface covers everything this manifest uses: `manifest_version: 2`,
`register_tool(... description, emoji)`, `register_command(... args_hint)` and
`config_schema`, all present in the `v2026.8.13` source tree, while release
`0.20.0` (`v2026.8.3`) has neither `manifest_version: 2` nor `config_schema`.
Newer Hermes also enforces the same floor from the manifest, so an older host
skips the plugin cleanly instead of half-loading it. The floor is
surface-verified, not runtime-verified on 0.20.1 itself; if the QA lane cannot
exercise it there, raise the floor rather than claim support.

## Install

The public repository URL and its pinned commit do not exist yet, so this note
does not print an install command as if it had been run.

When the repository is published, the two equivalent forms are:

```bash
# by catalog-style repo reference (also accepts repo#subdir for a monorepo)
hermes plugins install <repo-url>

# or by cloning into the active Hermes plugin directory yourself
git clone <repo-url> "$HERMES_HOME/plugins/reporealm"
```

Until then, the supported path is running from a checkout:

```bash
cd /path/to/reporealm-checkout
python3 -m reporealm --help
```

`python3 -m sourcedrive ...` remains a working alias for the same CLI: the
implementation package keeps its internal name.

## Verify an install

Run these in order; each answers a different question.

1. **Manifest and capabilities** - `hermes plugins validate /path/to/checkout`.
   It loads the plugin in an isolated child process, calls `register(ctx)` and
   compares what was actually registered against `provides_tools`, then checks
   `requires_hermes`, `config_schema`, `requires_env` and the install scan.
2. **Loading and registration** - `hermes plugins list` should show `reporealm`
   enabled, and the command/tool should appear in the session that loads it.
3. **Native dispatch** - `/reporealm /path/to/a/repository` should return a
   loopback URL, and `/reporealm status` should report that instance healthy.
   A tool call to `reporealm_chambers` with `{"repo": "..."}` should return the
   schema-v1 payload.
4. **Served game** - open the returned URL; `/healthz` should report
   `app: reporealm` with the same pid, port and fingerprint as the CLI record.
5. **Owned stop** - `/reporealm stop --port <port>` should close the port and
   remove the instance record, and must refuse any process it cannot identify.

Steps 1-5 are the gate that has **not** yet run against this candidate's final
bytes. Do not report the plugin as installed-and-working from source execution
alone.

## Run

```bash
python3 -m reporealm analyse /path/to/repo --out payload.json   # payload only
python3 -m reporealm export  /path/to/repo --out game.html      # offline single file
python3 -m reporealm play    /path/to/repo                      # foreground, Ctrl+C stops
python3 -m reporealm play    /path/to/repo --background         # detached + URL
python3 -m reporealm status
python3 -m reporealm stop --port 7788
```

`export` writes one self-contained HTML file: renderer, game modules, payload,
poster, fonts and every licence notice inlined. `play` exports into the runtime
cache and serves it on `127.0.0.1` only.

### Where state lives

Runtime state stays out of the checkout, in `$REPOREALM_CACHE` (or
`$XDG_CACHE_HOME/reporealm`, or `~/.cache/reporealm`): one export directory per
repository fingerprint, one instance record per managed server, and one log per
background server. The legacy `SOURCE_DRIVE_CACHE` variable is still honoured as
an internal alias.

## Uninstall / stop

```bash
python3 -m reporealm stop --all     # stop every managed instance
rm -rf "$REPOREALM_CACHE"           # remove exports, records and logs
```

Then remove the plugin directory (or `hermes plugins remove reporealm` once a
catalog install exists), and delete `plugins.entries.reporealm` from
`config.yaml` if you set the `port` config key. Nothing was written into the
plugin directory itself, so removing it leaves no runtime state behind.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `frontend exporter not found at .../scripts/build_web.py` | The directory is not a full checkout (a wheel-style copy cannot export). Install the whole repository, or pass `--exporter`. |
| `port 7788 is held by another RepoRealm instance for a different repository` | A managed server for another repository owns that port. `python3 -m reporealm stop --port 7788`, or pass `--port`. |
| `server ... did not answer /healthz within 15s` | The background server failed to start; read the log path printed in the message. |
| `no managed RepoRealm instances` from `status` | No instance records in the active cache root - check `REPOREALM_CACHE` before assuming a server is unmanaged. |
| Browser test aborts with `SingletonSocket path too long` | Test-environment constraint: use a short `TMPDIR`. Product behaviour is unaffected. |

## What is proven, and what is not

Proven today: the analyser, exporter, managed server and stop semantics are
exercised by the backend suite on a source checkout; the CLI path is the same
path the plugin calls.

Not proven on this candidate: a clean clone/directory install, upstream
`hermes plugins validate` at a pinned commit, native registration against an
unmodified Hermes release, the end-to-end browser journeys on the final export,
and any wheel or catalog installation. Those run in the QA lane after the
writers freeze the tree.
