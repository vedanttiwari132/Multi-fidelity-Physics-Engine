// Knockout Physics — game loop, rules and HUD.

import * as THREE from 'three';
import { World, collideParticles, collideParticleSphere } from './physics.js';
import { Opponent, PUNCH_LABEL } from './fighter.js';
import { Player } from './player.js';
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
const GLOVE_MASS = 3;
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

const world = new World({ iterations: 6 });
const arena = new Arena(scene, world);
const player = new Player(world, scene);
const opp = new Opponent(world, scene);
const debugView = new PhysicsDebugView(scene, world);
const sfx = new Sfx();

const game = {
  phase: 'menu', // menu | intro | fight | knockdown | rest | over
  round: 1, timer: ROUND_TIME, difficulty: 'normal',
  time: 0, timeScale: 1, slowmo: 0, phaseT: 0,
  count: 0, countT: 0, downWho: null, getUpAt: 0,
  paused: false, overlay: false, noLock: false, vignette: 0, lagP: 100, lagO: 100, counterUntil: -1,
  stats: null,
};
const ctx = { playerPos: player.pos, playerHead: player.headPos, playerChest: player.chestPos, time: 0 };

function newStats() {
  return { thrown: 0, landed: 0, blocked: 0, dodged: 0, topSpeed: 0, topEnergy: 0, dealt: 0, taken: 0, oppThrown: 0, oppLanded: 0 };
}
game.stats = newStats();

// ---------------------------------------------------------------- contacts
const impulse = new THREE.Vector3();
const BODY_PARTS = ['head', 'neck', 'chest', 'belly', 'pelvis', 'shoulderL', 'shoulderR', 'hipL', 'hipR', 'kneeL', 'kneeR'];

world.collisionHook = (h, iter) => {
  for (const g of player.gloves) {
    // Body hooks swing around his arms unless he has dropped his guard to cover the body.
    const aroundArms = g.punch && g.punch.type === 'bodyhook' && g.punch.phase !== 'ret' && !opp.coverLow;
    // Resting gloves don't parry for you: his punches only meet your gloves when you hold guard or are punching.
    const gloveActive = player.guarding || !!g.punch;
    for (const p of opp.list) {
      if (aroundArms && p.region === 'guard') continue;
      if (p.hand && !gloveActive) continue;
      const s = collideParticles(g.particle, p, h, 0.15);
      if (s >= 0) onGloveContact(g, p, s);
    }
  }
  if (game.phase !== 'menu') {
    for (const hand of opp.handList) {
      const hp = opp.p[hand.name];
      let s = collideParticleSphere(hp, player.headPos, player.headRadius, player.headVel, 1 / 5, h, 0.1, impulse);
      if (s >= 0) onPlayerStruck(hand, s, impulse, 'head');
      s = collideParticleSphere(hp, player.chestPos, 0.2, player.vel, 1 / 30, h, 0.1, impulse);
      if (s >= 0) onPlayerStruck(hand, s, impulse, 'body');
    }
  }
  if (iter === 0) {
    bodyContact();
    arena.collideRopes(opp.list, player);
  }
};

function bodyContact() {
  const R = 0.3;
  for (const name of BODY_PARTS) {
    const p = opp.p[name];
    if (p.pos.y > player.headBase.y + 0.2) continue;
    const dx = p.pos.x - player.pos.x, dz = p.pos.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    const minD = R + p.radius;
    if (d < minD && d > 1e-6) {
      const pen = minD - d, nx = dx / d, nz = dz / d;
      p.pos.x += nx * pen * 0.8; p.pos.z += nz * pen * 0.8;
      player.pos.x -= nx * pen * 0.2; player.pos.z -= nz * pen * 0.2;
    }
  }
}

function onGloveContact(g, p, speed) {
  // Your glove intercepted one of his punches -> block
  const hp = p.hand?.punch;
  if (hp && !hp.hit && !hp.blocked && hp.phase === 'ext' && speed > 1) {
    hp.blocked = true;
    game.stats.blocked++;
    // Absorbing a punch costs more stamina than throwing one, and some of it still gets through.
    // (A glove that merely gets in the way, without holding guard, costs less and lets nothing through.)
    const guarded = player.guarding;
    const drain = THREE.MathUtils.clamp(4 + speed * 1.3 * hp.def.power * opp.diff.power, 6, 20) * (guarded ? 1 : 0.5);
    player.stamina = Math.max(0, player.stamina - drain);
    const chip = guarded ? Math.max(0, speed - 2.0) * 2.4 * opp.diff.damage * hp.def.power * 0.25 : 0;
    player.health = Math.max(0, player.health - chip);
    game.stats.taken += chip;
    game.vignette = Math.min(1, game.vignette + chip / 10);
    sfx.block(speed / 8);
    const broken = player.stamina <= 0;
    if (!broken) hp.hit = true;   // guard held: no clean shot; broken guard: the glove can still reach your head
    publishHit(hp, chip, 2, Math.max(speed, hp.speed || 0), 0, false);
    showImpact(broken ? 'GUARD BROKEN' : guarded ? 'BLOCKED' : 'PARRIED', `−${drain.toFixed(0)} stamina${chip ? ` · −${chip.toFixed(1)} health` : ''}`);
    if (player.health <= 0 && player.mode === 'fight') playerKnockdown();
    return;
  }
  const pu = g.punch;
  if (!pu || pu.done || pu.phase === 'wind' || speed < 1.5) return;
  pu.done = true;
  const mu = (GLOVE_MASS * p.mass) / (GLOVE_MASS + p.mass);
  const energy = 0.5 * mu * speed * speed;
  if (mp.on) {   // online: the person you hit decides the damage and reports it back
    if (p.region === 'guard') sfx.block(speed / 8); else sfx.punch(Math.min(1, speed / 9), p.region);
    return;
  }
  if (opp.mode !== 'fight') { sfx.punch(0.2, 'body'); return; }
  if (p.region === 'guard') {
    sfx.block(speed / 8);
    showImpact('BLOCKED', speed, energy);
    opp.coverT = Math.max(opp.coverT, 0.25);
    return;
  }
  if (p.region === 'low') { sfx.punch(0.3, 'body'); showImpact('LOW', speed, energy); return; }

  const counter = opp.isPunching() || game.time < game.counterUntil;
  const mult = p.region === 'head' ? 1 : pu.type === 'bodyhook' ? 0.9 : 0.6;
  const dmg = Math.max(0, speed - 2.2) * 2.2 * pu.power * mult * (counter ? 1.25 : 1);
  game.stats.landed++;
  game.stats.dealt += dmg;
  game.stats.topSpeed = Math.max(game.stats.topSpeed, speed);
  game.stats.topEnergy = Math.max(game.stats.topEnergy, energy);
  opp.takeHit(dmg, p.region);
  sfx.punch(speed / 9, p.region);
  arena.excitement += dmg / 20;
  const label = counter ? 'COUNTER!' : p.region === 'head' ? (dmg > 14 ? 'HUGE SHOT' : 'HEAD') : 'BODY SHOT';
  showImpact(label, speed, energy);
  if (opp.health <= 0) oppKnockdown({ name: punchName(g, pu.type), speed, energy });
}

function onPlayerStruck(hand, speed, imp, region) {
  if (player.mode !== 'fight') { player.takeHit(imp, 0, region); return; }
  const pu = hand.punch;
  let dmg = 0;
  // Only a glove still travelling forward does damage, not one on its way back.
  const travelling = pu && (pu.phase === 'ext' || (!pu.mirror && pu.phase === 'ret' && pu.t < pu.wind + pu.def.ext + 0.05));
  if (pu?.mirror) speed = Math.max(speed, pu.speed || 0);   // online: use their real glove speed
  if (pu && !pu.hit && travelling && speed > 1.5) {
    pu.hit = true;
    const counter = mp.on && (mp.rs?.ctr || player.gloves.some((g) => g.punch?.phase === 'ext'));
    dmg = Math.max(0, speed - 2.0) * 2.4 * opp.diff.damage * pu.def.power * (region === 'head' ? 1 : 0.5) * (counter ? 1.25 : 1);
    if (region === 'body' && player.guarding) dmg *= 0.5;
    publishHit(pu, dmg, region === 'head' ? 0 : 1, speed, 0.5 * (15 / 8) * speed * speed, counter);
    game.stats.taken += dmg;
    game.stats.oppLanded++;
    sfx.punch(speed / 9, region);
    game.vignette = Math.min(1, game.vignette + dmg / 16);
    arena.excitement += dmg / 25;
  }
  player.takeHit(imp, dmg, region);
  if (player.health <= 0) playerKnockdown();
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
  opp.setDifficulty(game.difficulty);
  player.reset(0, 1.45, 0);
  opp.reset(0, -1.45, 0);
  opp.knockdowns = 0;
  game.stats = newStats();
  game.round = 1;
  game.lagP = game.lagO = 100;
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
  return { straight: g.side < 0 ? 'JAB' : 'CROSS', hook: `${side} HOOK`, uppercut: `${side} UPPERCUT`, bodyhook: `${side} BODY HOOK` }[type];
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
  const base = { easy: 3, normal: 4, hard: 5 }[game.difficulty];
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

function finish(won, method) {
  game.phase = 'over';
  player.mode = player.mode === 'down' ? 'down' : 'idle';
  if (opp.mode !== 'down') opp.mode = 'idle';
  $('count').textContent = '';
  $('recover').classList.add('hidden');
  sfx.bell(3);
  sfx.crowdCheer(1.5);
  arena.excitement = 2.5;
  banner(won === null ? 'DRAW' : won ? 'YOU WIN!' : 'YOU LOSE');
  setTimeout(() => {
    if (game.phase !== 'over') return;   // left before the results came up
    const s = game.stats;
    $('res-title').textContent = won === null ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT';
    $('res-detail').textContent = `${won === null ? '' : won ? 'Won' : 'Lost'} by ${method.toLowerCase()} · round ${game.round}`;
    const acc = s.thrown ? Math.round((100 * s.landed) / s.thrown) : 0;
    const rows = [
      ['Punches landed', `${s.landed} / ${s.thrown} (${acc}%)`],
      ['Damage dealt / taken', `${s.dealt.toFixed(0)} / ${s.taken.toFixed(0)}`],
      ['Hardest punch', `${s.topSpeed.toFixed(1)} m/s · ${s.topEnergy.toFixed(0)} J`],
      ['Their punches blocked / dodged', `${s.blocked} / ${s.dodged}`],
      ['Knockdowns (scored / suffered)', `${opp.knockdowns || 0} / ${player.knockdowns}`],
    ];
    $('res-stats').innerHTML = rows.map(([a, b]) => `<div>${a}</div><div>${b}</div>`).join('');
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
  setGlovesVisible(false);
}

// ---------------------------------------------------------------- knockout cam
// Every frame we record all particle positions. On a knockdown the last ~2 s are
// replayed in slow motion from a third-person camera that orbits the impact.
const KO_BEFORE = 0.8, KO_AFTER = 1.15;
const REC_FRAMES = 480;
const NP = world.particles.length;
const NX = 9;   // extra per-frame values (see extrasInto)
const rec = { t: new Float64Array(REC_FRAMES), pos: new Float32Array(REC_FRAMES * NP * 3), extra: new Float32Array(REC_FRAMES * NX), head: 0, count: 0 };
const live = { pos: new Float32Array(NP * 3), prev: new Float32Array(NP * 3), extra: new Float32Array(NX) };
const ko = { hitTime: 0, t: 0, info: null, skip: false, impactPlayed: false, center: new THREE.Vector3(), angle0: 0, shake: 0 };
const _look = new THREE.Vector3();
const _bodyQ = { quaternion: new THREE.Quaternion() };

function extrasInto(arr, o) {
  arr[o] = player.pos.x; arr[o + 1] = player.pos.z; arr[o + 2] = player.yaw; arr[o + 3] = player.twist;
  arr[o + 4] = opp.yaw; arr[o + 5] = player.duck;
  arr[o + 6] = player.vel.x; arr[o + 7] = player.vel.z; arr[o + 8] = player.avatar.phase;
}
function extrasFrom(arr, o) {
  player.pos.x = arr[o]; player.pos.z = arr[o + 1]; player.yaw = arr[o + 2]; player.twist = arr[o + 3];
  opp.yaw = arr[o + 4]; player.duck = arr[o + 5];
  player.vel.x = arr[o + 6]; player.vel.z = arr[o + 7]; player.avatar.phase = arr[o + 8];
}

function recordFrame() {
  const i = rec.head;
  rec.t[i] = game.time;
  const base = i * NP * 3;
  world.particles.forEach((p, k) => { rec.pos[base + k * 3] = p.pos.x; rec.pos[base + k * 3 + 1] = p.pos.y; rec.pos[base + k * 3 + 2] = p.pos.z; });
  extrasInto(rec.extra, i * NX);
  rec.head = (i + 1) % REC_FRAMES;
  rec.count = Math.min(REC_FRAMES, rec.count + 1);
}

function sampleReplay(time) {
  // frames are in chronological order starting at the oldest one
  const first = (rec.head - rec.count + REC_FRAMES) % REC_FRAMES;
  let a = first, b = first;
  for (let n = 0; n < rec.count; n++) {
    const i = (first + n) % REC_FRAMES;
    if (rec.t[i] <= time) a = i;
    if (rec.t[i] >= time) { b = i; break; }
    b = i;
  }
  const span = rec.t[b] - rec.t[a];
  const u = span > 1e-6 ? THREE.MathUtils.clamp((time - rec.t[a]) / span, 0, 1) : 0;
  const ba = a * NP * 3, bb = b * NP * 3;
  world.particles.forEach((p, k) => {
    const j = k * 3;
    p.pos.set(
      rec.pos[ba + j] + (rec.pos[bb + j] - rec.pos[ba + j]) * u,
      rec.pos[ba + j + 1] + (rec.pos[bb + j + 1] - rec.pos[ba + j + 1]) * u,
      rec.pos[ba + j + 2] + (rec.pos[bb + j + 2] - rec.pos[ba + j + 2]) * u,
    );
  });
  extrasFrom(rec.extra, u < 0.5 ? a * NX : b * NX);
}

function startKoCam() {
  world.particles.forEach((p, k) => {
    live.pos[k * 3] = p.pos.x; live.pos[k * 3 + 1] = p.pos.y; live.pos[k * 3 + 2] = p.pos.z;
    live.prev[k * 3] = p.prev.x; live.prev[k * 3 + 1] = p.prev.y; live.prev[k * 3 + 2] = p.prev.z;
  });
  extrasInto(live.extra, 0);
  game.phase = 'kocam';
  ko.t = ko.hitTime - KO_BEFORE;
  ko.skip = false; ko.impactPlayed = false; ko.shake = 0;
  // frame the shot from the side of the line between the two fighters
  sampleReplay(ko.hitTime);
  const dx = opp.p.head.pos.x - player.pos.x, dz = opp.p.head.pos.z - player.pos.z;
  ko.center.set(player.pos.x + dx * 0.55, 0, player.pos.z + dz * 0.55);
  ko.angle0 = Math.atan2(dz, dx) + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2 - 0.35);
  player.avatar.group.visible = true;
  $('hud').classList.add('hidden');
  $('kocam').classList.remove('hidden');
  const i = ko.info;
  $('kc-caption').textContent = i ? `${i.name} · ${i.speed.toFixed(1)} m/s · ${i.energy.toFixed(0)} J` : '';
  $('kc-caption').classList.remove('show');
}

function updateKoCam(dtReal) {
  const near = Math.abs(ko.t - ko.hitTime);
  const rate = (0.12 + 0.33 * Math.min(1, near / 0.35)) * (mp.on ? 1.6 : 1);   // slowest right at the impact; quicker online
  ko.t += dtReal * rate;
  if (!ko.impactPlayed && ko.t >= ko.hitTime) {
    ko.impactPlayed = true;
    ko.shake = 1;
    sfx.punch(1.4, 'head');
    sfx.crowdCheer(1.5);
    $('kc-caption').classList.add('show');
  }
  sampleReplay(ko.t);
  const prog = (ko.t - (ko.hitTime - KO_BEFORE)) / (KO_BEFORE + KO_AFTER);
  const ang = ko.angle0 + prog * 0.6;
  ko.shake = Math.max(0, ko.shake - dtReal * 2.5);
  const sh = ko.shake * 0.03;
  camera.position.set(ko.center.x + Math.cos(ang) * 2.3 + (Math.random() - 0.5) * sh, 1.45 - prog * 0.35 + (Math.random() - 0.5) * sh, ko.center.z + Math.sin(ang) * 2.3);
  _look.copy(opp.p.head.pos).lerp(ko.center.setY(1.2), 0.35);
  camera.lookAt(_look);
  ko.center.y = 0;

  _bodyQ.quaternion.setFromEuler(new THREE.Euler(0, player.yaw + player.twist, 0, 'YXZ'));
  opp.view.update();
  player.view.update(_bodyQ);
  player.avatar.update();
  arena.updateRopes();
  debugView.update();
  if (ko.t >= ko.hitTime + KO_AFTER || ko.skip) endKoCam();
}

function endKoCam() {
  world.particles.forEach((p, k) => {
    p.pos.set(live.pos[k * 3], live.pos[k * 3 + 1], live.pos[k * 3 + 2]);
    p.prev.set(live.prev[k * 3], live.prev[k * 3 + 1], live.prev[k * 3 + 2]);
  });
  extrasFrom(live.extra, 0);
  player.avatar.group.visible = false;
  $('kocam').classList.add('hidden');
  $('hud').classList.remove('hidden');
  game.count = 0; game.countT = 0;
  if (mp.on) {
    const m = mp.role === 'host' ? mp.m : mp.rs?.m;
    game.phase = m?.phase === 'over' ? 'over' : (['intro', 'fight', 'knockdown', 'rest'].includes(m?.phase) ? m.phase : 'knockdown');
    if (m?.phase === 'knockdown' && m.count > 0) $('count').textContent = m.count;
  } else game.phase = 'knockdown';
}


// ---------------------------------------------------------------- online play
// The host runs the match clock (rounds, knockdown counts, result). Each fighter
// decides for themselves whether a punch reached their own head, so a dodge that
// worked on your screen always counts, and reports what they took back to the puncher.
const net = new Net();
const MP_DIFF = { damage: 0.9, power: 1 };
const PH = ['none', 'wind', 'ext', 'ret'];
const TYPES = ['straight', 'hook', 'uppercut', 'bodyhook'];
const TYPE_POWER = { straight: 1, hook: 1.15, uppercut: 1.15, bodyhook: 1.1 };
const MODES = ['fight', 'idle', 'down', 'rising'];
const remoteBody = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), head: new THREE.Vector3(0, 1.6, 0), gloves: [new THREE.Vector3(), new THREE.Vector3()], yaw: 0 };
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
  const s = [player.pos.x, player.pos.z, player.vel.x, player.vel.z, player.yaw + player.twist,
    player.headPos.x, player.headPos.y, player.headPos.z,
    ...player.gloves[0].particle.pos.toArray(), ...player.gloves[1].particle.pos.toArray()].map(r3);
  const st = { role: mp.role, name: net.name, s, k, mode: player.mode, hp: r3(player.health), kd: player.knockdowns,
    taken: r3(game.stats.taken), ctr: game.time < game.counterUntil ? 1 : 0 };
  if (mp.hitLog.length) st.hit = mp.hitLog;
  if (mp.role === 'host') { st.m = mp.m; st.opp = mp.peer; }
  return st;
}

function readRemote(p) {
  const pr = p.presence || {};
  const s = pr.s, k = pr.k;
  if (!Array.isArray(s) || s.length !== 14 || !Array.isArray(k) || k.length !== 8) return false;
  const r = remoteBody;
  r.pos.set(num(s[0], -3.2, 3.2), 0, num(s[1], -3.2, 3.2));
  r.vel.set(num(s[2], -5, 5), 0, num(s[3], -5, 5));
  r.yaw = num(s[4], -1e4, 1e4);
  r.head.set(num(s[5], -3.5, 3.5), num(s[6], 0.2, 2.2, 1.6), num(s[7], -3.5, 3.5));
  r.gloves[0].set(num(s[8], -3.5, 3.5), num(s[9], 0, 2.4, 1.3), num(s[10], -3.5, 3.5));
  r.gloves[1].set(num(s[11], -3.5, 3.5), num(s[12], 0, 2.4, 1.3), num(s[13], -3.5, 3.5));
  for (const g of r.gloves) if (g.distanceTo(r.head) > 1.1) g.sub(r.head).setLength(1.1).add(r.head);   // no impossible reach
  mp.rs = {
    mode: MODES.includes(pr.mode) ? pr.mode : 'idle', hp: num(pr.hp, 0, 100, 100), kd: num(pr.kd, 0, 9) | 0,
    taken: num(pr.taken, 0, 1e5), ctr: pr.ctr === 1, name: cleanName(pr.name),
    hit: Array.isArray(pr.hit) ? pr.hit : null, m: pr.m && typeof pr.m === 'object' ? pr.m : null,
    opp: typeof pr.opp === 'string' ? pr.opp : null,
  };
  mirrorPunches(k);
  return true;
}

const AI_NAME = (type, i) => (type === 'straight' ? (i === 0 ? 'jab' : 'cross') : type === 'hook' ? (i === 0 ? 'hookL' : 'hookR')
  : type === 'uppercut' ? 'upperR' : 'bodyR');

/** Copy their punches onto the puppet's hands so blocking, dodging, the warning ring and glow all work. */
function mirrorPunches(k) {
  for (let i = 0; i < 2; i++) {
    const hand = i === 0 ? opp.hands.L : opp.hands.R;
    const ph = PH[num(k[i * 4], 0, 3) | 0], type = TYPES[num(k[i * 4 + 1], 0, 3) | 0];
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
}

/** Their punch finished without touching you: reward the dodge. */
function endMirror(pu) {
  if (pu.ended) return;
  pu.ended = true;
  if (!pu.sawExt || pu.hit || pu.blocked || player.mode !== 'fight' || game.phase !== 'fight') return;
  if (!player.dodging && player.duck < 0.15) return;
  game.counterUntil = game.time + 0.7;
  game.stats.dodged++;
  player.stamina = Math.min(100, player.stamina + 6);
  showImpact(player.dodging ? 'SLIPPED!' : 'DUCKED!', 'counter now');
}

/** You were hit (or blocked): tell the puncher. region 0 head, 1 body, 2 blocked. */
function publishHit(pu, dmg, region, speed, energy, counter) {
  if (!mp.on) return;
  mp.hitSeq++;
  // keep the last few, so two hits between network updates both get reported
  mp.hitLog = [...mp.hitLog, [mp.hitSeq, pu.seq, r3(dmg), region, r3(speed), r3(energy), counter ? 1 : 0]].slice(-4);
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
  const punchSeq = num(h[1], 0, 1e9) | 0, dmg = num(h[2], 0, 100), region = num(h[3], 0, 2) | 0;
  const speed = num(h[4], 0, 30), energy = num(h[5], 0, 2000), counter = h[6] === 1;
  if (region === 2) { showImpact('BLOCKED', speed, energy); return; }
  game.stats.landed++;
  game.stats.dealt += dmg;
  game.stats.topSpeed = Math.max(game.stats.topSpeed, speed);
  game.stats.topEnergy = Math.max(game.stats.topEnergy, energy);
  arena.excitement += dmg / 20;
  showImpact(counter ? 'COUNTER!' : region === 0 ? (dmg > 14 ? 'HUGE SHOT' : 'HEAD') : 'BODY SHOT', speed, energy);
  mp.lastInfo = { name: mp.names.get(punchSeq) || 'PUNCH', speed, energy };
}

function syncRemoteMode() {
  const rm = mp.rs.mode;
  if (rm === 'down' && opp.mode !== 'down') { opp.knockDown(); onRemoteKnockdown(); }
  else if ((rm === 'rising' || rm === 'fight') && opp.mode === 'down') opp.rise(mp.rs.hp);
  else if (rm === 'idle' && opp.mode === 'fight') opp.mode = 'idle';
  else if (rm === 'fight' && opp.mode === 'idle') opp.mode = 'fight';
  opp.health = mp.rs.hp;
  opp.knockdowns = mp.rs.kd;
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
  opp.remote = remoteBody;
  opp.diff = MP_DIFF;
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
const THREAT_DIR = { jab: 't', cross: 't', hookL: 'r', hookR: 'l', bodyR: 'b', upperR: 'b' };
const GET_UP_TEXT = TOUCH ? 'TAP ANY BUTTON TO GET UP' : 'MASH SPACE TO GET UP';
const THREAT_HINT = TOUCH ? {
  jab: 'SLIP  ◀ ▶', cross: 'SLIP  ◀ ▶', hookL: 'DUCK', hookR: 'DUCK', bodyR: 'GUARD', upperR: 'SLIP  ◀ ▶',
} : {
  jab: 'SLIP  ⇧ + CLICK', cross: 'SLIP  ⇧ + CLICK', hookL: 'DUCK  C', hookR: 'DUCK  C',
  bodyR: 'BLOCK  SPACE', upperR: 'SLIP  ⇧ + CLICK',
};
const threatEls = { t: null, l: null, r: null, b: null };
function updateThreat() {
  let hand = null;
  if (game.phase === 'fight' && opp.mode === 'fight' && player.mode === 'fight') {
    for (const h of opp.handList) {
      const pu = h.punch;
      if (pu && !pu.hit && !pu.blocked && (pu.phase === 'wind' || pu.phase === 'ext')) hand = h;
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
      `${world.particles.length} particles · ${world.constraints.length} constraints · ${Math.round(1 / STEP)} Hz × ${world.iterations} iters\n` +
      `opp tone ${opp.tone.toFixed(2)} · daze ${opp.daze.toFixed(2)} · ${opp.tactic}`;
  } else $('debug-info').textContent = '';
}

function setGlovesVisible(v) {
  for (const it of player.view.items) it.group.visible = it.fore.visible = it.upper.visible = v;
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
  if (game.phase === 'kocam') { ko.skip = true; return; }
  if (!document.pointerLockElement && !game.noLock) { lockPointer(); return; }
  if (e.shiftKey) {   // Shift + left/right click: slip your head that way
    if (e.button === 0) player.requestDodge('left');
    if (e.button === 2) player.requestDodge('right');
    return;
  }
  if (e.button === 0) player.requestPunch(0, 'straight');
  if (e.button === 2) player.requestPunch(1, 'straight');
});
window.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  if (e.code === 'KeyV') debugView.toggle();
  if (e.code === 'KeyM') sfx.toggleMute();
  if (!inMatch() || game.paused || game.overlay) return;
  if (e.repeat) return;
  player.keys.add(e.code);
  if (e.code === 'KeyP') { setPaused(true); return; }
  if (game.phase === 'kocam') {
    if (e.code === 'Space' || e.code === 'Enter') ko.skip = true;
    return;
  }
  if (e.code === 'KeyQ') player.requestPunch(0, e.shiftKey ? 'bodyhook' : 'hook');
  if (e.code === 'KeyE') player.requestPunch(1, e.shiftKey ? 'bodyhook' : 'hook');
  if (e.code === 'KeyZ') player.requestPunch(0, 'uppercut');
  if (e.code === 'KeyX') player.requestPunch(1, 'uppercut');
  if (e.code === 'Space' && player.mode === 'down' && player.knockdowns < 3) {
    player.recover += 0.085;
  }
});
window.addEventListener('keyup', (e) => player.keys.delete(e.code));
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

player.onPunch = (g, type) => {
  game.stats.thrown++;
  if (mp.on) mp.names.set(g.punch.seq, punchName(g, type));
  else opp.notifyIncoming(game.time, type === 'bodyhook');
};
player.onSwing = () => sfx.whoosh(0.5);
opp.onSwing = () => { sfx.whoosh(0.3); game.stats.oppThrown++; };
player.onDodge = () => sfx.whoosh(0.45);
// A punch that misses while you were moving your head leaves him open for a counter.
opp.onWhiff = (o, hand) => {
  if (game.phase !== 'fight' || player.mode !== 'fight') return;
  const ducked = player.duck > 0.15;
  if (!player.dodging && !ducked) return;
  hand.punch.whiffed = true;
  o.staggerT = Math.max(o.staggerT, 0.35);
  o.comboQueue = [];
  game.counterUntil = game.time + 0.7;
  game.stats.dodged++;
  player.stamina = Math.min(100, player.stamina + 6);
  showImpact(player.dodging ? 'SLIPPED!' : 'DUCKED!', 'counter now');
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
document.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse' && game.phase === 'kocam') ko.skip = true; });

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
  world.step(h);
}

toMenu();
let last = performance.now();
let acc = 0;
renderer.setAnimationLoop((now) => {
  const dtReal = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (game.paused && !mp.on) { touch?.setVisible(false); renderer.render(scene, camera); return; }
  if (mp.on) mpUpdate(dtReal, dtReal, now);
  if (game.phase === 'kocam') {
    updateKoCam(dtReal);
    arena.updateCrowd(dtReal);
    renderer.render(scene, camera);
    return;
  }

  if (game.slowmo > 0) { game.slowmo -= dtReal; game.timeScale = 0.25; }
  else game.timeScale = Math.min(1, game.timeScale + dtReal * 2);
  const dt = dtReal * game.timeScale;
  game.time += dt;
  ctx.time = game.time;

  updatePhase(dt, dtReal);
  opp.think(dt, ctx);

  acc += dt;
  let n = 0;
  while (acc >= STEP && n < MAX_STEPS) { substep(STEP); acc -= STEP; n++; }
  if (n === MAX_STEPS) acc = 0;

  player.avatar.tick(dt);
  if (game.phase !== 'menu') recordFrame();
  arena.updateRopes();
  arena.updateCrowd(dtReal);
  opp.view.update();
  debugView.update();

  if (game.phase === 'menu') {
    const a = game.time * 0.12;
    camera.position.set(Math.sin(a) * 4.2, 2.0, Math.cos(a) * 4.2);
    camera.lookAt(opp.p.chest.pos.x, 1.2, opp.p.chest.pos.z);
  } else {
    player.updateCamera(camera);
    camera.updateMatrixWorld();
    player.view.update(camera);
    updateHud(dtReal);
    updateThreat();
  }
  touch?.setVisible(inMatch() && !game.paused && !game.overlay && game.phase !== 'kocam');
  renderer.render(scene, camera);
});

// handy for tinkering from the console
window.game = { game, player, opp, world, arena, startMatch, oppKnockdown, mp, net };
