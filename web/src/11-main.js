/* RepoRealm - boot, input and the fixed-step loop.
 *
 * The only file that touches the DOM before the UI layer exists. The browser
 * drives exactly the same simulation the node tests drive: one input struct,
 * one fixed step, one state read-back. Nothing here can set the door open.
 */
(function () {
  'use strict';

  var SD = window.SD;
  if (!SD) {
    document.body.innerHTML = '<pre style="color:#ff8a8a;font:13px monospace;padding:24px">' +
      'RepoRealm failed to load: the game modules are missing.</pre>';
    return;
  }

  var STEP = SD.Sim.STEP;
  var LOOK_RATE = 1.9;          // radians per second on the arrow keys
  // A frame may advance at most this much world time. Software rendering can
  // stall for a second or more; the old cap of a quarter second put the whole
  // chamber into slow motion whenever that happened, so a held key moved the
  // body a fraction of the distance it should have. 90 steps is 1.5 s of world
  // time, which keeps real time down to about one rendered frame per second.
  var MAX_CATCHUP = 90;
  var AIM_INTERVAL = 0.09;

  var runtime = {
    ready: false,
    started: false,
    paused: false,
    levelIndex: 0,
    input: { moveX: 0, moveZ: 0, jumpPressed: false },
    keys: {},
    lookDx: 0,
    lookDy: 0,
    accumulator: 0,
    lastTime: 0,
    frames: 0,
    fps: 0,
    aim: null,
    aimTimer: 0,
    dragLook: false,
    pointerLocked: false,
    narration: {},
    lastPos: null,
    stepCount: 0
  };

  function fail(title, detail) {
    var card = document.getElementById('sd-boot-error');
    if (!card) return;
    card.style.display = 'block';
    card.innerHTML = '';
    var h = document.createElement('h2');
    h.textContent = title;
    var pre = document.createElement('pre');
    pre.textContent = String(detail || '');
    card.appendChild(h);
    card.appendChild(pre);
  }

  window.addEventListener('error', function (ev) {
    fail('RepoRealm runtime error', (ev.error && ev.error.stack) || ev.message);
  });
  window.addEventListener('unhandledrejection', function (ev) {
    fail('RepoRealm hit an unhandled promise rejection',
      (ev.reason && (ev.reason.stack || ev.reason.message)) || String(ev.reason));
  });

  // ---------------------------------------------------------------- payload
  var payload = SD.Payload.normalise(window.SOURCE_DRIVE_DATA);

  // ---------------------------------------------------------------- settings
  var prefersReduced = false;
  try {
    prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { prefersReduced = false; }
  var settings = new SD.Core.Settings(window.localStorage);
  if (prefersReduced && settings.get('reducedMotion') === false && !settings.store.read(SD.Core.SETTINGS_KEY)) {
    settings.set('reducedMotion', true);
  }

  var root = document.getElementById('sd-root') || document.body;
  var audio = SD.Audio.create();
  audio.setMuted(settings.get('muted'));

  var ui = SD.UI.create({
    root: root,
    settings: settings,
    callbacks: {
      start: function (i) { startLevel(i); },
      resume: function () { if (runtime.started) resume(); },
      hint: function () { showHint(); },
      restart: function () { restart(); },
      next: function () { nextLevel(); },
      title: function () { toTitle(); },
      settings: function (key, value) {
        if (key === 'muted') audio.setMuted(value);
        if ((key === 'muted' && value) || (key === 'narration' && !value)) ui.stopSpeech();
        if (renderer) renderer.applySettings();
        ui.syncSettings();
      }
    }
  });

  var renderer = null;
  try {
    renderer = SD.Render.create({ canvas: ui.canvas, settings: settings });
  } catch (err) {
    ui.showError('NO 3D CONTEXT', 'This browser could not create a WebGL context.\n\n' + (err && err.message ? err.message : err) +
      '\n\nThe chamber needs WebGL; nothing is faked when it is missing.');
    fail('WebGL is unavailable', err && err.stack ? err.stack : err);
    return;
  }

  var sim = null;

  // ---------------------------------------------------------------- narration
  function say(key, text, seconds) {
    if (runtime.narration[key]) return;
    runtime.narration[key] = true;
    ui.say(text, seconds);
  }

  function levelLine(level, index) {
    var bits = [];
    bits.push(level.title + '.');
    // The objective is already on the HUD for as long as it is needed. Speaking
    // it here put the same sentence on screen twice at once, so the subtitle
    // carries context instead of an echo.
    if (index === 0) {
      bits.push('The chamber is generated from ' + payload.repo.name + ': ' + payload.repo.moduleCount + ' modules, ' + payload.repo.edgeCount + ' import edges.');
    } else {
      bits.push('Chamber ' + (index + 1) + ' of ' + payload.levels.length + '.');
    }
    return bits.join(' ');
  }

  // ---------------------------------------------------------------- level flow
  function clearInputs() {
    runtime.keys = {};
    runtime.jumpQueued = false;
    runtime.lookDx = 0;
    runtime.lookDy = 0;
    runtime.dragLook = false;
    runtime.accumulator = 0;
  }

  function toTitle() {
    ui.setCrt(true);
    clearInputs();
    ui.stopSpeech();
    runtime.started = false;
    runtime.paused = false;
    if (document.pointerLockElement) document.exitPointerLock();
    ui.hidePause();
    ui.hideTerminal();
    ui.hideComplete();
    ui.hud.classList.add('sd-hidden');
    ui.showTitle(titleModel());
  }

  function titleModel() {
    var repo = payload.repo || { name: 'no repository', warnings: [] };
    var summary = payload.ok
      ? repo.moduleCount + ' modules \u00b7 ' + repo.edgeCount + ' import edges \u00b7 ' + (repo.languages || []).join(', ')
      : '';
    return {
      repoName: repo.name,
      fingerprint: repo.fingerprint,
      summary: summary,
      warnings: (payload.warnings || []).slice(0, 4),
      levels: (payload.levels || []).map(function (l) {
        return { id: l.id, title: l.title, kind: l.kind };
      }),
      unavailable: payload.unavailable || [],
      emptyReason: payload.ok ? '' : payload.detail || 'The analyser produced no playable chambers for this repository.',
      emptyDetail: payload.ok ? '' : ('reason: ' + payload.reason)
    };
  }

  function startLevel(index) {
    ui.finishBoot();
    ui.setCrt(false);
    if (!payload.ok || !payload.levels.length) return;
    clearInputs();
    var i = Math.max(0, Math.min(payload.levels.length - 1, index));
    runtime.levelIndex = i;
    sim = SD.Sim.create(payload, i, {});
    var level = payload.levels[i];
    var geom = sim.geom;
    renderer.build(geom, sim);
    renderer.applySettings();
    ui.hideTitle();
    ui.hidePause();
    ui.hideComplete();
    ui.hideTerminal();
    ui.hud.classList.remove('sd-hidden');
    ui.setLevel(geom, level, payload.repo);
    runtime.started = true;
    runtime.paused = false;
    runtime.accumulator = 0;
    runtime.narration = {};
    runtime.lastPos = { x: sim.player.pos.x, z: sim.player.pos.z };
    settings.set('lastLevel', level.id);
    say('intro', levelLine(level, i), 7.5);
    audio.play('ui');
    requestPointerLock();
  }

  function restart() {
    if (!sim) return;
    clearInputs();
    runtime.paused = false;
    runtime.started = true;
    ui.hidePause();
    ui.hideHelp();
    ui.hideTerminal();
    ui.hideComplete();
    sim.reset();
    renderer.build(sim.geom, sim);
    ui.hud.classList.remove('sd-hidden');
    ui.setLevel(sim.geom, payload.levels[runtime.levelIndex], payload.repo);
    runtime.accumulator = 0;
    runtime.narration = {};
    ui.say(sim.level.title + '. Chamber reset. The portals are cleared with it.', 4);
    requestPointerLock();
  }

  function nextLevel() {
    if (!sim) return;
    var next = runtime.levelIndex + 1;
    if (next < payload.levels.length) startLevel(next);
    else toTitle();
  }

  function pause() {
    if (!sim || runtime.paused || sim.phase === 'complete') return;
    clearInputs();
    ui.stopSpeech();
    runtime.paused = true;
    if (document.pointerLockElement) document.exitPointerLock();
    ui.showPause();
    ui.syncSettings();
  }

  function resume() {
    if (!runtime.started) { ui.hideHelp(); return; }
    clearInputs();
    runtime.paused = false;
    ui.hidePause();
    ui.hideTerminal();
    requestPointerLock();
  }

  // ---------------------------------------------------------------- input
  function requestPointerLock() {
    if (!ui.canvas.requestPointerLock) return;
    try {
      var p = ui.canvas.requestPointerLock();
      if (p && p.catch) p.catch(function () { /* fall back to arrow keys / drag */ });
    } catch (e) { /* fall back */ }
  }

  document.addEventListener('pointerlockchange', function () {
    runtime.pointerLocked = document.pointerLockElement === ui.canvas;
  });

  document.addEventListener('mousemove', function (ev) {
    if (runtime.paused || !runtime.started) return;
    if (!runtime.pointerLocked && !runtime.dragLook) return;
    var scale = 0.0022 * (settings.get('sensitivity') || 1);
    runtime.lookDx += (ev.movementX || 0) * scale;
    runtime.lookDy += (ev.movementY || 0) * scale;
  });

  ui.canvas.addEventListener('mousedown', function (ev) {
    audio.ensure();
    if (!runtime.started) return;
    if (runtime.paused) return;
    if (ev.button === 0) {
      if (!runtime.pointerLocked && !runtime.dragLook) runtime.dragLook = true;
      shoot('blue');
    } else if (ev.button === 2) {
      shoot('orange');
    }
  });
  window.addEventListener('mouseup', function () { runtime.dragLook = false; });
  ui.canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  ui.canvas.addEventListener('click', function () {
    if (runtime.started && !runtime.paused && !runtime.pointerLocked) requestPointerLock();
  });

  function shoot(slot) {
    if (!sim || !runtime.started || runtime.paused || sim.phase !== 'playing') return;
    var res = sim.shoot(slot);
    if (res.ok) {
      audio.play(slot === 'blue' ? 'portal-blue' : 'portal-orange');
      if (sim.portals.activeCount() === 2) {
        say('pair', 'Both apertures are live. What enters one leaves the other at the same speed, turned.', 5);
      }
    } else {
      audio.play('portal-refused');
      ui.flash(res.reason || 'That surface will not hold a portal.', 'bad', 2.6);
    }
  }

  function interact() {
    if (!sim || !runtime.started || runtime.paused || sim.phase !== 'playing') return;
    var res = sim.interact();
    if (res.action === 'pickup') {
      audio.play('pickup');
      ui.flash('CARRYING ' + (res.cube.label || 'CUBE'), 'good', 1.6);
    } else if (res.action === 'drop') {
      audio.play('drop');
    } else if (res.action === 'terminal') {
      openTerminal(res.terminal);
    }
  }

  function showHint() {
    var level = payload.levels[runtime.levelIndex];
    if (!level) return;
    var before = ui.hintState().tier;
    var tier = ui.showHint(level.hints);
    if (!tier) ui.flash('No hint was written for this room.', 'bad', 3);
    else if (tier === before) ui.flash('No further hints for this room.', 'bad', 3);
  }

  function openTerminal(terminal) {
    clearInputs();
    ui.stopSpeech();
    var level = payload.levels[runtime.levelIndex];
    var t = terminal || sim.geom.terminals.find(function (x) { return x.id === 'terminal-evidence'; });
    var items = SD.Payload.evidenceFor(level, payload);
    // The weighbridge reuses test-import evidence. Qualify the view model,
    // without rewriting the payload or claiming test execution/effectiveness.
    if (level.kind === 'weighbridge') items = items.map(function (item) {
      return Object.assign({}, item, {scope: SD.Payload.SCOPE_NOTE.tests});
    });
    if (t.id !== 'terminal-evidence' && t.id.indexOf('evidence') < 0) {
      items = [];
    }
    ui.showTerminal({
      id: t.id,
      kind: level.kind,
      title: t.title,
      objective: t.id === 'terminal-brief' ? (level.kind === 'portals' ? SD.Realm.trainingGoal : level.objective) : '',
      levelTitle: t.id === 'terminal-brief' ? level.title : (level.kind === 'portals' ? SD.Realm.trainingGoal : level.objective),
      items: items,
      emptyText: t.id === 'terminal-brief'
        ? (level.kind === 'portals'
          ? (SD.Realm.trainingGoal + '\n\nThis room teaches portal movement only. It does not assess repository knowledge, and there are no module cubes or plates to solve here.')
          : ('Your field procedure: read EVIDENCE, compare the labelled modules, then carry every required module to its own plate. A refusal explains the mismatch. The exit only completes this chamber when you physically walk through it.\n\nRepository: ' + payload.repo.name + ', ' + payload.repo.moduleCount + ' modules, ' + payload.repo.edgeCount + ' import edges.'))
        : 'No evidence was recorded for this chamber.',
      scopeSummary: SD.Payload.scopeSummaryFor(level) +
        ((level.kind === 'tests' || level.kind === 'weighbridge')
          ? ' A test import does not prove the test would catch a change.' : '')
    });
    if (document.pointerLockElement) document.exitPointerLock();
    runtime.paused = true;
  }

  window.addEventListener('keydown', function (ev) {
    if (runtime.paused && ['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyQ', 'KeyF'].indexOf(ev.code) >= 0) return;
    if (ev.repeat) {
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(ev.code) >= 0) {
        runtime.keys[ev.code] = true;
        ev.preventDefault();
      }
      return;
    }
    var ownsOverlay = !runtime.started || runtime.paused;
    var control = ev.target && ev.target.closest && ev.target.closest('button,input,summary,select,textarea');
    if (ownsOverlay && (ev.code === 'Tab' || (control && ev.code !== 'Escape'))) return;
    runtime.keys[ev.code] = true;
    audio.ensure();
    switch (ev.code) {
      case 'Space':
        runtime.jumpQueued = true;
        ev.preventDefault();
        break;
      case 'KeyE':
        if (ui.terminalVisible()) { ui.hideTerminal(); resume(); } else { interact(); }
        break;
      case 'Tab':
        ev.preventDefault();
        if (ui.terminalVisible()) { ui.hideTerminal(); resume(); } else if (sim && !runtime.paused) { openTerminal(null); }
        break;
      case 'KeyR':
        if (runtime.started) restart();
        break;
      case 'KeyN':
        if (sim && !runtime.paused && sim.phase === 'playing') showHint();
        break;
      case 'KeyM':
        settings.set('muted', !settings.get('muted'));
        audio.setMuted(settings.get('muted'));
        if (settings.get('muted')) ui.stopSpeech();
        ui.syncSettings();
        break;
      case 'KeyH':
        if (ui.helpVisible()) { ui.hideHelp(); resume(); } else if (runtime.started && sim) { clearInputs(); ui.showHelp(); runtime.paused = true; if (document.pointerLockElement) document.exitPointerLock(); }
        break;
      case 'Escape':
        if (ui.terminalVisible()) { ui.hideTerminal(); resume(); }
        else if (ui.helpVisible()) { ui.hideHelp(); resume(); }
        else if (runtime.paused) resume();
        else pause();
        break;
      case 'KeyQ':
        shoot('blue');
        break;
      case 'KeyF':
        shoot('orange');
        break;
      case 'Enter':
        if (!runtime.started && payload.ok) startLevel(0);
        break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': case 'Digit6':
        if (!runtime.started && payload.ok) startLevel(Number(ev.code.slice(5)) - 1);
        break;
      default:
        break;
    }
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(ev.code) >= 0) {
      ev.preventDefault();
    }
  });

  window.addEventListener('keyup', function (ev) {
    runtime.keys[ev.code] = false;
  });

  window.addEventListener('blur', function () {
    clearInputs();
  });

  document.addEventListener('visibilitychange', function () {
    root.dataset.pageHidden = String(document.hidden);
    runtime.lastTime = 0;
    if (runtime.frameRequest) cancelAnimationFrame(runtime.frameRequest);
    if (!document.hidden) runtime.frameRequest = requestAnimationFrame(frame);
    if (document.visibilityState === 'hidden' && runtime.started && !runtime.paused) pause();
  });

  window.addEventListener('resize', function () {
    if (renderer) renderer.resize();
  });

  // ---------------------------------------------------------------- aim read
  function readAim() {
    if (!sim) return null;
    if (sim.held) return { kind: 'cube', label: 'E · DROP ' + sim.held.id };
    var hit = sim.raycast(SD.Sim.REACH);
    if (!hit) return null;
    var solid = hit.solid;
    if (solid.kind === 'cube') {
      return { kind: 'cube', portalable: false, label: 'E · CARRY ' + solid.cube.id };
    }
    var term = sim.nearestTerminal();
    if (term) return { kind: 'terminal', portalable: false, label: 'READ ' + (term.title || 'TERMINAL') };
    if (solid.portalable) return { kind: 'surface', portalable: true, label: 'PORTAL SURFACE' };
    return { kind: 'surface', portalable: false, label: solid.refusal || 'NO APERTURE HERE' };
  }

  // ---------------------------------------------------------------- events -> feedback
  function drainEvents() {
    if (!sim) return;
    var events = sim.drainEvents();
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      switch (ev.type) {
        case 'portal-cross':
          audio.play('enter');
          say('cross', 'The pair turns your fall into a throw. Speed is kept; only the direction changes.', 6);
          break;
        case 'pickup':
          break;
        case 'plate-press':
          audio.play('plate');
          ui.flash('PLATE PRESSED \u00b7 ' + ev.label, 'good', 2.2);
          break;
        case 'plate-reject': {
          audio.play('plate-reject');
          var refusal = 'REFUSED: ' + ev.label + ' \u2014 ' + ev.reason;
          var cue = SD.Payload.refusalCue(ev.label);
          // Two channels, no duplication: the toast carries the payload copy and
          // stays for its full reading time (flash enforces the floor); the
          // subtitle is a short pointer that names the refused cube, so a
          // rejection never leaves the previous line sitting there contradicting
          // it and never stacks a second copy of the denial onto the HUD.
          ui.flash(refusal, 'bad', 6);
          ui.say(cue, SD.UI.readingSeconds(cue, 4));
          break;
        }
        case 'door-unlock':
          say('unlock', 'The set is complete. The door reads the whole set, not the first answer.', 5);
          break;
        case 'door-weight':
          say('door-weight', 'The set is complete, but this door weighs the floor. Stand on the plate in front of it.', 5);
          break;
        case 'door-open':
          audio.play('door-open');
          break;
        case 'door-close':
          audio.play('door-close');
          break;
        case 'recovered':
          audio.play('recover');
          ui.flash(ev.reason === 'chasm' ? 'THE TRENCH RETURNS YOU. THE PORTALS STAY.' : 'RECOVERED', 'bad', 2.6);
          break;
        case 'exit':
          audio.play('exit');
          onComplete();
          break;
        case 'cube-reset':
          ui.flash('THE CUBE LEFT THE ROOM. BACK TO ITS START.', 'bad', 2.6);
          break;
        case 'jump':
          audio.play('jump');
          break;
        case 'land':
          if (ev.speed > 6) audio.play('land');
          break;
        default:
          break;
      }
    }
  }

  function onComplete() {
    clearInputs();
    var level = payload.levels[runtime.levelIndex];
    runtime.paused = true;
    if (document.pointerLockElement) document.exitPointerLock();
    ui.showComplete({
      title: level.title,
      line: level.kind === 'portals'
        ? 'You connected two apertures and crossed the training barrier. Next: use repository evidence to choose what belongs on a plate.'
        : level.kind === 'entry'
          ? 'You followed the registered command to its evidenced module, placed it on the plate and crossed the exit. This identifies that command target, not every runnable file in the repository.'
          : 'You carried the evidenced module set to the plates and walked out through the door. The evidence establishes only the recorded relationships.',
      time: sim.time,
      crossings: sim.stats.portalCrossings,
      plates: sim.door.satisfied,
      required: sim.door.required,
      recoveries: sim.stats.recoveries,
      hasNext: runtime.levelIndex + 1 < payload.levels.length
    });
    say('clear', 'Chamber clear.', 3);
  }

  // ---------------------------------------------------------------- loop
  function stepOnce(dt) {
    if (!sim || runtime.paused || sim.phase !== 'playing') return;
    var s = settings.values;

    // look: arrow keys. Pitch is positive-up in the controller, so ArrowUp and
    // an upward mouse move both raise it. invertY is a mouse preference only.
    var lookX = 0, lookY = 0;
    if (runtime.keys.ArrowLeft) lookX -= 1;
    if (runtime.keys.ArrowRight) lookX += 1;
    if (runtime.keys.ArrowUp) lookY += 1;
    if (runtime.keys.ArrowDown) lookY -= 1;
    if (lookX || lookY) {
      sim.player.look(lookX * LOOK_RATE * dt, lookY * LOOK_RATE * dt);
    }
    if (runtime.lookDx || runtime.lookDy) {
      var invert = s.invertY ? 1 : -1;
      sim.player.look(runtime.lookDx, runtime.lookDy * invert);
      runtime.lookDx = 0;
      runtime.lookDy = 0;
    }

    var moveZ = (runtime.keys.KeyW ? 1 : 0) - (runtime.keys.KeyS ? 1 : 0);
    var moveX = (runtime.keys.KeyD ? 1 : 0) - (runtime.keys.KeyA ? 1 : 0);
    var input = { moveX: moveX, moveZ: moveZ, jumpPressed: !!runtime.jumpQueued };
    runtime.jumpQueued = false;

    var before = sim.player.pos;
    sim.step(dt, input);
    runtime.stepCount++;

    // footsteps on a cadence, purely cosmetic
    var moved = Math.abs(sim.player.pos.x - before.x) + Math.abs(sim.player.pos.z - before.z);
    if (sim.player.onGround && moved > 0.004) {
      runtime.footPhase = (runtime.footPhase || 0) + moved;
      if (runtime.footPhase > 1.35) { runtime.footPhase = 0; audio.play('step'); }
    }
    drainEvents();
  }

  function frame(now) {
    if (document.hidden) { runtime.lastTime = now; return; }
    runtime.frameRequest = requestAnimationFrame(frame);
    if (!runtime.lastTime) runtime.lastTime = now;
    var dt = Math.min(MAX_CATCHUP * STEP, (now - runtime.lastTime) / 1000);
    runtime.lastTime = now;
    runtime.frames++;
    runtime.fps = runtime.fps * 0.9 + (1 / Math.max(0.001, dt)) * 0.1;

    if (sim && runtime.started) {
      if (!runtime.manualClock && !runtime.paused && sim.phase === 'playing') {
        runtime.accumulator += dt;
        var steps = 0;
        while (runtime.accumulator >= STEP && steps < MAX_CATCHUP) {
          stepOnce(STEP);
          runtime.accumulator -= STEP;
          steps++;
        }
        if (steps === MAX_CATCHUP) runtime.accumulator = 0;
      }
      runtime.aimTimer -= dt;
      if (runtime.aimTimer <= 0) {
        runtime.aim = readAim();
        runtime.aimTimer = AIM_INTERVAL;
      }
      ui.setState(sim, runtime.aim, dt);
      renderer.render(sim, runtime.paused ? 0 : dt);
    } else if (payload.ok) {
      renderer.renderMenu(dt);
    } else if (payload.ok === false) {
      // honest empty state: no chamber, nothing to render
    }

    if (!runtime.ready && sim) {
      runtime.ready = true;
      window.SourceDrive.ready = true;
    }
  }

  // ---------------------------------------------------------------- test + accessibility hooks
  window.SourceDrive = {
    ready: false,
    version: 1,
    payloadOk: payload.ok,
    payloadReason: payload.reason,
    levels: function () {
      return (payload.levels || []).map(function (l, i) {
        return { index: i, id: l.id, kind: l.kind, title: l.title, objective: l.objective };
      });
    },
    status: function () {
      if (!sim) return { phase: 'title', levelIndex: runtime.levelIndex, paused: runtime.paused };
      var st = sim.status();
      if (!runtime.started) st.phase = 'title';
      st.paused = runtime.paused;
      st.levelIndex = runtime.levelIndex;
      st.settings = settings.values;
      st.statsRender = renderer ? renderer.stats : null;
      st.aim = runtime.aim;
      st.fps = Math.round(runtime.fps);
      st.stepped = runtime.stepCount;
      return st;
    },
    geom: function () {
      if (!sim) return null;
      return {
        id: sim.geom.id, kind: sim.geom.kind, spawn: sim.geom.spawn,
        layout: sim.geom.layout, bounds: sim.geom.bounds,
        zones: sim.geom.zones, plan: sim.geom.plan, farY: sim.geom.farY,
        chasm: sim.geom.chasm, mounts: sim.geom.mounts.map(function (m) {
          return { id: m.id, centre: m.centre, normal: m.normal };
        }),
        plates: sim.plates.map(function (p) { return { id: p.id, centre: p.centre, satisfied: p.satisfied }; }),
        cubes: sim.cubes.map(function (c) { return { id: c.id, label: c.label, correct: c.correct, spawn: c.spawn }; }),
        door: { required: sim.door.required, trigger: sim.geom.door.trigger, zPlane: sim.geom.door.zPlane },
        terminals: sim.geom.terminals.map(function (t) { return { id: t.id, title: t.title, pos: t.pos, stand: t.stand, facing: t.facing }; })
      };
    },
    /* Render diagnostics: what the GPU was actually asked to draw, and from
     * where. Read-only numbers, used to tell "dark scene" from "nothing drawn". */
    diag: function () {
      if (!renderer || !sim) return null;
      var r = renderer;
      var bg = r.scene.background;
      var f = r.scene.fog;
      var c = r.camera;
      return {
        triangles: r.renderer.info.render.triangles,
        calls: r.renderer.info.render.calls,
        objects: r.scene.children.length,
        meshes: Object.keys(r.meshes || {}).length,
        exposure: r.renderer.toneMappingExposure,
        background: bg && bg.getHexString ? bg.getHexString() : String(bg),
        fog: f ? { near: f.near, far: f.far, colour: f.color.getHexString() } : null,
        camera: { x: c.position.x, y: c.position.y, z: c.position.z,
                  pitch: c.rotation.x, yaw: c.rotation.y },
        lights: {
          hemi: r.hemi.intensity, key: r.key.intensity, fill: r.fill ? r.fill.intensity : null,
          accent: r.accent ? r.accent.intensity : null
        },
        portalViews: !!r.portalViewsEnabled,
        frames: r.stats.frames
      };
    },
    /* View-only screenshot hook: place the render camera, look from it, redraw.
     * It cannot move the player, grant a portal, or change any rule - it only
     * picks where the picture is taken from. Pass null to return to the body. */
    inspectCamera: function (pos, yaw, pitch) {
      if (!renderer || !sim) return false;
      if (!pos) {
        renderer.inspectView = null;
      } else {
        renderer.inspectView = {
          pos: { x: pos.x || 0, y: pos.y === undefined ? 1.6 : pos.y, z: pos.z || 0 },
          yaw: yaw || 0,
          pitch: pitch || 0
        };
      }
      renderer.render(sim, 0);
      return true;
    },
    /* Deterministic stepping for the physics probes. Interaction tests must use
     * real key events: this hook can advance the same step, not change the rules. */
    step: function (n, input) {
      if (!sim) return null;
      for (var i = 0; i < (n || 1); i++) sim.step(STEP, input || {});
      drainEvents();
      return sim.status();
    },
    /* Test clock only: DOM events supply all input through stepOnce. */
    manualClock: function (enabled) { runtime.manualClock = !!enabled; clearInputs(); },
    advanceInput: function (n) {
      if (!runtime.manualClock) throw new Error('Enable manualClock before stepping input');
      for (var i = 0; i < n; i++) stepOnce(STEP);
      runtime.aim = readAim();
      ui.setState(sim, runtime.aim, n * STEP);
      renderer.render(sim, 0);
      return this.status();
    },
    start: function (index) { startLevel(index || 0); },
    restart: restart,
    pause: pause,
    resume: resume,
    title: toTitle,
    reset: function () { if (sim) sim.reset(); },
    settings: function () { return JSON.parse(JSON.stringify(settings.values)); },
    setSetting: function (key, value) {
      var v = settings.set(key, value);
      if (key === 'muted') audio.setMuted(v);
      renderer.applySettings();
      ui.syncSettings();
      return v;
    },
    canvas: function () { return ui.canvas; },
    portalScreen: function (slot) {
      // NDC -> CSS pixels, so a test can click the aperture it can see.
      var p = sim && sim.portals.slots[slot];
      if (!p || !renderer) return null;
      var THREE = window.THREE;
      var v = new THREE.Vector3(p.frame.pos.x, p.frame.pos.y, p.frame.pos.z);
      v.project(renderer.camera);
      var rect = ui.canvas.getBoundingClientRect();
      return {
        x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
        visible: v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1
      };
    },
    worldToScreen: function (point) {
      if (!renderer) return null;
      var THREE = window.THREE;
      var v = new THREE.Vector3(point.x, point.y, point.z);
      v.project(renderer.camera);
      var rect = ui.canvas.getBoundingClientRect();
      return {
        x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
        visible: v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1
      };
    },
    ui: function () {
      return {
        title: !ui.title.classList.contains('sd-hidden'),
        pause: ui.pauseVisible(),
        help: ui.helpVisible(),
        terminal: ui.terminalVisible(),
        complete: ui.completeVisible(),
        chamberLabel: ui.chamberLabel.textContent,
        objective: ui.objective.textContent,
        plates: ui.platesLabel.textContent,
        subtitle: ui.subtitle.textContent,
        subtitleRemaining: Math.max(0, Math.round((ui.subtitleTimer || 0) * 10) / 10),
        toast: ui.toast.textContent,
        // The dwell the last toast was given, and how much is left of it. A
        // re-audit measures these instead of assuming the value in the source.
        toastSeconds: ui.toastSeconds || 0,
        toastRemaining: Math.max(0, Math.round((ui.toastTimer || 0) * 10) / 10),
        hint: ui.hintState(),
        boot: ui.bootVisible(),
        scanlines: getComputedStyle(ui.scan).display !== 'none' 
      };
    }
  };

  // ---------------------------------------------------------------- boot
  if (!payload.ok) {
    ui.showTitle(titleModel());
    ui.showError('NO CHAMBER FROM THIS REPOSITORY', (payload.detail || '') + '\n\n' + (payload.reason || ''));
    runtime.ready = true;
    window.SourceDrive.ready = true;
  } else {
    ui.showTitle(titleModel());
    ui.showBoot(titleModel());
    // Pre-build the first chamber behind the title card so ENTER is instant and
    // the first frame already has geometry to light.
    sim = SD.Sim.create(payload, 0, {});
    renderer.build(sim.geom, sim);
    renderer.buildMenu();
    ui.setLevel(sim.geom, payload.levels[0], payload.repo);
    ui.hud.classList.add('sd-hidden');
  }

  runtime.frameRequest = requestAnimationFrame(frame);
})();
