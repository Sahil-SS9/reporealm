# RepoRealm 0.3.0 - release candidate notes

Version `0.3.0` is the public-identity candidate: the first slice is renamed from
its internal codename to **RepoRealm**, with one public slug, one public tool,
one public command and one version across manifest, project metadata and the
local catalog draft.

This file records what changed in the packaging/branding lane and which checks
are still outstanding. It is not an acceptance record.

## Public surface (canonical)

| Surface | Value |
|---|---|
| Plugin / catalog name | `reporealm` |
| Manifest | `plugin.yaml`, `manifest_version: 2` |
| Version | `0.3.0` (same in `plugin.yaml`, `pyproject.toml`, `sourcedrive.__version__`, catalog draft) |
| Slash command | `/reporealm <repo> | status | stop` |
| Tool | `reporealm_chambers` (toolset `reporealm`) |
| Module entry point | `python -m reporealm` |
| Console script | `reporealm` |
| Hermes floor | `requires_hermes: ">=0.20.1"` |

`>=0.20.1` is grounded in a released upstream tree, not a guess. Read from the
upstream source at each release tag: `0.20.1` (`v2026.8.13`) already has
`manifest_version: 2`, `register_tool(... description, emoji)`,
`register_command(... args_hint)` and `config_schema`, which is everything this
plugin uses, while `0.20.0` (`v2026.8.3`) has neither `manifest_version: 2` nor
`config_schema`. It is not a CalVer date and not a future version. The floor is
surface-verified from released source, not runtime-verified on 0.20.1; if QA
cannot exercise that release, raise the floor rather than claim support.

## Internal identifiers kept on purpose

These stay: they are implementation names, not public surface, and changing them
would fork the game or the tests for no user-visible gain.

- Python package `sourcedrive` (public wrapper `reporealm` delegates to it).
- Game-side globals `SD`, `SourceDrive`, and the payload global
  `window.SOURCE_DRIVE_DATA` that the read-only web modules consume.
- `analyse.py` compatibility entry point.
- `SOURCE_DRIVE_CACHE` as a legacy alias for `REPOREALM_CACHE`.

Removed rather than aliased: the `source-drive` console script, the
`source_drive_chambers` tool, the `/source-drive` command and the
`source-drive` health identity. This is an unpublished candidate, so there is no
compatibility contract to preserve and two public names would be worse than one.

## What changed

- **Manifest** (`plugin.yaml`): `name: reporealm`, `version: 0.3.0`,
  `provides_tools: [reporealm_chambers]`, `requires_hermes: ">=0.20.1"`.
  The `homepage` URL was removed rather than repointed, because no public
  repository exists yet and a stale link is a false claim.
- **Project metadata** (`pyproject.toml`): project name `reporealm`, version
  `0.3.0`, console script `reporealm`, packages `sourcedrive` + `reporealm`.
- **Plugin** (`__init__.py`): public tool/command/toolset names, help text,
  output and error prefixes.
- **Wrapper** (`reporealm/`): `python -m reporealm` and the `reporealm` package,
  delegating to the one implementation.
- **Backend branding**: CLI `prog`, output headers, error prefixes, background
  spawn (`-m reporealm`), health identity `app: reporealm`, server identity
  string, cache directory/env names, thread/handler names.
- **Builder** (`scripts/build_web.py`): generic, containment-checked
  `{{ASSET:...}}` discovery with a fail-closed "no unfilled marker" rule, and a
  required `{{FONT_NOTICES}}` placeholder, so the poster, fonts and OFL texts
  ship from a cloned layout without editing the builder.
- **Docs**: `README.md` rewritten as public product/install/use/limits docs;
  `docs/PLUGIN-INSTALL.md` added; `web/NOTICE.md` re-branded and extended with
  poster and font attribution.
- **Submission drafts**: `submission/CATALOG-DRAFT-reporealm.yaml` and
  `submission/PACKAGING-LANE.txt`.

Not touched by this lane: `web/shell.html`, the web modules, web tests and the
web assets (owned by the UI lane), the controlling brief, earlier receipts, and
the retained historical evidence archives.

## Outstanding before anything public

The rename changed public names and the health identity, so the checks below must
run on the frozen tree; none of them are claimed here.

1. **Backend suite** - `python3 -m unittest discover -s tests -t .` on this tree
   (test expectations were updated for the public names; the behaviour assertions
   are unchanged).
2. **Frontend suites** - the node unit suite and the real browser suite on the
   final export produced by the updated builder.
3. **Real export** - one export from a clean clone, confirming the poster, all
   three fonts and both OFL notices are embedded and no `{{ASSET:` or
   `{{FONT_NOTICES}}` marker survives.
4. **Native registration** - `/reporealm` and `reporealm_chambers` through an
   unmodified Hermes release at or above the declared floor, not just this
   checkout's import path.
5. **Clean directory install** - clone, `hermes plugins validate`, install by
   directory, then the command/tool checks in `docs/PLUGIN-INSTALL.md`.
6. **Catalog draft** - replace the pending `repo`/`sha`/`maintainer` fields with
   real values after the owner publishes the repository and the tested commit
   exists; run catalog CI's `hermes plugins validate` at that pin.

## Known gaps in this candidate

- Public repository URL and 40-hex commit pin: **pending** (not fabricated, not
  guessed). The catalog draft carries explicit pending markers.
- Wheel/sdist: **not built, not verified, not offered**.
- The health identity rename means a managed server started under the old
  `source-drive` identity is no longer recognised by `stop`. No such server was
  running when this lane was prepared; if one appears, stop it with the old
  checkout's CLI before switching.
- No performance, cross-browser, mobile or audio-quality certification is made.
