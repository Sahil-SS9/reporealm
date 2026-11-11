/* RepoRealm - the interface layer.
 *
 * Owns every DOM surface: title/chamber select, HUD, subtitle line, terminal
 * reader, settings, pause, completion and the honest failure card. It reads the
 * simulation for state and never mutates it. Browser only.
 */
(function (SD) {
  'use strict';
  var C = SD.Core;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function UI(opts) {
    this.root = opts.root;
    this.settings = opts.settings;
    this.callbacks = opts.callbacks || {};
    this.speech = null;
    this.subtitleTimer = 0;
    this.toastTimer = 0;
    this.built = false;
    this.terminalOpen = null;
    this.paused = false;
    this.narrationVoice = null;
    this.speechVoices = null;
    this.voiceListenerAttached = false;
    this.build();
  }

  UI.prototype.build = function () {
    var self = this;
    var root = this.root;

    this.canvasHost = el('div', 'sd-stage');
    this.canvas = el('canvas', 'sd-canvas');
    this.canvas.id = 'sd-canvas';
    this.canvasHost.appendChild(this.canvas);
    root.appendChild(this.canvasHost);

    this.vignette = el('div', 'sd-vignette');
    root.appendChild(this.vignette);
    this.scan = el('div', 'sd-scanlines');
    root.appendChild(this.scan);

    // ------------------------------------------------------------ HUD
    this.hud = el('div', 'sd-hud');
    root.appendChild(this.hud);

    var cross = el('div', 'sd-crosshair');
    cross.setAttribute('data-testid', 'crosshair');
    this.crossDot = el('span', 'sd-dot');
    this.crossRing = el('span', 'sd-ring');
    cross.appendChild(this.crossDot);
    cross.appendChild(this.crossRing);
    this.hud.appendChild(cross);

    var header = el('div', 'sd-header');
    this.hud.appendChild(header);
    var top = el('div', 'sd-top');
    this.chamberLabel = el('div', 'sd-chamber', '');
    this.chamberLabel.setAttribute('data-testid', 'chamber-label');
    this.repoLabel = el('div', 'sd-repo', '');
    top.appendChild(this.chamberLabel);
    top.appendChild(this.repoLabel);
    header.appendChild(top);

    this.objective = el('div', 'sd-objective', '');
    this.objective.setAttribute('data-testid', 'objective-human');
    header.appendChild(this.objective);

    var status = el('div', 'sd-status');
    this.slots = el('div', 'sd-slots');
    this.slotBlue = el('i', 'sd-slot sd-slot-blue', 'A');
    this.slotOrange = el('i', 'sd-slot sd-slot-orange', 'B');
    this.slots.appendChild(this.slotBlue);
    this.slots.appendChild(this.slotOrange);
    this.platesLabel = el('div', 'sd-plates', '');
    this.platesLabel.setAttribute('data-testid', 'plate-count');
    status.appendChild(this.slots);
    status.appendChild(this.platesLabel);
    header.appendChild(status);

    var bottom = el('div', 'sd-bottom');
    this.hud.appendChild(bottom);

    this.subtitle = el('div', 'sd-subtitle', '');
    this.subtitle.setAttribute('data-testid', 'subtitle');
    this.subtitle.setAttribute('aria-live', 'polite');
    bottom.appendChild(this.subtitle);

    this.toast = el('div', 'sd-toast', '');
    this.toast.setAttribute('data-testid', 'toast');
    this.toast.setAttribute('aria-live', 'assertive');
    bottom.appendChild(this.toast);

    var feedback = el('div', 'sd-feedback');
    bottom.appendChild(feedback);

    this.hint = el('div', 'sd-hint', 'WASD move \u00b7 ARROWS look \u00b7 SPACE jump \u00b7 E carry \u00b7 CLICK blue \u00b7 RIGHT CLICK orange \u00b7 N hint \u00b7 R reset \u00b7 ESC pause');
    feedback.appendChild(this.hint);

    this.aimLabel = el('div', 'sd-aim', '');
    feedback.appendChild(this.aimLabel);

    // ------------------------------------------------------------ hints
    // On demand only. Tier 1 says what kind of thing the answer is, tier 2 says
    // where the clue lives, tier 3 says the next step. The door and the plates
    // are untouched by any of it, and the HUD records which tiers were used.
    this.hintPanel = el('div', 'sd-hintpanel sd-hidden', '');
    this.hintPanel.setAttribute('data-testid', 'hint-panel');
    this.hintPanel.setAttribute('role', 'status');
    bottom.appendChild(this.hintPanel);
    this.hintChip = el('button', 'sd-hintchip', 'HINT (N)');
    this.hintChip.type = 'button';
    this.hintChip.setAttribute('data-testid', 'hint-chip');
    this.hintChip.addEventListener('click', function () {
      if (self.callbacks.hint) self.callbacks.hint();
    });
    feedback.appendChild(this.hintChip);
    this.hintTier = 0;

    // ------------------------------------------------------------ boot
    this.boot = el('div', 'sd-boot sd-hidden');
    this.boot.setAttribute('data-testid', 'boot');
    root.appendChild(this.boot);
    this.bootStage = 0;

    // ------------------------------------------------------------ title
    this.title = el('div', 'sd-overlay sd-title');
    this.title.setAttribute('data-testid', 'title');
    root.appendChild(this.title);

    // ------------------------------------------------------------ pause
    this.pauseOverlay = el('div', 'sd-overlay sd-pause sd-hidden');
    this.pauseOverlay.setAttribute('data-testid', 'pause');
    root.appendChild(this.pauseOverlay);

    // ------------------------------------------------------------ help
    this.helpOverlay = el('div', 'sd-overlay sd-help sd-hidden');
    this.helpOverlay.setAttribute('data-testid', 'help');
    root.appendChild(this.helpOverlay);

    // ------------------------------------------------------------ terminal
    this.terminalOverlay = el('div', 'sd-overlay sd-terminal sd-hidden');
    this.terminalOverlay.tabIndex = -1;
    this.terminalOverlay.setAttribute('data-testid', 'terminal');
    root.appendChild(this.terminalOverlay);

    // ------------------------------------------------------------ completion
    this.doneOverlay = el('div', 'sd-overlay sd-done sd-hidden');
    this.doneOverlay.setAttribute('data-testid', 'complete');
    root.appendChild(this.doneOverlay);

    // ------------------------------------------------------------ failure
    this.errorCard = el('div', 'sd-overlay sd-error sd-hidden');
    this.errorCard.setAttribute('data-testid', 'error');
    root.appendChild(this.errorCard);

    this.buildHelp();
    this.built = true;
    return this;
  };

  // ---------------------------------------------------------------- settings
  // `prefix` namespaces the test id only. The underlying `data-setting` key,
  // the change/input listeners and the shared settings object stay identical
  // across surfaces, so the title accordion and the pause panel edit the same
  // state; the pause panel keeps the canonical `setting-<k>` ids because it is
  // the surface the suite drives and a duplicate would make `[data-testid=
  // setting-k]` resolve to whichever widget happens to come first in the DOM.
  UI.prototype.settingsRow = function (key, label, kind, extra, prefix) {
    var self = this;
    var row = el('label', 'sd-row');
    var name = el('span', 'sd-row-label', label);
    row.appendChild(name);
    var input;
    if (kind === 'range') {
      input = el('input', 'sd-range');
      input.type = 'range';
      input.min = extra.min; input.max = extra.max; input.step = extra.step;
      input.value = this.settings.get(key);
      var out = el('span', 'sd-row-value', C.fmtNum(input.value, 2));
      input.addEventListener('input', function () {
        var v = self.settings.set(key, Number(input.value));
        out.textContent = C.fmtNum(v, 2);
        if (self.callbacks.settings) self.callbacks.settings(key, v);
      });
      row.appendChild(input);
      row.appendChild(out);
    } else {
      input = el('input', 'sd-check');
      input.type = 'checkbox';
      input.checked = !!this.settings.get(key);
      input.addEventListener('change', function () {
        var v = self.settings.set(key, input.checked);
        if (self.callbacks.settings) self.callbacks.settings(key, v);
      });
      row.appendChild(input);
    }
    input.setAttribute('data-setting', key);
    row.setAttribute('data-testid', (prefix || '') + 'setting-' + key);
    return row;
  };

  UI.prototype.buildSettings = function (prefix) {
    var s = el('div', 'sd-settings');
    s.appendChild(el('h3', 'sd-h3', 'SETTINGS'));
    s.appendChild(this.settingsRow('fov', 'Field of view', 'range', { min: 55, max: 110, step: 1 }, prefix));
    s.appendChild(this.settingsRow('sensitivity', 'Look sensitivity', 'range', { min: 0.2, max: 3, step: 0.05 }, prefix));
    s.appendChild(this.settingsRow('renderScale', 'Render scale', 'range', { min: 0.4, max: 1, step: 0.05 }, prefix));
    s.appendChild(this.settingsRow('invertY', 'Invert look Y', 'check', undefined, prefix));
    s.appendChild(this.settingsRow('muted', 'Mute sound', 'check', undefined, prefix));
    s.appendChild(this.settingsRow('narration', 'Facility narration', 'check', undefined, prefix));
    s.appendChild(this.settingsRow('reducedMotion', 'Reduce motion', 'check', undefined, prefix));
    return s;
  };

  // ---------------------------------------------------------------- title card
  UI.prototype.showTitle = function (model) {
    var self = this;
    var card = clear(this.title);
    card.classList.remove('sd-hidden');

    var wrap = el('div', 'sd-title-card');
    var kicker = el('div', 'sd-kicker', 'A HERMES PLUGIN \u00b7 FIRST PERSON');
    wrap.appendChild(kicker);
    var h1 = el('h1', 'sd-title-main', 'RepoRealm');
    wrap.appendChild(h1);
    var sub = el('div', 'sd-title-sub', 'chambers built from a real repository');
    wrap.appendChild(sub);

    // Who and how much, in one line. No fingerprint, no warnings count, no
    // diagnostics dump on the front page: the details live behind the
    // disclosure below and in the pause menu.
    var repo = el('div', 'sd-repo-card');
    repo.appendChild(el('div', 'sd-repo-name', model.repoName || 'no repository'));
    var meta = (model.levels.length ? model.levels.length + (model.levels.length === 1 ? ' chamber' : ' chambers') : 'no chambers') +
      ' \u00b7 v' + (model.version || '1');
    repo.appendChild(el('div', 'sd-repo-meta', meta));
    wrap.appendChild(repo);

    if (model.emptyReason) {
      var empty = el('div', 'sd-empty');
      empty.appendChild(el('div', 'sd-empty-title', 'NOTHING TO PLAY'));
      empty.appendChild(el('div', 'sd-empty-body', model.emptyReason));
      if (model.emptyDetail) empty.appendChild(el('div', 'sd-empty-detail', model.emptyDetail));
      wrap.appendChild(empty);
    }

    var levels = el('div', 'sd-chambers');
    levels.appendChild(el('div', 'sd-kicker', model.levels.length ? 'CHAMBERS' : 'NO CHAMBERS'));
    model.levels.forEach(function (lv, i) {
      var b = el('button', 'sd-chamber-button');
      b.type = 'button';
      b.setAttribute('data-testid', 'chamber-' + i);
      b.setAttribute('data-level-id', lv.id);
      b.appendChild(el('span', 'sd-cb-index', String(i + 1).padStart(2, '0')));
      b.appendChild(el('span', 'sd-cb-title', lv.title));
      b.appendChild(el('span', 'sd-cb-kind', lv.kind));
      b.addEventListener('click', function () { if (self.callbacks.start) self.callbacks.start(i); });
      levels.appendChild(b);
    });
    wrap.appendChild(levels);

    if (model.levels.length) {
      var start = el('button', 'sd-primary', 'PRESS ENTER TO START');
      start.type = 'button';
      start.setAttribute('data-testid', 'start');
      start.addEventListener('click', function () { if (self.callbacks.start) self.callbacks.start(0); });
      wrap.appendChild(start);
      wrap.appendChild(el('div', 'sd-title-foot', 'ENTER starts training · choose any chapter from Chapters'));
    }

    var controls = el('div', 'sd-controls');
    controls.innerHTML =
      '<b>WASD</b> move &nbsp; <b>ARROWS / MOUSE</b> look &nbsp; <b>SPACE</b> jump<br>' +
      '<b>LEFT CLICK</b> blue portal &nbsp; <b>RIGHT CLICK</b> orange portal<br>' +
      '<b>E</b> carry / read &nbsp; <b>R</b> reset chamber &nbsp; <b>ESC</b> pause &nbsp; <b>M</b> mute';
    wrap.appendChild(controls);

    if (model.warnings && model.warnings.length) {
      var details = el('details', 'sd-details');
      details.appendChild(el('summary', '', 'REPOSITORY NOTES (' + model.warnings.length + ')'));
      var warn = el('ul', 'sd-warn');
      model.warnings.forEach(function (w) { warn.appendChild(el('li', '', w)); });
      details.appendChild(warn);
      wrap.appendChild(details);
    }
    if (model.unavailable && model.unavailable.length) {
      // Visible, not collapsed: on a card that says "nothing to play", the
      // specific reason is the point. Hiding it behind a disclosure meant the
      // honest explanation was one click away from nobody.
      var un = el('div', 'sd-details sd-unavailable');
      un.appendChild(el('div', 'sd-un-head', 'NOT GENERATED (' + model.unavailable.length + ')'));
      model.unavailable.forEach(function (u) {
        un.appendChild(el('div', 'sd-un-line', u.kind + ': ' + u.reason));
      });
      wrap.appendChild(un);
    }

    card.appendChild(wrap);
    return card;
  };

  UI.prototype.hideTitle = function () { this.title.classList.add('sd-hidden'); };

  // ---------------------------------------------------------------- boot
  // Two beats, in the manner of a 1995 cartridge: the studio card, then the
  // wordmark. The timer plays both; any key or click skips straight to the
  // title.
  UI.prototype.showBoot = function (model) {
    var self = this;
    this.bootModel = model || {};
    this.bootStage = 1;
    this.boot.classList.remove('sd-hidden');
    this.root.classList.add('sd-crt');
    this._renderBoot();
    this.bootTimer = setTimeout(function () { self.finishBoot(); }, 6500);
    if (!this._bootKeys) {
      this._bootKeys = true;
      this._bootHandler = function (ev) {
        // One input skips the whole boot, straight to the title. The event is
        // swallowed so the same press can never also start the game beneath
        // the boot card (the game's own keydown handler is on window bubble).
        if (ev && ev.type === 'keydown') {
          ev.preventDefault();
          ev.stopImmediatePropagation();
        }
        self.finishBoot();
      };
      this.boot.addEventListener('click', this._bootHandler);
      window.addEventListener('keydown', this._bootHandler, true);
    }
    return this;
  };

  UI.prototype._renderBoot = function () {
    var card = clear(this.boot);
    var inner = el('div', 'sd-boot-inner');
    if (this.bootStage <= 1) {
      inner.appendChild(el('div', 'sd-boot-studio', 'SUNSET STUDIO'));
      inner.appendChild(el('div', 'sd-boot-rule'));
      inner.appendChild(el('div', 'sd-boot-card-line', 'PRESENTS A 1995 CARTRIDGE'));
    } else {
      inner.appendChild(el('h1', 'sd-boot-mark', 'RepoRealm'));
      inner.appendChild(el('div', 'sd-boot-rule'));
      inner.appendChild(el('div', 'sd-boot-card-line',
        (this.bootModel.repoName || 'a repository') + ' \u00b7 ' +
        (this.bootModel.levels ? this.bootModel.levels.length : 0) + ' CHAMBERS'));
    }
    card.appendChild(inner);
    card.appendChild(el('div', 'sd-boot-foot', 'PRESS ANY KEY'));
    card.setAttribute('data-boot-stage', String(this.bootStage));
  };

  UI.prototype.bootAdvance = function () {
    if (this.bootStage === 0) return;
    if (this.bootStage === 1) {
      this.bootStage = 2;
      this._renderBoot();
      var self = this;
      this.bootTimer = setTimeout(function () { self.bootAdvance(); }, 1700);
      return;
    }
    this.finishBoot();
  };

  UI.prototype.finishBoot = function () {
    if (this.bootTimer) { clearTimeout(this.bootTimer); this.bootTimer = 0; }
    this.bootStage = 0;
    this.boot.classList.add('sd-hidden');
    if (this._bootHandler) {
      this.boot.removeEventListener('click', this._bootHandler);
      window.removeEventListener('keydown', this._bootHandler, true);
      this._bootHandler = null;
    }
    // CRT scanlines belong to the menu surfaces, never to the 3D HUD.
    this.setCrt(true);
  };

  UI.prototype.bootVisible = function () { return !this.boot.classList.contains('sd-hidden'); };
  UI.prototype.setCrt = function (on) {
    this.root.classList.toggle('sd-crt', !!on);
  };

  // ---------------------------------------------------------------- help
  UI.prototype.buildHelp = function () {
    var self = this;
    var card = clear(this.helpOverlay);
    var box = el('div', 'sd-card');
    box.appendChild(el('h2', 'sd-h2', 'CONTROLS'));
    var rows = [
      ['WASD', 'walk'],
      ['MOUSE or ARROW KEYS', 'look (the arrow keys work without pointer lock)'],
      ['SPACE', 'jump'],
      ['LEFT CLICK / Q', 'fire the blue portal'],
      ['RIGHT CLICK / F', 'fire the orange portal'],
      ['E', 'pick up, drop, or read a screen'],
      ['N', 'hint for this room (press again for more)'],
      ['TAB', 'read the evidence terminal from anywhere'],
      ['R', 'reset the chamber'],
      ['ESC', 'pause, settings, help'],
      ['M', 'mute']
    ];
    var table = el('div', 'sd-keytable');
    rows.forEach(function (r) {
      var row = el('div', 'sd-keyrow');
      row.appendChild(el('span', 'sd-key', r[0]));
      row.appendChild(el('span', 'sd-keydesc', r[1]));
      table.appendChild(row);
    });
    box.appendChild(table);
    box.appendChild(el('p', 'sd-note', 'This room is built from the repository the plugin read. There is no quiz: carry every module the evidence requires to its own plate, then walk through the exit.'));
    var close = el('button', 'sd-primary', 'CLOSE');
    close.type = 'button';
    close.setAttribute('data-testid', 'help-close');
    close.addEventListener('click', function () { self.hideHelp(); if (self.callbacks.resume) self.callbacks.resume(); });
    box.appendChild(close);
    card.appendChild(box);
  };

  UI.prototype.showHelp = function () { this.helpOverlay.classList.remove('sd-hidden'); };
  UI.prototype.hideHelp = function () { this.helpOverlay.classList.add('sd-hidden'); };
  UI.prototype.helpVisible = function () { return !this.helpOverlay.classList.contains('sd-hidden'); };

  // ---------------------------------------------------------------- pause
  UI.prototype.showPause = function () {
    var self = this;
    this.paused = true;
    var card = clear(this.pauseOverlay);
    card.classList.remove('sd-hidden');
    var box = el('div', 'sd-card');
    box.appendChild(el('h2', 'sd-h2', 'PAUSED'));
    box.appendChild(el('p', 'sd-note', 'The chamber holds its state. Portals, cubes and plates are exactly where you left them.'));

    var resume = el('button', 'sd-primary', 'RESUME');
    resume.type = 'button';
    resume.setAttribute('data-testid', 'resume');
    resume.addEventListener('click', function () { self.hidePause(); if (self.callbacks.resume) self.callbacks.resume(); });
    box.appendChild(resume);

    var row = el('div', 'sd-button-row');
    var again = el('button', 'sd-secondary', 'RESTART CHAMBER');
    again.type = 'button';
    again.setAttribute('data-testid', 'restart');
    again.addEventListener('click', function () { self.hidePause(); if (self.callbacks.restart) self.callbacks.restart(); });
    row.appendChild(again);
    var toTitle = el('button', 'sd-secondary', 'CHAMBER SELECT');
    toTitle.type = 'button';
    toTitle.setAttribute('data-testid', 'to-title');
    toTitle.addEventListener('click', function () { self.hidePause(); if (self.callbacks.title) self.callbacks.title(); });
    row.appendChild(toTitle);
    box.appendChild(row);

    box.appendChild(this.buildSettings());

    var helpBtn = el('button', 'sd-secondary', 'CONTROLS');
    helpBtn.type = 'button';
    helpBtn.setAttribute('data-testid', 'help-open');
    helpBtn.addEventListener('click', function () { self.showHelp(); });
    box.appendChild(helpBtn);

    card.appendChild(box);
  };

  UI.prototype.hidePause = function () {
    this.paused = false;
    this.pauseOverlay.classList.add('sd-hidden');
  };
  UI.prototype.pauseVisible = function () { return !this.pauseOverlay.classList.contains('sd-hidden'); };

  // ---------------------------------------------------------------- terminal
  UI.prototype.showTerminal = function (model) {
    var self = this;
    var card = clear(this.terminalOverlay);
    card.classList.remove('sd-hidden');
    this.terminalOpen = model.id;

    var box = el('div', 'sd-card sd-card-wide');
    box.setAttribute('data-testid', 'terminal-card');
    box.appendChild(el('div', 'sd-kicker', (model.id === 'terminal-brief' ? 'FIELD BRIEF' : 'SOURCE EVIDENCE') + ' \u00b7 ' + model.kind.toUpperCase()));
    box.appendChild(el('h2', 'sd-h2', model.title));
    box.appendChild(el('div', 'sd-terminal-path', model.levelTitle));
    if (model.objective) {
      box.appendChild(el('div', 'sd-kicker', 'FULL CHAMBER TASK'));
      box.appendChild(el('p', 'sd-note rr-full-task', model.objective));
    }

    var list = el('div', 'sd-evidence-list');
    if (!model.items.length) {
      list.appendChild(el('p', 'sd-note', model.emptyText));
    }
    model.items.forEach(function (e, i) {
      var item = el('div', 'sd-evidence');
      item.setAttribute('data-testid', 'evidence-' + i);
      var head = el('div', 'sd-evidence-head');
      head.appendChild(el('span', 'sd-evidence-index', String(i + 1).padStart(2, '0')));
      var path = el('code', 'sd-evidence-path', e.path + ':' + e.line);
      path.setAttribute('data-testid', 'evidence-path-' + i);
      head.appendChild(path);
      item.appendChild(head);
      item.appendChild(el('pre', 'sd-evidence-code', e.code || '(no snippet recorded)'));
      if (e.arrow) {
        item.appendChild(el('div', 'sd-evidence-arrow', 'import direction: ' + e.arrow.text));
      } else {
        item.appendChild(el('div', 'sd-evidence-arrow sd-dim', 'no import edge is recorded for this line'));
      }
      if (e.summary) item.appendChild(el('div', 'sd-evidence-summary', e.summary));
      item.appendChild(el('div', 'sd-evidence-scope', 'WHAT THIS SHOWS: ' + e.scope));
      list.appendChild(item);
    });
    box.appendChild(list);

    box.appendChild(el('p', 'sd-note sd-scope-note', model.scopeSummary));

    var close = el('button', 'sd-primary', 'CLOSE  (E)');
    close.type = 'button';
    close.setAttribute('data-testid', 'terminal-close');
    close.addEventListener('click', function () { self.hideTerminal(); if (self.callbacks.resume) self.callbacks.resume(); });
    box.appendChild(close);
    card.appendChild(box);
    this.terminalOpen = model.id;
    card.scrollTop = 0;
    card.focus({ preventScroll: true });
  };

  UI.prototype.hideTerminal = function () {
    this.terminalOverlay.classList.add('sd-hidden');
    this.terminalOpen = null;
  };
  UI.prototype.terminalVisible = function () { return !this.terminalOverlay.classList.contains('sd-hidden'); };

  // ---------------------------------------------------------------- completion
  UI.prototype.showComplete = function (model) {
    var self = this;
    var card = clear(this.doneOverlay);
    card.classList.remove('sd-hidden');
    var box = el('div', 'sd-card');
    box.appendChild(el('div', 'sd-kicker', 'CHAMBER CLEAR'));
    box.appendChild(el('h2', 'sd-h2', model.title));
    box.appendChild(el('p', 'sd-note', model.line));
    var stats = el('div', 'sd-stats');
    [['time', C.fmtNum(model.time, 1) + 's'], ['portal crossings', model.crossings],
      ['cubes placed', model.plates + '/' + model.required], ['recoveries', model.recoveries]]
      .forEach(function (s) {
        var row = el('div', 'sd-stat');
        row.appendChild(el('span', 'sd-stat-k', s[0]));
        row.appendChild(el('span', 'sd-stat-v', String(s[1])));
        stats.appendChild(row);
      });
    box.appendChild(stats);

    var row = el('div', 'sd-button-row');
    if (model.hasNext) {
      var next = el('button', 'sd-primary', 'NEXT CHAMBER');
      next.type = 'button';
      next.setAttribute('data-testid', 'next-chamber');
      next.addEventListener('click', function () { self.hideComplete(); if (self.callbacks.next) self.callbacks.next(); });
      row.appendChild(next);
    }
    var again = el('button', 'sd-secondary', 'REPLAY');
    again.type = 'button';
    again.setAttribute('data-testid', 'replay');
    again.addEventListener('click', function () { self.hideComplete(); if (self.callbacks.restart) self.callbacks.restart(); });
    row.appendChild(again);
    var sel = el('button', 'sd-secondary', 'CHAMBER SELECT');
    sel.type = 'button';
    sel.setAttribute('data-testid', 'complete-title');
    sel.addEventListener('click', function () { self.hideComplete(); if (self.callbacks.title) self.callbacks.title(); });
    row.appendChild(sel);
    box.appendChild(row);
    card.appendChild(box);
  };

  UI.prototype.hideComplete = function () { this.doneOverlay.classList.add('sd-hidden'); };
  UI.prototype.completeVisible = function () { return !this.doneOverlay.classList.contains('sd-hidden'); };

  // ---------------------------------------------------------------- failure
  UI.prototype.showError = function (title, detail) {
    var card = clear(this.errorCard);
    card.classList.remove('sd-hidden');
    var box = el('div', 'sd-card');
    box.appendChild(el('div', 'sd-kicker', 'RepoRealm'));
    box.appendChild(el('h2', 'sd-h2', title));
    box.appendChild(el('pre', 'sd-error-detail', detail));
    card.appendChild(box);
  };

  // ---------------------------------------------------------------- HUD update
  UI.prototype.setLevel = function (geom, level, repo) {
    this.chamberLabel.textContent = level.title.toUpperCase() +
      (level.difficulty === 'HARD' ? ' \u00b7 HARD' : '');
    this.repoLabel.textContent = repo.name + ' \u00b7 ' + level.kind.toUpperCase() + ' CHAMBER';
    this.objective.textContent = level.objective;
    this.level = level;
    this.geom = geom;
    this.repo = repo;
    this.slotBlue.classList.remove('sd-active');
    this.slotOrange.classList.remove('sd-active');
    this.platesLabel.textContent = geom.plates.length ? 'PLATES 0/' + geom.plates.length : 'DOOR OPEN';
    this.crossRing.className = 'sd-ring';
    this.aimLabel.textContent = '';
    this.hintTier = 0;
    this.hintPanel.textContent = '';
    this.hintPanel.classList.add('sd-hidden');
    this.hintChip.textContent = 'HINT (N)';
  };

  UI.prototype.setState = function (sim, aim, dt) {
    if (!sim) return;
    this.hud.classList.remove('sd-hidden');
    if (this.level !== sim.level) {
      this.level = sim.level;
    }
    this.slotBlue.classList.toggle('sd-active', !!sim.portals.slots.blue);
    this.slotOrange.classList.toggle('sd-active', !!sim.portals.slots.orange);

    var satisfied = sim.plates.filter(function (p) { return p.satisfied; }).length;
    this.platesLabel.textContent = sim.plates.length
      ? (sim.door.open ? 'DOOR OPEN \u00b7 WALK OUT' : 'PLATES ' + satisfied + '/' + sim.plates.length)
      : 'DOOR OPEN';

    if (aim) {
      var cls = 'sd-ring';
      if (aim.kind === 'cube') cls += ' sd-ring-cube';
      else if (aim.kind === 'terminal') cls += ' sd-ring-use';
      else if (aim.portalable) cls += ' sd-ring-ok';
      else if (aim.kind) cls += ' sd-ring-bad';
      if (this.crossRing.className !== cls) this.crossRing.className = cls;
      this.aimLabel.textContent = aim.label || '';
    }

    if (this.subtitleTimer > 0) {
      this.subtitleTimer -= dt;
      if (this.subtitleTimer <= 0) {
        // A cue timer may only retire the copy it started. `say()` records the
        // text it showed; if the line on screen is different, an older timer
        // would hide a cue it never wrote (the 600 px rows in the refusal-stack
        // sweep leave exactly that state, and the next size up then measured a
        // pointer cue with zero size even though the height rule draws it).
        if (this.subtitle.textContent === this.subtitleSaid) {
          this.subtitle.classList.remove('sd-show');
          this.subtitleSaid = '';
        }
        if (this.speech) { try { this.speech.cancel(); } catch (e) { /* ignore */ } }
      }
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.remove('sd-show');
    }
  };

  // ---------------------------------------------------------------- voice
  UI.prototype.stopSpeech = function () {
    if (this.speech) { try { this.speech.cancel(); } catch (e) { /* optional */ } }
  };

  UI.prototype._localVoices = function () {
    if (!this.speech) return [];
    if (!this.speechVoices) this.speechVoices = this.speech.getVoices() || [];
    if (!this.speechVoices.length && !this.voiceListenerAttached && this.speech.addEventListener) {
      var self = this;
      this.voiceListenerAttached = true;
      this.speech.addEventListener('voiceschanged', function () {
        self.speechVoices = self.speech.getVoices() || [];
      });
    }
    return (this.speechVoices || []).filter(function (v) { return v.localService; });
  };

  UI.prototype.showHint = function (hints) {
    if (!hints) return 0;
    var tier = Math.min(3, (this.hintTier || 0) + 1);
    var text = hints['tier' + tier];
    // Missing tiers do not invent help: stop at the last tier that exists.
    while (tier > 1 && !text) { tier--; text = hints['tier' + tier]; }
    if (!text) return 0;
    this.hintTier = tier;
    this.hintPanel.textContent = 'HINT ' + tier + ' OF 3 \u00b7 ' + text;
    this.hintPanel.classList.remove('sd-hidden');
    this.hintChip.textContent = 'HINT ' + tier + '/3';
    return tier;
  };

  UI.prototype.hintState = function () {
    return {
      tier: this.hintTier || 0,
      visible: !this.hintPanel.classList.contains('sd-hidden'),
      text: this.hintPanel.textContent || ''
    };
  };

  UI.prototype.say = function (text, seconds, kind) {
    if (!text) return;
    var self = this;
    this.subtitle.textContent = text;
    this.subtitleSaid = text;
    this.subtitle.className = 'sd-subtitle sd-show' + (kind ? ' sd-' + kind : '');
    this.subtitleTimer = seconds || Math.max(2.6, Math.min(9, text.length / 14));
    if (this.settings.get('narration') && !this.settings.get('muted') && typeof window.speechSynthesis !== 'undefined') {
      try {
        if (!this.speech) this.speech = window.speechSynthesis;
        // Only local voices: an offline export must never request cloud speech.
        var voices = this._localVoices();
        var voice = voices.find(function (v) { return /^en-GB/i.test(v.lang); }) ||
          voices.find(function (v) { return /^en/i.test(v.lang); });
        if (!voice) return self; // subtitles remain available without installed voices
        this.speech.cancel();
        var u = new SpeechSynthesisUtterance(text.replace(/[\u2014\u2013]/g, ','));
        u.voice = voice;
        u.rate = 0.96;
        u.pitch = 0.82;
        u.volume = 0.9;
        u.lang = 'en-GB';
        this.speech.speak(u);
      } catch (e) { /* narration is optional; subtitles always work */ }
    }
    return self;
  };

  // ---------------------------------------------------------------- reading time
  // One definition of "how long must this stay on screen". 220 wpm is the
  // measured basis the QA re-audit used for the refusal copy (37 words = 10.1 s);
  // everything that shows copy for a fixed time now asks this function so the
  // two channels cannot disagree about how long a message lives.
  var READ_WPM = 220;

  function readingSeconds(text, floor) {
    var words = String(text || '').trim().split(/\s+/).filter(function (w) { return !!w; }).length;
    return Math.max(floor || 0, Math.round((words / READ_WPM) * 60 * 10) / 10);
  }

  UI.prototype.flash = function (text, kind, seconds) {
    if (!text) return 0;
    this.toast.textContent = text;
    this.toast.className = 'sd-toast sd-show' + (kind ? ' sd-toast-' + kind : '');
    // Never hide copy before it can be read. A refusal runs to 37 words / 6-7
    // lines (~10.1 s at 220 wpm); the old fixed 6 s dwell pulled it mid-sentence.
    // The floor lives here so every future long toast inherits it.
    this.toastTimer = Math.max(seconds || 2.4, readingSeconds(text, 0));
    // The dwell this message was actually given. Read-only fact for the audits
    // and the diag surface: a caller's wish is not evidence of what was shown.
    this.toastSeconds = this.toastTimer;
    return this.toastTimer;
  };

  // Every surface that renders a settings row, not the first one in the DOM:
  // the title accordion is built before the pause panel, so a single
  // querySelector per key refreshed only the hidden widget and left the visible
  // control showing a stale value after a reload.
  UI.prototype.syncSettings = function () {
    var self = this;
    ['fov', 'sensitivity', 'renderScale'].forEach(function (key) {
      self.root.querySelectorAll('[data-setting="' + key + '"]').forEach(function (input) {
        input.value = self.settings.get(key);
      });
    });
    ['invertY', 'muted', 'narration', 'reducedMotion'].forEach(function (key) {
      self.root.querySelectorAll('[data-setting="' + key + '"]').forEach(function (input) {
        input.checked = !!self.settings.get(key);
      });
    });
  };

  SD.UI = {
    create: function (opts) { return new UI(opts); },
    readingSeconds: readingSeconds,
    UI: UI
  };
})(typeof window !== 'undefined' ? (window.SD = window.SD || {}) : (globalThis.SD = globalThis.SD || {}));
