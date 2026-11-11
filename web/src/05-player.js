/* SOURCE DRIVE - first-person player controller (physics only, no renderer). */
(function (SD) {
  'use strict';
  var C = SD.Core;

  var SIZE = { x: 0.64, y: 1.75, z: 0.64 };
  var EYE = 1.62;
  var WALK = 4.6;
  var GROUND_ACCEL = 55;
  var AIR_ACCEL = 16;
  var GROUND_FRICTION = 11;
  var GRAVITY = 18;
  var JUMP_SPEED = 6.1;
  var MAX_FALL = 40;
  var COYOTE = 0.1;

  function Player(world, portals, spawn) {
    this.world = world;
    this.portals = portals;
    this.size = { x: SIZE.x, y: SIZE.y, z: SIZE.z };
    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.onGround = false;
    this.yaw = 0;
    this.pitch = 0;
    this.airTime = 0;
    this.groundTime = 0;
    this.bob = 0;
    this.travelled = null;
    this.lastGroundY = 0;
    this.setSpawn(spawn || { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  }

  Player.prototype.setSpawn = function (spawn) {
    this.spawn = { x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw || 0, pitch: spawn.pitch || 0 };
    this.respawn();
  };

  Player.prototype.respawn = function () {
    this.pos = { x: this.spawn.x, y: this.spawn.y, z: this.spawn.z };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = this.spawn.yaw;
    this.pitch = this.spawn.pitch;
    this.onGround = false;
    this.airTime = 0;
    this.groundTime = 0;
    this.travelled = null;
    this._portal = null;
  };

  Player.prototype.eye = function () {
    return { x: this.pos.x, y: this.pos.y + EYE, z: this.pos.z };
  };

  Player.prototype.forward = function () {
    var cp = Math.cos(this.pitch);
    return { x: Math.sin(this.yaw) * cp, y: Math.sin(this.pitch), z: Math.cos(this.yaw) * cp };
  };

  Player.prototype.aimPoint = function (distance) {
    var f = this.forward();
    var e = this.eye();
    var d = distance || 40;
    return { x: e.x + f.x * d, y: e.y + f.y * d, z: e.z + f.z * d };
  };

  Player.prototype.speed = function () {
    return Math.sqrt(this.vel.x * this.vel.x + this.vel.y * this.vel.y + this.vel.z * this.vel.z);
  };

  Player.prototype.look = function (dYaw, dPitch) {
    this.yaw += dYaw;
    this.pitch = C.clamp(this.pitch + dPitch, -1.5533, 1.5533);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  };

  /* One fixed physics step. Input is the real held-key state. */
  Player.prototype.step = function (dt, input) {
    var res = { jumped: false, landed: false, travelled: null, hitWall: false };
    var inX = input.moveX || 0;
    var inZ = input.moveZ || 0;

    // Wish direction in world space from yaw only (pitch never changes speed).
    // forward = (sin yaw, 0, cos yaw). The camera is built with
    // rotation.y = yaw + PI, so screen-right is (-cos yaw, 0, sin yaw); inX is
    // +1 for D and must be applied along *that* vector, not along +X.
    var sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
    var wishX = sinY * inZ - cosY * inX;
    var wishZ = cosY * inZ + sinY * inX;
    var wishLen = Math.sqrt(wishX * wishX + wishZ * wishZ);
    if (wishLen > 1e-4) { wishX /= wishLen; wishZ /= wishLen; }
    var wishMag = Math.min(1, wishLen);

    var accel = this.onGround ? GROUND_ACCEL : AIR_ACCEL;
    if (wishMag > 0) {
      this.vel.x += wishX * accel * dt * wishMag;
      this.vel.z += wishZ * accel * dt * wishMag;
    }
    // ground friction
    if (this.onGround) {
      var damp = Math.max(0, 1 - GROUND_FRICTION * dt);
      this.vel.x *= damp;
      this.vel.z *= damp;
    }
    // Horizontal speed cap. On the ground it is the walk speed. In the air the
    // cap is whatever speed the body left the ground with, so a fling carries
    // through untouched but air control cannot accelerate you past a jump.
    var hs = Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
    if (this.onGround) {
      this.airCap = Math.max(WALK, hs);
      if (hs > WALK) {
        this.vel.x = this.vel.x / hs * WALK;
        this.vel.z = this.vel.z / hs * WALK;
        hs = WALK;
      }
    } else {
      var cap = this.airCap === undefined ? WALK : Math.max(WALK, this.airCap);
      if (hs > cap) {
        this.vel.x = this.vel.x / hs * cap;
        this.vel.z = this.vel.z / hs * cap;
        hs = cap;
      }
    }

    // jump
    if (input.jumpPressed && (this.onGround || this.groundTime < COYOTE)) {
      this.vel.y = JUMP_SPEED;
      this.onGround = false;
      this.groundTime = COYOTE; // consume the coyote window
      res.jumped = true;
    }

    this.vel.y -= GRAVITY * dt;
    if (this.vel.y < -MAX_FALL) this.vel.y = -MAX_FALL;

    var before = { x: this.pos.x, y: this.pos.y, z: this.pos.z };
    var wasGround = this.onGround;
    var move = this.world.moveBody(this, { x: this.vel.x * dt, y: this.vel.y * dt, z: this.vel.z * dt });
    res.hitWall = move.hitX || move.hitZ;

    if (this.onGround) {
      this.airTime = 0;
      this.groundTime = 0;
      this.lastGroundY = this.pos.y;
      if (!wasGround) res.landed = true;
    } else {
      this.airTime += dt;
      this.groundTime += dt;
    }

    // Portal crossing is checked after integration, as portal64 does.
    var travel = this.portals ? this.portals.traverse(this, dt) : null;
    if (travel) {
      // Re-derive the view from the transformed forward vector.
      var f = this.forward();
      var nf = this.portals.transformDirection(travel.fromPortal, f);
      this.yaw = Math.atan2(nf.x, nf.z);
      this.pitch = C.clamp(Math.asin(C.clamp(nf.y, -1, 1)), -1.5533, 1.5533);
      this.onGround = false;
      // carry the launched speed: the air cap must not eat a fling
      this.airCap = Math.max(WALK, travel.exitSpeed);
      res.travelled = travel;
      this.travelled = travel;
    }

    // Head bob is presentation only; kept here so renderer stays dumb.
    if (this.onGround && hs > 0.6) this.bob += dt * hs * 2.1;
    else this.bob += dt * 0.6;

    if (this.pos.y < (this.world.killY === undefined ? -30 : this.world.killY)) {
      this.respawn();
      res.fell = true;
    }

    res.moved = Math.abs(this.pos.x - before.x) + Math.abs(this.pos.y - before.y) + Math.abs(this.pos.z - before.z);
    return res;
  };

  SD.Player = {
    create: function (world, portals, spawn) { return new Player(world, portals, spawn); },
    SIZE: SIZE, EYE: EYE, WALK: WALK, GRAVITY: GRAVITY, JUMP_SPEED: JUMP_SPEED
  };
})(typeof window !== 'undefined' ? (window.SD = window.SD || {}) : (globalThis.SD = globalThis.SD || {}));
