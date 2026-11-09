// Knockout Physics — game loop, rules and HUD.

import * as THREE from 'three';
import { World, collideParticles, collideParticleSphere } from './physics.js';
import { Opponent, PUNCH_LABEL } from './fighter.js';
import { Player } from './player.js';
import { Arena } from './arena.js';
import { Sfx } from './audio.js';
import { PhysicsDebugView } from './debug.js';

const STEP = 1 / 240;      // physics rate
const MAX_STEPS = 16;
const ROUND_TIME = 90;
const ROUNDS = 3;
const GLOVE_MASS = 3;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- setup
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
  paused: false, noLock: false, vignette: 0, lagP: 100, lagO: 100, counterUntil: -1,
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
    showImpact(broken ? 'GUARD BROKEN' : guarded ? 'BLOCKED' : 'PARRIED', `−${drain.toFixed(0)} stamina${chip ? ` · −${chip.toFixed(1)} health` : ''}`);
    if (player.health <= 0 && player.mode === 'fight') playerKnockdown();
    return;
  }
  const pu = g.punch;
  if (!pu || pu.done || pu.phase === 'wind' || speed < 1.5) return;
  pu.done = true;
  const mu = (GLOVE_MASS * p.mass) / (GLOVE_MASS + p.mass);
  const energy = 0.5 * mu * speed * speed;
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
  const travelling = pu && (pu.phase === 'ext' || (pu.phase === 'ret' && pu.t < pu.wind + pu.def.ext + 0.05));
  if (pu && !pu.hit && travelling && speed > 1.5) {
    pu.hit = true;
    dmg = Math.max(0, speed - 2.0) * 2.4 * opp.diff.damage * pu.def.power * (region === 'head' ? 1 : 0.5);
    if (region === 'body' && player.guarding) dmg *= 0.5;
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
function startMatch() {
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
  $('recover-text').textContent = player.knockdowns >= 3 ? 'STAY DOWN…' : 'MASH SPACE TO GET UP';
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
      ['His punches blocked / dodged', `${s.blocked} / ${s.dodged}`],
      ['Knockdowns (you / him)', `${opp.knockdowns || 0} / ${player.knockdowns}`],
    ];
    $('res-stats').innerHTML = rows.map(([a, b]) => `<div>${a}</div><div>${b}</div>`).join('');
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
const rec = { t: new Float64Array(REC_FRAMES), pos: new Float32Array(REC_FRAMES * NP * 3), extra: new Float32Array(REC_FRAMES * 6), head: 0, count: 0 };
const live = { pos: new Float32Array(NP * 3), prev: new Float32Array(NP * 3), extra: new Float32Array(6) };
const ko = { hitTime: 0, t: 0, info: null, skip: false, impactPlayed: false, center: new THREE.Vector3(), angle0: 0, shake: 0 };
const _look = new THREE.Vector3();
const _bodyQ = { quaternion: new THREE.Quaternion() };

function extrasInto(arr, o) {
  arr[o] = player.pos.x; arr[o + 1] = player.pos.z; arr[o + 2] = player.yaw; arr[o + 3] = player.twist;
  arr[o + 4] = opp.yaw; arr[o + 5] = player.duck;
}
function extrasFrom(arr, o) {
  player.pos.x = arr[o]; player.pos.z = arr[o + 1]; player.yaw = arr[o + 2]; player.twist = arr[o + 3];
  opp.yaw = arr[o + 4]; player.duck = arr[o + 5];
}

function recordFrame() {
  const i = rec.head;
  rec.t[i] = game.time;
  const base = i * NP * 3;
  world.particles.forEach((p, k) => { rec.pos[base + k * 3] = p.pos.x; rec.pos[base + k * 3 + 1] = p.pos.y; rec.pos[base + k * 3 + 2] = p.pos.z; });
  extrasInto(rec.extra, i * 6);
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
  extrasFrom(rec.extra, u < 0.5 ? a * 6 : b * 6);
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
  const rate = 0.12 + 0.33 * Math.min(1, near / 0.35);   // slowest right at the impact
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
  game.phase = 'knockdown';
  game.count = 0; game.countT = 0;
}

// ---------------------------------------------------------------- incoming punch warning
const THREAT_DIR = { jab: 't', cross: 't', hookL: 'r', hookR: 'l', bodyR: 'b', upperR: 'b' };
const THREAT_HINT = {
  jab: 'SLIP  ⇧A / ⇧D', cross: 'SLIP  ⇧A / ⇧D', hookL: 'DUCK  C  ·  PULL BACK  ⇧S', hookR: 'DUCK  C  ·  PULL BACK  ⇧S',
  bodyR: 'BLOCK  SPACE', upperR: 'PULL BACK  ⇧S',
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
  game.paused = p;
  $('pause').classList.toggle('hidden', !p);
  if (p) player.keys.clear();
}

$('resume').addEventListener('click', () => { setPaused(false); lockPointer(); });
$('leave').addEventListener('click', () => { setPaused(false); toMenu(); });

document.addEventListener('mousemove', (e) => {
  if (!inMatch() || game.paused) return;
  if (!document.pointerLockElement && !game.noLock) return;
  player.look(e.movementX || 0, e.movementY || 0);
});

canvas.addEventListener('mousedown', (e) => {
  if (!inMatch() || game.paused) return;
  if (game.phase === 'kocam') { ko.skip = true; return; }
  if (!document.pointerLockElement && !game.noLock) { lockPointer(); return; }
  const type = e.shiftKey ? 'uppercut' : 'straight';
  if (e.button === 0) player.requestPunch(0, type);
  if (e.button === 2) player.requestPunch(1, type);
});
window.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  if (e.code === 'KeyV') debugView.toggle();
  if (e.code === 'KeyM') sfx.toggleMute();
  if (!inMatch() || game.paused) return;
  if (e.repeat) return;
  player.keys.add(e.code);
  if (e.code === 'KeyP') { setPaused(true); return; }
  if (game.phase === 'kocam') {
    if (e.code === 'Space' || e.code === 'Enter') ko.skip = true;
    return;
  }
  if (e.code === 'KeyQ') player.requestPunch(0, e.shiftKey ? 'bodyhook' : 'hook');
  if (e.code === 'KeyE') player.requestPunch(1, e.shiftKey ? 'bodyhook' : 'hook');
  if (e.shiftKey) {
    if (e.code === 'KeyA') player.requestDodge('left');
    if (e.code === 'KeyD') player.requestDodge('right');
    if (e.code === 'KeyS') player.requestDodge('back');
  }
  if (e.code === 'Space' && game.phase === 'knockdown' && player.mode === 'down' && player.knockdowns < 3) {
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
$('again').addEventListener('click', startMatch);
$('to-menu').addEventListener('click', toMenu);

player.onPunch = (g, type) => { game.stats.thrown++; opp.notifyIncoming(game.time, type === 'bodyhook'); };
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

// ---------------------------------------------------------------- loop
function updatePhase(dt, dtReal) {
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
  if (game.paused) { renderer.render(scene, camera); return; }
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
  renderer.render(scene, camera);
});

// handy for tinkering from the console
window.game = { game, player, opp, world, arena, startMatch, oppKnockdown };
