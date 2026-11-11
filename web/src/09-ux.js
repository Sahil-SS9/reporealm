/* RepoRealm presentation. Rules and payload identity remain with SD. */
(function (SD) {
  'use strict';
  var P = SD.UI.UI.prototype;
  // One legend for every chamber. The movement, portal, reset and pause keys are
  // the same bindings the canvas listens for (11-main.js key map + mouse
  // buttons), so a player never has to open Controls to find them. Written once
  // so a per-chamber edit cannot drop a key the game still accepts.
  var KEY_LEGEND = 'WASD move \u00b7 ARROWS look \u00b7 SPACE jump \u00b7 E carry \u00b7 ' +
    'CLICK blue \u00b7 RIGHT CLICK orange \u00b7 R reset \u00b7 ESC pause';
  function node(tag, cls, text) {
    var n = document.createElement(tag); n.className = cls || '';
    if (text !== undefined) n.textContent = text; return n;
  }
  function button(text, cls, action) {
    var n = node('button', cls, text); n.type = 'button'; n.addEventListener('click', action); return n;
  }
  P.showTitle = function (model) {
    var self = this;
    this.title.replaceChildren(); this.title.classList.remove('sd-hidden');
    var wrap = node('main', 'rr-menu');
    var head = node('header', 'rr-menu-head');
    head.appendChild(node('span', 'rr-brand', 'RepoRealm'));
    head.appendChild(node('span', 'rr-edition', 'REPOSITORY EXPEDITION / 01'));
    wrap.appendChild(head);
    var main = node('section', 'rr-menu-body');
    // A repository with no playable chamber keeps the gateway's frame but not
    // its promise: the heading says what is actually true and the block below
    // names what the analyser could not build, so the empty state is honest
    // instead of a play screen with a footnote.
    var playable = model.levels.length > 0;
    main.appendChild(node('p', 'sd-kicker', playable ? 'REAL CODE. PHYSICAL DISCOVERY.' : 'NO PLAYABLE CHAMBER'));
    main.appendChild(node('h1', 'rr-headline', playable ? 'Step inside\nyour source.' : 'Nothing\nto play.'));
    main.appendChild(node('p', 'rr-intro', playable
      ? 'Read the evidence. Connect the portals. Find your way through a living repository.'
      : 'No chamber could be built from this repository. What was missing is listed below.'));
    if (playable) {
      var play = button('Play RepoRealm  ↗', 'sd-primary rr-play', function () { self.callbacks.start(0); });
      play.setAttribute('data-testid', 'start'); main.appendChild(play);
      main.appendChild(node('p', 'rr-play-note', 'Start with portal training · keyboard + mouse'));
    }
    if (model.emptyReason) {
      var empty = node('div', 'sd-empty');
      empty.appendChild(node('p', 'sd-empty-title', 'NOTHING TO PLAY'));
      empty.appendChild(node('p', 'sd-empty-body', model.emptyReason));
      (model.unavailable || []).forEach(function (u) {
        empty.appendChild(node('p', 'sd-empty-detail', u.kind + ': ' + u.reason));
      });
      if (model.emptyDetail) empty.appendChild(node('p', 'sd-empty-detail', model.emptyDetail));
      main.appendChild(empty);
    }
    var nav = node('nav', 'rr-menu-nav'); nav.setAttribute('aria-label', 'Expedition tools');
    var shelf = node('section', 'rr-shelf sd-hidden'); shelf.id = 'rr-chapters';
    var chapters = button('Chapters', '', function () {
      var open = shelf.classList.toggle('sd-hidden') === false;
      chapters.setAttribute('aria-expanded', String(open));
      if (open) shelf.querySelector('button').focus();
    });
    chapters.setAttribute('aria-controls', 'rr-chapters'); chapters.setAttribute('aria-expanded', 'false');
    if (playable) nav.appendChild(chapters);
    var settings = node('details', 'rr-settings');
    settings.appendChild(node('summary', '', 'Settings')); settings.appendChild(this.buildSettings('title-')); nav.appendChild(settings);
    nav.appendChild(button('Controls', '', function () { self.showHelp(); }));
    main.appendChild(nav); wrap.appendChild(main);
    var vista = node('aside', 'rr-vista-label');
    vista.appendChild(node('span', 'rr-vista-index', '↘'));
    vista.appendChild(node('span', '', 'THE GATEWAY\nA route into the repository'));
    wrap.appendChild(vista);
    shelf.appendChild(node('h2', 'sd-h2', 'Choose a chamber'));
    shelf.appendChild(node('p', 'sd-note', 'Every chapter is available. No saved progress is implied.'));
    model.levels.forEach(function (lv, i) {
      var b = button('', 'sd-chamber-button', function () { self.callbacks.start(i); });
      b.style.setProperty('--i', i); b.setAttribute('data-testid', 'chamber-' + i); b.setAttribute('data-level-id', lv.id);
      var chamberNumber = /^CHAMBER\s+(\d+)/i.exec(lv.title);
      b.appendChild(node('span', 'sd-cb-index', chamberNumber ? chamberNumber[1].padStart(2, '0') : String(i).padStart(2, '0')));
      b.appendChild(node('span', 'sd-cb-title', lv.title.replace(/^CHAMBER \d+\s*[-–]\s*/i, ''))); b.appendChild(node('span', 'sd-cb-kind', lv.kind)); shelf.appendChild(b);
    });
    shelf.appendChild(button('Back to gateway', 'rr-close', function () { shelf.classList.add('sd-hidden'); chapters.setAttribute('aria-expanded','false'); chapters.focus(); }));
    wrap.appendChild(shelf);
    var footer = node('footer', 'rr-menu-footer');
    footer.appendChild(node('span', 'rr-repo', model.repoName + ' / ' + model.levels.length + ' chambers'));
    var details = node('details', 'rr-repository-notes'); details.appendChild(node('summary', '', 'Repository details'));
    details.appendChild(node('p', '', model.summary));
    (model.warnings || []).forEach(function (w) { details.appendChild(node('p', 'sd-warn', w)); });
    (model.unavailable || []).forEach(function (u) { details.appendChild(node('p', '', u.kind + ': ' + u.reason)); });
    footer.appendChild(details); wrap.appendChild(footer); this.title.appendChild(wrap);
    return this.title;
  };
  P._renderBoot = function () {
    this.boot.replaceChildren();
    var inner = node('div', 'rr-opening');
    var art = node('img', 'rr-poster'); art.src = document.getElementById('rr-poster-asset').src;
    art.alt = 'RepoRealm: a sunset-coloured gateway beneath a descending explorer'; inner.appendChild(art);
    inner.appendChild(node('p', 'sd-kicker', 'A repository is a world worth exploring.'));
    inner.appendChild(button('Enter the gateway  →', 'sd-primary', this.finishBoot.bind(this)));
    this.boot.appendChild(inner); this.boot.setAttribute('data-boot-stage', String(this.bootStage));
  };
  var originalBuild = P.build;
  P.build = function () {
    originalBuild.call(this);
    this.root.dataset.reducedMotion = String(!!this.settings.get('reducedMotion'));
    this.hint.textContent = KEY_LEGEND;
    this.root.addEventListener('keydown', function (e) {
      if (e.code !== 'Tab') return;
      var overlays = Array.from(this.querySelectorAll('.sd-overlay:not(.sd-hidden),.sd-boot:not(.sd-hidden)'));
      var active = overlays[overlays.length - 1]; if (!active) return;
      var focusable = Array.from(active.querySelectorAll('button,input,summary')).filter(function (n) { return n.getClientRects().length && !n.disabled; });
      if (!focusable.length) return;
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || !active.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !active.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    });
    return this;
  };
  var sync = P.syncSettings;
  P.syncSettings = function () { sync.call(this); this.root.dataset.reducedMotion = String(!!this.settings.get('reducedMotion')); };
  var showHelp = P.showHelp;
  P.showHelp = function () { showHelp.call(this); this.helpOverlay.querySelector('button').focus(); };
  var hideHelp = P.hideHelp;
  P.hideHelp = function () { hideHelp.call(this); if (!this.title.classList.contains('sd-hidden')) this.title.querySelector('button').focus(); };
  ['showPause', 'showComplete'].forEach(function (method) {
    var original = P[method];
    P[method] = function (model) {
      original.call(this, model);
      var overlay = method === 'showPause' ? this.pauseOverlay : this.doneOverlay;
      var first = overlay.querySelector('button'); if (first) first.focus();
    };
  });
  var setLevel = P.setLevel;
  P.setLevel = function (geom, level, repo) {
    setLevel.call(this, geom, level, repo);
    if (level.kind === 'portals') this.objective.textContent = SD.Realm.trainingGoal;
    if (level.kind === 'entry') this.objective.textContent = 'Follow the command registration. Read EVIDENCE, then carry its module to the plate.';
    var goals = {
      imports: 'Read EVIDENCE. Carry every importing module to the plates.',
      tests: 'Read the test import lines. Carry every matching test to the plates.',
      relay: 'Connect the mounts to cross the wall. Carry every importing module to the plates.',
      weighbridge: 'Place every matching test. Stand on the DOOR PLATE, then walk through.'
    };
    if (goals[level.kind]) this.objective.textContent = goals[level.kind];
    // The full qualified task remains in the reader, not a clipped HUD title.
    this.realmGoal = this.objective.textContent;
    this.hint.textContent = KEY_LEGEND;
  };
  var setState = P.setState;
  P.setState = function (sim, aim, dt) {
    setState.call(this, sim, aim, dt);
    if (sim.levelIndex > 1) {
      var goal = this.realmGoal;
      if (sim.door.open) goal = 'Door open. Walk through the exit to complete this chamber.';
      else if (sim.level.kind === 'weighbridge' && sim.plates.length && sim.plates.every(function (p) { return p.satisfied; })) {
        goal = 'All modules placed. Stand on the DOOR PLATE, then walk through.';
      }
      if (this.objective.textContent !== goal) this.objective.textContent = goal;
    }
    if (!aim) this.aimLabel.textContent = 'Explore the chamber';
  };
})(window.SD);
