// Knockout Physics — game loop, rules and HUD.

import * as THREE from 'three';
import { PhysicsWorld } from './sim.js';
import { Opponent, PUNCH_LABEL } from './fighter.js';
import { Player } from './player.js';
import { Referee } from './referee.js';
import { Arena } from './arena.js';
import { Sfx } from './audio.js';
import { PhysicsDebugView } from './debug.js';
import { Net, cleanName } from './net.js';
import { TouchControls, isTouchDevice } from './touch.js';

const TOUCH = isTouchDevice();
if (TOUCH) document.body.classList.add('touch');

const STEP = 1 / 240;      // physics rate
const MAX_STEPS = 16;
const ROUND_TIME = 90;
const ROUNDS = 3;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- setup
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, TOUCH ? 1.5 : 2));   // phones: lighter rendering
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07080c);
scene.fog = new THREE.Fog(0x07080c, 14, 32);
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.03, 100);

const world = new PhysicsWorld();   // Rapier: rigid bodies, joints with motors, the cage
const arena = new Arena(scene, world);
const player = new Player(world, scene);
const opp = new Opponent(world, scene, { index: 1 });
const referee = new Referee(world, scene);
const refCtx = { a: player.pos, b: opp.base, down: null, counting: false, time: 0 };
const debugView = new PhysicsDebugView(scene, world);
debugView.fighters = [opp];   // V also shows his hitboxes
const sfx = new Sfx();

const game = {
  phase: 'menu', // menu | intro | fight | knockdown | rest | over
  round: 1, timer: ROUND_TIME, difficulty: 'normal',
  time: 0, timeScale: 1, slowmo: 0, phaseT: 0,
  count: 0, countT: 0, downWho: null, getUpAt: 0,
  paused: false, overlay: false, noLock: false, vignette: 0, lagP: 100, lagO: 100, counterUntil: -1,
  stats: null,
};
const ctx = { playerPos: player.pos, playerHead: player.headPos, playerChest: player.chestPos, playerLegs: player.legPos, time: 0 };

function newStats() {
  return { thrown: 0, landed: 0, blocked: 0, dodged: 0, topSpeed: 0, topEnergy: 0, dealt: 0, taken: 0, oppThrown: 0, oppLanded: 0 };
}
game.stats = newStats();

// ---------------------------------------------------------------- contacts
// Everything is solid in the physics world (Rapier): his body parts, your gloves, kicking foot
// and head, your body, the cage. After each step it reports which strikers (gloves, fists,
// feet) touched what, how fast they met and how hard; the rules below turn that into damage.
// Hitboxes are the colliders themselves (see ragdoll.js): his are capsules sized to his body
// (the head one runs from the jaw to the back of the skull); yours are a ball where your skull
// is (moving with your eyes, so a slip or duck counts the moment you make it) and your real
// body's torso and legs.
const attackOf = (p) => p.hand?.punch || (p.kicker?.punch && p.kicker.punch.foot === p.name ? p.kicker.punch : null);
const impulse = new THREE.Vector3();
const hit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), info: null };   // the contact being handled

/** Contacts that shouldn't happen this step (they pass through each other). */
world.filter = (A, B) => {
  if (!A || !B) return true;
  const gl = A.kind === 'glove' ? A : B.kind === 'glove' ? B : null;
  const other = gl === A ? B : A;
  if (gl && other.kind === 'body' && other.owner === opp) {
    const g = gl.glove, type = g.punch?.type;
    // body hooks and kicks go around his arms unless he has dropped his guard to cover the body
    if ((type === 'bodyhook' || type === 'kick') && g.punch.phase !== 'ret' && !opp.coverLow && other.region === 'guard') return false;
    // resting gloves don't parry for you: his strikes only meet your gloves when you hold guard or are punching
    if (!g.isLeg && !player.guarding && !g.punch && (other.hand || attackOf(other))) return false;
  }
  return true;
};

const RANK = { block: 0, head: 1, body: 2, legs: 3 };
const pending = [];
/** Sort this step's contacts (a guard in the way wins over the head behind it), then apply them. */
function onContact(r) {
  const { a, b } = r;
  const flip = (x) => x === b;
  // your glove or kicking foot against him (his guard, his body, or his strike: a block)
  const gl = a.kind === 'glove' ? a : b.kind === 'glove' ? b : null;
  if (gl) {
    const o = gl === a ? b : a;
    if (o.kind === 'body' && o.owner === opp) pending.push({ rank: attackOf(o) ? 0 : 1, fn: () => { setHit(r, o, flip(o)); onGloveContact(gl.glove, o, r.speed); } });
    else if (o.kind === 'body' && o.owner === referee) pending.push({ rank: 2, fn: () => { setHit(r, o, flip(o)); onRefereeStruck(gl.glove, o, r.speed, true); } });
    return;
  }
  // his fist or kicking foot against you
  const st = a.striker && a.owner === opp ? a : b.striker && b.owner === opp ? b : null;
  if (!st) return;
  const o = st === a ? b : a;
  const slot = st.fist ? st.hand : opp.kickSlot.punch && opp.kickSlot.punch.foot === st.name ? opp.kickSlot : null;
  if (!slot) return;
  impulse.copy(r.normal).multiplyScalar(r.impulse * (st === a ? 1 : -1));
  if (o.kind === 'phead') pending.push({ rank: 1, fn: () => { setHit(r, o, flip(o)); onPlayerStruck(slot, r.speed, impulse.clone(), 'head'); } });
  else if (o.kind === 'body' && o.owner === player.body) {
    const region = o.part.startsWith('thigh') || o.part.startsWith('shin') || o.part.startsWith('foot') ? 'legs' : 'body';
    pending.push({ rank: RANK[region], fn: () => { setHit(r, o, flip(o)); onPlayerStruck(slot, r.speed, impulse.clone(), region, true); } });
  } else if (o.kind === 'body' && o.owner === referee) pending.push({ rank: 2, fn: () => { setHit(r, o, flip(o)); onRefereeStruck(slot, o, r.speed, false); } });
}
function setHit(r, info, isB) {
  hit.point.copy(r.point);
  hit.normal.copy(r.normal).multiplyScalar(isB ? 1 : -1);   // pointing into the one that was hit
  hit.info = info;
}
function flushContacts() {
  if (!pending.length) return;
  pending.sort((x, y) => x.rank - y.rank);
  for (const c of pending) c.fn();
  pending.length = 0;
}

/** A clean shot also rocks the body part it lands on (on top of the glove's own momentum). */
function rock(target, dmg) {
  if (!hit.info || !target.rig) return;
  target.rig.hit(hit.info.part, impulse.copy(hit.normal).multiplyScalar(Math.min(30, 4 + dmg * 1.1)), hit.point);
}

// Your eyes never go inside him: if your head would, your body is eased back (once per step).
const EYE_R = 0.17;
const STANDING = (m) => m === 'fight' || m === 'idle';
const _push = new THREE.Vector3();
function keepEyesOut() {
  if (!STANDING(player.mode) || !STANDING(opp.mode)) return;
  const e = player.headPos;
  for (const n of ['head', 'neck', 'chest', 'shoulderL', 'shoulderR']) {
    const q = opp.p[n];
    const dx = e.x - q.pos.x, dy = e.y - q.pos.y, dz = e.z - q.pos.z;
    const d = Math.hypot(dx, dy, dz), minD = EYE_R + q.radius;
    if (d >= minD) continue;
    const hd = Math.hypot(dx, dz) || 1e-6, pen = (minD - d) * 0.7;
    _push.set((dx / hd) * pen, 0, (dz / hd) * pen);
    player.body.rig.shift(_push);
    player.pos.add(_push);
  }
}

// ---------------------------------------------------------------- the referee
/** A strike (yours or his) landed on the referee. src: your glove / his hand or kick slot. */
function onRefereeStruck(src, info, speed, byPlayer) {
  if (referee.mode === 'down' || game.phase !== 'fight' || mp.on) return;
  const pu = src.punch;
  if (!pu || pu.refHit || speed < 1.5 || pu.phase === 'wind' || (byPlayer ? pu.done : pu.hit)) return;
  pu.refHit = true;
  if (byPlayer) pu.done = true; else pu.hit = true;   // it was spent on him
  const kick = byPlayer ? pu.type === 'kick' : pu.def.kind === 'kick';
  const power = byPlayer ? pu.power : opp.diff.power * pu.def.power;
  const v = Math.max(0, speed - 2.0) * power;
  const region = info.region === 'head' ? 'head' : 'body';
  const dmg = v * 2.3 * (region === 'head' ? 1 : 0.6) * (kick ? 1.3 : 1);
  referee.takeHit(dmg, region, { cons: region === 'head' ? dmg * 1.9 : dmg * 0.4, bal: kick ? v * 5 : 0 });
  rock(referee, dmg);
  sfx.punch(Math.min(1.4, speed / 9), region);
  const energy = 0.5 * (byPlayer ? (kick ? 6 : 3) : 3) * speed * speed;
  showImpact(byPlayer ? 'YOU HIT THE REF!' : 'HE HIT THE REF!', speed, energy);
  arena.excitement += 0.5;
  if (byPlayer) logEvent('hit', 'REF SHOT', { dmg, speed, energy });
  if (referee.health <= 0 || referee.cons <= 0) refereeKnockout(byPlayer, { speed, energy });
}

/** The referee is out cold: both fighters go down with him. No winner. */
function refereeKnockout(byPlayer, info) {
  referee.knockDown();
  for (const h of [...opp.handList, opp.kickSlot]) h.punch = null;
  player.knockDown();
  opp.knockDown();
  game.downWho = 'ref';
  game.phase = 'kowait';
  game.count = 0; game.countT = 0;
  game.slowmo = 0.6;
  ko.hitTime = game.time;
  ko.info = { name: byPlayer ? 'YOUR SHOT ON THE REF' : 'HIS SHOT ON THE REF', ...info };
  sfx.crowdCheer(1.6);
  arena.excitement = 2.5;
  banner('REFEREE DOWN!');
}

/** One of his kicks met something: it stops there and he pulls it back (no swinging on through). */
function endKick(k) {
  if (k.def.kind === 'kick' && k.phase === 'ext') k.t = Math.max(k.t, k.wind + k.def.ext);
}

function onGloveContact(g, p, speed) {
  // Your glove intercepted one of his punches or kicks -> block
  const hp = attackOf(p);
  if (hp && !hp.hit && !hp.blocked && hp.phase === 'ext' && speed > 1 && !g.isLeg) {
    hp.blocked = true;
    game.stats.blocked++;
    // Absorbing a strike costs more stamina than throwing one, and some of it still gets through:
    // a little health and a little consciousness. (A glove that merely gets in the way, without
    // holding guard, costs less and lets nothing through.)
    const guarded = player.guarding;
    const kick = hp.def.kind === 'kick';
    const drain = THREE.MathUtils.clamp(4 + speed * 1.3 * hp.def.power * opp.diff.power, 6, 20) * (guarded ? 1 : 0.5) * (kick ? 1.4 : 1);
    player.stamina = Math.max(0, player.stamina - drain);
    const chip = guarded ? Math.max(0, speed - 2.0) * 2.4 * opp.diff.damage * hp.def.power * 0.25 : 0;
    player.health = Math.max(0, player.health - chip);
    player.hurt(chip * 0.8, kick ? 10 : 0);
    game.stats.taken += chip;
    game.vignette = Math.min(1, game.vignette + chip / 10);
    sfx.block(speed / 8);
    const broken = player.stamina <= 0;
    if (!broken) hp.hit = true;   // guard held: no clean shot; broken guard: the strike can still reach your head
    if (kick && !hp.mirror) endKick(hp);
    publishHit(hp, chip, 2, Math.max(speed, hp.speed || 0), 0, false);
    showImpact(broken ? 'GUARD BROKEN' : guarded ? 'BLOCKED' : 'PARRIED', `−${drain.toFixed(0)} stamina${chip ? ` · −${chip.toFixed(1)} health` : ''}`);
    if (guarded) { logEvent('block', 'BLOCK'); if (!mp.on) opp.noteHabit('block'); }
    if ((player.mode === 'fight' || player.mode === 'tripped') && (player.health <= 0 || player.cons <= 0)) playerKnockdown();
    return;
  }
  const pu = g.punch;
  if (!pu || pu.done || pu.phase === 'wind' || speed < 1.5) return;
  pu.done = true;
  // a kick stops where it lands and is pulled back, instead of swinging on through his body
  if (g.isLeg) pu.t = Math.max(pu.t, pu.def.wind + pu.def.ext);
  const mass = g.particle.mass;
  const mu = (mass * p.mass) / (mass + p.mass);
  const energy = 0.5 * mu * speed * speed;
  if (mp.on) {   // online: the person you hit decides the damage and reports it back
    if (p.region === 'guard') sfx.block(speed / 8); else sfx.punch(Math.min(1, speed / 9), p.region === 'low' ? 'body' : p.region);
    return;
  }
  if (opp.mode !== 'fight') { sfx.punch(0.2, 'body'); return; }
  const isKick = pu.type === 'kick';
  if (p.region === 'guard' && !isKick) {
    sfx.block(speed / 8);
    showImpact('BLOCKED', speed, energy);
    opp.coverT = Math.max(opp.coverT, 0.25);
    opp.onOpening(game.time);   // he blocked it: his chance to fire back
    return;
  }
  if (p.region === 'low' && !isKick) { sfx.punch(0.3, 'body'); showImpact('LOW', speed, energy); return; }

  const counter = opp.isPunching() || game.time < game.counterUntil;
  const cm = counter ? 1.25 : 1;
  const v = Math.max(0, speed - 2.2) * pu.power;
  let dmg, cons, bal = 0;
  if (isKick) {
    if (p.region === 'head') { dmg = v * 3.0; cons = dmg * 2.2; bal = 25; }         // head kick
    else if (p.region === 'low') { dmg = v * 1.1; cons = 2; bal = v * 7; }           // leg kick: chops the legs out
    else { dmg = v * 2.0 * (p.region === 'guard' ? 0.4 : 1); cons = dmg * 0.4; bal = v * 4; }
  } else {
    const mult = p.region === 'head' ? 1 : pu.type === 'bodyhook' ? 0.9 : 0.6;
    dmg = v * 2.2 * mult;
    cons = p.region === 'head' ? dmg * 1.6 : dmg * 0.35;
    if (pu.type === 'superman') bal = 15;
  }
  dmg *= cm; cons *= cm;
  game.stats.landed++;
  game.stats.dealt += dmg;
  game.stats.topSpeed = Math.max(game.stats.topSpeed, speed);
  game.stats.topEnergy = Math.max(game.stats.topEnergy, energy);
  opp.takeHit(dmg, p.region, { cons, bal });
  rock(opp, dmg);
  if (dmg > 6) game.hitStop = Math.min(0.08, dmg * 0.004);   // a heavy shot freezes the moment
  sfx.punch(Math.min(1.5, speed / 9 * (isKick ? 1.3 : 1)), p.region === 'low' ? 'body' : p.region);
  arena.excitement += dmg / 20;
  const name = punchName(g, pu.type);
  const swept = opp.mode === 'tripped';
  const label = swept ? 'SWEPT!' : counter ? 'COUNTER!' : pu.type === 'superman' ? 'SUPERMAN!' : isKick ? (p.region === 'head' ? 'HEAD KICK' : p.region === 'low' ? 'LEG KICK' : 'BODY KICK')
    : p.region === 'head' ? (dmg > 14 ? 'HUGE SHOT' : 'HEAD') : 'BODY SHOT';
  showImpact(label, speed, energy);
  logEvent('hit', (counter ? 'COUNTER ' : '') + name, { dmg, speed, energy });
  if (swept) { logEvent('sweep', 'SWEEP'); sfx.crowdCheer(1); }
  if (opp.health <= 0 || opp.cons <= 0) oppKnockdown({ name: (counter ? 'COUNTER ' : '') + name, speed, energy });
}

function onPlayerStruck(hand, speed, imp, region, physical = false) {
  if (player.mode !== 'fight') { player.takeHit(imp, 0, region === 'legs' ? 'body' : region, physical); return; }
  const pu = hand.punch;
  let dmg = 0;
  // Only a glove still travelling forward does damage, not one on its way back.
  const travelling = pu && (pu.phase === 'ext' || (!pu.mirror && pu.phase === 'ret' && pu.t < pu.wind + pu.def.ext + 0.05));
  if (pu?.mirror) speed = Math.max(speed, pu.speed || 0);   // online: use their real glove speed
  if (pu && !pu.hit && travelling && speed > 1.5) {
    pu.hit = true;
    const kick = pu.def.kind === 'kick';
    if (kick && !pu.mirror) endKick(pu);   // his foot stops on you and comes back
    const counter = mp.on ? (mp.rs?.ctr || player.gloves.some((g) => g.punch?.phase === 'ext')) : false;
    const v = Math.max(0, speed - 2.0) * opp.diff.damage * pu.def.power * (counter ? 1.25 : 1);
    dmg = v * 2.4 * (region === 'head' ? 1 : region === 'legs' ? 0.3 : 0.5);
    if (region === 'body' && player.guarding) dmg *= 0.5;
    const cons = region === 'head' ? dmg * 1.6 : region === 'body' ? dmg * 0.3 : 1;
    const bal = kick ? (region === 'legs' ? v * 8 : v * 4) : pu.def.kind === 'superman' ? 12 : 0;
    player.hurt(cons, bal);
    publishHit(pu, dmg, region === 'head' ? 0 : region === 'legs' ? 3 : 1, speed, 0.5 * (15 / 8) * speed * speed, counter, player.mode === 'tripped');
    game.stats.taken += dmg;
    game.stats.oppLanded++;
    sfx.punch(speed / 9, region === 'legs' ? 'body' : region);
    game.vignette = Math.min(1, game.vignette + dmg / 16);
    arena.excitement += dmg / 25;
    if (dmg > 6) game.hitStop = Math.min(0.08, dmg * 0.004);
    if (player.mode === 'tripped') { banner('SWEPT!'); sfx.crowdCheer(0.8); }
  }
  player.takeHit(imp, dmg, region === 'legs' ? 'body' : region, physical);
  if ((player.mode === 'fight' || player.mode === 'tripped') && (player.health <= 0 || player.cons <= 0)) playerKnockdown();
}

// ---------------------------------------------------------------- rules
/** Phones: go fullscreen and sideways when a fight starts (needs a tap, so call from one). */
function goFullscreen() {
  if (!TOUCH || document.fullscreenElement) return;
  const el = document.documentElement;
  const p = el.requestFullscreen?.({ navigationUI: 'hide' });
  if (p && p.then) p.then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
}

function startMatch() {
  goFullscreen();
  sfx.init();
  referee.setActive(true);
  opp.setDifficulty(game.difficulty);
  player.reset(0, 1.45, 0);
  opp.reset(0, -1.45, 0);
  opp.knockdowns = 0;
  game.stats = newStats();
  game.round = 1;
  game.lagP = game.lagO = 100;
  combo.cur = null; combo.clips = [];
  $('menu').classList.add('hidden');
  $('results').classList.add('hidden');
  $('hud').classList.remove('hidden');
  setGlovesVisible(true);
  startRound();
  lockPointer();
}

function startRound() {
  game.timer = ROUND_TIME;
  game.phase = 'intro';
  game.phaseT = 0;
  player.resetKeepHealth(0, 1.45, 0);
  opp.resetKeepHealth(0, -1.45, 0);
  if (referee.active) referee.reset(1.9, 0, -Math.PI / 2);   // at the side, facing the middle
  player.mode = 'idle';
  opp.mode = 'idle';
  banner(game.round === ROUNDS ? 'FINAL ROUND' : `ROUND ${game.round}`);
}

function endRound() {
  sfx.bell(2);
  player.mode = 'idle';
  opp.mode = 'idle';
  if (game.round >= ROUNDS) { decision(); return; }
  game.phase = 'rest';
  game.phaseT = 0;
  banner(`END OF ROUND ${game.round}`);
  player.health = Math.min(100, player.health + 20); player.stamina = 100;
  opp.health = Math.min(100, opp.health + 20);
}

function punchName(g, type) {
  const side = g.side < 0 ? 'LEFT' : 'RIGHT';
  return { straight: g.side < 0 ? 'JAB' : 'CROSS', hook: `${side} HOOK`, uppercut: `${side} UPPERCUT`, bodyhook: `${side} BODY HOOK`,
    kick: `${side} KICK`, superman: 'SUPERMAN PUNCH' }[type];
}

function oppKnockdown(info) {
  opp.knockDown();
  game.phase = 'kowait';
  game.downWho = 'opp';
  game.count = 0; game.countT = 0;
  game.slowmo = 0.5;
  ko.hitTime = game.time;
  ko.info = info;
  sfx.crowdCheer(1.5);
  arena.excitement = 2;
  const base = { easy: 3, normal: 4, hard: 5, expert: 6, champion: 6 }[game.difficulty] ?? 4;
  game.getUpAt = opp.knockdowns >= 3 ? Infinity : Math.min(9, base + Math.floor(Math.random() * 3) + opp.knockdowns);
  banner('KNOCKDOWN!');
}

function playerKnockdown() {
  if (mp.on) {   // online: the host counts; you mash Space to get up
    player.knockDown();
    game.slowmo = 0.8;
    sfx.crowdCheer(1.2);
    arena.excitement = 1.6;
    $('recover').classList.remove('hidden');
    $('recover-text').textContent = player.knockdowns >= 3 ? 'STAY DOWN…' : GET_UP_TEXT;
    banner("YOU'RE DOWN!");
    return;
  }
  player.knockDown();
  game.phase = 'knockdown';
  game.downWho = 'player';
  game.count = 0; game.countT = 0;
  game.slowmo = 0.8;
  opp.mode = 'idle';
  opp.home.set(-Math.sign(player.pos.x || 1) * 2.2, 0, -Math.sign(player.pos.z || 1) * 2.2);
  sfx.crowdCheer(1.2);
  arena.excitement = 1.6;
  $('recover').classList.remove('hidden');
  $('recover-text').textContent = player.knockdowns >= 3 ? 'STAY DOWN…' : GET_UP_TEXT;
  banner("YOU'RE DOWN!");
}

function updateKnockdown(dtReal) {
  game.countT += dtReal;
  if (game.countT >= 1) {
    game.countT -= 1;
    game.count++;
    if (game.count <= 10) $('count').textContent = game.count;
    sfx.tone?.call(sfx, { freq: 220, dur: 0.12, gain: 0.15, type: 'square' });
  }
  if (game.downWho === 'ref') {   // the referee is out cold, and both fighters with him
    if (game.count >= 3) finish(null, 'REFEREE KNOCKOUT', 'NO CONTEST');
    return;
  }
  if (game.downWho === 'opp') {
    if (opp.mode === 'down' && game.count >= game.getUpAt) {
      opp.rise(Math.max(20, 55 - opp.knockdowns * 10 + Math.random() * 15));
      $('count').textContent = '';
    }
    if (opp.mode === 'fight') { game.phase = 'fight'; $('count').textContent = ''; }
    if (opp.mode === 'down' && game.count >= 10) finish(true, 'KNOCKOUT');
  } else {
    if (player.mode === 'down') {
      player.recover = Math.max(0, player.recover - dtReal * 0.15);
      $('recover-fill').style.width = `${Math.min(100, player.recover * 100)}%`;
      if (player.recover >= 1) {
        player.rise(Math.max(25, 60 - player.knockdowns * 12));
        $('recover').classList.add('hidden');
        $('count').textContent = '';
      } else if (game.count >= 10) finish(false, 'KNOCKOUT');
    } else if (player.mode === 'fight') {
      game.phase = 'fight';
      opp.mode = 'fight';
      opp.tactic = 'stalk';
      $('count').textContent = '';
    }
  }
}

function decision() {
  const sYou = game.stats.dealt + 15 * (opp.knockdowns || 0);
  const sOpp = game.stats.taken + 15 * player.knockdowns;
  const diff = sYou - sOpp;
  if (Math.abs(diff) < 4) finish(null, 'DRAW');
  else finish(diff > 0, 'DECISION');
}

function finish(won, method, title = null) {
  if (game.phase === 'kocam') endKoCam();
  finishCombo();
  game.phase = 'over';
  player.mode = player.mode === 'down' ? 'down' : 'idle';
  if (opp.mode !== 'down') opp.mode = 'idle';
  $('count').textContent = '';
  $('recover').classList.add('hidden');
  sfx.bell(3);
  sfx.crowdCheer(1.5);
  arena.excitement = 2.5;
  banner(title || (won === null ? 'DRAW' : won ? 'YOU WIN!' : 'YOU LOSE'));
  setTimeout(() => {
    if (game.phase !== 'over') return;   // left before the results came up
    const s = game.stats;
    $('res-title').textContent = title || (won === null ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT');
    $('res-detail').textContent = title ? `${method.toLowerCase()}: both fighters went down with the referee` : `${won === null ? '' : won ? 'Won' : 'Lost'} by ${method.toLowerCase()} · round ${game.round}`;
    const acc = s.thrown ? Math.round((100 * s.landed) / s.thrown) : 0;
    const rows = [
      ['Strikes landed', `${s.landed} / ${s.thrown} (${acc}%)`],
      ['Damage dealt / taken', `${s.dealt.toFixed(0)} / ${s.taken.toFixed(0)}`],
      ['Hardest strike', `${s.topSpeed.toFixed(1)} m/s · ${s.topEnergy.toFixed(0)} J`],
      ['Their strikes blocked / dodged', `${s.blocked} / ${s.dodged}`],
      ['Knockdowns (scored / suffered)', `${opp.knockdowns || 0} / ${player.knockdowns}`],
      ['Best combo', s.bestCombo ? `${s.bestCombo.hits} hits` : '—'],
    ];
    const box = $('res-stats');
    box.textContent = '';
    for (const [a, b] of rows) { const x = document.createElement('div'); x.textContent = a; const y = document.createElement('div'); y.textContent = b; box.append(x, y); }
    const n = combo.clips.length;
    $('highlights-btn').hidden = !n;
    $('highlights-btn').textContent = `WATCH HIGHLIGHTS (${n})`;
    $('again').textContent = mp.on ? 'BACK TO LOBBY' : 'REMATCH';
    $('results').classList.remove('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
  }, 2600);
}

function toMenu() {
  if (game.phase === 'kocam') endKoCam();
  game.phase = 'menu';
  game.slowmo = 0; game.timeScale = 1;
  $('kocam').classList.add('hidden');
  $('recover').classList.add('hidden');
  $('count').textContent = '';
  if (document.pointerLockElement) document.exitPointerLock();
  $('results').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('menu').classList.remove('hidden');
  player.reset(0, 2.4, 0);
  opp.reset(0, 0, 0);
  referee.setActive(true);
  referee.reset(2.2, 0.9, -Math.PI / 2);
  setGlovesVisible(false);
}

// ---------------------------------------------------------------- replays: knockout cam & highlight reel
// The last ~8 s of every physics body is recorded (60 times a second). While you fight, your
// actions are grouped into combos (strikes, dodges, blocks with less than 1.3 s between
// them). Good combos are copied out as clips for the highlight reel. A knockdown replays
// its whole combo: slow at each key moment (a duck, a slip, a block) and ultra slow on
// the final blow.
const KO_AFTER = 1.15;
const REC_FRAMES = 480, REC_DT = 1 / 60;
const NP = world.recordSize / 3;   // (stored as 3 floats per "slot": NP * 3 = 7 floats per body)
const NX = 11;   // extra per-frame values (see extrasInto)
const COMBO_GAP = 1.3;
const MAX_CLIPS = 8;
const rec = { t: new Float64Array(REC_FRAMES), pos: new Float32Array(REC_FRAMES * NP * 3), extra: new Float32Array(REC_FRAMES * NX), head: 0, count: 0, lastT: -1 };
const live = { state: null, extra: new Float32Array(NX) };
const ko = { hitTime: 0, info: null, skip: false };
const reel = { clips: [], i: 0, t: 0, mode: null, clip: null, center: new THREE.Vector3(), angle0: 0, shake: 0, next: 0, chain: [], abort: false };
const combo = { cur: null, clips: [] };
const _look = new THREE.Vector3();
const _bodyQ = { quaternion: new THREE.Quaternion() };
const smooth01 = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

function extrasInto(arr, o) {
  arr[o] = player.pos.x; arr[o + 1] = player.pos.z; arr[o + 2] = player.yaw; arr[o + 3] = player.twist;
  arr[o + 4] = opp.yaw; arr[o + 5] = player.duck;
  arr[o + 6] = player.vel.x; arr[o + 7] = player.vel.z; arr[o + 8] = player.avatar.phase;
  arr[o + 9] = player.leg.side; arr[o + 10] = player.jumpY;
}
function extrasFrom(arr, o) {
  player.pos.x = arr[o]; player.pos.z = arr[o + 1]; player.yaw = arr[o + 2]; player.twist = arr[o + 3];
  opp.yaw = arr[o + 4]; player.duck = arr[o + 5];
  player.vel.x = arr[o + 6]; player.vel.z = arr[o + 7]; player.avatar.phase = arr[o + 8];
  player.leg.side = arr[o + 9]; player.jumpY = arr[o + 10];
}

function recordFrame() {
  if (rec.count && game.time - rec.lastT < REC_DT) return;
  rec.lastT = game.time;
  const i = rec.head;
  rec.t[i] = game.time;
  const base = i * NP * 3;
  world.writeState(rec.pos, base);
  extrasInto(rec.extra, i * NX);
  rec.head = (i + 1) % REC_FRAMES;
  rec.count = Math.min(REC_FRAMES, rec.count + 1);
}

/** Copy recorded frames between two times into a standalone clip. */
function framesBetween(t0, t1) {
  const out = [];
  const first = (rec.head - rec.count + REC_FRAMES) % REC_FRAMES;
  for (let n = 0; n < rec.count; n++) {
    const i = (first + n) % REC_FRAMES;
    if (rec.t[i] < t0 || rec.t[i] > t1) continue;
    out.push({ t: rec.t[i], pos: rec.pos.slice(i * NP * 3, (i + 1) * NP * 3), extra: rec.extra.slice(i * NX, (i + 1) * NX) });
  }
  return out;
}

/** Your fight actions, grouped into combos. kind: hit | dodge | block | sweep */
function logEvent(kind, label, extra = {}) {
  if (game.phase === 'menu' || game.phase === 'over') return;
  const t = game.time;
  if (!combo.cur || t - combo.cur.last > COMBO_GAP) {
    finishCombo();
    combo.cur = { start: t, last: t, events: [], hits: 0, dmg: 0, defense: 0, sweeps: 0 };
  }
  const c = combo.cur;
  c.events.push({ t, kind, label, ...extra });
  c.last = t;
  if (kind === 'hit') { c.hits++; c.dmg += extra.dmg || 0; }
  if (kind === 'dodge' || kind === 'block') c.defense++;
  if (kind === 'sweep') c.sweeps++;
}

const comboWorth = (c) => c.hits >= 3 || (c.defense >= 1 && c.hits >= 1) || c.sweeps > 0 || c.events.some((e) => /SUPERMAN/.test(e.label) && e.kind === 'hit');

/** Close the current combo; save it as a clip if it was a good one (or ended in a knockdown). */
function finishCombo(knockout = false) {
  const c = combo.cur;
  if (!c) return null;
  combo.cur = null;
  if (!knockout && !comboWorth(c)) return null;
  // keep only defence that leads into the strikes (a lone early block isn't part of the story)
  const firstHit = c.events.findIndex((e) => e.kind === 'hit');
  const events = c.events.filter((e, i) => e.kind !== 'block' || (firstHit >= 0 && i >= firstHit - 2));
  const t0 = Math.max(events[0].t - 0.6, (knockout ? ko.hitTime : c.last) - 7);
  const frames = framesBetween(t0, knockout ? ko.hitTime + KO_AFTER : c.last + 0.9);
  if (frames.length < 5) return null;
  const markers = events.map((e) => ({ t: e.t, label: e.label, kind: e.kind, speed: e.speed, energy: e.energy, final: false }));
  if (knockout) { const lastHit = [...markers].reverse().find((m) => m.kind === 'hit'); if (lastHit) lastHit.final = true; }
  const title = markers.filter((m) => m.kind !== 'sweep').map((m) => m.label).join('  →  ');
  const clip = { frames, markers, title, ko: knockout, hits: c.hits, t: c.start,
    score: c.hits + c.defense * 1.5 + c.dmg / 10 + c.sweeps * 3 + (knockout ? 10 : 0) };
  combo.clips.push(clip);
  combo.clips.sort((a, b) => b.score - a.score);
  combo.clips.length = Math.min(combo.clips.length, MAX_CLIPS);
  if (c.hits > (game.stats.bestCombo?.hits || 0)) game.stats.bestCombo = { hits: c.hits, title };
  return clip;
}

function sampleClip(clip, time) {
  const f = clip.frames;
  let lo = 0, hi = f.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (f[mid].t <= time) lo = mid; else hi = mid; }
  const a = f[lo], b = f[hi];
  const span = b.t - a.t;
  const u = span > 1e-6 ? THREE.MathUtils.clamp((time - a.t) / span, 0, 1) : 0;
  world.readState(a.pos, 0, b.pos, u);
  extrasFrom(u < 0.5 ? a.extra : b.extra, 0);
}

/** Playback speed: slow at each key moment, ultra slow on the knockout blow. */
function rateAt(clip, t) {
  let r = clip.ko ? 0.6 : 0.75;
  for (const m of clip.markers) {
    const d = Math.abs(t - m.t);
    if (m.final) r = Math.min(r, (mp.on ? 0.1 : 0.04) + 0.6 * smooth01(d / 0.5));
    else r = Math.min(r, 0.22 + 0.5 * smooth01(d / 0.3));
  }
  return r * (mp.on && reel.mode === 'ko' ? 1.8 : 1);   // online the fight goes on, so keep it short
}

function playClips(clips, mode) {
  if (!clips.length) return false;
  live.state = world.saveLive();
  extrasInto(live.extra, 0);
  live.legPunch = player.leg.punch; player.leg.punch = null;
  Object.assign(reel, { clips, mode, abort: false });
  ko.skip = false;
  game.phase = mode === 'ko' ? 'kocam' : 'reel';
  player.avatar.group.visible = true;
  // the replay shows your body, whose fists are drawn on your gloves: hide the first-person ones
  live.gloves = player.view.items.map((it) => it.group.visible);
  for (const it of player.view.items) it.arm.visible = it.group.visible = false;
  $('hud').classList.add('hidden');
  $('kocam').classList.remove('hidden');
  $('kc-title-text').textContent = mode === 'ko' ? 'KNOCKOUT CAM' : 'HIGHLIGHTS';
  startClip(0);
  return true;
}

function startClip(i) {
  const c = reel.clips[i];
  Object.assign(reel, { i, clip: c, t: c.frames[0].t, next: 0, chain: [], shake: 0 });
  const key = (c.markers.find((m) => m.final) || c.markers[c.markers.length - 1] || c.frames[c.frames.length >> 1]).t;
  sampleClip(c, key);
  const dx = opp.p.head.pos.x - player.pos.x, dz = opp.p.head.pos.z - player.pos.z;
  reel.center.set(player.pos.x + dx * 0.55, 0, player.pos.z + dz * 0.55);
  // film from the side the referee isn't standing on (he'd be in the shot)
  const rp = referee.p.pelvis.pos;
  const side = (s) => { const a = Math.atan2(dz, dx) + s * (Math.PI / 2 - 0.35) + 0.35; return Math.hypot(reel.center.x + Math.cos(a) * 2.4 - rp.x, reel.center.z + Math.sin(a) * 2.4 - rp.z); };
  const s = side(1) > side(-1) ? 1 : -1;
  reel.angle0 = Math.atan2(dz, dx) + s * (Math.PI / 2 - 0.35);
  $('kc-sub').textContent = reel.mode === 'reel' ? `${i + 1} / ${reel.clips.length}${c.ko ? ' · KNOCKOUT' : ''}` : '';
  $('kc-caption').textContent = '';
  $('kc-caption').classList.remove('show');
}

function updateReel(dtReal) {
  const c = reel.clip;
  reel.t += dtReal * rateAt(c, reel.t);
  while (reel.next < c.markers.length && reel.t >= c.markers[reel.next].t) {
    const m = c.markers[reel.next++];
    if (m.kind !== 'sweep') reel.chain.push(m.label);
    if (m.kind === 'hit') { sfx.punch(m.final ? 1.4 : 0.9, 'head'); reel.shake = m.final ? 1 : 0.4; }
    else if (m.kind === 'dodge') sfx.whoosh(0.8);
    else if (m.kind === 'block') sfx.block(0.8);
    else if (m.kind === 'sweep') { reel.chain.push('SWEEP'); sfx.crowdCheer(1); }
    if (m.final) sfx.crowdCheer(1.5);
    $('kc-caption').textContent = reel.chain.join('  →  ') + (m.final && m.speed ? `   ·   ${m.speed.toFixed(1)} m/s · ${m.energy.toFixed(0)} J` : '');
    $('kc-caption').classList.add('show');
  }
  sampleClip(c, reel.t);
  const t0 = c.frames[0].t, t1 = c.frames[c.frames.length - 1].t;
  const prog = (reel.t - t0) / Math.max(0.01, t1 - t0);
  const ang = reel.angle0 + prog * 0.7;
  reel.shake = Math.max(0, reel.shake - dtReal * 2.5);
  const sh = reel.shake * 0.03;
  camera.position.set(reel.center.x + Math.cos(ang) * 2.4 + (Math.random() - 0.5) * sh, 1.45 - prog * 0.35 + (Math.random() - 0.5) * sh, reel.center.z + Math.sin(ang) * 2.4);
  _look.copy(opp.p.head.pos).lerp(reel.center.setY(1.2), 0.35);
  camera.lookAt(_look);
  reel.center.y = 0;

  _bodyQ.quaternion.setFromEuler(new THREE.Euler(0, player.yaw + player.twist, 0, 'YXZ'));
  opp.view.update();
  referee.view.update();
  player.view.update(_bodyQ);
  player.legView.update(_bodyQ);
  player.avatar.update();
  debugView.update();
  if (reel.abort) { endReel(); return; }
  if (reel.t >= t1 || ko.skip) {
    ko.skip = false;
    if (reel.i + 1 < reel.clips.length) startClip(reel.i + 1); else endReel();
  }
}

function endReel() {
  world.restoreLive(live.state);
  extrasFrom(live.extra, 0);
  player.leg.punch = live.legPunch || null;
  player.avatar.group.visible = false;
  player.view.items.forEach((it, i) => { it.arm.visible = it.group.visible = live.gloves ? live.gloves[i] : true; });
  $('kocam').classList.add('hidden');
  const mode = reel.mode;
  reel.mode = null;
  if (mode === 'reel') { game.phase = 'over'; $('results').classList.remove('hidden'); return; }
  afterKnockoutReplay();
}

function afterKnockoutReplay() {
  $('hud').classList.remove('hidden');
  game.count = 0; game.countT = 0;
  if (mp.on) {
    const m = mp.role === 'host' ? mp.m : mp.rs?.m;
    game.phase = m?.phase === 'over' ? 'over' : (['intro', 'fight', 'knockdown', 'rest'].includes(m?.phase) ? m.phase : 'knockdown');
    if (m?.phase === 'knockdown' && m.count > 0) $('count').textContent = m.count;
  } else game.phase = 'knockdown';
}

// Knockout cam: replay the combo that ended in the knockdown.
function startKoCam() {
  const clip = finishCombo(true);
  if (!clip || !playClips([clip], 'ko')) afterKnockoutReplay();
}
const updateKoCam = updateReel;
const endKoCam = endReel;

function watchHighlights() {
  finishCombo();
  const clips = [...combo.clips].sort((a, b) => a.t - b.t);   // in the order they happened
  if (!clips.length) return;
  $('results').classList.add('hidden');
  playClips(clips, 'reel');
}

// ---------------------------------------------------------------- online play
// The host runs the match clock (rounds, knockdown counts, result). Each fighter
// decides for themselves whether a punch reached their own head, so a dodge that
// worked on your screen always counts, and reports what they took back to the puncher.
const net = new Net();
const MP_DIFF = { damage: 0.9, power: 1 };
const PH = ['none', 'wind', 'ext', 'ret'];
const TYPES = ['straight', 'hook', 'uppercut', 'bodyhook', 'superman'];
const TYPE_POWER = { straight: 1, hook: 1.15, uppercut: 1.15, bodyhook: 1.1, superman: 1.6, kick: 1.3 };
const MODES = ['fight', 'idle', 'down', 'rising', 'tripped'];
const remoteBody = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), head: new THREE.Vector3(0, 1.6, 0), gloves: [new THREE.Vector3(), new THREE.Vector3()], yaw: 0,
  kickPos: new THREE.Vector3(), jumpY: 0 };
const mp = { on: false };
const _gv = new THREE.Vector3();
const num = (v, lo, hi, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const r3 = (v) => Math.round(v * 1000) / 1000;

function resetMp(role) {
  Object.assign(mp, {
    on: !!role, role, started: false, peer: null, rs: null, lastSeen: performance.now(), joinT: performance.now(),
    hitSeq: mp.hitSeq || 0, hitLog: [], lastConfirm: 0, lastInfo: null, names: new Map(),
    m: { phase: 'waiting', round: 1, timer: ROUND_TIME, count: 0, down: null, winner: null, method: null, epoch: 0 },
    applied: '', shownCount: -1, phaseT: 0, countT: 0,
  });
}

// Each fighter starts in their own corner: host at +z facing -z, guest the other way.
const myCorner = () => (mp.role === 'host' ? [0, 1.45, 0] : [0, -1.45, Math.PI]);
const theirCorner = () => (mp.role === 'host' ? [0, -1.45, 0] : [0, 1.45, Math.PI]);   // opponent-body yaw convention

function myState() {
  const k = [];
  for (const g of player.gloves) {
    const pu = g.punch;
    k.push(pu ? PH.indexOf(pu.phase) : 0, pu ? TYPES.indexOf(pu.type) : 0, pu ? pu.seq : 0, r3(g.particle.getVelocity(STEP, _gv).length()));
  }
  const kp = player.leg.punch;   // the kick: phase, which leg, sequence, foot speed
  k.push(kp ? PH.indexOf(kp.phase) : 0, player.leg.side, kp ? kp.seq : 0, r3(player.leg.particle.getVelocity(STEP, _gv).length()));
  const s = [player.pos.x, player.pos.z, player.vel.x, player.vel.z, player.yaw + player.twist,
    player.headPos.x, player.headPos.y, player.headPos.z,
    ...player.gloves[0].particle.pos.toArray(), ...player.gloves[1].particle.pos.toArray(),
    ...player.leg.particle.pos.toArray(), player.jumpY].map(r3);
  const st = { role: mp.role, name: net.name, s, k, mode: player.mode, hp: r3(player.health), kd: player.knockdowns, c: r3(player.cons),
    taken: r3(game.stats.taken), ctr: game.time < game.counterUntil ? 1 : 0 };
  if (mp.hitLog.length) st.hit = mp.hitLog;
  if (mp.role === 'host') { st.m = mp.m; st.opp = mp.peer; }
  return st;
}

function readRemote(p) {
  const pr = p.presence || {};
  const s = pr.s, k = pr.k;
  if (!Array.isArray(s) || s.length !== 18 || !Array.isArray(k) || k.length !== 12) return false;
  const r = remoteBody;
  r.pos.set(num(s[0], -3.2, 3.2), 0, num(s[1], -3.2, 3.2));
  r.vel.set(num(s[2], -5, 5), 0, num(s[3], -5, 5));
  r.yaw = num(s[4], -1e4, 1e4);
  r.head.set(num(s[5], -3.5, 3.5), num(s[6], 0.2, 2.2, 1.6), num(s[7], -3.5, 3.5));
  r.gloves[0].set(num(s[8], -3.5, 3.5), num(s[9], 0, 2.4, 1.3), num(s[10], -3.5, 3.5));
  r.gloves[1].set(num(s[11], -3.5, 3.5), num(s[12], 0, 2.4, 1.3), num(s[13], -3.5, 3.5));
  for (const g of r.gloves) if (g.distanceTo(r.head) > 1.1) g.sub(r.head).setLength(1.1).add(r.head);   // no impossible reach
  r.kickPos.set(num(s[14], -3.5, 3.5), num(s[15], 0, 2.2, 0.1), num(s[16], -3.5, 3.5));
  r.jumpY = num(s[17], 0, 1);
  mp.rs = {
    mode: MODES.includes(pr.mode) ? pr.mode : 'idle', hp: num(pr.hp, 0, 100, 100), kd: num(pr.kd, 0, 9) | 0,
    taken: num(pr.taken, 0, 1e5), ctr: pr.ctr === 1, name: cleanName(pr.name), cons: num(pr.c, 0, 100, 100),
    hit: Array.isArray(pr.hit) ? pr.hit : null, m: pr.m && typeof pr.m === 'object' ? pr.m : null,
    opp: typeof pr.opp === 'string' ? pr.opp : null,
  };
  mirrorPunches(k);
  return true;
}

const AI_NAME = (type, i) => (type === 'straight' ? (i === 0 ? 'jab' : 'cross') : type === 'hook' ? (i === 0 ? 'hookL' : 'hookR')
  : type === 'uppercut' ? 'upperR' : type === 'superman' ? 'superman' : 'bodyR');

/** Copy their punches onto the puppet's hands so blocking, dodging, the warning ring and glow all work. */
function mirrorPunches(k) {
  for (let i = 0; i < 2; i++) {
    const hand = i === 0 ? opp.hands.L : opp.hands.R;
    const ph = PH[num(k[i * 4], 0, 3) | 0], type = TYPES[num(k[i * 4 + 1], 0, TYPES.length - 1) | 0];
    const seq = num(k[i * 4 + 2], 0, 1e9) | 0, spd = num(k[i * 4 + 3], 0, 30);
    let pu = hand.punch;
    if (pu && (ph === 'none' || pu.seq !== seq)) { endMirror(pu); hand.punch = pu = null; }
    if (ph === 'none') continue;
    if (!pu) {
      pu = hand.punch = { mirror: true, seq, type, name: AI_NAME(type, i), t: 0, wind: 1, phase: ph, hit: false, blocked: false, speed: 0,
        def: { power: TYPE_POWER[type], aim: type === 'bodyhook' ? 'chest' : 'head', ext: 0.15 } };
    }
    if (pu.phase === 'ext' && ph !== 'ext') endMirror(pu);
    if (ph === 'ext') { pu.sawExt = true; pu.speed = Math.max(pu.speed, spd); }
    pu.phase = ph;
  }
  // their kick drives the puppet's matching foot (their left leg is this body's left foot)
  const ph = PH[num(k[8], 0, 3) | 0], side = num(k[9], -1, 1) < 0 ? -1 : 1;
  const seq = num(k[10], 0, 1e9) | 0, spd = num(k[11], 0, 30);
  let kp = opp.kickSlot.punch;
  if (kp && (ph === 'none' || kp.seq !== seq)) { endMirror(kp); opp.kickSlot.punch = kp = null; }
  if (ph !== 'none') {
    if (!kp) {
      kp = opp.kickSlot.punch = { mirror: true, seq, type: 'kick', name: side < 0 ? 'kickL' : 'kickR', foot: side < 0 ? 'footL' : 'footR',
        t: 0, wind: 1, phase: ph, hit: false, blocked: false, speed: 0, def: { power: TYPE_POWER.kick, kind: 'kick', aim: 'legs', ext: 0.2 } };
    }
    if (kp.phase === 'ext' && ph !== 'ext') endMirror(kp);
    if (ph === 'ext') { kp.sawExt = true; kp.speed = Math.max(kp.speed, spd); }
    kp.phase = ph;
  }
}

/** Their punch finished without touching you: reward the dodge. */
function endMirror(pu) {
  if (pu.ended) return;
  pu.ended = true;
  if (!pu.sawExt || pu.hit || pu.blocked || player.mode !== 'fight' || game.phase !== 'fight') return;
  if (!player.dodging && player.duck < 0.15 && !player.airborne) return;
  game.counterUntil = game.time + 0.7;
  game.stats.dodged++;
  player.stamina = Math.min(100, player.stamina + 6);
  const how = player.dodging ? 'SLIP' : player.airborne ? 'JUMP' : 'DUCK';
  showImpact(`${how === 'SLIP' ? 'SLIPPED' : how === 'JUMP' ? 'JUMPED' : 'DUCKED'}!`, 'counter now');
  logEvent('dodge', how);
}

/** You were hit (or blocked): tell the puncher. region 0 head, 1 body, 2 blocked, 3 legs; swept: it knocked you off your feet. */
function publishHit(pu, dmg, region, speed, energy, counter, swept = false) {
  if (!mp.on) return;
  mp.hitSeq++;
  // keep the last few, so two hits between network updates both get reported
  mp.hitLog = [...mp.hitLog, [mp.hitSeq, pu.seq, r3(dmg), region, r3(speed), r3(energy), counter ? 1 : 0, swept ? 1 : 0]].slice(-4);
}

const hitSeqOf = (h) => (Array.isArray(h) ? num(h[0], 0, 1e9) | 0 : 0);

/** What your punches did, as reported by the person you hit. */
function readConfirms(list) {
  if (!list) return;
  for (const h of [...list].sort((a, b) => hitSeqOf(a) - hitSeqOf(b))) readConfirm(h);
}

function readConfirm(h) {
  if (!Array.isArray(h)) return;
  const seq = hitSeqOf(h);
  if (seq <= mp.lastConfirm) return;
  mp.lastConfirm = seq;
  const punchSeq = num(h[1], 0, 1e9) | 0, dmg = num(h[2], 0, 100), region = num(h[3], 0, 3) | 0;
  const speed = num(h[4], 0, 30), energy = num(h[5], 0, 2000), counter = h[6] === 1, swept = h[7] === 1;
  if (region === 2) { showImpact('BLOCKED', speed, energy); return; }
  const name = mp.names.get(punchSeq) || 'STRIKE';
  game.stats.landed++;
  game.stats.dealt += dmg;
  game.stats.topSpeed = Math.max(game.stats.topSpeed, speed);
  game.stats.topEnergy = Math.max(game.stats.topEnergy, energy);
  arena.excitement += dmg / 20;
  showImpact(swept ? 'SWEPT!' : counter ? 'COUNTER!' : region === 3 ? 'LEG KICK' : region === 0 ? (dmg > 14 ? 'HUGE SHOT' : 'HEAD') : 'BODY SHOT', speed, energy);
  mp.lastInfo = { name, speed, energy };
  logEvent('hit', (counter ? 'COUNTER ' : '') + name, { dmg, speed, energy });
  if (swept) logEvent('sweep', 'SWEEP');
}

function syncRemoteMode() {
  const rm = mp.rs.mode;
  if (rm === 'down' && opp.mode !== 'down') { opp.knockDown(); onRemoteKnockdown(); }
  else if (rm === 'tripped' && opp.mode === 'fight') opp.trip();
  else if ((rm === 'rising' || rm === 'fight') && (opp.mode === 'down' || opp.mode === 'tripped')) opp.rise(mp.rs.hp, opp.mode === 'tripped');
  else if (rm === 'idle' && opp.mode === 'fight') opp.mode = 'idle';
  else if (rm === 'fight' && opp.mode === 'idle') opp.mode = 'fight';
  opp.health = mp.rs.hp;
  opp.knockdowns = mp.rs.kd;
  opp.cons = mp.rs.cons;
}

function onRemoteKnockdown() {
  if (game.phase !== 'fight' && game.phase !== 'knockdown') return;
  ko.hitTime = game.time - 0.1;
  ko.info = mp.lastInfo;
  game.phase = 'kowait';
  game.slowmo = 0.4;
  sfx.crowdCheer(1.5);
  arena.excitement = 2;
  banner('KNOCKDOWN!');
}

function hostTick(dt, dtReal) {
  const m = mp.m, rmode = mp.rs?.mode;
  const set = (phase) => { m.phase = phase; m.epoch++; mp.phaseT = 0; };
  mp.phaseT += dtReal;
  switch (m.phase) {
    case 'waiting':
      if (mp.peer && mp.rs) { m.round = 1; m.timer = ROUND_TIME; set('intro'); }
      break;
    case 'intro':
      if (mp.phaseT > 2.2) set('fight');
      break;
    case 'fight':
      if (!mp.silent) m.timer = Math.max(0, m.timer - dt);   // the clock waits while the connection is down
      if (player.mode === 'down') { m.down = 'host'; m.count = 0; mp.countT = 0; set('knockdown'); }
      else if (rmode === 'down') { m.down = 'guest'; m.count = 0; mp.countT = 0; set('knockdown'); }
      else if (m.timer <= 0) {
        if (m.round >= ROUNDS) {
          const hostScore = (mp.rs?.taken || 0) + 15 * (mp.rs?.kd || 0);
          const guestScore = game.stats.taken + 15 * player.knockdowns;
          m.winner = Math.abs(hostScore - guestScore) < 4 ? 'draw' : hostScore > guestScore ? 'host' : 'guest';
          m.method = m.winner === 'draw' ? 'DRAW' : 'DECISION';
          set('over');
        } else set('rest');
      }
      break;
    case 'knockdown': {
      mp.countT += dtReal;
      if (mp.countT >= 1) { mp.countT -= 1; m.count++; }
      const downMode = m.down === 'host' ? player.mode : rmode;
      if (downMode === 'fight') set('fight');
      else if (m.count >= 10) { m.winner = m.down === 'host' ? 'guest' : 'host'; m.method = 'KNOCKOUT'; set('over'); }
      break;
    }
    case 'rest':
      if (mp.phaseT > 4.5) { m.round++; m.timer = ROUND_TIME; set('intro'); }
      break;
    default:
      break;
  }
}

function applyMatch(m) {
  if (!m || typeof m.phase !== 'string') return;
  game.round = num(m.round, 1, ROUNDS, 1) | 0;
  game.timer = num(m.timer, 0, ROUND_TIME, ROUND_TIME);
  const key = `${m.phase}:${m.epoch}`;
  if (key !== mp.applied) { mp.applied = key; onMatchPhase(m); }
  if (m.phase === 'knockdown') {
    const c = num(m.count, 0, 10) | 0;
    if (c !== mp.shownCount) {
      mp.shownCount = c;
      if (game.phase !== 'kocam') $('count').textContent = c > 0 ? c : '';
      if (c > 0) sfx.tone({ freq: 220, dur: 0.12, gain: 0.15, type: 'square' });
    }
  }
}

function setPhase(p) { if (game.phase !== 'kowait' && game.phase !== 'kocam') game.phase = p; }

function onMatchPhase(m) {
  switch (m.phase) {
    case 'intro': {
      const [x, z, yaw] = myCorner(), [ox, oz, oyaw] = theirCorner();
      player.resetKeepHealth(x, z, yaw);
      opp.resetKeepHealth(ox, oz, oyaw);
      player.mode = 'idle'; opp.mode = 'idle';
      $('count').textContent = '';
      setPhase('intro');
      banner(game.round === ROUNDS ? 'FINAL ROUND' : `ROUND ${game.round}`);
      break;
    }
    case 'fight':
      if (player.mode === 'idle') player.mode = 'fight';
      if (opp.mode === 'idle') opp.mode = 'fight';
      $('count').textContent = '';
      if (game.phase === 'intro') { sfx.bell(1); banner('FIGHT!'); }
      setPhase('fight');
      break;
    case 'knockdown':
      mp.shownCount = -1;
      setPhase('knockdown');
      break;
    case 'rest':
      sfx.bell(2);
      if (player.mode === 'fight') player.mode = 'idle';
      player.health = Math.min(100, player.health + 20); player.stamina = 100;
      banner(`END OF ROUND ${game.round}`);
      setPhase('rest');
      break;
    case 'over': {
      if (game.phase === 'kocam') endKoCam();
      const w = m.winner;
      finish(w === 'draw' ? null : w === mp.role, typeof m.method === 'string' ? m.method.slice(0, 12) : 'DECISION');
      break;
    }
    default:
      break;
  }
}

function beginOnlineMatch() {
  mp.started = true;
  sfx.init();
  for (const id of ['lobby', 'waiting', 'menu', 'results']) $(id).classList.add('hidden');
  $('hud').classList.remove('hidden');
  setGlovesVisible(true);
  game.stats = newStats();
  game.lagP = game.lagO = 100;
  game.counterUntil = -1;
  combo.cur = null; combo.clips = [];
  opp.remote = remoteBody;
  opp.diff = MP_DIFF;
  referee.setActive(false);   // (online matches have no referee yet: each side would see its own)
  mp.lastConfirm = Math.max(0, ...(mp.rs?.hit || []).map(hitSeqOf));   // ignore reports from before this match
  const [x, z, yaw] = myCorner(), [ox, oz, oyaw] = theirCorner();
  player.reset(x, z, yaw);
  opp.reset(ox, oz, oyaw);
  opp.knockdowns = 0;
  game.phase = 'intro';
  $('opp-name').textContent = mp.rs?.name || 'Opponent';
  net.setListed(false);
  overlay('MATCH FOUND', `You're fighting ${mp.rs?.name || 'your opponent'}. Click to start.`, 'FIGHT');
}

function mpUpdate(dt, dtReal, now) {
  const others = net.others();
  let rp = null;
  if (mp.role === 'host') {
    if (mp.peer) rp = others.find((p) => p.peer === mp.peer) || null;
    if (!rp && !mp.started) {
      rp = others.find((p) => p.presence?.role === 'guest' && Array.isArray(p.presence.s)) || null;
      if (rp) mp.peer = rp.peer;
    }
  } else {
    rp = others.find((p) => p.presence?.role === 'host') || null;
  }
  // `t` is when their latest state arrived; a held copy from a dropped link doesn't count as hearing them.
  if (rp && readRemote(rp)) mp.lastSeen = Math.max(mp.lastSeen, rp.t ?? now);
  mp.silent = mp.started && now - mp.lastSeen > 1500;

  if (!mp.started) {
    if (mp.role === 'guest') {
      const me = net.myPeer();
      const noMatch = `No open match found with code ${String(net.code).toUpperCase()}.`;
      if (net.full || (rp && mp.rs?.opp && me && mp.rs.opp !== me)) { lobbyError('That match already has two fighters.'); return; }
      if (net.unreachable || net.failReason === 'unreachable') { lobbyError(noMatch); return; }
      if (net.failReason === 'blocked') {
        lobbyError(net.hasRelay
          ? "Couldn't connect to that match: one of your networks is blocking the connection. Try a different network."
          : "Couldn't connect to that match: one of your networks blocks direct connections, and this copy of the game has no relay server set up.");
        return;
      }
      if (rp && me && mp.rs?.opp === me && mp.rs.m && mp.rs.m.phase !== 'waiting') beginOnlineMatch();
      // a direct connection can take a while to set up (the game retries a few times)
      else if (!rp && now - mp.joinT > (net.kind === 'p2p' ? 40000 : 8000)) { lobbyError(noMatch); return; }
    } else {
      hostTick(dt, dtReal);
      if (mp.m.phase !== 'waiting') beginOnlineMatch();
    }
  } else {
    $('netwarn').hidden = !(mp.silent && game.phase !== 'over');
    // a dropped link gets time to reconnect before it counts as leaving
    if (now - mp.lastSeen > 12000 && game.phase !== 'over') { $('netwarn').hidden = true; opponentLeft(); return; }
    if (mp.rs) { syncRemoteMode(); readConfirms(mp.rs.hit); }
    if (mp.role === 'host') hostTick(dt, dtReal);
    applyMatch(mp.role === 'host' ? mp.m : mp.rs?.m);
    // getting up: mash Space, allowed from the count of 3
    if (player.mode === 'down') {
      $('recover').classList.remove('hidden');
      player.recover = Math.max(0, player.recover - dtReal * 0.15);
      $('recover-fill').style.width = `${Math.min(100, player.recover * 100)}%`;
      const count = num((mp.role === 'host' ? mp.m : mp.rs?.m)?.count, 0, 10);
      if (player.recover >= 1 && count >= 3 && player.knockdowns < 3) {
        player.rise(Math.max(25, 60 - player.knockdowns * 12));
        $('recover').classList.add('hidden');
      }
    }
  }
  // While the replay is on screen the bodies hold replayed poses, so only the match clock is sent.
  if (game.phase === 'kocam') net.send(mp.role === 'host' ? { m: mp.m, hb: Math.round(now / 250) } : { hb: Math.round(now / 250) }, now);
  else net.send(myState(), now);
}

function opponentLeft() {
  banner('OPPONENT LEFT');
  finish(true, 'FORFEIT');
}

// ---- lobby UI
function savedName() { try { return localStorage.getItem('km-name') || ''; } catch { return ''; } }
function rememberName(n) { try { localStorage.setItem('km-name', n); } catch { /* private window */ } }

async function openLobby() {
  $('menu').classList.add('hidden');
  $('results').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  $('nick').value = $('nick').value || savedName();
  lobbyStatus('Connecting…');
  if (!net.available) await net.init();
  const ok = net.available;
  for (const id of ['host-btn', 'join-btn', 'code-input']) $(id).disabled = !ok;
  $('list-head').hidden = $('match-list').hidden = ok && !net.canList;
  if (!ok) {
    lobbyStatus(net.blockedHere
      ? 'Online play on claude.ai needs you to be signed in, with access to this page from whoever shared it.'
      : 'Online play needs a browser that supports WebRTC, such as a current Chrome, Edge, Firefox or Safari.');
    renderLobby([]);
    return;
  }
  lobbyStatus(net.canList
    ? 'Host a match, or join one that someone else is hosting. Anyone you share this page with can see open matches while they have it open.'
    : 'Host a match and send your opponent the code, or enter the code they sent you.');
  renderLobby(net.openMatches());
}

function lobbyStatus(text) { $('lobby-status').textContent = text; }

let lobbyKey = null;
function renderLobby(list) {
  // Only redraw when the list really changes, so a JOIN button isn't replaced under the cursor.
  const key = (net.available ? 'y' : 'n') + JSON.stringify((list || []).map((m) => [m.code, m.name]));
  if (key === lobbyKey) return;
  lobbyKey = key;
  const el = $('match-list');
  el.textContent = '';
  if (!list || !list.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = net.available ? 'No open matches right now.' : 'Online play is not available here.';
    el.append(p);
    return;
  }
  for (const m of list) {
    const row = document.createElement('div');
    row.className = 'match-row';
    const n = document.createElement('span'); n.textContent = m.name;
    const c = document.createElement('code'); c.textContent = m.code;
    const b = document.createElement('button'); b.textContent = 'JOIN'; b.addEventListener('click', () => joinMatch(m.code));
    row.append(n, c, b);
    el.append(row);
  }
}
net.onLobby = (list) => { if (!$('lobby').classList.contains('hidden')) renderLobby(list || []); };

function playerName() {
  const n = cleanName($('nick').value);
  rememberName(n);
  return n;
}

async function hostMatch() {
  try {
    resetMp('host');
    const code = await net.host(playerName());
    $('lobby').classList.add('hidden');
    $('wait-note').textContent = net.canList
      ? 'Your match is listed for anyone who has this page open. They can also join with the code'
      : 'Send your opponent this code. They open the game, choose Play online and enter it.';
    $('wait-code').textContent = code.toUpperCase();
    $('waiting').classList.remove('hidden');
  } catch {
    resetMp(null);
    lobbyStatus(net.kind === 'p2p'
      ? "Couldn't reach the matchmaking server. Check your connection and try again."
      : 'Could not open a match right now. Try again in a moment.');
  }
}

async function joinMatch(code) {
  try {
    lobbyStatus(`Joining ${String(code).toUpperCase()}…`);
    resetMp('guest');
    await net.join(code, playerName());
    mp.joinT = performance.now();
  } catch (e) {
    resetMp(null);
    lobbyStatus(e?.message === 'bad_code' ? 'Match codes are 4 to 8 letters and numbers.' : 'Could not join that match. Check the code and try again.');
  }
}

function lobbyError(msg) {
  net.leave();
  resetMp(null);
  $('waiting').classList.add('hidden');
  openLobby().then(() => lobbyStatus(msg));
}

async function mpLeave(toLobby = false) {
  $('netwarn').hidden = true;
  await net.leave();
  resetMp(null);
  opp.remote = null;
  opp.setDifficulty(game.difficulty);
  $('opp-name').textContent = '"THE BRICK"';
  setOverlay(false);
  $('waiting').classList.add('hidden');
  toMenu();
  if (toLobby) openLobby();
}

// ---------------------------------------------------------------- incoming punch warning
const THREAT_DIR = { jab: 't', cross: 't', hookL: 'r', hookR: 'l', bodyR: 'b', upperR: 'b', superman: 't', kickL: 'b', kickR: 'b', kickBody: 'b' };
const GET_UP_TEXT = TOUCH ? 'TAP ANY BUTTON TO GET UP' : 'MASH SPACE TO GET UP';
const THREAT_HINT = TOUCH ? {
  jab: 'SLIP  ◀ ▶', cross: 'SLIP  ◀ ▶', hookL: 'DUCK', hookR: 'DUCK', bodyR: 'GUARD', upperR: 'SLIP  ◀ ▶',
  superman: 'SLIP  ◀ ▶', kickL: 'JUMP', kickR: 'JUMP', kickBody: 'GUARD',
} : {
  jab: 'SLIP  ALT + A / D', cross: 'SLIP  ALT + A / D', hookL: 'DUCK  C', hookR: 'DUCK  C',
  bodyR: 'BLOCK  SHIFT', upperR: 'SLIP  ALT + A / D',
  superman: 'SLIP  ALT + A / D', kickL: 'JUMP  SPACE', kickR: 'JUMP  SPACE', kickBody: 'BLOCK  SHIFT',
};
const threatEls = { t: null, l: null, r: null, b: null };
function updateThreat() {
  let hand = null;
  if (game.phase === 'fight' && opp.mode === 'fight' && player.mode === 'fight') {
    for (const h of [...opp.handList, opp.kickSlot]) {
      const pu = h.punch;
      if (pu && !pu.hit && !pu.blocked && !pu.feintShown && (pu.phase === 'wind' || pu.phase === 'ext')) hand = h;
    }
  }
  const box = $('threat');
  if (!threatEls.t) for (const k of Object.keys(threatEls)) threatEls[k] = box.querySelector('.' + k);
  if (!hand) { box.classList.remove('on'); return; }
  const pu = hand.punch;
  const dir = THREAT_DIR[pu.name];
  for (const [k, el] of Object.entries(threatEls)) el.classList.toggle('lit', k === dir);
  const u = pu.phase === 'wind' ? Math.min(1, pu.t / pu.wind) : 1;
  box.style.setProperty('--urgency', u.toFixed(2));
  $('threat-label').textContent = PUNCH_LABEL[pu.name];
  $('threat-hint').textContent = THREAT_HINT[pu.name];
  box.classList.add('on');
}

// ---------------------------------------------------------------- HUD
function banner(text) {
  const b = $('banner');
  b.textContent = text;
  b.classList.remove('show');
  void b.offsetWidth;
  b.classList.add('show');
}

function showImpact(label, speed, energy) {
  const el = $('impact');
  el.querySelector('.label').textContent = label;
  el.querySelector('.phys').textContent = speed == null ? '' : typeof speed === 'string' ? speed : `${speed.toFixed(1)} m/s · ${energy.toFixed(0)} J`;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

function updateHud(dt) {
  game.lagP = Math.max(player.health, game.lagP - dt * 25);
  game.lagO = Math.max(opp.health, game.lagO - dt * 25);
  $('p-health').style.width = `${player.health}%`;
  $('p-lag').style.width = `${game.lagP}%`;
  $('o-health').style.width = `${opp.health}%`;
  $('o-lag').style.width = `${game.lagO}%`;
  $('stamina').style.width = `${player.stamina}%`;
  $('p-cons').style.width = `${player.cons}%`;
  $('o-cons').style.width = `${opp.cons ?? 100}%`;
  $('p-cons').classList.toggle('low', player.cons < 35);
  // dazed: your vision blurs and dims
  const inst = player.mode === 'fight' || player.mode === 'idle' ? player.instability : 0;
  const filter = inst > 0.03 ? `blur(${(inst * 2.2).toFixed(1)}px) saturate(${(1 - inst * 0.6).toFixed(2)}) brightness(${(1 - inst * 0.25).toFixed(2)})` : '';
  if (filter !== game.filter) { game.filter = filter; canvas.style.filter = filter; }
  $('p-kd').textContent = player.knockdowns ? '▼ '.repeat(player.knockdowns) + 'KNOCKDOWNS' : '';
  $('o-kd').textContent = opp.knockdowns ? 'KNOCKDOWNS ' + '▼ '.repeat(opp.knockdowns) : '';
  const t = Math.max(0, Math.ceil(game.timer));
  $('timer').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  $('round').textContent = `ROUND ${game.round} / ${ROUNDS}`;
  const lowHealth = player.health < 25 ? 0.25 + 0.1 * Math.sin(game.time * 6) : 0;
  game.vignette = Math.max(0, game.vignette - dt * 1.2);
  $('vignette').style.opacity = Math.max(game.vignette, lowHealth);
  if (debugView.visible) {
    $('debug-info').textContent =
      `${world.world.bodies.len()} bodies · ${world.world.impulseJoints.len()} joints · ${Math.round(1 / STEP)} Hz × ${world.world.numSolverIterations} iters\n` +
      `opp tone ${opp.tone.toFixed(2)} · daze ${opp.daze.toFixed(2)} · ${opp.tactic}`;
  } else $('debug-info').textContent = '';
}

function setGlovesVisible(v) {
  for (const it of player.view.items) it.group.visible = it.arm.visible = v;
}

// ---------------------------------------------------------------- input
const canvas = renderer.domElement;
const inMatch = () => game.phase !== 'menu' && game.phase !== 'over';

function lockPointer() {
  if (game.noLock) return;
  try {
    const r = canvas.requestPointerLock?.();
    if (r && r.catch) r.catch(() => { game.noLock = true; });
  } catch { game.noLock = true; }
}

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (!locked && inMatch() && !game.noLock) setPaused(true);
});
document.addEventListener('pointerlockerror', () => { game.noLock = true; });

function setPaused(p) {
  if (mp.on) { if (p) overlay('MENU', 'The fight keeps going while this is open.', 'RESUME'); else setOverlay(false); return; }
  game.paused = p;
  if (p) overlay('PAUSED', 'Leaving ends the fight and returns to the menu.', 'RESUME', true);
  else setOverlay(false);
}

/** The pause panel doubles as the online "click to start" / menu panel. */
function overlay(title, note, resumeText, pausing = false) {
  $('pause-title').textContent = title;
  $('pause-note').textContent = note;
  $('resume').textContent = resumeText;
  game.overlay = !pausing;
  $('pause').classList.remove('hidden');
  player.keys.clear();
}
function setOverlay(v) {
  game.overlay = false;
  game.paused = game.paused && v;
  if (!v) $('pause').classList.add('hidden');
}

$('resume').addEventListener('click', () => { game.paused = false; setOverlay(false); goFullscreen(); lockPointer(); });
$('leave').addEventListener('click', () => { game.paused = false; setOverlay(false); if (mp.on) mpLeave(); else toMenu(); });

document.addEventListener('mousemove', (e) => {
  if (!inMatch() || game.paused || game.overlay) return;
  if (!document.pointerLockElement && !game.noLock) return;
  player.look(e.movementX || 0, e.movementY || 0);
});

canvas.addEventListener('mousedown', (e) => {
  if (!inMatch() || game.paused || game.overlay) return;
  if (game.phase === 'kocam' || game.phase === 'reel') { ko.skip = true; return; }
  if (!document.pointerLockElement && !game.noLock) { lockPointer(); return; }
  // (in the air, a straight becomes a superman punch)
  if (e.button === 0) player.requestPunch(0, 'straight');
  if (e.button === 2) player.requestPunch(1, 'straight');
});
window.addEventListener('contextmenu', (e) => e.preventDefault());

const DASH_KEYS = { KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right' };
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code.startsWith('Arrow') || e.altKey || e.key === 'Alt') e.preventDefault();   // Alt: no browser menu
  if (e.code === 'KeyV') debugView.toggle();
  if (e.code === 'KeyM') sfx.toggleMute();
  if (game.phase === 'reel') {   // highlight reel: any key skips, Esc stops
    if (e.code === 'Escape') reel.abort = true; else if (e.code === 'Space' || e.code === 'Enter') ko.skip = true;
    return;
  }
  if (!inMatch() || game.paused || game.overlay) return;
  if (e.repeat) return;
  // Alt + direction: slip / dash (doesn't also walk)
  if (e.altKey && DASH_KEYS[e.code]) { player.requestDash(DASH_KEYS[e.code]); return; }
  player.keys.add(e.code);
  if (e.code === 'KeyP') { setPaused(true); return; }
  if (game.phase === 'kocam') {
    if (e.code === 'Space' || e.code === 'Enter') ko.skip = true;
    return;
  }
  if (e.code === 'KeyQ') player.requestPunch(0, e.shiftKey ? 'bodyhook' : 'hook');
  if (e.code === 'KeyE') player.requestPunch(1, e.shiftKey ? 'bodyhook' : 'hook');
  // Z / X: uppercuts; with Shift: left / right kick
  if (e.code === 'KeyZ') { if (e.shiftKey) player.requestKick(-1); else player.requestPunch(0, 'uppercut'); }
  if (e.code === 'KeyX') { if (e.shiftKey) player.requestKick(1); else player.requestPunch(1, 'uppercut'); }
  if (e.code === 'KeyC' && player.mode === 'fight' && !mp.on) opp.noteHabit('duck');
  if (e.code === 'Space') {
    if (player.mode === 'down') { if (player.knockdowns < 3) player.recover += 0.085; }
    else player.requestJump();
  }
});
window.addEventListener('keyup', (e) => { player.keys.delete(e.code); if (e.key === 'Alt') e.preventDefault(); });
window.addEventListener('blur', () => player.keys.clear());

document.querySelectorAll('[data-diff]').forEach((b) => b.addEventListener('click', () => {
  game.difficulty = b.dataset.diff;
  document.querySelectorAll('[data-diff]').forEach((o) => o.classList.toggle('sel', o === b));
}));
$('start').addEventListener('click', startMatch);
$('again').addEventListener('click', () => (mp.on ? mpLeave(true) : startMatch()));
$('to-menu').addEventListener('click', () => (mp.on ? mpLeave() : toMenu()));
$('online-btn').addEventListener('click', openLobby);
$('lobby-back').addEventListener('click', () => { $('lobby').classList.add('hidden'); $('menu').classList.remove('hidden'); });
$('host-btn').addEventListener('click', hostMatch);
$('join-btn').addEventListener('click', () => joinMatch($('code-input').value));
$('code-input').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') joinMatch($('code-input').value); });
$('nick').addEventListener('keydown', (e) => e.stopPropagation());
$('cancel-host').addEventListener('click', () => mpLeave(true));
$('highlights-btn').addEventListener('click', watchHighlights);

player.onPunch = (g, type) => {
  game.stats.thrown++;
  if (mp.on) mp.names.set(g.punch.seq, punchName(g, type));
  else opp.notifyIncoming(game.time, type === 'bodyhook' || type === 'kick', type === 'superman');
};
player.onSwing = (g) => sfx.whoosh(g.punch?.type === 'superman' || g.isLeg ? 0.9 : 0.5);
player.onMiss = () => { if (!mp.on && game.phase === 'fight') opp.onOpening(game.time); };   // he punishes misses
player.onJump = () => {
  sfx.whoosh(0.3);
  // a jump is the superman punch's tell: he sees it coming
  if (!mp.on) { opp.notifyIncoming(game.time, false, true); opp.noteHabit('jump'); }
};
player.onDash = () => sfx.whoosh(0.4);
player.onTrip = () => { sfx.punch(0.6, 'body'); arena.excitement += 1; };
opp.onTrip = () => { arena.excitement += 1.2; };
opp.onSwing = () => { sfx.whoosh(0.3); game.stats.oppThrown++; };
player.onDodge = () => { sfx.whoosh(0.45); if (!mp.on) opp.noteHabit('slip'); };
// A strike that misses while you were moving your head (or jumping its kick) leaves him open for a counter.
opp.onWhiff = (o, hand) => {
  if (game.phase !== 'fight' || player.mode !== 'fight') return;
  const ducked = player.duck > 0.15;
  if (!player.dodging && !ducked && !player.airborne) return;
  hand.punch.whiffed = true;
  o.staggerT = Math.max(o.staggerT, 0.35);
  o.comboQueue = [];
  game.counterUntil = game.time + 0.7;
  game.stats.dodged++;
  player.stamina = Math.min(100, player.stamina + 6);
  const how = player.dodging ? 'SLIP' : player.airborne ? 'JUMP' : 'DUCK';
  showImpact(`${how === 'SLIP' ? 'SLIPPED' : how === 'JUMP' ? 'JUMPED' : 'DUCKED'}!`, 'counter now');
  logEvent('dodge', how);
};

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- touch
if (TOUCH) {
  game.noLock = true;   // no mouse to lock
  scene.traverse((o) => { if (o.isLight && o.castShadow) o.shadow.mapSize.set(1024, 1024); });
}
const touch = TOUCH ? new TouchControls({
  root: $('touch'),
  player,
  active: () => inMatch() && !game.paused && !game.overlay && game.phase !== 'kocam',
  onPress: () => { if (inMatch() && player.mode === 'down' && player.knockdowns < 3) player.recover += 0.085; },
  onPause: () => { if (inMatch()) setPaused(true); },
}) : null;
// tap to skip the knockout replay
document.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse' && (game.phase === 'kocam' || game.phase === 'reel')) ko.skip = true; });

// ---------------------------------------------------------------- loop
function updatePhase(dt, dtReal) {
  if (mp.on) {
    if (game.phase === 'kowait' && game.time >= ko.hitTime + KO_AFTER) startKoCam();
    return;
  }
  switch (game.phase) {
    case 'intro':
      game.phaseT += dtReal;
      if (game.phaseT > 1.6) {
        game.phase = 'fight';
        player.mode = 'fight';
        opp.mode = 'fight';
        sfx.bell(1);
        banner('FIGHT!');
      }
      break;
    case 'fight':
      game.timer -= dt;
      if (game.timer <= 0) endRound();
      break;
    case 'knockdown':
      updateKnockdown(dtReal);
      break;
    case 'kowait':
      if (game.time >= ko.hitTime + KO_AFTER) startKoCam();
      break;
    case 'rest':
      game.phaseT += dtReal;
      if (game.phaseT > 4.5) { game.round++; startRound(); }
      break;
    default:
      break;
  }
}

function substep(h) {
  player.preStep(h);
  opp.preStep(h, ctx);
  if (referee.active) referee.preStep(h);
  world.step(h, onContact);
  flushContacts();
  keepEyesOut();
}

toMenu();
let last = performance.now();
let acc = 0;
renderer.setAnimationLoop((now) => {
  const dtReal = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (game.paused && !mp.on) { touch?.setVisible(false); renderer.render(scene, camera); return; }
  if (mp.on) mpUpdate(dtReal, dtReal, now);
  if (game.phase === 'kocam' || game.phase === 'reel') {
    if (game.filter) { game.filter = ''; canvas.style.filter = ''; }
    updateKoCam(dtReal);
    arena.updateCrowd(dtReal);
    renderer.render(scene, camera);
    return;
  }

  if (game.hitStop > 0) { game.hitStop -= dtReal; game.timeScale = 0.05; }
  else if (game.slowmo > 0) { game.slowmo -= dtReal; game.timeScale = 0.25; }
  else game.timeScale = Math.min(1, game.timeScale + dtReal * (game.timeScale < 0.2 ? 12 : 2));
  const dt = dtReal * game.timeScale;
  game.time += dt;
  ctx.time = game.time;

  updatePhase(dt, dtReal);
  opp.think(dt, ctx);
  refCtx.time = game.time;
  refCtx.down = game.downWho === 'opp' && opp.mode === 'down' ? opp.p.pelvis.pos : game.downWho === 'player' && player.mode === 'down' ? player.body.p.pelvis.pos : null;
  refCtx.counting = !!refCtx.down && game.phase === 'knockdown';
  if (referee.active) referee.think(dt, refCtx);

  acc += dt;
  let n = 0;
  while (acc >= STEP && n < MAX_STEPS) { substep(STEP); acc -= STEP; n++; }
  if (n === MAX_STEPS) acc = 0;

  player.avatar.tick(dt);
  if (game.phase !== 'menu') recordFrame();
  // a combo ends when you've done nothing for a moment
  if (combo.cur && game.phase !== 'kowait' && game.time - combo.cur.last > COMBO_GAP) finishCombo();
  arena.updateCrowd(dtReal);
  opp.view.update();
  referee.view.update();
  debugView.update();

  if (game.phase === 'menu') {
    const a = game.time * 0.12;
    camera.position.set(Math.sin(a) * 2.9, 1.75, Math.cos(a) * 2.9);   // inside the cage
    camera.lookAt(opp.p.chest.pos.x, 1.2, opp.p.chest.pos.z);
  } else {
    player.updateCamera(camera);
    camera.updateMatrixWorld();
    player.view.update(camera);
    player.legView.update(camera);
    updateHud(dtReal);
    updateThreat();
  }
  touch?.setVisible(inMatch() && !game.paused && !game.overlay && game.phase !== 'kocam' && game.phase !== 'reel');
  renderer.render(scene, camera);
});

// handy for tinkering from the console
window.game = { renderer, scene, debugView, referee, refCtx, ctx, substep, camera, game, player, opp, world, arena, startMatch, oppKnockdown, mp, net, combo, reel, rateAt, watchHighlights, finishCombo, recordFrame, startKoCam, updateReel, finish };
