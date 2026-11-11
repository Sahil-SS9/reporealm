"""Chamber (level) construction from analysed facts.

Every cube is a real module id from the graph and every piece of evidence points
at a real local file, line and snippet. When the facts needed for a level are not
present, the level is omitted and recorded in ``unavailable`` with the reason —
a decoy is never invented and an unsupported repository never receives a fixture
it did not earn.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

from .entry import EntryReport
from .jsgraph import JsGraph
from .pygraph import PyGraph
from .scan import ScanResult, is_test_path

MAX_COPY_LEN = 2000
MAX_DECOYS = 3
MAX_EVIDENCE_CODE = 240

#: Names that make a module *look* like a program's entry without being one.
PLAUSIBLE_ENTRY_STEMS = ("main", "cli", "__main__", "run", "app", "start", "server")

TESTS_SCOPE_WARNING = (
    "This only shows the test imports this module. It does not prove the test would catch "
    "a change: for that, the test has to fail when the code changes."
)

#: Scope sentence appended to every negative import claim. A static AST read can only
#: deny a *direct* import in the analysed file; it cannot deny a transitive one.
IMPORT_SCOPE_WARNING = (
    "We only checked the import lines written in this one file. "
    "A file can still pull in other things indirectly."
)


def _no_import_reason(subject: str, shown: str) -> str:
    return (
        f"This file imports {shown}. It has no import line for {subject} "
        f"in the copy we read. {IMPORT_SCOPE_WARNING}"
    )


@dataclass
class Evidence:
    id: str
    path: str
    line: int
    code: str
    summary: str

    def as_payload(self) -> dict:
        return {
            "id": self.id,
            "path": self.path,
            "line": self.line,
            "code": self.code,
            "summary": self.summary,
        }


@dataclass
class Cube:
    id: str
    label: str
    correct: bool
    reason: str
    evidence_ids: list[str] = field(default_factory=list)

    def as_payload(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "correct": self.correct,
            "reason": self.reason,
            "evidence_ids": list(self.evidence_ids),
        }


@dataclass
class Level:
    id: str
    kind: str
    title: str
    objective: str
    subject: str
    answer_ids: list[str]
    cubes: list[Cube]
    evidence: list[Evidence]
    layout: dict
    #: Three tiers of on-demand help, plain words, weakest first. Tier 1 says what
    #: kind of thing the answer is, tier 2 says where the clue lives, tier 3 says
    #: the next step. None of them solves the chamber: the door still needs the
    #: plate and the module carried by hand.
    hints: dict = field(default_factory=dict)
    #: Blank for the standard chambers; HARD marks the exam rooms that reuse an
    #: earlier chamber's facts inside a harder space.
    difficulty: str = ""

    def as_payload(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "title": self.title[:MAX_COPY_LEN],
            "objective": self.objective[:MAX_COPY_LEN],
            "subject": self.subject[:MAX_COPY_LEN],
            "answer_ids": list(self.answer_ids),
            "cubes": [c.as_payload() for c in self.cubes],
            "evidence": [e.as_payload() for e in self.evidence],
            "layout": dict(self.layout),
            "hints": dict(self.hints),
            "difficulty": self.difficulty,
        }


@dataclass
class LevelSet:
    levels: list[Level]
    unavailable: list[dict]
    warnings: list[str]


def level_seed(fingerprint: str, level_id: str) -> int:
    """Deterministic, content-sensitive layout seed for one level."""
    digest = hashlib.sha256(f"{fingerprint}:{level_id}".encode("utf-8")).hexdigest()
    return int(digest[:12], 16) % (2**31)


def layout_for(fingerprint: str, level_id: str) -> dict:
    seed = level_seed(fingerprint, level_id)
    return {
        "seed": seed,
        "width": 12 + seed % 13,          # 12..24 m
        "length": 20 + (seed // 13) % 17,  # 20..36 m
        "height": 5 + (seed // 221) % 5,   # 5..9 m
    }


def _label(module_id: str) -> str:
    """Readable cube label that keeps the exact id discoverable."""
    return module_id


def _is_test_module(rel: str) -> bool:
    return is_test_path(rel)


def _evidence_id(level_id: str, used: int) -> str:
    return f"{level_id}.e{used}"


def _snippet(text: str, line: int) -> str:
    """The exact source line a claim cites, truncated for display."""
    if line <= 0:
        return ""
    lines = text.splitlines()
    if line > len(lines):
        return ""
    return lines[line - 1].strip()[:MAX_EVIDENCE_CODE]


class _EvidenceBuilder:
    """Accumulates unique evidence for one level, keyed by (path, line, code)."""

    def __init__(self, level_id: str) -> None:
        self.level_id = level_id
        self.items: list[Evidence] = []
        self._index: dict[tuple[str, int, str], str] = {}

    def add(self, path: str, line: int, code: str, summary: str) -> str:
        key = (path, line, code)
        if key in self._index:
            return self._index[key]
        ev = Evidence(
            id=_evidence_id(self.level_id, len(self.items) + 1),
            path=path,
            line=line,
            code=code,
            summary=summary,
        )
        self.items.append(ev)
        self._index[key] = ev.id
        return ev.id


def _tutorial(fingerprint: str) -> Level:
    return Level(
        id="tutorial",
        kind="portals",
        title="CHAMBER 00 - TWO OPENINGS",
        objective=(
            "Walk the training room. Put one opening in a wall and one in the floor, "
            "then carry a cube through. Nothing about the repository is tested here."
        ),
        subject="portals",
        answer_ids=[],
        cubes=[],
        evidence=[],
        layout=layout_for(fingerprint, "tutorial"),
        hints={
            "tier1": "This room is about the portals themselves, not about the code.",
            "tier2": "The pair of mounts is on the west wall and on the screen ahead of you.",
            "tier3": "Put one portal on each mount, then walk into either one.",
        },
    )


def _entry_level(
    scan: ScanResult, graph: PyGraph, entries: EntryReport, fingerprint: str
) -> tuple[Level | None, str]:
    primary = entries.primary
    if primary is None:
        return None, _entry_reason(graph, entries)
    if len(graph.modules) < 2:
        return None, "the repository has too few modules for a front-door choice"
    evidence_items = [ev for ev in primary.evidence if ev.line > 0]
    if not evidence_items:
        return None, "the entry point has no citable manifest line or __main__ guard line"
    decoys = _entry_decoys(graph, primary.module_id)
    if not decoys:
        return None, (
            "every other module is either a package, a test, unparseable, itself an entry "
            "point, or a package __main__ module, so there is no honest decoy to choose between"
        )
    builder = _EvidenceBuilder("entry")
    evidence_ids: list[str] = []
    for ev in evidence_items[:3]:
        evidence_ids.append(builder.add(ev.rel, ev.line, ev.code, ev.summary))
    reason = "; ".join(primary.reasons) or "declared as the program's entry point"
    cubes = [
        Cube(
            id=primary.module_id,
            label=_label(primary.module_id),
            correct=True,
            reason=f"{reason}.",
            evidence_ids=list(evidence_ids),
        )
    ]
    script = primary.primary_script
    # Every decoy claim is relative to the registration the chamber is actually
    # about. "Not the module X points at" is provable from the manifest; "running
    # this file does nothing" is not provable from a static read, so it is never said.
    anchor = f"the {script!r} command" if script else "any start-up entry in this copy"
    by_rel = scan.by_rel()
    for module_id in decoys:
        module = graph.modules[module_id]
        run_line = graph.top_level_runs.get(module_id)
        decoy_evidence: list[str] = []
        if run_line:
            snippet = _snippet(by_rel[module.rel].text(), run_line)
            decoy_evidence.append(
                builder.add(
                    module.rel,
                    run_line,
                    snippet,
                    "top-level call: this file does something when it is executed",
                )
            )
            decoy_reason = (
                f"{anchor.capitalize()} starts a different module. This file does run code "
                f"at line {run_line}, but that only shows the file does something - not that "
                "anything starts the app through it."
            )
        else:
            decoy_reason = (
                f"{anchor.capitalize()} starts a different module, and there is no "
                "if __name__ == '__main__' guard for this one in the copy we read."
            )
        cubes.append(
            Cube(
                id=module_id,
                label=_label(module_id),
                correct=False,
                reason=decoy_reason,
                evidence_ids=decoy_evidence,
            )
        )
    cubes.sort(key=lambda c: (not c.correct, c.id))
    repo = entries.repo_name or "this repository"
    if script:
        manifest_paths = ", ".join(sorted({ev.rel for ev in evidence_items}))
        objective = (
            f"{repo} registers the command {script!r} ({manifest_paths}), and that command "
            f"runs {primary.module_id}. Carry that module onto the plate. {repo} may ship "
            "other commands and other runnable files; only the module the command names "
            "answers this chamber."
        )
    else:
        objective = (
            f"{repo} registers no command that points at a file here. Carry the module that "
            f"declares itself the program ({primary.module_id}) onto the plate. Only a "
            "manifest entry or a __main__ guard counts as evidence."
        )
    return (
        Level(
            id="entry",
            kind="entry",
            title="CHAMBER 01 - THE FRONT DOOR",
            objective=objective,
            subject=primary.module_id,
            answer_ids=[primary.module_id],
            cubes=cubes,
            evidence=builder.items,
            layout=layout_for(fingerprint, "entry"),
            hints={
                "tier1": "The answer is the file that starts the app, not a library it uses.",
                "tier2": "The evidence screen shows the start-up line that names it.",
                "tier3": f"Carry {primary.module_id} to the plate.",
            },
        ),
        "",
    )


def _unparseable(graph: PyGraph) -> set[str]:
    """Repo-relative paths we could not parse: never used as puzzle candidates.

    A file with a syntax error still exists (it is a graph node), but no claim can
    be made about its guards or imports, so it must not appear as a decoy.
    """
    return {entry["path"] for entry in graph.parse_errors}


def _entry_decoys(graph: PyGraph, subject: str) -> list[str]:
    """Real modules that plausibly look like an entry point but are not the one
    this repository's manifest registers.

    Modules that *are* entry points by another route are excluded: a ``__main__``
    guard or a package ``__main__.py`` both genuinely start something, so calling
    them "not how the program starts" would teach a false fact.
    """
    unparseable = _unparseable(graph)
    candidates: list[tuple[int, str]] = []
    for module_id, module in graph.modules.items():
        if module_id == subject:
            continue
        if module_id in graph.guards:  # another real entry point: genuinely ambiguous
            continue
        if module.is_package:  # an __init__ is never "the program"
            continue
        if module_id.split(".")[-1] == "__main__":  # `python -m pkg` runs it
            continue
        if _is_test_module(module.rel):
            continue
        if module.rel in unparseable:  # cannot be analysed, so cannot be cited
            continue
        stem = module_id.split(".")[-1]
        rank = 0 if stem in PLAUSIBLE_ENTRY_STEMS else 1
        candidates.append((rank, module_id))
    candidates.sort()
    return [module_id for _, module_id in candidates[:MAX_DECOYS]]


def _imports_level(graph: PyGraph, fingerprint: str) -> Level | None:
    edge_map = graph.edge_dict()
    best: tuple[tuple, str] | None = None
    for module_id, module in graph.modules.items():
        if _is_test_module(module.rel):
            continue
        importers = graph.importers(module_id)
        if not 2 <= len(importers) <= 3:
            continue
        product_importers = [
            importer
            for importer in importers
            if (m := graph.modules.get(importer)) is not None and not _is_test_module(m.rel)
        ]
        if not product_importers:
            # A package only its own tests import is not a routing lesson.
            continue
        # Deterministic ranking: real product importers first, then more importers
        # (richer puzzle), then fewer path segments (a subject a human can hold in
        # their head), then the id.
        key = (-len(product_importers), -len(importers), module_id.count("."), module_id)
        if best is None or key < best[0]:
            best = (key, module_id)
    if best is None:
        return None
    subject = best[1]
    importers = graph.importers(subject)
    builder = _EvidenceBuilder("imports")
    cubes: list[Cube] = []
    for importer in importers:
        edges = edge_map.get((importer, subject)) or []
        anchor = edges[0] if edges else None
        if anchor is None:  # pragma: no cover - importers are derived from edges
            continue
        ev_id = builder.add(
            anchor.path,
            anchor.line,
            anchor.code,
            f"{anchor.source} -> {anchor.target} (static import statement)",
        )
        cubes.append(
            Cube(
                id=importer,
                label=_label(importer),
                correct=True,
                reason=f"imports {subject} at {anchor.path}:{anchor.line}.",
                evidence_ids=[ev_id],
            )
        )
    if len(cubes) < 2:
        return None
    for decoy in _import_decoys(graph, subject, {c.id for c in cubes}):
        targets = graph.targets(decoy)
        shown = (
            ", ".join(targets[:3])
            if targets
            else "no module in this repository"
        )
        cubes.append(
            Cube(
                id=decoy,
                label=_label(decoy),
                correct=False,
                reason=_no_import_reason(subject, shown),
            )
        )
    cubes.sort(key=lambda c: (not c.correct, c.id))
    return Level(
        id="imports",
        kind="imports",
        title="CHAMBER 02 - DEPENDENCY ROUTING",
        objective=(
            f"Carry every module that imports {subject}. You need all of them; "
            "one correct cube is not enough."
        ),
        subject=subject,
        answer_ids=sorted(c.id for c in cubes if c.correct),
        cubes=cubes,
        evidence=builder.items,
        layout=layout_for(fingerprint, "imports"),
        hints={
            "tier1": "The answer is a set of files, not a single one.",
            "tier2": "Each import line on the evidence screen names one file that pulls this one in.",
            "tier3": "Carry every module the import lines point at: " + ", ".join(sorted(c.id for c in cubes if c.correct)) + ".",
        },
    )


def _import_decoys(graph: PyGraph, subject: str, correct: set[str]) -> list[str]:
    """Modules that import something (so they look connected) but not *subject*."""
    unparseable = _unparseable(graph)
    candidates: list[tuple[int, str]] = []
    for module_id, module in graph.modules.items():
        if module_id == subject or module_id in correct:
            continue
        if _is_test_module(module.rel):
            continue
        if module.rel in unparseable:
            continue
        targets = graph.targets(module_id)
        if not targets:
            continue
        candidates.append((0, module_id))
    candidates.sort()
    return [module_id for _, module_id in candidates[:MAX_DECOYS]]


def _tests_level(graph: PyGraph, fingerprint: str, avoid: str | None = None) -> tuple[Level | None, str]:
    edge_map = graph.edge_dict()
    unparseable = _unparseable(graph)
    ranked: list[tuple[tuple, str, list[str]]] = []
    for module_id, module in graph.modules.items():
        if _is_test_module(module.rel):
            continue
        if module.rel in unparseable:
            continue
        test_importers = [
            importer
            for importer in graph.importers(module_id)
            if (m := graph.modules.get(importer)) is not None and _is_test_module(m.rel)
        ]
        if not 1 <= len(test_importers) <= 2:
            continue
        # Prefer a subject the routing chamber did not already use, then the
        # tightest suite, then fewer path segments, then the id.
        key = (1 if module_id == avoid else 0, len(test_importers), module_id.count("."), module_id)
        ranked.append((key, module_id, sorted(test_importers)))
    if not ranked:
        return None, (
            "no product module is imported by one or two test modules, so no guard chamber "
            "can be grounded"
        )
    ranked.sort()
    _, subject, test_importers = ranked[0]
    builder = _EvidenceBuilder("tests")
    cubes: list[Cube] = []
    for importer in test_importers:
        edges = edge_map.get((importer, subject)) or []
        anchor = edges[0] if edges else None
        if anchor is None:  # pragma: no cover - derived from edges
            continue
        ev_id = builder.add(
            anchor.path,
            anchor.line,
            anchor.code,
            f"{anchor.source} -> {anchor.target} (test module importing its subject)",
        )
        cubes.append(
            Cube(
                id=importer,
                label=_label(importer),
                correct=True,
                reason=(
                    f"imports {subject} at {anchor.path}:{anchor.line}, so it is the suite "
                    "positioned to exercise it."
                ),
                evidence_ids=[ev_id],
            )
        )
    if not cubes:
        return None, "the guard subject has no citable test import line"
    decoys = _test_decoys(graph, subject, {c.id for c in cubes})
    if not decoys:
        return None, (
            "no other test module exists to use as an honest decoy, so the chamber would "
            "have a single option"
        )
    for decoy in decoys:
        targets = graph.targets(decoy)
        shown = (
            ", ".join(targets[:3])
            if targets
            else "no module in this repository"
        )
        cubes.append(
            Cube(
                id=decoy,
                label=_label(decoy),
                correct=False,
                reason=_no_import_reason(subject, shown),
            )
        )
    cubes.sort(key=lambda c: (not c.correct, c.id))
    return (
        Level(
            id="tests",
            kind="tests",
            title="CHAMBER 03 - THE GUARD",
            objective=(
                f"Find the test that imports {subject}. Use the import lines, not the file "
                f"name. {TESTS_SCOPE_WARNING}"
            ),
            subject=subject,
            answer_ids=sorted(c.id for c in cubes if c.correct),
            cubes=cubes,
            evidence=builder.items,
            layout=layout_for(fingerprint, "tests"),
            hints={
                "tier1": "The answer is a test file, not product code.",
                "tier2": "The evidence screen shows which test the analyser saw importing this module.",
                "tier3": "Carry the test the import line names: " + ", ".join(sorted(c.id for c in cubes if c.correct)) + ".",
            },
        ),
        "",
    )


def _test_decoys(graph: PyGraph, subject: str, correct: set[str]) -> list[str]:
    unparseable = _unparseable(graph)
    helpers: list[str] = []
    packages: list[str] = []
    for module_id, module in graph.modules.items():
        if module_id == subject or module_id in correct:
            continue
        if not _is_test_module(module.rel):
            continue
        if module.rel in unparseable:
            continue
        if module.is_package:  # a tests/__init__ is not a candidate suite
            packages.append(module_id)
        else:
            helpers.append(module_id)
    helpers.sort()
    packages.sort()
    # Real test modules first; fall back to packages only when nothing else exists.
    return (helpers or packages)[:MAX_DECOYS]


def _relay_level(imports: Level, fingerprint: str) -> Level:
    """CHAMBER 04 - THE RELAY: the dependency-routing solve behind a barrier.

    The subject, cubes and evidence are deliberately the routing chamber's own:
    the harder room deepens one true fact instead of inventing a second one.
    The new cost is spatial - the barrier strips the room, so the only crossing
    is the portal pair taught in the intake, used under exam conditions.
    """
    return Level(
        id="relay",
        kind="relay",
        title="CHAMBER 04 - THE RELAY",
        difficulty="HARD",
        objective=(
            imports.objective.rstrip(". ") + ". "
            "A wall now splits the room: get across with the portal pair first."
        ),
        subject=imports.subject,
        answer_ids=list(imports.answer_ids),
        cubes=list(imports.cubes),
        evidence=list(imports.evidence),
        layout=layout_for(fingerprint, "relay"),
        hints={
            "tier1": "Same answer as the routing room; the wall is the new part.",
            "tier2": "The mounts sit on the side walls, one per side of the wall between you and the cubes. The slot in the wall lets you aim.",
            "tier3": "Shoot both mounts, walk in, then carry every answer to the far plates: "
            + ", ".join(imports.answer_ids) + ".",
        },
    )


def _weighbridge_level(tests: Level, fingerprint: str) -> Level:
    """CHAMBER 05 - THE WEIGHBRIDGE: the guard chamber plus the floor plate.

    Same subject, cubes and evidence as the guard chamber. The door will not
    swing for the cube alone: the metal plate in front of it must feel the
    player's weight, so the final answer has to be earned on your feet.
    """
    tier3 = tests.hints.get("tier3", "")
    return Level(
        id="weighbridge",
        kind="weighbridge",
        title="CHAMBER 05 - THE WEIGHBRIDGE",
        difficulty="HARD",
        objective=(
            tests.objective.rstrip(". ") + ". "
            "The door also weighs the floor: stand on its plate to make it open."
        ),
        subject=tests.subject,
        answer_ids=list(tests.answer_ids),
        cubes=list(tests.cubes),
        evidence=list(tests.evidence),
        layout=layout_for(fingerprint, "weighbridge"),
        hints={
            "tier1": "Same answer as the guard room; the door is the new part.",
            "tier2": "The evidence screen shows which test the analyser saw importing this module.",
            "tier3": tier3.rstrip(". ") + ". Then stand on the metal plate in front of the door.",
        },
    )


def build_levels(
    scan: ScanResult,
    graph: PyGraph,
    js_graph: JsGraph,
    entries: EntryReport,
    fingerprint: str,
) -> LevelSet:
    levels: list[Level] = []
    unavailable: list[dict] = []

    if not graph.modules:
        unavailable.append(
            {
                "kind": "chambers",
                "reason": (
                    "this repository has no Python modules, so no chamber can be built "
                    "from its real code"
                ),
            }
        )
        return LevelSet(levels=[], unavailable=unavailable, warnings=list(scan.warnings))

    levels.append(_tutorial(fingerprint))

    entry_level, entry_reason = _entry_level(scan, graph, entries, fingerprint)
    if entry_level is None:
        unavailable.append({"kind": "entry", "reason": entry_reason})
    else:
        levels.append(entry_level)

    imports_level = _imports_level(graph, fingerprint)
    if imports_level is None:
        unavailable.append(
            {
                "kind": "imports",
                "reason": (
                    "no module here is imported by two or three other modules (at least one "
                    "of them product code), so this chamber cannot be built without "
                    "inventing one"
                ),
            }
        )
    else:
        levels.append(imports_level)

    tests_level, tests_reason = _tests_level(
        graph, fingerprint, avoid=imports_level.subject if imports_level else None
    )
    if tests_level is None:
        unavailable.append({"kind": "tests", "reason": tests_reason})
    else:
        levels.append(tests_level)

    # The exam rooms (HARD) rebuild an earlier chamber's facts inside a harder
    # space. They disappear honestly when their base chamber could not exist.
    if imports_level is None:
        unavailable.append(
            {
                "kind": "relay",
                "reason": (
                    "no routing chamber could be built, so the relay room has no "
                    "real import set to reuse"
                ),
            }
        )
    else:
        levels.append(_relay_level(imports_level, fingerprint))

    if tests_level is None:
        unavailable.append(
            {
                "kind": "weighbridge",
                "reason": (
                    "no guard chamber could be built, so the weighbridge room has no "
                    "real test evidence to reuse"
                ),
            }
        )
    else:
        levels.append(_weighbridge_level(tests_level, fingerprint))

    return LevelSet(levels=levels, unavailable=unavailable, warnings=list(scan.warnings))


def _entry_reason(graph: PyGraph, entries: EntryReport) -> str:
    if not entries.candidates:
        return (
            "no entry point evidence was found (no __main__ guard, no package __main__, "
            "no console_scripts entry), so no front-door chamber can be stated"
        )
    if len(graph.modules) < 2:
        return "the repository has too few modules for a front-door choice"
    return "the entry point has no citable manifest line or __main__ guard line"
