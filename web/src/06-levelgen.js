/* SOURCE DRIVE - deterministic chamber geometry.
 *
 * Everything here is plain data: AABBs, plates, cube spawns, mounts, signs.
 * The renderer turns it into meshes; the physics world and the portal manager
 * consume the same boxes. Geometry is generated from the payload's layout seed
 * and kind, so the same repository always builds the same chamber, and every
 * chamber contains at least one reachable solution:
 *
 *   movement  : floor, walls, ceiling, spawn, exit vestibule
 *   portals   : portal mounts (aperture-sized panels) plus freely portalable
 *               walls/floor; the tutorial splits the room with a barrier you
 *               can only pass by walking through a portal pair
 *   momentum  : a catwalk you leave sideways, a floor drop pad where the walk
 *               actually lands, and a launch panel whose exit throws you across
 *               a trench wider than a running jump
 *   weight    : plates, physical cubes, a door with two sliding leaves
 *
 * The momentum chamber is *sized from the physics* rather than guessed:
 *   - the drop pad sits where a walking fall crosses the floor plane,
 *   - the launch panel's height is solved from the speed the fall builds and the
 *     distance the transformed velocity has to cover,
 *   - the trench is wider than the maximum running jump.
 * web/src/05-player.js owns those constants; this file reads them, so retuning
 * the controller cannot silently produce an unsolvable room.
 */
(function (SD) {
  'use strict';
  var C = SD.Core;

  var WALL = 0.5;
  var DOOR_W = 1.8;
  var DOOR_H = 2.5;
  var VESTIBULE = 2.6;
  var PLATE_SIZE = 2.0;
  var PLATE_MIN = 1.6;
  var CUBE_SIZE = 0.62;
  var PEDESTAL_H = 0.34;
  var MAX_CUBES = 6;

  var CATWALK_W = 2.2;
  var CATWALK_LEN = 2.2;
  var STAIRS_Z = 2.4;      // fixed footprint; step count follows the height
  var ENTRY_STRIP = 1.2;
  var PANEL_W = 2.8;
  var PANEL_T = 0.4;
  var PAD_CLEAR = 1.5;     // floor between the pad aperture and the panel base
  var STRIP = 1.2;         // standing room between the panel face and the trench
  var LAND_EDGE = 0.37;    // portal exit sits this far off the panel face
  var LAND_TARGET = 1.15;  // where the fling should drop you, past the far lip
  var LAND_MIN = 0.55;     // ...and the least we will accept
  var JUMP_MARGIN = 0.5;   // trench is this much wider than a running jump

  function box(id, kind, x0, x1, y0, y1, z0, z1, opts) {
    var o = opts || {};
    var b = {
      id: id,
      kind: kind,
      aabb: {
        min: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) },
        max: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) }
      },
      portalable: !!o.portalable,
      material: o.material || 'panel',
      dynamic: !!o.dynamic,
      visible: o.visible !== false,
      trim: o.trim || null
    };
    if (o.refusal) b.refusal = o.refusal;
    if (o.tag) b.tag = o.tag;
    return b;
  }

  function addSolids(list, solid) { list.push(solid); return solid; }

  /* The movement numbers, read from the controller so the room stays honest. */
  function tuning() {
    var g = SD.Player.GRAVITY;
    var walk = SD.Player.WALK;
    var jump = SD.Player.JUMP_SPEED;
    var bodyH = SD.Player.SIZE.y;
    var halfFoot = SD.Player.SIZE.x / 2;
    var bodyHalf = bodyH / 2;
    // Longest horizontal gap a running jump can span: flight time 2v/g, plus the
    // overhang the body box allows on both lips.
    var jumpReach = 2 * walk * jump / g + 2 * halfFoot;
    return {
      g: g, walk: walk, jump: jump, bodyH: bodyH, bodyHalf: bodyHalf,
      halfFoot: halfFoot, jumpReach: jumpReach
    };
  }

  function build(level) {
    var P = SD.Payload.requirements(level);
    var l = level.layout.length, w = level.layout.width, h = level.layout.height;
    var halfW = w / 2, halfL = l / 2;
    var rng = C.stream(level.layout.seed, 'chamber:' + level.id + ':' + level.kind);
    // The exam rooms (relay, weighbridge) drop the trench in favour of the
    // tutorial barrier: the wall between you and the cubes leaves only the
    // portal pair as a crossing, which is exactly the skill the intake taught.
    var hasChasm = level.kind !== 'portals' && level.kind !== 'relay' &&
      level.kind !== 'weighbridge';
    var solids = [];
    var signs = [];
    var mounts = [];

    var T = tuning();
    var G = T.g, WALK = T.walk, BODY_HALF = T.bodyHalf, HALF_FOOT = T.halfFoot;
    var STEP_ASSIST = 0.52;

    var zDoor = halfL;
    var zVestEnd = zDoor + VESTIBULE;

    // ---- heights -------------------------------------------------------
    // Head-room over the catwalk, then the panel: as tall as the chamber
    // allows, because exit height is what turns a fall into distance.
    var catwalkY = C.clamp(h - 2.8, 2.3, 3.6);
    var panelH = Math.min(h - 0.5, 4.8);
    var apertureH = SD.Portals.HEIGHT;
    var mountMax = panelH - apertureH / 2 - 0.05;    // aperture top under the panel top
    var exitMax = mountMax - BODY_HALF;
    var stairCount = Math.max(4, Math.ceil(catwalkY / (STEP_ASSIST - 0.06)));
    var stairRun = STAIRS_Z / stairCount;
    var rise = catwalkY / stairCount;

    // ---- z plan: near side ---------------------------------------------
    var cwX0 = -halfW + 0.05;
    var cwX1 = -halfW + CATWALK_W;
    var cwZ0 = -halfL + ENTRY_STRIP + STAIRS_Z;
    var cwZ1 = cwZ0 + CATWALK_LEN;
    var padY = 0.02;
    var padZ = cwZ1 - 0.45;                    // a body standing at the rail
    // A walking body leaves the +X lip with up to half a foot of overhang and
    // keeps walking while it falls. This is where its centre crosses y = 0.
    var dropDrift = HALF_FOOT + WALK * Math.sqrt(2 * (catwalkY + BODY_HALF) / G);
    var padX = cwX1 + dropDrift;
    var fallSpeed = Math.sqrt(2 * G * (catwalkY + BODY_HALF));

    // The launch panel stands off the room's centre line so the entrance view
    // keeps the catwalk, the drop pad and the trench in shot; the fling leaves
    // it drifting back toward the middle of the far hall.
    var panelX = Math.min(2.6, halfW - PANEL_W / 2 - 0.6);
    var panelX0 = panelX - PANEL_W / 2, panelX1 = panelX + PANEL_W / 2;
    var panelZ0 = padZ + apertureH / 2 + PAD_CLEAR;
    var panelZ1 = panelZ0 + PANEL_T;
    var chasmZ0 = panelZ1 + STRIP;
    var exitZ = panelZ1 + LAND_EDGE;

    // ---- trench --------------------------------------------------------
    // Wider than the longest running jump, and the fling has to clear it.
    var gapWanted = T.jumpReach + JUMP_MARGIN;
    var gapFloor = T.jumpReach + 0.2;
    // Solve the launch height that lands the body LAND_TARGET past the far lip.
    // The exit sits a little *behind* the near lip, so the reach is measured
    // from there: lip - exit = (chasmZ0 - exitZ) + gap.
    var wantReach = (chasmZ0 - exitZ) + gapWanted + LAND_TARGET;
    var exitFeet = (wantReach * wantReach * G) / (2 * fallSpeed * fallSpeed);
    exitFeet = C.clamp(exitFeet, 0.55, exitMax);
    var mountY = exitFeet + BODY_HALF;
    var flingReach = fallSpeed * Math.sqrt(2 * exitFeet / G);

    // ---- z plan: far side ----------------------------------------------
    // Budget the far hall from where the body actually lands to the door. The
    // trench may give up width (never below the jump limit) before the chamber
    // loses its puzzle; the plate may shrink before the walkway disappears.
    var gap = gapWanted;
    var plateSize = PLATE_SIZE;
    var approach = 1.0;
    var landingZ = 0;
    var zCubes = 0;
    var zPlate = 0;
    var fits = false;
    for (var attempt = 0; attempt < 8 && hasChasm && !fits; attempt++) {
      landingZ = exitZ + flingReach;
      var margin = landingZ - (chasmZ0 + gap);
      if (margin < LAND_MIN) {
        gap = Math.max(gapFloor, gap - (LAND_MIN - margin));
        continue;
      }
      zCubes = landingZ + 1.0;                        // pedestal row starts clear of the body
      zPlate = zDoor - approach - plateSize / 2;
      fits = (zCubes + 0.55 + 0.9) <= (zPlate - plateSize / 2);
      if (!fits) {
        if (plateSize > PLATE_MIN) plateSize = PLATE_MIN;
        else if (approach > 0.85) approach = 0.85;
        else gap = Math.max(gapFloor, gap - 0.2);
      }
    }
    if (!hasChasm) {
      gap = 0;
      // The exam rooms land the portal exit just inside the screen's south
      // face; keep the cube plinths between the barrier and that band, clear
      // of both, so a walk-in portal never spawns the player on a pedestal.
      zCubes = (level.kind === 'relay' || level.kind === 'weighbridge')
        ? zDoor - 6.4
        : zDoor - 5.6;
      zPlate = zDoor - 2.2;
      landingZ = 0;
    }
    var chasmZ1 = chasmZ0 + gap;

    // ------------------------------------------------------------ shell
    if (hasChasm) {
      addSolids(solids, box('floor-a', 'floor', -halfW, halfW, -0.5, 0, -halfL - WALL, chasmZ0,
        { portalable: true, material: 'floor' }));
      addSolids(solids, box('floor-b', 'floor', -halfW, halfW, -0.5, 0, chasmZ1, zVestEnd + WALL,
        { portalable: true, material: 'floor' }));
      addSolids(solids, box('chasm-near', 'pitwall', -halfW, halfW, -3.2, 0, chasmZ0 - 0.45, chasmZ0,
        { material: 'trim' }));
      addSolids(solids, box('chasm-far', 'pitwall', -halfW, halfW, -3.2, 0, chasmZ1, chasmZ1 + 0.45,
        { material: 'trim' }));
      addSolids(solids, box('chasm-bottom', 'pitfloor', -halfW, halfW, -3.7, -3.2, chasmZ0, chasmZ1,
        { material: 'void' }));
    } else {
      addSolids(solids, box('floor-a', 'floor', -halfW, halfW, -0.5, 0, -halfL - WALL, zVestEnd + WALL,
        { portalable: true, material: 'floor' }));
    }

    addSolids(solids, box('wall-x0', 'wall', -halfW - WALL, -halfW, -0.5, h, -halfL - WALL, zVestEnd + WALL,
      { portalable: true, material: 'wall' }));
    addSolids(solids, box('wall-x1', 'wall', halfW, halfW + WALL, -0.5, h, -halfL - WALL, zVestEnd + WALL,
      { portalable: true, material: 'wall' }));
    addSolids(solids, box('wall-z0', 'wall', -halfW, halfW, 0, h, -halfL - WALL, -halfL,
      { portalable: true, material: 'wall' }));
    addSolids(solids, box('ceiling', 'ceiling', -halfW, halfW, h, h + WALL, -halfL - WALL, zVestEnd + WALL,
      { material: 'ceiling', visible: true }));

    var dx0 = -DOOR_W / 2, dx1 = DOOR_W / 2;
    addSolids(solids, box('wall-z1-left', 'wall', -halfW, dx0, 0, h, zDoor, zDoor + WALL,
      { portalable: false, refusal: 'The exit frame is structural.', material: 'wall' }));
    addSolids(solids, box('wall-z1-right', 'wall', dx1, halfW, 0, h, zDoor, zDoor + WALL,
      { portalable: false, refusal: 'The exit frame is structural.', material: 'wall' }));
    addSolids(solids, box('wall-z1-lintel', 'wall', dx0, dx1, DOOR_H, h, zDoor, zDoor + WALL,
      { portalable: false, refusal: 'The exit frame is structural.', material: 'wall' }));
    addSolids(solids, box('vest-end', 'wall', -halfW, halfW, 0, h, zVestEnd, zVestEnd + WALL,
      { material: 'wall-bright' }));
    // the vestibule cheeks are the side walls, continued to zVestEnd

    // ------------------------------------------------------------ exit door
    var leafT = 0.22;
    var leafW = DOOR_W / 2;
    var doorZ = zDoor - leafT - 0.02;
    var leaves = [
      { id: 'door-leaf-left', side: -1, closed: { x0: -leafW, x1: 0 }, open: { x0: -leafW * 2, x1: -leafW } },
      { id: 'door-leaf-right', side: 1, closed: { x0: 0, x1: leafW }, open: { x0: leafW, x1: leafW * 2 } }
    ];
    var doorSolids = leaves.map(function (leaf) {
      return addSolids(solids, box(leaf.id, 'door', leaf.closed.x0, leaf.closed.x1, 0, DOOR_H, doorZ, doorZ + leafT,
        { material: 'door', dynamic: true, refusal: 'The door leaves are not portal surfaces.', trim: 'accent' }));
    });
    var door = {
      id: 'exit-door',
      zPlane: doorZ,
      width: DOOR_W,
      height: DOOR_H,
      base: 0,
      leaves: doorSolids,
      leafSpec: leaves,
      open: false,
      progress: 0,
      centre: { x: 0, y: DOOR_H / 2, z: doorZ },
      trigger: {
        min: { x: dx0 + 0.15, y: 0, z: zDoor + 0.9 },
        max: { x: dx1 - 0.15, y: DOOR_H, z: zVestEnd - 0.35 }
      },
      required: P.plateCount,
      status: 'locked'
    };

    // ------------------------------------------------------------ portal mounts
    // A mount is a *region on a real surface*: aiming anywhere inside it lands
    // the portal on its centre, so the designed puzzle is reproducible from a
    // rough aim. The renderer draws the panel from this record; nothing here is
    // a phantom collider.
    function mount(spec) {
      var surface = null;
      for (var i = 0; i < solids.length; i++) if (solids[i].id === spec.surfaceId) surface = solids[i];
      if (!surface) throw new Error('mount ' + spec.id + ' has no surface ' + spec.surfaceId);
      var n = spec.normal;
      // Flat mounts are laid with their long axis along the room (world Z), the
      // same convention PortalManager.surfaceFrame uses, so a fall drifts along
      // the aperture's *short* axis - the one the level generator solved for.
      var up = spec.up || (Math.abs(n.y) > 0.9 ? { x: 0, y: 0, z: -1 } : { x: 0, y: 1, z: 0 });
      var frame = C.frameFromNormal(spec.centre, n, up);
      var region = {
        min: { x: spec.centre.x, y: spec.centre.y, z: spec.centre.z },
        max: { x: spec.centre.x, y: spec.centre.y, z: spec.centre.z }
      };
      // The aperture, projected onto the world axes, plus a hand's width of aim
      // slack on the two tangent axes.
      var axes = [frame.x, frame.y];
      var halfs = [SD.Portals.WIDTH / 2, SD.Portals.HEIGHT / 2];
      for (var a = 0; a < 2; a++) {
        var ax = axes[a], half = halfs[a];
        region.min.x = Math.min(region.min.x, spec.centre.x + ax.x * half);
        region.max.x = Math.max(region.max.x, spec.centre.x + ax.x * half);
        region.min.y = Math.min(region.min.y, spec.centre.y + ax.y * half);
        region.max.y = Math.max(region.max.y, spec.centre.y + ax.y * half);
        region.min.z = Math.min(region.min.z, spec.centre.z + ax.z * half);
        region.max.z = Math.max(region.max.z, spec.centre.z + ax.z * half);
      }
      var slack = 0.5;
      for (var ax2 = 0; ax2 < 2; ax2++) {
        var v = axes[ax2];
        if (Math.abs(v.x) > 0.5) { region.min.x -= slack; region.max.x += slack; }
        if (Math.abs(v.y) > 0.5) { region.min.y -= slack; region.max.y += slack; }
        if (Math.abs(v.z) > 0.5) { region.min.z -= slack; region.max.z += slack; }
      }
      // ...and the surface's own thickness so the ray cannot slip past the face.
      if (Math.abs(n.x) > 0.9) { region.min.x -= 0.12; region.max.x += 0.12; }
      if (Math.abs(n.y) > 0.9) { region.min.y -= 0.12; region.max.y += 0.12; }
      if (Math.abs(n.z) > 0.9) { region.min.z -= 0.12; region.max.z += 0.12; }

      var rec = {
        id: spec.id, label: spec.label, hint: spec.hint || '',
        centre: { x: spec.centre.x, y: spec.centre.y, z: spec.centre.z },
        normal: n, up: up, surfaceId: spec.surfaceId, region: region, frame: frame
      };
      if (!surface.mounts) surface.mounts = [];
      surface.mounts.push(rec);
      mounts.push(rec);
      signs.push({
        id: 'sign-' + spec.id, text: spec.label,
        pos: {
          x: spec.centre.x + frame.y.x * (halfs[1] + 0.34),
          y: spec.centre.y + frame.y.y * (halfs[1] + 0.34),
          z: spec.centre.z + frame.y.z * (halfs[1] + 0.34)
        },
        facing: n, size: 0.34, style: 'panel'
      });
      return rec;
    }

    // ------------------------------------------------------------ tutorial barrier
    var barrierZ = zDoor - 8.0;
    if (!hasChasm) {
      var slotY0 = 1.45, slotY1 = 3.05, slotX0 = -3.0, slotX1 = 3.0;
      addSolids(solids, box('barrier', 'barrier', -halfW, halfW, 0, slotY0, barrierZ, barrierZ + 0.6,
        { material: 'barrier' }));
      addSolids(solids, box('barrier-top', 'barrier', -halfW, halfW, slotY1, h, barrierZ, barrierZ + 0.6,
        { material: 'barrier' }));
      addSolids(solids, box('barrier-left', 'barrier', -halfW, slotX0, slotY0, slotY1, barrierZ, barrierZ + 0.6,
        { material: 'barrier' }));
      addSolids(solids, box('barrier-right', 'barrier', slotX1, halfW, slotY0, slotY1, barrierZ, barrierZ + 0.6,
        { material: 'barrier' }));

      var screenZ = barrierZ + 3.4;
      var screenW = Math.min(9.0, w - 2.0);
      addSolids(solids, box('screen-wall', 'screen', -screenW / 2, screenW / 2, 0, Math.min(4.4, h - 0.6),
        screenZ, screenZ + 0.5, { portalable: true, material: 'mount' }));
      signs.push({
        id: 'sign-screen', text: 'PORTAL SURFACE',
        pos: { x: 0, y: Math.min(4.4, h - 0.6) + 0.4, z: screenZ - 0.26 },
        facing: { x: 0, y: 0, z: -1 }, size: 0.42, style: 'panel'
      });
      mount({
        id: 'mount-near', label: 'PORTAL', hint: 'shoot the near wall',
        centre: { x: -halfW, y: 1.55, z: barrierZ - 1.5 }, normal: { x: 1, y: 0, z: 0 },
        surfaceId: 'wall-x0'
      });
      signs.push({
        id: 'sign-slot', text: 'NO DOOR. ONLY THE PAIR.',
        pos: { x: 0, y: slotY1 + 0.45, z: barrierZ - 0.32 },
        facing: { x: 0, y: 0, z: -1 }, size: 0.5, style: 'chamber'
      });
    }

    // ------------------------------------------------------------ momentum kit
    var chasm = null;
    if (hasChasm) {
      chasm = {
        z0: chasmZ0, z1: chasmZ1, width: C.round(gap, 2), depth: 3.2,
        recovery: {
          min: { x: -halfW, y: -5.2, z: chasmZ0 },
          max: { x: halfW, y: -0.7, z: chasmZ1 }
        }
      };

      for (var s = 0; s < stairCount; s++) {
        var z0 = -halfL + ENTRY_STRIP + s * stairRun;
        addSolids(solids, box('stair-' + s, 'stair', cwX0, cwX1, 0, rise * (s + 1), z0, z0 + stairRun,
          { material: 'stair', portalable: false, refusal: 'Steps are too small to hold an aperture.' }));
      }
      addSolids(solids, box('catwalk', 'catwalk', cwX0, cwX1, catwalkY - 0.22, catwalkY, cwZ0, cwZ1,
        { material: 'catwalk', portalable: false, refusal: 'The catwalk grating will not hold an aperture.' }));
      addSolids(solids, box('catwalk-rail', 'rail', cwX0, cwX1, catwalkY, catwalkY + 1.0,
        cwZ1 - 0.09, cwZ1, { material: 'rail' }));
      // The +X side is railed except at the drop notch, which is where the pad
      // below is reachable. The notch is a little wider than the aperture so a
      // player who lines up with the lit pad cannot miss it.
      var notchHalf = 0.85;
      addSolids(solids, box('catwalk-edge-a', 'rail', cwX1 - 0.08, cwX1, catwalkY, catwalkY + 1.0,
        cwZ0, padZ - notchHalf, { material: 'rail' }));
      addSolids(solids, box('catwalk-edge-b', 'rail', cwX1 - 0.08, cwX1, catwalkY, catwalkY + 1.0,
        padZ + notchHalf, cwZ1 - 0.09, { material: 'rail' }));
      signs.push({
        id: 'sign-drop', text: 'DROP',
        pos: { x: cwX1 + 0.06, y: catwalkY + 1.15, z: padZ },
        facing: { x: 1, y: 0, z: 0 }, size: 0.28, style: 'panel'
      });

      mount({
        id: 'mount-pad', label: 'DROP ZONE', hint: 'floor portal - the walk lands here',
        centre: { x: padX, y: padY, z: padZ }, normal: { x: 0, y: 1, z: 0 },
        surfaceId: 'floor-a'
      });

      addSolids(solids, box('portal-panel', 'panel', panelX0, panelX1, 0, panelH, panelZ0, panelZ1,
        { portalable: true, material: 'mount' }));
      mount({
        id: 'mount-panel', label: 'LAUNCH PANEL', hint: 'wall portal - shoot it from the strip',
        centre: { x: (panelX0 + panelX1) / 2, y: mountY, z: panelZ1 }, normal: { x: 0, y: 0, z: 1 },
        surfaceId: 'portal-panel'
      });
      signs.push({
        id: 'sign-chasm', text: C.fmtNum(gap, 1) + ' m TRENCH',
        pos: { x: (panelX0 + panelX1) / 2, y: 0.55, z: chasmZ0 - 0.02 },
        facing: { x: 0, y: 0, z: -1 }, size: 0.38, style: 'warn'
      });
      signs.push({
        id: 'sign-launch', text: 'THROWN, NOT CLIMBED',
        pos: { x: (panelX0 + panelX1) / 2, y: 2.6, z: chasmZ1 + 0.06 },
        facing: { x: 0, y: 0, z: -1 }, size: 0.34, style: 'warn'
      });
    }

    // ---- the weighbridge floor plate ------------------------------------
    // The exam room's new rule: the door only swings while the player stands
    // on the plate in front of it. The cube set alone is not enough.
    if (level.kind === 'weighbridge') {
      var thrBox = box('door-threshold', 'plate', -1.15, 1.15, 0, 0.12,
        doorZ - 1.15, doorZ - 0.3,
        { material: 'plate', portalable: false, refusal: 'The door plate is not a portal surface.' });
      addSolids(solids, thrBox);
      door.threshold = {
        aabb: thrBox.aabb,
        centre: { x: 0, y: 0.12, z: (doorZ - 1.15 + doorZ - 0.3) / 2 },
        occupied: false, label: 'DOOR PLATE'
      };
      signs.push({
        id: 'sign-threshold', text: 'DOOR PLATE',
        pos: { x: 0, y: 0.74, z: doorZ - 1.45 },
        facing: { x: 0, y: 0, z: -1 }, size: 0.3, style: 'plate'
      });
    }

    // ------------------------------------------------------------ cubes
    var cubesInPlay = level.cubes.slice(0);
    if (cubesInPlay.length > MAX_CUBES) {
      var keepCorrect = cubesInPlay.filter(function (c) { return c.correct; });
      var keepWrong = cubesInPlay.filter(function (c) { return !c.correct; });
      cubesInPlay = keepCorrect.concat(keepWrong).slice(0, MAX_CUBES);
    }
    var cubeRows = cubesInPlay.length;
    var spacing = Math.min(2.6, (w - 3.0) / Math.max(1, cubeRows));
    var startX = -(spacing * (cubeRows - 1)) / 2;
    var pedestals = [];
    var cubes = cubesInPlay.map(function (c, i) {
      var px = startX + spacing * i;
      var ped = box('pedestal-' + i, 'pedestal', px - 0.55, px + 0.55, 0, PEDESTAL_H, zCubes - 0.55, zCubes + 0.55,
        { material: 'pedestal', portalable: false, refusal: 'The plinth is too small to hold an aperture.' });
      addSolids(solids, ped);
      pedestals.push(ped);
      return {
        id: c.id, label: c.label, correct: c.correct, reason: c.reason,
        evidenceIds: c.evidenceIds, size: CUBE_SIZE,
        spawn: { x: px, y: PEDESTAL_H + 0.001, z: zCubes },
        pedestalId: ped.id
      };
    });

    // ------------------------------------------------------------ plates
    var plates = [];
    var plateCount = P.hasCubes ? P.plateCount : 0;
    var plateSpacing = Math.min(3.0, (w - 4.0) / Math.max(1, plateCount));
    for (var pi = 0; pi < plateCount; pi++) {
      var pxp = -(plateSpacing * (plateCount - 1)) / 2 + plateSpacing * pi;
      var pad = box('plate-' + pi, 'plate', pxp - plateSize / 2, pxp + plateSize / 2, 0, 0.12,
        zPlate - plateSize / 2, zPlate + plateSize / 2,
        { material: 'plate', portalable: false, refusal: 'The plate housing is not a portal surface.' });
      addSolids(solids, pad);
      plates.push({
        id: 'plate-' + pi, number: pi + 1, aabb: pad.aabb,
        centre: { x: pxp, y: 0.12, z: zPlate },
        accepts: P.requiredCubeIds.slice(0), weight: 0,
        satisfied: false, occupantId: null, label: 'PLATE ' + (pi + 1)
      });
      signs.push({
        id: 'sign-plate-' + pi, text: 'PLATE ' + (pi + 1),
        pos: { x: pxp, y: 0.95, z: zPlate + plateSize / 2 + 0.06 },
        facing: { x: 0, y: 0, z: 1 }, size: 0.3, style: 'plate'
      });
    }

    // ------------------------------------------------------------ terminals
    var terminals = [];
    function terminal(id, title, evidenceIds, pos, facing, prompt) {
      var halfWide = 0.9, halfThick = 0.15;
      var cx = pos.x + facing.x * halfThick;
      var cz = pos.z + facing.z * halfThick;
      var x0 = Math.abs(facing.x) > 0.5 ? cx - halfThick : cx - halfWide;
      var x1 = Math.abs(facing.x) > 0.5 ? cx + halfThick : cx + halfWide;
      var z0 = Math.abs(facing.z) > 0.5 ? cz - halfThick : cz - halfWide;
      var z1 = Math.abs(facing.z) > 0.5 ? cz + halfThick : cz + halfWide;
      var t = addSolids(solids, box(id + '-body', 'terminal', x0, x1, pos.y - 0.8, pos.y + 0.8, z0, z1,
        { material: 'terminal', portalable: false, refusal: 'The terminal housing will not hold an aperture.' }));
      terminals.push({
        id: id, title: title, evidenceIds: evidenceIds, solidId: t.id,
        pos: { x: cx, y: pos.y, z: cz }, facing: facing, prompt: prompt,
        screen: { x: cx + facing.x * 0.03, y: pos.y, z: cz + facing.z * 0.03 },
        stand: { x: cx + facing.x * 1.6, y: 0.02, z: cz + facing.z * 1.6 }
      });
      signs.push({
        id: 'sign-' + id, text: title,
        pos: { x: cx + facing.x * 0.05, y: pos.y + 1.02, z: cz + facing.z * 0.05 },
        facing: facing, size: 0.3, style: 'panel'
      });
      return t;
    }

    terminal('terminal-brief', 'BRIEF', [], { x: halfW - 0.02, y: 1.55, z: -halfL + 2.6 },
      { x: -1, y: 0, z: 0 }, 'read the chamber brief');
    var evidenceTermZ = hasChasm ? zCubes + 1.5 : barrierZ + 1.6;
    terminal('terminal-evidence', 'EVIDENCE', level.evidence.map(function (e) { return e.id; }),
      { x: halfW - 0.02, y: 1.55, z: evidenceTermZ }, { x: -1, y: 0, z: 0 }, 'read the evidence');

    // ------------------------------------------------------------ signs / landmarks
    signs.push({
      id: 'sign-title', text: level.title, pos: { x: 0, y: DOOR_H + 1.65, z: zDoor - 0.28 },
      facing: { x: 0, y: 0, z: -1 }, size: 0.62, style: 'chamber'
    });
    signs.push({
      id: 'sign-exit', text: 'EXIT', pos: { x: 0, y: DOOR_H + 0.6, z: zDoor - 0.3 },
      facing: { x: 0, y: 0, z: -1 }, width: 3.2, height: 0.8, style: 'exit'
    });
    // A physical forward cue on the entrance-facing structure, not an x-ray
    // label. The actual doorway marker remains on its lintel beyond the puzzle.
    signs.push({
      id: 'sign-exit-approach', text: 'EXIT AHEAD',
      pos: hasChasm ? { x: panelX, y: panelH - 0.65, z: panelZ0 - 0.02 }
        : { x: 0, y: 0.85, z: barrierZ - 0.02 },
      facing: { x: 0, y: 0, z: -1 }, width: 2.8, height: 0.7, style: 'exit'
    });
    signs.push({
      id: 'sign-entry', text: level.objective, pos: { x: 0, y: 2.9, z: -halfL + 0.02 },
      facing: { x: 0, y: 0, z: 1 }, size: 0.36, style: 'chamber'
    });
    signs.push({
      id: 'sign-vest', text: 'CHAMBER CLEAR', pos: { x: 0, y: 2.4, z: zVestEnd - 0.02 },
      facing: { x: 0, y: 0, z: -1 }, size: 0.5, style: 'exit'
    });

    var numerals = ['01', '02', '03'];
    var numSpan = Math.max(2.0, (l - 10) / 3);
    for (var ni = 0; ni < numerals.length; ni++) {
      var jitter = (rng() - 0.5) * 0.9;
      signs.push({
        id: 'sign-numeral-' + ni, text: numerals[ni],
        pos: { x: halfW - 0.02, y: h * 0.62, z: -halfL + 5.0 + jitter + ni * numSpan },
        facing: { x: -1, y: 0, z: 0 }, size: 1.5, style: 'numeral'
      });
    }

    // ------------------------------------------------------------ spawn
    var spawnX = hasChasm ? 1.8 : 0;
    var spawnZ = -halfL + 1.5;
    var spawn = {
      x: spawnX, y: 0.02, z: spawnZ,
      yaw: Math.atan2(-spawnX, zDoor - spawnZ) || 0,
      pitch: 0
    };
    if (!hasChasm) spawn.yaw = 0;

    var bounds = {
      min: { x: -halfW, y: -4.0, z: -halfL },
      max: { x: halfW, y: h, z: zVestEnd }
    };

    return {
      id: level.id, kind: level.kind, title: level.title, objective: level.objective,
      subject: level.subject, seed: level.layout.seed, layout: level.layout,
      bounds: bounds, spawn: spawn, farY: 0,
      solids: solids, cubes: cubes, pedestals: pedestals, plates: plates,
      door: door, terminals: terminals, mounts: mounts, signs: signs, chasm: chasm,
      plan: {
        catwalkY: C.round(catwalkY, 2), stairCount: stairCount,
        mountY: C.round(mountY, 2), exitFeet: C.round(exitFeet, 2),
        fallSpeed: C.round(fallSpeed, 2), flingReach: C.round(flingReach, 2),
        exitZ: C.round(exitZ, 3),
        dropDrift: C.round(dropDrift, 2), gap: C.round(gap, 2),
        landingZ: C.round(landingZ, 2), plateSize: C.round(plateSize, 2),
        jumpReach: C.round(T.jumpReach, 2), fits: fits
      },
      zones: {
        door: { zPlane: zDoor, vestEnd: zVestEnd },
        cubeRow: { z: zCubes },
        plates: { z: zPlate },
        catwalk: hasChasm ? { x0: cwX0, x1: cwX1, y: catwalkY, z0: cwZ0, z1: cwZ1 } : null,
        stairs: hasChasm ? { x0: cwX0, x1: cwX1, z0: -halfL + ENTRY_STRIP, z1: cwZ0, steps: stairCount } : null,
        pad: hasChasm ? { x: padX, y: padY, z: padZ } : null,
        drop: hasChasm ? { x: cwX1, z: padZ } : null,
        notch: hasChasm ? { z: padZ, half: 0.85 } : null,
        panel: hasChasm ? { x0: panelX0, x1: panelX1, z0: panelZ0, z1: panelZ1, face: panelZ1, height: panelH } : null,
        barrier: hasChasm ? null : { z: barrierZ, screenZ: barrierZ + 3.4 }
      },
      requirements: P,
      theme: {
        floor: 0x2a2f3a, wall: 0xdfd8c8, ceiling: 0x1d2027, trim: 0x11141a,
        accent: 0xffc65c, blue: 0x3fa9ff, orange: 0xff8a3d, danger: 0xff5a5a,
        metal: 0x8f9296, grate: 0x4a5058, pit: 0x11141c
      }
    };
  }

  function applyDoorProgress(level, t) {
    var p = C.clamp(t, 0, 1);
    level.door.progress = p;
    for (var i = 0; i < level.door.leaves.length; i++) {
      var solid = level.door.leaves[i];
      var spec = level.door.leafSpec[i];
      var x0 = C.lerp(spec.closed.x0, spec.open.x0, p);
      var x1 = C.lerp(spec.closed.x1, spec.open.x1, p);
      solid.aabb.min.x = Math.min(x0, x1);
      solid.aabb.max.x = Math.max(x0, x1);
    }
  }

  SD.LevelGen = {
    build: build,
    applyDoorProgress: applyDoorProgress,
    tuning: tuning,
    CUBE_SIZE: CUBE_SIZE,
    DOOR_W: DOOR_W,
    DOOR_H: DOOR_H,
    PLATE_SIZE: PLATE_SIZE,
    constants: {
      CATWALK_W: CATWALK_W, STRIP: STRIP, PAD_CLEAR: PAD_CLEAR,
      LAND_TARGET: LAND_TARGET, STAIRS_Z: STAIRS_Z
    }
  };
})(typeof window !== 'undefined' ? (window.SD = window.SD || {}) : (globalThis.SD = globalThis.SD || {}));
