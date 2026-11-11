/* SOURCE DRIVE - payload validation and normalisation.
 *
 * The frontend consumes schema_version 1 (see REBUILD-CONTRACT.md). Nothing here
 * trusts the analyser: every field is checked, and anything unsupported degrades
 * to an honest empty state instead of a half-built chamber.
 */
(function (SD) {
  'use strict';

  var C = SD.Core;
  var SUPPORTED_SCHEMA = 1;
  var KINDS = { portals: 1, entry: 1, imports: 1, tests: 1, relay: 1, weighbridge: 1 };
  var KIND_ORDER = { portals: 0, entry: 1, imports: 2, tests: 3, relay: 4, weighbridge: 5 };

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function str(v, fallback) { return typeof v === 'string' && v.length ? v : (fallback === undefined ? '' : fallback); }
  function posInt(v) {
    var n = Number(v);
    return (isFinite(n) && n >= 1 && Math.floor(n) === n) ? n : 0;
  }
  function arr(v) { return Array.isArray(v) ? v : []; }

  function emptyState(reason, detail) {
    return {
      ok: false,
      reason: reason,
      detail: detail || '',
      repo: null,
      levels: [],
      unavailable: [],
      warnings: []
    };
  }

  function normaliseEvidence(raw, cubeIds) {
    var out = [];
    arr(raw).forEach(function (e) {
      if (!isObj(e)) return;
      var id = str(e.id);
      var line = posInt(e.line);
      var path = str(e.path);
      if (!id || !path || !line) return;
      out.push({
        id: id,
        path: path,
        line: line,
        code: str(e.code),
        summary: str(e.summary),
        cubeIds: cubeIds || []
      });
    });
    return out;
  }

  function normaliseCube(raw, levelId, index, warnings) {
    if (!isObj(raw)) return null;
    var id = str(raw.id);
    if (!id) { warnings.push('cube ' + index + ' in "' + levelId + '" has no id and was dropped'); return null; }
    var evidenceIds = arr(raw.evidence_ids).map(str).filter(Boolean);
    return {
      id: id,
      label: str(raw.label, id),
      correct: raw.correct === true,
      reason: str(raw.reason),
      evidenceIds: evidenceIds
    };
  }

  function normaliseLevel(raw, index, warnings) {
    if (!isObj(raw)) return null;
    var id = str(raw.id, 'level-' + index);
    var kind = str(raw.kind, 'entry');
    if (!KINDS[kind]) {
      warnings.push('level "' + id + '" has unknown kind "' + kind + '"; treated as entry');
      kind = 'entry';
    }
    var cubes = [];
    arr(raw.cubes).forEach(function (c, i) {
      var cube = normaliseCube(c, id, i, warnings);
      if (cube) cubes.push(cube);
    });

    var answerIds = arr(raw.answer_ids).map(str).filter(Boolean);
    // answer_ids is authoritative for what the door requires. A cube is only
    // correct if the analyser said so AND it is in the required answer set, or
    // (when answer_ids is absent) if the analyser marked it correct.
    var known = {};
    cubes.forEach(function (c) { known[c.id] = c; });
    var required = [];
    answerIds.forEach(function (aid) {
      if (known[aid]) {
        known[aid].correct = true;
        required.push(aid);
      } else {
        warnings.push('level "' + id + '" requires "' + aid + '" which has no cube; ignored');
      }
    });
    if (!required.length) {
      cubes.forEach(function (c) { if (c.correct) required.push(c.id); });
    }
    cubes.forEach(function (c) {
      if (required.indexOf(c.id) >= 0) c.correct = true;
    });

    var evidence = normaliseEvidence(raw.evidence);
    // Attach evidence ids to cubes so a terminal can show why a cube is wrong.
    var byId = {};
    evidence.forEach(function (e) { byId[e.id] = e; });
    evidence.forEach(function (e) {
      cubes.forEach(function (c) {
        if (c.evidenceIds.indexOf(e.id) >= 0) e.cubeIds.push(c.id);
      });
    });

    var hints = null;
    if (isObj(raw.hints)) {
      var tiers = {};
      ['tier1', 'tier2', 'tier3'].forEach(function (k) {
        var v = str(raw.hints[k]);
        if (v) tiers[k] = v;
      });
      if (tiers.tier1 || tiers.tier2 || tiers.tier3) hints = tiers;
    }

    var layout = isObj(raw.layout) ? raw.layout : {};
    var seedRaw = Number(layout.seed);
    var layoutOut = {
      seed: isFinite(seedRaw) && seedRaw >= 0 ? Math.floor(seedRaw) >>> 0 : C.hashString(id),
      width: C.clamp(Number(layout.width) || 16, 12, 24),
      length: C.clamp(Number(layout.length) || 26, 20, 36),
      height: C.clamp(Number(layout.height) || 6.5, 5, 9)
    };

    return {
      id: id,
      kind: kind,
      title: str(raw.title, 'CHAMBER ' + (index + 1)),
      objective: str(raw.objective, str(raw.ask, 'Reach the exit.')),
      difficulty: str(raw.difficulty),
      subject: str(raw.subject),
      answerIds: required,
      cubes: cubes,
      evidence: evidence,
      evidenceById: byId,
      layout: layoutOut,
      hints: hints,
      order: index,
      kindOrder: KIND_ORDER[kind]
    };
  }

  function normalise(raw) {
    var warnings = [];

    if (!isObj(raw)) {
      return emptyState('payload-missing', 'No game data was embedded in this file.');
    }
    if (raw.schema_version !== SUPPORTED_SCHEMA) {
      return emptyState('schema-version',
        'This build expects payload schema_version ' + SUPPORTED_SCHEMA +
        ' but the file carries ' + JSON.stringify(raw.schema_version) + '.');
    }
    if (!isObj(raw.repo)) {
      return emptyState('repo-missing', 'The payload has no repository record.');
    }

    var repoRaw = raw.repo;
    var repo = {
      name: str(repoRaw.name, 'unknown repository'),
      fingerprint: str(repoRaw.fingerprint, ''),
      languages: arr(repoRaw.languages).map(str).filter(Boolean),
      moduleCount: Number(repoRaw.module_count) || 0,
      edgeCount: Number(repoRaw.edge_count) || 0,
      warnings: arr(repoRaw.warnings).map(str).filter(Boolean)
    };

    var graph = { nodes: [], edges: [], nodeById: {} };
    if (isObj(raw.graph)) {
      arr(raw.graph.nodes).forEach(function (n) {
        if (!isObj(n)) return;
        var id = str(n.id);
        if (!id) return;
        var node = { id: id, path: str(n.path, id) };
        graph.nodes.push(node);
        graph.nodeById[id] = node;
      });
      arr(raw.graph.edges).forEach(function (e) {
        if (!isObj(e)) return;
        var src = str(e.source), dst = str(e.target), line = posInt(e.line);
        if (!src || !dst || !line) return;
        graph.edges.push({ source: src, target: dst, path: str(e.path), line: line, code: str(e.code) });
      });
    }

    var levels = [];
    arr(raw.levels).forEach(function (l, i) {
      var lev = normaliseLevel(l, i, warnings);
      if (lev) levels.push(lev);
    });
    // Stable pedagogical order: movement/portals first, then front door, then
    // dependency routing, then the guard. Within a kind, analyser order wins.
    levels.sort(function (a, b) {
      if (a.kindOrder !== b.kindOrder) return a.kindOrder - b.kindOrder;
      return a.order - b.order;
    });
    levels.forEach(function (l, i) { l.order = i; });

    var unavailable = [];
    arr(raw.unavailable).forEach(function (u) {
      if (!isObj(u)) return;
      var kind = str(u.kind);
      if (!kind) return;
      unavailable.push({ kind: kind, reason: str(u.reason) });
    });

    repo.warnings.forEach(function (w) { if (warnings.indexOf(w) < 0) warnings.push(w); });

    if (!levels.length) {
      var st = emptyState('no-levels',
        'This repository produced no playable chambers. Nothing is being faked: ' +
        'the analyser found no entry manifest, no import edges, or no test imports to build a room from.');
      st.repo = repo;
      st.graph = graph;
      st.unavailable = unavailable;
      st.warnings = warnings;
      return st;
    }

    return {
      ok: true,
      reason: '',
      detail: '',
      schemaVersion: SUPPORTED_SCHEMA,
      repo: repo,
      graph: graph,
      levels: levels,
      unavailable: unavailable,
      warnings: warnings,
      // True when every chamber is tutorial-only material. Used by the title
      // screen to say plainly that this repo has limited evidence.
      evidenceThin: levels.every(function (l) { return l.kind === 'portals' || !l.evidence.length; })
    };
  }

  // Requirements for one level, expressed as plain data the level builder and
  // the HUD both read. Kept here so the gate rule has exactly one definition.
  function requirements(level) {
    var correct = level.cubes.filter(function (c) { return c.correct; });
    var wantIds = level.answerIds.slice(0);
    if (!wantIds.length) wantIds = correct.map(function (c) { return c.id; });
    return {
      plateCount: Math.min(4, Math.max(1, wantIds.length)),
      requiredCubeIds: wantIds,
      hasCubes: level.cubes.length > 0,
      multi: wantIds.length > 1
    };
  }

  SD.Payload = {
    SCHEMA: SUPPORTED_SCHEMA,
    normalise: normalise,
    requirements: requirements,
    kinds: Object.keys(KINDS)
  };

  // ---------------------------------------------------------------- evidence text
  // One definition of how a piece of evidence is described, shared by the
  // in-world terminal screen and the readable overlay. Everything here comes
  // from the payload: path, line, snippet, and the import edge's direction.

  var SCOPE_NOTE = {
    entry: 'This is start-up evidence: a __main__ guard or a command entry point. It does not prove the module runs cleanly.',
    imports: 'This is an import line in the file. It does not prove the imported code is ever called.',
    tests: 'This is a test importing the module. It does not prove the test would catch a change.',
    portals: 'Training room. Nothing about the repository is claimed here.'
  };

  // The durable scope note printed under the evidence list. A per-evidence SCOPE
  // line says what one line of evidence proves; this says what the chamber as a
  // whole refuses to claim, and it outlives the toast. Import and test chambers
  // deny a *direct* edge, so the transitive/dynamic caveat belongs on this
  // surface too: the toast is not durable, this note is.
  var SCOPE_SUMMARY = {
    entry: 'This is a read-only analysis. The analyser never runs repository code.',
    imports: 'This is a read-only analysis. The analyser never runs repository code. ' +
      'It does not rule out indirect or runtime imports.',
    tests: 'This is a read-only analysis. The analyser never runs repository code. ' +
      'It does not rule out indirect or runtime imports.',
    portals: 'This is a read-only analysis. The analyser never runs repository code.'
  };

  function scopeSummaryFor(level) {
    var kind = (level && level.kind) || 'imports';
    return SCOPE_SUMMARY[kind] || SCOPE_SUMMARY.imports;
  }

  // The subtitle is a pointer, not a second copy of the refusal. The bottom stack
  // is anchored 8 px above the toast, so every cue line eats the clearance to the
  // objective panel: a 27-word cue (4 lines / 108.8 px) overprinted the tests
  // chamber's objective by 14.4 px at 1024x640. The cue therefore names the
  // refused cube and points at the two surfaces that own the detail. It makes no
  // claim of its own, so it can neither disagree with the payload nor repeat the
  // toast's denial sentence.
  function refusalCue(label) {
    return 'Refused: ' + (str(label) || 'that cube') +
      ' \u2014 the panel has the full reason, the terminal has the scope note.';
  }

  function arrowFor(edge) {
    if (!edge) return null;
    return { from: edge.source, to: edge.target, text: edge.source + ' \u2192 ' + edge.target };
  }

  function evidenceFor(level, payload) {
    var byLine = {};
    if (payload && payload.graph && payload.graph.edges) {
      payload.graph.edges.forEach(function (e) {
        byLine[e.path + ':' + e.line] = e;
      });
    }
    return (level && level.evidence ? level.evidence : []).map(function (e) {
      var edge = byLine[e.path + ':' + e.line] || null;
      return {
        id: e.id,
        path: e.path,
        line: e.line,
        code: e.code,
        summary: e.summary,
        arrow: arrowFor(edge),
        scope: SCOPE_NOTE[level.kind] || SCOPE_NOTE.imports
      };
    });
  }

  // Compact lines for the in-world screen (canvas texture).
  function terminalPreview(terminal, level, payload) {
    var repoName = payload && payload.repo ? payload.repo.name : '';
    var out = [
      { text: terminal.title, size: 40, color: '#ffd166', weight: 700, gap: 0 },
      { text: level.kind.toUpperCase() + ' \u00b7 ' + repoName, size: 22, color: '#8f8a7c', weight: 500, gap: 44 }
    ];
    var items = evidenceFor(level, payload);
    if (!items.length) {
      out.push({ text: terminal.id === 'terminal-brief' ? level.objective : 'No evidence was recorded for this chamber.', size: 26, color: '#e8e2d6', weight: 500, gap: 60 });
      return out;
    }
    var shown = items.slice(0, 3);
    shown.forEach(function (e) {
      out.push({ text: e.path + ':' + e.line, size: 27, color: '#ffd166', weight: 700, gap: 58, align: 'left' });
      out.push({ text: (e.arrow ? e.arrow.text : e.code), size: 21, color: '#cfc7b8', weight: 500, gap: 32, align: 'left' });
    });
    if (items.length > shown.length) {
      out.push({ text: '+' + (items.length - shown.length) + ' more \u00b7 press E', size: 20, color: '#7f7a6e', weight: 500, gap: 30, align: 'left' });
    }
    return out;
  }

  SD.Payload.evidenceFor = evidenceFor;
  SD.Payload.terminalPreview = terminalPreview;
  SD.Payload.scopeSummaryFor = scopeSummaryFor;
  SD.Payload.refusalCue = refusalCue;
  SD.Payload.SCOPE_NOTE = SCOPE_NOTE;
})(typeof window !== 'undefined' ? (window.SD = window.SD || {}) : (globalThis.SD = globalThis.SD || {}));
