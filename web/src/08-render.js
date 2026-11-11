/* SOURCE DRIVE - the renderer.
 *
 * Three.js (MIT, vendored at web/vendor/three.min.js) draws the chamber the
 * physics already described: one mesh per collider, one quad per portal, and a
 * real render-to-texture view *through* each aperture. Nothing here decides
 * gameplay: it reads `geom` once and `sim` every frame.
 *
 * Browser only. The node unit tests never load this file (see test/unit/run.js).
 */
(function (SD) {
  'use strict';
  var C = SD.Core;

  var MATERIALS = {
    floor: { color: 0x4b5157, rough: 0.88, metal: 0.02, tex: 'concrete' },
    wall: { color: 0x8a8378, rough: 0.82, metal: 0.02, tex: 'panel' },
    'wall-bright': { color: 0xa39a88, rough: 0.7, metal: 0.03, tex: 'panel' },
    ceiling: { color: 0x3f444a, rough: 0.95, metal: 0.05 },
    trim: { color: 0x14171c, rough: 0.55, metal: 0.55 },
    stair: { color: 0x23272e, rough: 0.6, metal: 0.35 },
    catwalk: { color: 0x3a4048, rough: 0.6, metal: 0.45, tex: 'grate' },
    rail: { color: 0x8d939c, rough: 0.35, metal: 0.8 },
    panel: { color: 0x9b9384, rough: 0.72, metal: 0.02, tex: 'panel' },
    mount: { color: 0x7d7668, rough: 0.7, metal: 0.02, tex: 'panel' },
    plate: { color: 0x22262d, rough: 0.5, metal: 0.4 },
    door: { color: 0x2b3038, rough: 0.45, metal: 0.6 },
    pedestal: { color: 0x2a2f36, rough: 0.7, metal: 0.2 },
    terminal: { color: 0x191d23, rough: 0.6, metal: 0.3 },
    barrier: { color: 0x242830, rough: 0.75, metal: 0.15 },
    screen: { color: 0x9a917f, rough: 0.75, metal: 0.02, tex: 'panel' },
    pitwall: { color: 0x1e2228, rough: 0.9, metal: 0.1 },
    void: { color: 0x0b0d11, rough: 1, metal: 0 },
    cube: { color: 0x9c9484, rough: 0.6, metal: 0.15 }
  };

  function ensureThree() {
    if (typeof window === 'undefined' || !window.THREE) {
      throw new Error('THREE is not loaded - the renderer cannot start.');
    }
    return window.THREE;
  }

  // ---------------------------------------------------------------- textures
  function canvas2d(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function textureFrom(canvas, repeat) {
    var THREE = ensureThree();
    var t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    t.encoding = THREE.sRGBEncoding;
    if (repeat) t.repeat.set(repeat[0], repeat[1]);
    return t;
  }

  /* Procedural surfaces: drawn in code, no image assets. */
  function makeSurfaceTexture(kind) {
    var c = canvas2d(256, 256), g = c.getContext('2d');
    if (kind === 'panel') {
      g.fillStyle = '#ded7c7'; g.fillRect(0, 0, 256, 256);
      g.strokeStyle = 'rgba(90,86,76,0.16)'; g.lineWidth = 1;
      g.strokeRect(1.5, 1.5, 253, 253);
      g.strokeStyle = 'rgba(120,114,102,0.10)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(128, 0); g.lineTo(128, 256); g.stroke();
      g.beginPath(); g.moveTo(0, 128); g.lineTo(256, 128); g.stroke();
      for (var i = 0; i < 900; i++) {
        g.fillStyle = 'rgba(0,0,0,' + (Math.random() * 0.03) + ')';
        g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
      }
    } else if (kind === 'concrete') {
      g.fillStyle = '#68717b'; g.fillRect(0, 0, 256, 256);
      for (var j = 0; j < 2600; j++) {
        var v = Math.random() * 22 - 11;
        g.fillStyle = 'rgba(' + (104 + v) + ',' + (113 + v) + ',' + (123 + v) + ',0.75)';
        g.fillRect(Math.random() * 256, Math.random() * 256, 3, 3);
      }
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 2;
      g.strokeRect(1, 1, 254, 254);
    } else {
      g.fillStyle = '#3d434b'; g.fillRect(0, 0, 256, 256);
      g.strokeStyle = '#20242a'; g.lineWidth = 8;
      for (var k = 0; k < 256; k += 32) {
        g.beginPath(); g.moveTo(k, 0); g.lineTo(k, 256); g.stroke();
        g.beginPath(); g.moveTo(0, k); g.lineTo(256, k); g.stroke();
      }
    }
    return c;
  }

  var TEX_CACHE = {};
  function sharedTexture(kind) {
    if (!TEX_CACHE[kind]) TEX_CACHE[kind] = makeSurfaceTexture(kind);
    return TEX_CACHE[kind];
  }

  /* Text plate: used for wall signs, terminal screens and cube labels. */
  function fitFont(g, text, maxWidth, size, weight) {
    var px = size;
    do {
      g.font = weight + ' ' + Math.round(px) + 'px ui-monospace, "DejaVu Sans Mono", Menlo, monospace';
      if (g.measureText(text).width <= maxWidth) return px;
      px -= 2;
    } while (px > 9);
    return px;
  }

  function wrapText(g, text, maxWidth) {
    var words = String(text).split(/\s+/);
    var lines = [];
    var line = '';
    for (var i = 0; i < words.length; i++) {
      var candidate = line ? line + ' ' + words[i] : words[i];
      if (g.measureText(candidate).width > maxWidth && line) {
        lines.push(line);
        line = words[i];
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function makeTextTexture(spec) {
    var w = spec.width || 512, h = spec.height || 128;
    var c = canvas2d(w, h), g = c.getContext('2d');
    g.fillStyle = spec.background || '#0c0f13';
    g.fillRect(0, 0, w, h);
    if (spec.border) {
      g.strokeStyle = spec.border;
      g.lineWidth = spec.borderWidth || 4;
      g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth);
    }
    var y = spec.padding === undefined ? 0 : spec.padding;
    var lines = spec.lines || [{ text: spec.text || '', size: h * 0.42, color: '#ffd166' }];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      g.textAlign = ln.align || 'center';
      g.textBaseline = 'middle';
      var x = ln.align === 'left' ? (spec.pad || 22) : (ln.align === 'right' ? w - (spec.pad || 22) : w / 2);
      var avail = w - (spec.pad || 22) * 2;
      var size = ln.size || h * 0.3;
      var weight = ln.weight || 600;
      var text = String(ln.text === undefined ? '' : ln.text);
      var px = fitFont(g, text, avail, size, weight);
      var wrapped = px <= 10 ? wrapText(g, text, avail) : [text];
      g.font = weight + ' ' + Math.round(px) + 'px ' + (ln.font || 'ui-monospace, "DejaVu Sans Mono", Menlo, monospace');
      g.fillStyle = ln.color || '#e8e2d6';
      y += (ln.gap === undefined ? size * 1.35 : ln.gap);
      for (var wline = 0; wline < wrapped.length; wline++) {
        g.fillText(wrapped[wline], x, y + wline * px * 1.25);
      }
    }
    return textureFrom(c);
  }

  // ---------------------------------------------------------------- geometry
  function frameMatrix(THREE, frame) {
    var m = new THREE.Matrix4();
    m.set(
      frame.x.x, frame.y.x, frame.z.x, frame.pos.x,
      frame.x.y, frame.y.y, frame.z.y, frame.pos.y,
      frame.x.z, frame.y.z, frame.z.z, frame.pos.z,
      0, 0, 0, 1
    );
    return m;
  }

  function sizeOf(box) {
    return {
      x: Math.max(0.001, box.max.x - box.min.x),
      y: Math.max(0.001, box.max.y - box.min.y),
      z: Math.max(0.001, box.max.z - box.min.z)
    };
  }

  function centreOf(box) {
    return {
      x: (box.min.x + box.max.x) / 2,
      y: (box.min.y + box.max.y) / 2,
      z: (box.min.z + box.max.z) / 2
    };
  }

  // ---------------------------------------------------------------- renderer
  function Renderer(opts) {
    this.THREE = ensureThree();
    this.canvas = opts.canvas;
    this.settings = opts.settings;
    this.theme = null;
    this.geom = null;
    this.sim = null;
    this.meshes = {};
    this.signMeshes = [];
    this.portalQuads = { blue: null, orange: null };
    this.portalFrames = { blue: 0, orange: 0 };
    this.rt = { blue: null, orange: null };
    this.vcam = { blue: null, orange: null };
    this.reducedMotion = false;
    this.bob = 0;
    this.clock = 0;
    this.portalViewsEnabled = true;
    this.stats = { portalRenders: 0, frames: 0 };

    var THREE = this.THREE;
    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas, antialias: true, powerPreference: 'high-performance'
    });
    this.renderer.setClearColor(0x0b0d11, 1);
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Exposure and the light levels below are one decision, not two: the earlier
    // "too dark" report was answered by raising both, which saturated every
    // surface to the same near-white and made the chamber unreadable in the
    // other direction. Warm dim ambient + a strong warm key keeps the gradients.
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x1b1e22, 26, 92);
    this.camera = new THREE.PerspectiveCamera(78, 1.6, 0.06, 120);
    this.camera.rotation.order = 'YXZ';
    // View-only override used by the screenshot tests. It moves the render
    // camera and nothing else: the player, the physics and the puzzle state are
    // untouched, and clearing it returns the first-person view.
    this.inspectView = null;

    this.vcam.blue = new THREE.PerspectiveCamera(78, 1.6, 0.06, 120);
    this.vcam.orange = new THREE.PerspectiveCamera(78, 1.6, 0.06, 120);

    this.hemi = new THREE.HemisphereLight(0xffd2a1, 0x241f1b, 0.55);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffd9a8, 1.6);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.scene.add(this.key);
    this.scene.add(this.key.target);
    this.fill = new THREE.DirectionalLight(0x9fc2ff, 0.3);
    this.fill.position.set(-6, 4, -8);
    this.scene.add(this.fill);
    this.accent = new THREE.PointLight(0xffc65c, 1.2, 18, 2);
    this.scene.add(this.accent);
    this.doorGlow = new THREE.PointLight(0xffd9a0, 0.9, 14, 2);
    this.scene.add(this.doorGlow);
    this.padGlow = new THREE.PointLight(0x9fd0ff, 0.85, 12, 2);
    this.scene.add(this.padGlow);
    this.entryFill = new THREE.PointLight(0xbfd4ff, 0.55, 16, 2);
    this.scene.add(this.entryFill);

    this.resize();
    this.applySettings();
  }

  Renderer.prototype.applySettings = function () {
    var s = this.settings.values || this.settings;
    var fov = s.fov === undefined ? 78 : s.fov;
    this.camera.fov = fov;
    this.vcam.blue.fov = fov;
    this.vcam.orange.fov = fov;
    this.camera.updateProjectionMatrix();
    this.vcam.blue.updateProjectionMatrix();
    this.vcam.orange.updateProjectionMatrix();
    this.reducedMotion = !!s.reducedMotion;
    this.scale = s.renderScale === undefined ? 1 : s.renderScale;
    this.resize();
  };

  Renderer.prototype.resize = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var scale = this.scale === undefined ? 1 : this.scale;
    var w = this.canvas.clientWidth || window.innerWidth;
    var h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(dpr * scale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.vcam.blue.aspect = this.camera.aspect;
    this.vcam.orange.aspect = this.camera.aspect;
    this.vcam.blue.updateProjectionMatrix();
    this.vcam.orange.updateProjectionMatrix();
    var rw = Math.max(160, Math.round(w * 0.5 * scale * dpr));
    var rh = Math.max(100, Math.round(h * 0.5 * scale * dpr));
    if (this.rt.blue) { this.rt.blue.dispose(); this.rt.orange.dispose(); }
    var THREE = this.THREE;
    var mk = new THREE.WebGLRenderTarget(rw, rh, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false
    });
    this.rt.blue = mk;
    this.rt.orange = new THREE.WebGLRenderTarget(rw, rh, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false
    });
    if (this.portalQuads.blue) this.portalQuads.blue.material.uniforms.map.value = this.rt.blue.texture;
    if (this.portalQuads.orange) this.portalQuads.orange.material.uniforms.map.value = this.rt.orange.texture;
  };

  Renderer.prototype._material = function (name) {
    var THREE = this.THREE;
    var spec = MATERIALS[name] || MATERIALS.wall;
    if (this.sim) {
      var colours = {floor:0x666078,wall:0xc1b8cf,'wall-bright':0xd9c9d3,
        ceiling:0x3c304d,trim:0x282137,door:0x40344e,terminal:0x30253e,
        pedestal:0x4b405c,barrier:0x45394e,panel:0xcfc2d6,mount:0xd4c7d5};
      spec = Object.assign({}, spec);
      if (colours[name] !== undefined) spec.color = colours[name];
      if (this.sim.levelIndex > 1) {
        var routeColours = {stair:0x4b405c,catwalk:0x62566e,rail:0xb9abbf,
          plate:0x30253e,screen:0x72637d,pitwall:0x282137};
        if (routeColours[name] !== undefined) spec.color = routeColours[name];
      }
      if (name === 'floor') { spec.rough = .5; spec.metal = .16; }
    }
    var mat = new THREE.MeshStandardMaterial({
      color: spec.color, roughness: spec.rough, metalness: spec.metal
    });
    if (spec.tex) {
      mat.map = textureFrom(sharedTexture(spec.tex), [1, 1]);
      mat.needsUpdate = true;
    }
    return mat;
  };

  Renderer.prototype._addBox = function (solid) {
    var THREE = this.THREE;
    var size = sizeOf(solid.aabb), centre = centreOf(solid.aabb);
    var geo = new THREE.BoxGeometry(size.x, size.y, size.z);
    var mat = this._material(solid.material);
    if (mat.map) {
      mat.map.repeat.set(Math.max(1, Math.round(size.x / 2.4)), Math.max(1, Math.round(size.y / 2.4)));
    }
    var mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(centre.x, centre.y, centre.z);
    mesh.castShadow = solid.kind !== 'floor' && solid.kind !== 'ceiling';
    mesh.receiveShadow = true;
    mesh.userData.solidId = solid.id;
    this.scene.add(mesh);
    this.meshes[solid.id] = mesh;
    return mesh;
  };

  Renderer.prototype._addTrim = function (solid) {
    // A thin emissive nosing along the catwalk and stair edges: the landmarks
    // that make the room readable from the floor.
    if (solid.kind !== 'catwalk' && solid.kind !== 'stair') return;
    var THREE = this.THREE;
    var size = sizeOf(solid.aabb), centre = centreOf(solid.aabb);
    var mat = new THREE.MeshBasicMaterial({ color: solid.kind === 'catwalk' ? 0xffc65c : 0x8f7a45 });
    var geo = new THREE.BoxGeometry(size.x, 0.03, Math.min(0.06, size.z));
    var mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(centre.x, solid.aabb.max.y + 0.015, solid.aabb.min.z + 0.03);
    this.scene.add(mesh);
  };

  Renderer.prototype.build = function (geom, sim) {
    var THREE = this.THREE;
    if (this.geom) this.disposeLevel();
    this.geom = geom;
    this.sim = sim;
    this.theme = geom.theme;

    var i;
    for (i = 0; i < geom.solids.length; i++) {
      var solid = geom.solids[i];
      if (!solid.visible) continue;
      this._addBox(solid);
      this._addTrim(solid);
    }

    // ---- plates: dark housing with an indicator face
    for (i = 0; i < geom.plates.length; i++) {
      var pl = geom.plates[i];
      var plateMesh = this.meshes[pl.id];
      var size = sizeOf(pl.aabb);
      var glow = new THREE.Mesh(
        new THREE.BoxGeometry(size.x * 0.82, 0.02, size.z * 0.82),
        new THREE.MeshBasicMaterial({ color: 0x2f3a45 })
      );
      glow.position.set(pl.centre.x, pl.aabb.max.y + 0.011, pl.centre.z);
      glow.name = 'plate-glow-' + i;
      this.scene.add(glow);
      if (plateMesh) plateMesh.receiveShadow = true;
    }

    // ---- cubes: six labelled faces so the module name is readable in hand
    this.cubeMeshes = {};
    for (i = 0; i < geom.cubes.length; i++) {
      var gc = geom.cubes[i];
      var labelTex = makeTextTexture({
        width: 512, height: 512, background: '#cfc7b6', border: '#8a8272', borderWidth: 8, padding: 40,
        lines: [
          { text: gc.label, size: 58, color: '#141820', weight: 700 },
          { text: 'module', size: 34, color: '#5d574a', weight: 500, gap: 74 }
        ]
      });
      var faceMat = new THREE.MeshStandardMaterial({ map: labelTex, roughness: 0.75, metalness: 0.05 });
      var plainMat = new THREE.MeshStandardMaterial({ color: 0x8a8374, roughness: 0.72, metalness: 0.05 });
      var cube = new THREE.Mesh(
        new THREE.BoxGeometry(gc.size, gc.size, gc.size),
        [faceMat, faceMat, plainMat, plainMat, faceMat, faceMat]
      );
      cube.castShadow = true;
      cube.receiveShadow = true;
      this.scene.add(cube);
      this.cubeMeshes[gc.id] = cube;
    }

    // ---- terminals: a glowing screen on the facing side
    for (i = 0; i < geom.terminals.length; i++) {
      var t = geom.terminals[i];
      var screenLevel = this.sim.payload.levels[this.sim.levelIndex];
      if (screenLevel.kind === 'portals' && SD.Realm) {
        screenLevel = Object.assign({}, screenLevel, {objective: SD.Realm.trainingGoal});
      }
      var lines = SD.Payload.terminalPreview(t, screenLevel, this.sim.payload);
      var tex = makeTextTexture({
        width: 768, height: 480, background: '#080b0f', border: '#ffd166', borderWidth: 5,
        pad: 34,
        lines: lines
      });
      var screen = new THREE.Mesh(
        new THREE.PlaneGeometry(1.7, 1.05),
        new THREE.MeshBasicMaterial({ map: tex })
      );
      screen.position.set(t.pos.x + t.facing.x * 0.16, t.pos.y, t.pos.z + t.facing.z * 0.16);
      screen.rotation.y = Math.atan2(t.facing.x, t.facing.z);
      screen.name = 'screen-' + t.id;
      this.scene.add(screen);
    }

    // ---- wall signs
    for (i = 0; i < geom.signs.length; i++) {
      var sg = geom.signs[i];
      var isNumeral = sg.style === 'numeral';
      var flat = Math.abs(sg.facing.y) > 0.5;
      var colour = sg.style === 'exit' ? '#7ce0a0'
        : sg.style === 'warn' ? '#ff8a5c'
          : sg.style === 'plate' ? '#ffd166'
            : sg.style === 'numeral' ? 'rgba(232,226,214,0.28)' : '#ffd166';
      var bg = isNumeral ? 'rgba(10,12,16,0)' : '#0b0e12';
      var w = isNumeral ? 256 : 512, h = isNumeral ? 256 : 128;
      var stex = makeTextTexture({
        width: w, height: h, background: bg,
        border: isNumeral ? null : 'rgba(255,209,102,0.28)', borderWidth: 3,
        lines: [{
          text: sg.id === 'sign-entry' && this.sim.levelIndex === 0 && SD.Realm ? SD.Realm.trainingGoal : sg.text,
          size: isNumeral ? 150 : 46, color: colour, weight: 700
        }]
      });
      var signWidth = sg.width || (isNumeral ? 1.5 : Math.min(3.4, 0.42 * String(sg.text).length + 0.4));
      var signHeight = sg.height || (isNumeral ? 1.5 : Math.max(0.42, signWidth / 4));
      var plane = new THREE.Mesh(
        new THREE.PlaneGeometry(signWidth, signHeight),
        new THREE.MeshBasicMaterial({ map: stex, transparent: isNumeral })
      );
      plane.position.set(sg.pos.x, sg.pos.y, sg.pos.z);
      plane.name = sg.id;
      if (flat) {
        // A sign on a floor faces up: lay it flat instead of standing it on edge.
        plane.rotation.x = sg.facing.y > 0 ? -Math.PI / 2 : Math.PI / 2;
        plane.position.y = Math.max(sg.pos.y, 0.015);
      } else {
        plane.rotation.y = Math.atan2(sg.facing.x, sg.facing.z);
      }
      this.scene.add(plane);
      this.signMeshes.push(plane);
    }

    // ---- ceiling light strips: the room needs a lit ceiling, not a black void
    var stripMat = new THREE.MeshBasicMaterial({ color: 0xfff3d8 });
    for (i = 0; i < 3; i++) {
      var sz = geom.bounds.min.z + (geom.bounds.max.z - geom.bounds.min.z) * (0.22 + i * 0.28);
      var strip = new THREE.Mesh(
        new THREE.BoxGeometry(Math.min(6.5, geom.layout.width * 0.45), 0.08, 0.34),
        stripMat
      );
      strip.position.set(0, geom.layout.height - 0.015, sz);
      this.scene.add(strip);
    }

    // ---- portal quads
    this._buildPortalQuad('blue', 0x3fa9ff);
    this._buildPortalQuad('orange', 0xff8a3d);

    this._lightLevel();
    this.realmActive = false;
    if (this.realmDecorate) this.realmDecorate();
    this.portalFrames = { blue: 0, orange: 0 };
  };

  Renderer.prototype._buildPortalQuad = function (slot, colour) {
    var THREE = this.THREE;
    var geo = new THREE.PlaneGeometry(SD.Portals.WIDTH, SD.Portals.HEIGHT);
    var material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: this.rt[slot].texture },
        tint: { value: new THREE.Color(colour) },
        open: { value: 0.0 }
      },
      vertexShader: [
        'varying vec4 vClip;',
        'varying vec2 vUv;',
        'void main() {',
        '  vUv = uv;',
        '  vec4 world = modelMatrix * vec4(position, 1.0);',
        '  vClip = projectionMatrix * viewMatrix * world;',
        '  gl_Position = vClip;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D map;',
        'uniform vec3 tint;',
        'uniform float open;',
        'varying vec4 vClip;',
        'varying vec2 vUv;',
        'void main() {',
        '  vec2 uv = (vClip.xy / vClip.w) * 0.5 + 0.5;',
        '  vec3 c = texture2D(map, uv).rgb;',
        // a soft rim so the aperture reads as an opening even face-on
        '  vec2 d = abs(vUv - 0.5) * 2.0;',
        '  float rim = smoothstep(0.72, 1.0, max(d.x, d.y));',
        '  c = mix(tint * 0.12, c, open);',
        '  c = mix(c, tint, rim * 0.85);',
        '  gl_FragColor = vec4(c, 1.0);',
        '}'
      ].join('\n'),
      depthWrite: true,
      depthTest: true
    });
    var quad = new THREE.Mesh(geo, material);
    quad.matrixAutoUpdate = false;
    quad.visible = false;
    quad.frustumCulled = false;
    quad.name = 'portal-' + slot;
    this.scene.add(quad);
    this.portalQuads[slot] = quad;

    var ring = new THREE.Mesh(
      new THREE.PlaneGeometry(SD.Portals.WIDTH * 1.12, SD.Portals.HEIGHT * 1.08),
      new THREE.ShaderMaterial({
        uniforms: { tint: { value: new THREE.Color(colour) }, opacity: { value: .65 } },
        vertexShader: 'varying vec2 v;void main(){v=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
        fragmentShader: 'varying vec2 v;uniform vec3 tint;uniform float opacity;void main(){vec2 p=abs(v-.5)*2.;float edge=max(p.x,p.y);if(edge<.9)discard;float a=1.-smoothstep(.92,1.,edge);gl_FragColor=vec4(tint,a*opacity);}',
        transparent: true, depthWrite: false, side: THREE.DoubleSide
      })
    );
    ring.matrixAutoUpdate = false;
    ring.visible = false;
    ring.frustumCulled = false;
    this.scene.add(ring);
    this.portalRings = this.portalRings || {};
    this.portalRings[slot] = ring;
    var badge = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.3),
      new THREE.MeshBasicMaterial({ map: makeTextTexture({ width: 128, height: 96,
        text: slot === 'blue' ? 'A' : 'B', background: '#10151c' }), side: THREE.DoubleSide }));
    badge.position.set(0, SD.Portals.HEIGHT / 2 + 0.2, 0.025);
    ring.add(badge);
    // Slim layered hardware outside the aperture; never fills its destination.
    var railMat = new THREE.MeshStandardMaterial({color:0x3a3049,roughness:.35,metalness:.7});
    var lightMat = new THREE.MeshBasicMaterial({color:colour});
    [-1, 1].forEach(function (side) {
      var rail = new THREE.Mesh(new THREE.BoxGeometry(.07, SD.Portals.HEIGHT + .14, .045), railMat);
      rail.position.set(side * (SD.Portals.WIDTH / 2 + .07), 0, .012); ring.add(rail);
      var cap = new THREE.Mesh(new THREE.BoxGeometry(SD.Portals.WIDTH + .18, .045, .03), lightMat);
      cap.position.set(0, side * (SD.Portals.HEIGHT / 2 + .055), .015); ring.add(cap);
    });
  };

  Renderer.prototype._lightLevel = function () {
    var g = this.geom;
    var z0 = g.bounds.min.z, z1 = g.bounds.max.z;
    this.key.position.set(4, g.layout.height + 5, z1 + 6);
    this.key.target.position.set(0, 1, (z0 + z1) / 2);
    this.key.target.updateMatrixWorld();
    var span = Math.max(Math.abs(z1 - z0), g.layout.width) * 0.75 + 6;
    var cam = this.key.shadow.camera;
    cam.left = -span; cam.right = span; cam.top = span; cam.bottom = -span;
    cam.near = 0.5; cam.far = 90;
    cam.updateProjectionMatrix();
    this.key.shadow.bias = -0.0012;
    this.key.shadow.normalBias = 0.02;

    if (g.plates.length) this.accent.position.set(g.plates[0].centre.x, 2.0, g.plates[0].centre.z + 1.2);
    else this.accent.position.set(0, 2.4, z1 - 4);
    if (g.chasm) {
      this.fill.position.set(-2.0, 3.2, g.chasm.z0 - 3.0);
      this.doorGlow.position.set(0, 2.0, g.door.centre.z - 1.0);
    }
    // Key the room from where the puzzle actually happens, so the catwalk, the
    // pad and the launch panel are the lit landmarks rather than silhouettes.
    if (g.zones && g.zones.pad) {
      this.padGlow.position.set(g.zones.pad.x, 1.5, g.zones.pad.z);
      this.accent.position.set(
        (g.zones.panel.x0 + g.zones.panel.x1) / 2,
        Math.min(3.2, g.zones.panel.height - 1.2),
        g.zones.panel.z1 + 1.4
      );
    }
    this.entryFill.position.set(g.spawn.x, 2.6, g.spawn.z + 1.2);
    this.fill.position.set(g.spawn.x - 3, 3.4, g.spawn.z + 2.0);
  };

  Renderer.prototype.disposeLevel = function () {
    var THREE = this.THREE;
    var kill = function (obj) {
      if (!obj) return;
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(function (m) { if (m.map) m.map.dispose(); m.dispose(); });
        else { if (obj.material.map) obj.material.map.dispose(); obj.material.dispose(); }
      }
      if (obj.geometry) obj.geometry.dispose();
    };
    for (var id in this.meshes) if (Object.prototype.hasOwnProperty.call(this.meshes, id)) kill(this.meshes[id]);
    this.cubeMeshes = {};
    this.meshes = {};
    var keep = {};
    keep[this.portalQuads.blue && this.portalQuads.blue.uuid] = true;
    keep[this.portalQuads.orange && this.portalQuads.orange.uuid] = true;
    var doomed = [];
    this.scene.children.forEach(function (o) {
      if (o === this.hemi || o === this.key || o === this.key.target || o === this.fill ||
        o === this.accent || o === this.doorGlow) return;
      if (o.isMesh) doomed.push(o);
    }.bind(this));
    doomed.forEach(function (o) { this.scene.remove(o); kill(o); }.bind(this));
    this.signMeshes = [];
  };

  // ---------------------------------------------------------------- portal view
  Renderer.prototype._placePortalQuad = function (slot) {
    var portal = this.sim.portals.slots[slot];
    var quad = this.portalQuads[slot];
    var ring = this.portalRings[slot];
    if (!portal || !portal.active) {
      quad.visible = false;
      if (ring) ring.visible = false;
      return;
    }
    var m = frameMatrix(this.THREE, portal.frame);
    quad.matrix.copy(m);
    quad.material.uniforms.open.value = 1;
    quad.visible = true;
    if (ring) {
      ring.material.uniforms.opacity.value = this.sim.portals.pair() ? .85 : .45;
      ring.matrix.copy(m);
      ring.visible = true;
    }
    // Animate the aperture opening on placement.
    if (this.portalFrames[slot] < 1) this.portalFrames[slot] = Math.min(1, this.portalFrames[slot] + 0.14);
  };

  Renderer.prototype._renderPortal = function (slot, dt) {
    var src = this.sim.portals.slots[slot];
    if (!src || !src.active) return;
    var other = this.sim.portals.other(slot);
    if (!other || !other.active) return;
    var THREE = this.THREE;
    var mSrc = frameMatrix(THREE, src.frame);
    var mDst = frameMatrix(THREE, other.frame);
    var flip = new THREE.Matrix4().makeRotationY(Math.PI);
    var m = new THREE.Matrix4().multiplyMatrices(mDst, flip).multiply(mSrc.clone().invert());
    var camWorld = new THREE.Matrix4().multiplyMatrices(m, this.camera.matrixWorld);

    var vcam = this.vcam[slot];
    camWorld.decompose(vcam.position, vcam.quaternion, vcam.scale);
    vcam.updateMatrixWorld(true);
    vcam.matrixWorldInverse.copy(vcam.matrixWorld).invert();
    vcam.projectionMatrix.copy(this.camera.projectionMatrix);

    // The virtual camera sits *behind* the destination aperture, so the surface
    // the portal is mounted on would fill the view. Clip the frustum at the
    // destination plane (Lengyel's oblique near plane) and keep the half-space
    // the portal's normal points into: that is the destination room. Fragments
    // on the aperture map to exactly the same pixels as in the main pass, which
    // is what makes the screen-space sample below geometrically correct.
    var plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      new THREE.Vector3(other.normal.x, other.normal.y, other.normal.z),
      new THREE.Vector3(other.frame.pos.x, other.frame.pos.y, other.frame.pos.z)
    );
    plane.applyMatrix4(vcam.matrixWorldInverse);
    var clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    var pm = vcam.projectionMatrix;
    var q = new THREE.Vector4(
      (Math.sign(clip.x) + pm.elements[8]) / pm.elements[0],
      (Math.sign(clip.y) + pm.elements[9]) / pm.elements[5],
      -1.0,
      (1.0 + pm.elements[10]) / pm.elements[14]
    );
    var dot = clip.x * q.x + clip.y * q.y + clip.z * q.z + clip.w * q.w;
    if (Math.abs(dot) > 1e-6) {
      var k = 2.0 / dot;
      clip.multiplyScalar(k);
      pm.elements[2] = clip.x;
      pm.elements[6] = clip.y;
      pm.elements[10] = clip.z + 1.0 - 0.0035;
      pm.elements[14] = clip.w;
    }

    // Hide both apertures so neither portal renders itself.
    this.portalQuads.blue.visible = false;
    this.portalQuads.orange.visible = false;
    if (this.portalRings) { this.portalRings.blue.visible = false; this.portalRings.orange.visible = false; }

    this.renderer.setRenderTarget(this.rt[slot]);
    this.renderer.clear();
    this.renderer.render(this.scene, vcam);
    this.renderer.setRenderTarget(null);
    this.stats.portalRenders++;
  };

  Renderer.prototype.render = function (sim, dt) {
    var s = this.settings.values || this.settings;
    this.time = (this.time || 0) + dt;
    var p = sim.player;
    var bobAmt = this.reducedMotion ? 0 : Math.sin(p.bob * 2.0) * 0.035;
    var eyeY = p.pos.y + SD.Player.EYE + bobAmt;
    if (this.inspectView) {
      // Same convention as the player camera (yaw 0 looks toward +Z) so a test
      // can ask for "stand here looking there" without inverting the world.
      var iv = this.inspectView;
      this.camera.position.set(iv.pos.x, iv.pos.y, iv.pos.z);
      this.camera.rotation.set(iv.pitch, iv.yaw + Math.PI, 0, 'YXZ');
    } else {
      this.camera.position.set(p.pos.x, eyeY, p.pos.z);
      this.camera.rotation.set(p.pitch, p.yaw + Math.PI, 0, 'YXZ');
      // Three's camera looks down -Z: yaw 0 must look toward +Z.
      this.camera.rotation.y = p.yaw + Math.PI;
      this.camera.rotation.x = p.pitch;
    }
    this.camera.updateMatrixWorld(true);

    this._placePortalQuad('blue');
    this._placePortalQuad('orange');

    // Cubes + plate + door read straight out of the simulation.
    var i;
    if (this.cubeMeshes) {
      for (i = 0; i < sim.cubes.length; i++) {
        var cb = sim.cubes[i];
        var mesh = this.cubeMeshes[cb.id];
        if (!mesh) continue;
        mesh.position.set(cb.pos.x, cb.pos.y + cb.size.y / 2, cb.pos.z);
        mesh.rotation.y = cb.held ? 0.2 : 0;
        mesh.scale.setScalar(cb.held && !this.reducedMotion ? 1 + Math.sin(this.time * 3) * .008 : 1);
      }
    }
    for (i = 0; i < sim.plates.length; i++) {
      var glow = this.scene.getObjectByName('plate-glow-' + i);
      if (!glow) continue;
      var satisfied = sim.plates[i].satisfied;
      glow.material.color.setHex(satisfied ? 0xffd49a : 0x605773);
      if (this.realmActive && !this.reducedMotion && satisfied) glow.material.color.multiplyScalar(.94 + Math.sin(this.time * 2) * .06);
      glow.position.y = sim.plates[i].aabb.max.y + (sim.plates[i].occupantId ? 0.002 : 0.025);
    }
    for (i = 0; i < sim.geom.door.leaves.length; i++) {
      var leaf = sim.geom.door.leaves[i];
      var leafMesh = this.meshes[leaf.id];
      if (!leafMesh) continue;
      var size = sizeOf(leaf.aabb), centre = centreOf(leaf.aabb);
      // BoxGeometry already has the collider dimensions; only its centre moves.
      leafMesh.scale.set(1, 1, 1);
      leafMesh.position.set(centre.x, centre.y, centre.z);
    }

    if (this.portalViewsEnabled) {
      this._renderPortal('blue', dt);
      this._renderPortal('orange', dt);
      this._placePortalQuad('blue');
      this._placePortalQuad('orange');
    }
    // Re-assert visibility after the portal passes hid them.
    this.portalQuads.blue.visible = !!sim.portals.slots.blue;
    this.portalQuads.orange.visible = !!sim.portals.slots.orange;
    if (this.portalRings) {
      this.portalRings.blue.visible = !!sim.portals.slots.blue;
      this.portalRings.orange.visible = !!sim.portals.slots.orange;
    }

    this.renderer.render(this.scene, this.camera);
    this.stats.frames++;
  };

  SD.Render = {
    create: function (opts) { return new Renderer(opts); },
    Renderer: Renderer,
    makeTextTexture: makeTextTexture,
    MATERIALS: MATERIALS
  };
})(typeof window !== 'undefined' ? (window.SD = window.SD || {}) : (globalThis.SD = globalThis.SD || {}));
