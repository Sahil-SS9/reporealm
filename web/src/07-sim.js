/* SOURCE DRIVE - deterministic game core.
 *
 * No DOM, no THREE, no timers. The browser drives this with real input; the
 * node tests drive it with the same input struct. That is what keeps a passing
 * unit test and a passing play-through from being two different games.
 */
(function (SD) {
  'use strict';
  var C = SD.Core;

  var STEP = 1 / 120;
  var CARRY_DIST = 1.45;
  var CARRY_DROP = 0.32;
  var REACH = 3.2;
  var PORTAL_RANGE = 45;
  var DOOR_SPEED = 1.35;      // progress per second

  function Cube(geomCube) {
    this.id = geomCube.id;
    this.label = geomCube.label;
    this.correct = geomCube.correct;
    this.reason = geomCube.reason;
    this.evidenceIds = geomCube.evidenceIds;
    this.size = { x: geomCube.size, y: geomCube.size, z: geomCube.size };
    this.spawn = { x: geomCube.spawn.x, y: geomCube.spawn.y, z: geomCube.spawn.z };
    this.pos = { x: geomCube.spawn.x, y: geomCube.spawn.y, z: geomCube.spawn.z };
    this.vel = { x: 0, y: 0, z: 0 };
    this.onGround = false;
    this.held = false;
    this.thrown = 0;
    this._portal = null;
    this.pedestalId = geomCube.pedestalId;
  }

  Cube.prototype.reset = function () {
    this.pos = { x: this.spawn.x, y: this.spawn.y, z: this.spawn.z };
    this.vel = { x: 0, y: 0, z: 0 };
    this.onGround = false;
    this.held = false;
    this._portal = null;
  };

  function Sim(payload, levelIndex, options) {
    var opts = options || {};
    this.payload = payload;
    this.levelIndex = levelIndex;
    this.level = payload.levels[levelIndex];
    this.geom = SD.LevelGen.build(this.level);
    this.world = new SD.Physics.World(this.geom.solids);
    this.world.refresh();
    this.portals = SD.Portals.create({ world: this.world, bounds: this.geom.bounds });
    this.player = SD.Player.create(this.world, this.portals, this.geom.spawn);
    this.cubes = this.geom.cubes.map(function (c) { return new Cube(c); });
    this.plates = this.geom.plates.map(function (p) {
      return {
        id: p.id, number: p.number, aabb: p.aabb, centre: p.centre, accepts: p.accepts,
        satisfied: false, occupantId: null, refusedIds: []
      };
    });
    this.door = {
      open: false, progress: 0, required: this.plates.length,
      satisfied: 0, unlocked: this.plates.length === 0 && !this.geom.door.threshold, reject: ''
    };
    this.time = 0;
    this.events = [];
    this.phase = 'playing';
    this.held = null;
    this.terminalOpen = null;
    this.stats = { portalPlacements: 0, portalCrossings: 0, pickups: 0, recoveries: 0, plates: 0 };
    this.checkpoint = { x: this.geom.spawn.x, y: this.geom.spawn.y, z: this.geom.spawn.z };
    this._weighed = false;
    this._thrHintT = undefined;
    this.quiet = !!opts.quiet;
    this.lastTravel = null;
  }

  Sim.prototype.emit = function (type, data) {
    var ev = { type: type, t: C.round(this.time, 2) };
    if (data) for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) ev[k] = data[k];
    this.events.push(ev);
    return ev;
  };

  Sim.prototype.drainEvents = function () {
    var out = this.events;
    this.events = [];
    return out;
  };

  // ------------------------------------------------------------- resets
  Sim.prototype.reset = function () {
    this.portals.reset();
    this.player.respawn();
    this.cubes.forEach(function (c) { c.reset(); });
    this.plates.forEach(function (p) { p.satisfied = false; p.occupantId = null; p.refusedIds = []; });
    this.door.open = false;
    this.door.progress = 0;
    this.door.satisfied = 0;
    var thr0 = this.geom.door.threshold;
    if (thr0) thr0.occupied = false;
    this._weighed = false;
    this._thrHintT = undefined;
    this.door.unlocked = this.plates.length === 0 && !thr0;
    this.door.reject = '';
    SD.LevelGen.applyDoorProgress(this.geom, 0);
    this.held = null;
    this.terminalOpen = null;
    this.time = 0;
    this.phase = 'playing';
    this.checkpoint = { x: this.geom.spawn.x, y: this.geom.spawn.y, z: this.geom.spawn.z };
    this.stats = { portalPlacements: 0, portalCrossings: 0, pickups: 0, recoveries: 0, plates: 0 };
    this.lastTravel = null;
    this.emit('reset', { level: this.level.id });
  };

  Sim.prototype.respawn = function (reason) {
    this.player.pos = { x: this.checkpoint.x, y: this.checkpoint.y, z: this.checkpoint.z };
    this.player.vel = { x: 0, y: 0, z: 0 };
    this.player._portal = null;
    this.player.lastGroundY = this.checkpoint.y;
    if (this.held) { this.held.held = false; this.held = null; }
    this.stats.recoveries++;
    this.emit('recovered', { reason: reason || 'fall' });
  };

  // ------------------------------------------------------------- aiming
  Sim.prototype.aimAt = function (point) {
    var e = this.player.eye();
    var dx = point.x - e.x, dy = point.y - e.y, dz = point.z - e.z;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    this.player.yaw = Math.atan2(dx, dz);
    this.player.pitch = Math.asin(C.clamp(dy / len, -1, 1));
  };

  Sim.prototype.raycast = function (maxDist) {
    var eye = this.player.eye();
    var f = this.player.forward();
    var best = null;
    var hit = this.world.raycast(eye, f, maxDist || PORTAL_RANGE, null);
    if (hit) best = hit;
    // cubes block the ray too
    for (var i = 0; i < this.cubes.length; i++) {
      var c = this.cubes[i];
      if (c.held) continue;
      var box = SD.Physics.aabbOf(c);
      var ch = SD.Physics.rayAabb(eye, f, box, maxDist || PORTAL_RANGE);
      if (ch && (!best || ch.t < best.t)) {
        best = { t: ch.t, normal: ch.normal, solid: { id: 'cube:' + c.id, kind: 'cube', aabb: box, portalable: false, refusal: 'You cannot open a portal on a weighted cube.', cube: c } };
      }
    }
    return best;
  };

  Sim.prototype.shoot = function (slot) {
    if (this.phase !== 'playing') return { ok: false, reason: 'The chamber is paused.' };
    var hit = this.raycast(PORTAL_RANGE);
    if (!hit) {
      this.emit('portal-miss', { slot: slot, reason: 'Nothing in range.' });
      return { ok: false, reason: 'Nothing in range.' };
    }
    if (hit.solid.kind === 'cube') {
      this.emit('portal-miss', { slot: slot, reason: hit.solid.refusal });
      return { ok: false, reason: hit.solid.refusal };
    }
    var res = this.portals.place(slot, { point: this._hitPoint(hit), normal: hit.normal, solid: hit.solid });
    if (!res.ok) {
      this.emit('portal-miss', { slot: slot, reason: res.reason });
      return res;
    }
    this.stats.portalPlacements++;
    this.emit('portal-placed', { slot: slot, solid: res.portal.solidId });
    return res;
  };

  Sim.prototype._hitPoint = function (hit) {
    var eye = this.player.eye();
    var f = this.player.forward();
    return { x: eye.x + f.x * hit.t, y: eye.y + f.y * hit.t, z: eye.z + f.z * hit.t };
  };

  // ------------------------------------------------------------- interaction
  Sim.prototype.nearestTerminal = function () {
    var eye = this.player.eye();
    var f = this.player.forward();
    for (var i = 0; i < this.geom.terminals.length; i++) {
      var t = this.geom.terminals[i];
      var dx = t.pos.x - eye.x, dy = t.pos.y - eye.y, dz = t.pos.z - eye.z;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > REACH) continue;
      var dot = (dx * f.x + dy * f.y + dz * f.z) / (dist || 1);
      if (dot < 0.55) continue;
      return t;
    }
    return null;
  };

  Sim.prototype.interact = function () {
    if (this.phase !== 'playing') return { action: 'none' };
    if (this.held) {
      this.drop();
      return { action: 'drop' };
    }
    var term = this.nearestTerminal();
    if (term) {
      this.terminalOpen = term;
      this.emit('terminal-open', { id: term.id });
      return { action: 'terminal', terminal: term };
    }
    var hit = this.raycast(REACH);
    if (hit && hit.solid.kind === 'cube') {
      return this.pickup(hit.solid.cube);
    }
    // A held cube in reach on the floor is also grabbable by proximity.
    var near = this.nearestCube(1.9);
    if (near) return this.pickup(near);
    return { action: 'none' };
  };

  Sim.prototype.nearestCube = function (maxDist) {
    var eye = this.player.eye();
    var f = this.player.forward();
    var best = null;
    for (var i = 0; i < this.cubes.length; i++) {
      var c = this.cubes[i];
      if (c.held) continue;
      var dx = c.pos.x - eye.x, dz = c.pos.z - eye.z, dy = (c.pos.y + 0.3) - eye.y;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > maxDist) continue;
      var dot = (dx * f.x + dy * f.y + dz * f.z) / (dist || 1);
      if (dot < 0.2) continue;
      if (!best || dist < best.dist) best = { cube: c, dist: dist };
    }
    return best ? best.cube : null;
  };

  Sim.prototype.pickup = function (cube) {
    if (!cube || cube.held) return { action: 'none' };
    cube.held = true;
    cube.vel = { x: 0, y: 0, z: 0 };
    this.held = cube;
    this.stats.pickups++;
    this.emit('pickup', { id: cube.id, label: cube.label });
    return { action: 'pickup', cube: cube };
  };

  Sim.prototype.drop = function () {
    var cube = this.held;
    if (!cube) return { action: 'none' };
    var target = this.carryTarget();
    cube.held = false;
    this.held = null;
    cube._portal = null;
    // A cube released over a plate settles onto it - the plate is a defined
    // object, not a pixel test.
    var plate = this.plateUnder(target.x, target.z, 0.55);
    if (plate) {
      target = { x: plate.centre.x, y: plate.aabb.max.y, z: plate.centre.z };
    }
    cube.pos = { x: target.x, y: Math.max(target.y, 0) + 0.002, z: target.z };
    cube.vel = { x: 0, y: 0, z: 0 };
    this.emit('drop', { id: cube.id, label: cube.label });
    return { action: 'drop', cube: cube };
  };

  Sim.prototype.plateUnder = function (x, z, pad) {
    var p = pad === undefined ? 0.4 : pad;
    for (var i = 0; i < this.plates.length; i++) {
      var pl = this.plates[i];
      if (x >= pl.aabb.min.x - p && x <= pl.aabb.max.x + p &&
        z >= pl.aabb.min.z - p && z <= pl.aabb.max.z + p) return pl;
    }
    return null;
  };

  Sim.prototype.carryTarget = function () {
    var eye = this.player.eye();
    var f = this.player.forward();
    return {
      x: eye.x + f.x * CARRY_DIST,
      y: eye.y + f.y * CARRY_DIST - CARRY_DROP,
      z: eye.z + f.z * CARRY_DIST
    };
  };

  // ------------------------------------------------------------- step
  Sim.prototype.step = function (dt, input) {
    dt = Math.min(dt, STEP * 4);
    var inp = input || {};
    if (this.phase !== 'playing') { this.time += dt; return; }
    this.time += dt;
    this.portals.tick(dt);

    var res = this.player.step(dt, inp);
    if (res.travelled) {
      this.stats.portalCrossings++;
      this.lastTravel = res.travelled;
      this.emit('portal-cross', {
        from: res.travelled.fromPortal, to: res.travelled.toPortal,
        entrySpeed: C.round(res.travelled.entrySpeed, 2),
        exitSpeed: C.round(res.travelled.exitSpeed, 2)
      });
      // A held cube crosses with the player (playerPortalGrabTransform).
      if (this.held) {
        this.held._portal = null;
        this.held.pos = this.carryTarget();
      }
    }
    if (res.jumped) this.emit('jump', {});
    if (res.landed) this.emit('land', { speed: C.round(-this.player.vel.y, 1) });
    if (res.fell) this.emit('recovered', { reason: 'void' });

    // Trench recovery: the body falls below the lip, so recover on the feet
    // rather than waiting for the eye to sink into the box.
    if (this.geom.chasm && SD.Physics.containsPoint(this.geom.chasm.recovery, this.player.pos)) {
      this.respawn('chasm');
    }
    if (this.player.pos.y < -12) this.respawn('void');

    // checkpoint: standing on the far side of the chasm
    if (this.geom.chasm && this.player.onGround && this.player.pos.z > this.geom.chasm.z1 + 0.4 &&
      this.player.pos.y > -0.2) {
      this.checkpoint = { x: this.player.pos.x, y: this.player.pos.y, z: this.player.pos.z };
    }

    this._stepCubes(dt);
    this._stepPlates();
    this._stepDoor(dt);
    this._stepExit();
  };

  Sim.prototype._stepCubes = function (dt) {
    for (var i = 0; i < this.cubes.length; i++) {
      var c = this.cubes[i];
      if (c.held) {
        var t = this.carryTarget();
        c.pos = { x: t.x, y: Math.max(t.y, 0.01), z: t.z };
        c.vel = { x: 0, y: 0, z: 0 };
        continue;
      }
      c.vel.y -= SD.Player.GRAVITY * dt;
      if (c.vel.y < -30) c.vel.y = -30;
      var move = this.world.moveBody(c, {
        x: c.vel.x * dt, y: c.vel.y * dt, z: c.vel.z * dt
      });
      if (c.onGround) {
        var damp = Math.max(0, 1 - 9 * dt);
        c.vel.x *= damp;
        c.vel.z *= damp;
      }
      var travel = this.portals.traverse(c, dt);
      if (travel) {
        this.emit('cube-cross', {
          id: c.id, from: travel.fromPortal, to: travel.toPortal,
          exitSpeed: C.round(travel.exitSpeed, 2)
        });
      }
      // Anything that leaves the playable floor space (fell in the trench,
      // vanished under the slab) cannot be reached by the player: bring it
      // back to its start instead of leaving the chamber short of a cube.
      if (c.pos.y < -0.6) {
        var deep = c.pos.y < -3;
        c.pos = { x: c.spawn.x, y: c.spawn.y, z: c.spawn.z };
        c.vel = { x: 0, y: 0, z: 0 };
        c._portal = null;
        this.emit('cube-reset', { id: c.id, deep: deep });
      }
      if (move.hitX || move.hitZ) { c.vel.x *= 0.4; c.vel.z *= 0.4; }
    }
  };

  Sim.prototype._stepPlates = function () {
    var satisfied = 0;
    for (var i = 0; i < this.plates.length; i++) {
      var plate = this.plates[i];
      var box = plate.aabb;
      var occupant = null;
      for (var j = 0; j < this.cubes.length; j++) {
        var c = this.cubes[j];
        if (c.held) continue;
        var cx = c.pos.x, cz = c.pos.z, cy = c.pos.y;
        if (cx >= box.min.x - 0.05 && cx <= box.max.x + 0.05 &&
          cz >= box.min.z - 0.05 && cz <= box.max.z + 0.05 &&
          cy <= box.max.y + 0.35 && cy >= box.min.y - 0.2) {
          occupant = c;
          break;
        }
      }
      if (occupant) {
        if (occupant.correct) {
          if (!plate.satisfied || plate.occupantId !== occupant.id) {
            this.emit('plate-press', { plate: plate.id, cube: occupant.id, label: occupant.label });
          }
          plate.satisfied = true;
          plate.occupantId = occupant.id;
        } else {
          if (plate.refusedIds.indexOf(occupant.id) < 0) {
            plate.refusedIds.push(occupant.id);
            this.emit('plate-reject', {
              plate: plate.id, cube: occupant.id, label: occupant.label,
              reason: occupant.reason
            });
          }
          plate.satisfied = false;
          plate.occupantId = occupant.id;
        }
      } else {
        if (plate.satisfied) this.emit('plate-release', { plate: plate.id });
        plate.satisfied = false;
        plate.occupantId = null;
      }
      plate.seen = { id: occupant ? occupant.id : null, y: occupant ? occupant.pos.y : null };
      if (plate.satisfied) satisfied++;
    }
    this.door.satisfied = satisfied;
    var wasUnlocked = this.door.unlocked;
    // The weighbridge rule: with a door threshold present, the door only
    // unlocks while the plate in front of it feels the player's weight.
    var thr = this.geom.door.threshold || null;
    var occupied = false;
    if (thr) {
      var pb = SD.Physics.aabbOf({ pos: this.player.pos, size: this.player.size });
      var tb = thr.aabb;
      occupied = this.player.onGround &&
        pb.min.x <= tb.max.x && pb.max.x >= tb.min.x &&
        pb.min.z <= tb.max.z && pb.max.z >= tb.min.z;
      thr.occupied = occupied;
    }
    // A weigh-in, not a standing hold: once the plate felt the player with the
    // set complete, the door keeps its clearance. A standing requirement would
    // drop the leaves back onto the player mid-passage.
    if (thr && occupied && satisfied >= this.plates.length) this._weighed = true;
    this.door.unlocked = (this.plates.length === 0 || satisfied >= this.plates.length) &&
      (!thr || this._weighed);
    if (this.door.unlocked && !wasUnlocked) {
      this.stats.plates = satisfied;
      this.emit('door-unlock', { plates: satisfied, required: this.plates.length });
    }
    if (thr && !occupied && satisfied >= this.plates.length &&
        this.time - (this._thrHintT === undefined ? -10 : this._thrHintT) > 4) {
      this._thrHintT = this.time;
      this.emit('door-weight', {});
    }
  };

  Sim.prototype._stepDoor = function (dt) {
    var target = this.door.unlocked ? 1 : 0;
    var p = this.door.progress;
    if (Math.abs(target - p) > 1e-4) {
      p += C.clamp(target - p, -DOOR_SPEED * dt, DOOR_SPEED * dt);
      if (Math.abs(target - p) < 1e-3) p = target;
      this.door.progress = p;
      SD.LevelGen.applyDoorProgress(this.geom, p);
      if (p > 0.05 && p < 0.95) {
        // moving; nothing to emit
      }
    }
    var open = this.door.progress > 0.92;
    if (open !== this.door.open) {
      this.door.open = open;
      this.emit(open ? 'door-open' : 'door-close', {});
    }
  };

  Sim.prototype._stepExit = function () {
    if (this.phase !== 'playing') return;
    if (!this.door.open) return;
    var body = { pos: this.player.pos, size: this.player.size };
    var box = SD.Physics.aabbOf(body);
    var t = this.geom.door.trigger;
    if (SD.Physics.overlaps(box, t, 0)) {
      this.phase = 'complete';
      this.emit('exit', { level: this.level.id, time: C.round(this.time, 2) });
    }
  };

  // ------------------------------------------------------------- observation
  Sim.prototype.status = function () {
    var p = this.player;
    return {
      levelId: this.level.id,
      kind: this.level.kind,
      phase: this.phase,
      time: C.round(this.time, 2),
      player: {
        pos: { x: C.round(p.pos.x, 3), y: C.round(p.pos.y, 3), z: C.round(p.pos.z, 3) },
        vel: { x: C.round(p.vel.x, 2), y: C.round(p.vel.y, 2), z: C.round(p.vel.z, 2) },
        yaw: C.round(p.yaw, 3), pitch: C.round(p.pitch, 3),
        onGround: p.onGround, speed: C.round(p.speed(), 2)
      },
      portals: {
        blue: this.portals.slots.blue ? { active: true, solidId: this.portals.slots.blue.solidId, normal: this.portals.slots.blue.normal } : { active: false },
        orange: this.portals.slots.orange ? { active: true, solidId: this.portals.slots.orange.solidId, normal: this.portals.slots.orange.normal } : { active: false },
        pair: this.portals.activeCount() === 2,
        reason: this.portals.reason
      },
      held: this.held ? { id: this.held.id, label: this.held.label } : null,
      cubes: this.cubes.map(function (c) {
        return { id: c.id, label: c.label, correct: c.correct, held: c.held,
          pos: { x: C.round(c.pos.x, 2), y: C.round(c.pos.y, 2), z: C.round(c.pos.z, 2) } };
      }),
      plates: this.plates.map(function (p) {
        return { id: p.id, satisfied: p.satisfied, occupantId: p.occupantId, number: p.number,
          seen: p.seen || { id: null, y: null } };
      }),
      door: {
        open: this.door.open, progress: C.round(this.door.progress, 2),
        satisfied: this.door.satisfied, required: this.door.required,
        unlocked: this.door.unlocked,
        threshold: this.geom.door.threshold ? { occupied: this.geom.door.threshold.occupied } : null
      },
      stats: this.stats,
      lastTravel: this.lastTravel,
      terminalOpen: this.terminalOpen ? this.terminalOpen.id : null
    };
  };

  SD.Sim = {
    create: function (payload, levelIndex, opts) { return new Sim(payload, levelIndex, opts); },
    Sim: Sim,
    STEP: STEP,
    REACH: REACH
  };
})(typeof window !== 'undefined' ? (window.SD = window.SD || {}) : (globalThis.SD = globalThis.SD || {}));
