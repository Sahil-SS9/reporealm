"""Static entry-point evidence.

A module is an entry point only when something *declares* it: an
``if __name__ == "__main__"`` guard, a ``[project.scripts]`` /
``[tool.poetry.scripts]`` table, a ``setup.cfg`` ``console_scripts`` block, a
string-literal ``entry_points`` in ``setup.py``, or a package ``__main__.py``.

Manifests are read as data: TOML/INI/JSON are parsed, ``setup.py`` is walked with
:mod:`ast` and never executed, so a malicious ``setup.py`` cannot run.
"""

from __future__ import annotations

import ast
import configparser
import json
import re
from dataclasses import dataclass, field

from .pygraph import PyGraph, parse_source as pygraph_parse
from .scan import ScanResult

MAX_EVIDENCE_CODE = 240


@dataclass(frozen=True)
class EntryEvidence:
    """One grounded fact that supports (or denies) an entry claim."""

    rel: str
    line: int
    code: str
    summary: str
    module_id: str = ""


@dataclass
class EntryCandidate:
    module_id: str
    score: int
    reasons: list[str] = field(default_factory=list)
    evidence: list[EntryEvidence] = field(default_factory=list)
    script_names: list[str] = field(default_factory=list)
    primary_script: str = ""


@dataclass
class EntryReport:
    candidates: list[EntryCandidate] = field(default_factory=list)
    script_targets: dict[str, str] = field(default_factory=dict)  # script name -> module id
    manifest_evidence: list[EntryEvidence] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    #: Name of the repository these facts describe. Chambers quote it so a claim is
    #: always about *this* repository's registration, never about "the" front door.
    repo_name: str = ""

    @property
    def primary(self) -> EntryCandidate | None:
        return self.candidates[0] if self.candidates else None


def _line_of(text: str, needle: str, start: int = 1) -> int:
    """1-based line number of the first line containing *needle* (0 if absent)."""
    for idx, line in enumerate(text.splitlines(), start=1):
        if idx >= start and needle in line:
            return idx
    return 0


def _snippet(text: str, line: int) -> str:
    if line <= 0:
        return ""
    lines = text.splitlines()
    if line > len(lines):
        return ""
    return lines[line - 1].strip()[:MAX_EVIDENCE_CODE]


def _parse_pyproject(sf, report: EntryReport, graph: PyGraph) -> None:
    try:
        import tomllib
    except ModuleNotFoundError:  # pragma: no cover - Python < 3.11
        report.warnings.append("pyproject.toml skipped: tomllib unavailable on this interpreter")
        return
    text = sf.text()
    try:
        data = tomllib.loads(text)
    except (tomllib.TOMLDecodeError, ValueError) as exc:
        report.warnings.append(f"pyproject.toml is not valid TOML: {str(exc)[:160]}")
        return
    tables: list[tuple[str, dict]] = []
    project_scripts = ((data.get("project") or {}).get("scripts")) or {}
    if isinstance(project_scripts, dict) and project_scripts:
        tables.append(("[project.scripts]", project_scripts))
    poetry_scripts = (((data.get("tool") or {}).get("poetry") or {}).get("scripts")) or {}
    if isinstance(poetry_scripts, dict) and poetry_scripts:
        tables.append(("[tool.poetry.scripts]", poetry_scripts))
    for table_name, scripts in tables:
        header_line = _line_of(text, table_name) or 1
        for script_name in sorted(scripts):
            target = scripts[script_name]
            if isinstance(target, dict):  # poetry table form {"callable": "..."}
                target = target.get("callable") or target.get("reference") or ""
            target = str(target)
            module_part = target.split(":", 1)[0].strip()
            # Exact id only: resolving a prefix would credit the package with a
            # claim the manifest never made.
            module_id = graph.resolve_exact(module_part)
            line = _line_of(text, script_name, start=header_line) or header_line
            code = _snippet(text, line)
            if module_id is None:
                report.warnings.append(
                    f"{sf.rel}:{line}: entry manifest names module {module_part!r} "
                    "which has no file in this repository"
                )
                continue
            if not code:  # no citable line: keep the fact, drop the evidence
                report.warnings.append(
                    f"{sf.rel}: could not locate the line that registers {script_name!r}; "
                    "the chamber will not cite it"
                )
                report.script_targets[script_name] = module_id
                continue
            report.script_targets[script_name] = module_id
            report.manifest_evidence.append(
                EntryEvidence(
                    rel=sf.rel,
                    line=line,
                    code=code,
                    summary=(
                        f"{table_name} registers the console script {script_name!r} "
                        f"against {module_part}"
                    ),
                    module_id=module_id,
                )
            )


def _parse_setup_cfg(sf, report: EntryReport, graph: PyGraph) -> None:
    text = sf.text()
    parser = configparser.ConfigParser()
    try:
        parser.read_string(text)
    except configparser.Error as exc:
        report.warnings.append(f"setup.cfg is not valid INI: {str(exc)[:160]}")
        return
    if not parser.has_section("options.entry_points"):
        return
    raw = parser.get("options.entry_points", "console_scripts", fallback="")
    header_line = _line_of(text, "[options.entry_points]") or 1
    for line_text in raw.splitlines():
        entry = line_text.strip()
        if not entry or "=" not in entry:
            continue
        script_name, _, target = entry.partition("=")
        module_part = target.strip().split(":", 1)[0].strip()
        module_id = graph.resolve_exact(module_part)
        line = _line_of(text, entry, start=header_line) or header_line
        if module_id is None:
            report.warnings.append(
                f"{sf.rel}:{line}: console_scripts names module {module_part!r} "
                "which has no file in this repository"
            )
            continue
        report.script_targets[script_name.strip()] = module_id
        report.manifest_evidence.append(
            EntryEvidence(
                rel=sf.rel,
                line=line,
                code=_snippet(text, line),
                summary=(
                    f"setup.cfg [options.entry_points] registers the console script "
                    f"{script_name.strip()!r} against {module_part}"
                ),
                module_id=module_id,
            )
        )


_SETUP_ENTRY_RE = re.compile(r"([\w.\-]+)\s*=\s*([\w.]+)\s*:\s*[\w.]+")


def _setup_console_scripts(value: ast.AST, rel: str, report: EntryReport) -> list[tuple[str, str]]:
    """Extract (script, module) pairs from a literal ``entry_points`` argument.

    Two literal shapes are understood: a string
    (``"[console_scripts]\\nname = mod:func"``) and a dict whose
    ``console_scripts`` key maps to a string or a list of strings. Anything
    computed at runtime is skipped with a warning: the analyser never evaluates
    repository code.
    """
    if isinstance(value, ast.Constant) and isinstance(value.value, str):
        return [(m.group(1), m.group(2)) for m in _SETUP_ENTRY_RE.finditer(value.value)]
    if isinstance(value, ast.Dict):
        pairs: list[tuple[str, str]] = []
        for key, item in zip(value.keys, value.values):
            if not (isinstance(key, ast.Constant) and isinstance(key.value, str)):
                continue
            if key.value != "console_scripts":
                continue
            if isinstance(item, ast.Constant) and isinstance(item.value, str):
                pairs.extend((m.group(1), m.group(2)) for m in _SETUP_ENTRY_RE.finditer(item.value))
            elif isinstance(item, (ast.List, ast.Tuple)):
                for element in item.elts:
                    if isinstance(element, ast.Constant) and isinstance(element.value, str):
                        pairs.extend(
                            (m.group(1), m.group(2))
                            for m in _SETUP_ENTRY_RE.finditer(element.value)
                        )
            else:
                report.warnings.append(
                    f"{rel}:{getattr(item, 'lineno', 0)}: setup() console_scripts value is not a "
                    "literal; skipped (the analyser does not evaluate code)"
                )
        return pairs
    return []


def _parse_setup_py(sf, report: EntryReport, graph: PyGraph) -> None:
    """Walk ``setup(...)`` for literal console_scripts. Never executes it."""
    text = sf.text()
    try:
        tree = pygraph_parse(text, sf.rel)
    except (SyntaxError, ValueError, RecursionError, MemoryError) as exc:
        report.warnings.append(f"{sf.rel}: cannot be parsed as Python: {str(exc)[:160]}")
        return
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
        if name != "setup":
            continue
        for kw in node.keywords:
            if kw.arg != "entry_points":
                continue
            pairs = _setup_console_scripts(kw.value, sf.rel, report)
            if not pairs:
                report.warnings.append(
                    f"{sf.rel}:{kw.value.lineno}: setup() entry_points has no literal "
                    "console_scripts; skipped (the analyser does not evaluate code)"
                )
            for script_name, module_part in pairs:
                module_id = graph.resolve_exact(module_part)
                line = kw.value.lineno
                if module_id is None:
                    report.warnings.append(
                        f"{sf.rel}:{line}: entry_points names module {module_part!r} "
                        "which has no file in this repository"
                    )
                    continue
                report.script_targets[script_name] = module_id
                report.manifest_evidence.append(
                    EntryEvidence(
                        rel=sf.rel,
                        line=line,
                        code=_snippet(text, line),
                        summary=(
                            f"setup.py entry_points registers the console script "
                            f"{script_name!r} against {module_part}"
                        ),
                        module_id=module_id,
                    )
                )


def _parse_package_json(sf, report: EntryReport) -> None:
    text = sf.text()
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, ValueError) as exc:
        report.warnings.append(f"package.json is not valid JSON: {str(exc)[:160]}")
        return
    if not isinstance(data, dict):
        return
    fields = [k for k in ("main", "module", "bin") if k in data]
    if fields:
        report.warnings.append(
            "package.json declares "
            + ", ".join(sorted(fields))
            + " but JavaScript entry points are not modelled: chamber facts are Python-only"
        )


def find_entries(scan: ScanResult, graph: PyGraph, repo_name: str = "") -> EntryReport:
    repo_name = repo_name or scan.root.name
    report = EntryReport(repo_name=repo_name)
    for name in ("pyproject.toml", "setup.cfg", "setup.py", "package.json"):
        sf = scan.manifest(name)
        if sf is None:
            continue
        if name == "pyproject.toml":
            _parse_pyproject(sf, report, graph)
        elif name == "setup.cfg":
            _parse_setup_cfg(sf, report, graph)
        elif name == "setup.py":
            _parse_setup_py(sf, report, graph)
        else:
            _parse_package_json(sf, report)

    manifest_by_module: dict[str, list[EntryEvidence]] = {}
    for ev in report.manifest_evidence:
        if ev.module_id:
            manifest_by_module.setdefault(ev.module_id, []).append(ev)

    candidates: list[EntryCandidate] = []
    for module in sorted(graph.modules.values(), key=lambda m: m.id):
        score = 0
        reasons: list[str] = []
        evidence: list[EntryEvidence] = []
        script_names = sorted(
            name for name, module_id in report.script_targets.items() if module_id == module.id
        )
        in_manifest = manifest_by_module.get(module.id, [])
        primary_script = ""
        if in_manifest:
            score += 100
            reasons.append("registered as a console script in an entry manifest")
            evidence.extend(in_manifest)
            # When several scripts exist, prefer the one whose name matches the
            # repository's own name: that is the program the user means by "this
            # repository" rather than an auxiliary tool it also ships.
            ranked = sorted(script_names, key=lambda n: (-_name_bonus(n, repo_name), n))
            primary_script = ranked[0] if ranked else ""
            score += _name_bonus(primary_script, repo_name)
            if primary_script:
                reasons.append(f"backs the {primary_script!r} console script")
        guard_line = graph.guards.get(module.id)
        if guard_line:
            score += 40
            reasons.append("has an if __name__ == '__main__' guard")
            text = (scan.by_rel()[module.rel].text())
            evidence.append(
                EntryEvidence(
                    rel=module.rel,
                    line=guard_line,
                    code=_snippet(text, guard_line),
                    summary="the file runs itself only when executed as a script",
                )
            )
        if module.id.split(".")[-1] == "__main__":
            score += 25
            package = module.id.rsplit(".", 1)[0] or module.id
            reasons.append(
                f"is the __main__ module of {package}, so `python -m {package}` executes it"
            )
        run_line = graph.top_level_runs.get(module.id)
        if run_line and score:
            # Recorded as a fact about the file, never as an entry point: a top-level
            # call proves the file *does* something, not that anything starts it.
            text = scan.by_rel()[module.rel].text()
            reasons.append(f"runs code at line {run_line} when the file is executed")
            evidence.append(
                EntryEvidence(
                    rel=module.rel,
                    line=run_line,
                    code=_snippet(text, run_line),
                    summary="top-level call: this file does something when executed",
                )
            )
        if score:
            candidates.append(
                EntryCandidate(
                    module_id=module.id,
                    score=score,
                    reasons=reasons,
                    evidence=evidence,
                    script_names=script_names,
                    primary_script=primary_script,
                )
            )

    candidates.sort(key=lambda c: (-c.score, c.module_id))
    report.candidates = candidates
    if not candidates:
        report.warnings.append(
            "no entry point found: no __main__ guard, __main__.py, or console_scripts entry"
        )
    return report


def _name_bonus(script_name: str, repo_name: str) -> int:
    """Prefer a console script whose name looks like the repository's own name."""
    script = re.sub(r"[^a-z0-9]", "", script_name.lower())
    repo = re.sub(r"[^a-z0-9]", "", repo_name.lower())
    if not script or not repo:
        return 0
    if repo.startswith(script) or script.startswith(repo):
        return 60
    if script in repo:
        return 30
    return 0
