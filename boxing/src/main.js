// Knockout Physics — game loop, rules and HUD.

import * as THREE from 'three';
import { World, collideParticles, collideParticleSphere } from './physics.js';
import { Opponent } from './fighter.js';
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
  paused: false, noLock: false, vignette: 0, lagP: 100, lagO: 100,
  stats: null,
};
const ctx = { playerPos: player.pos, playerHead: player.headPos, playerChest: player.chestPos, time: 0 };

function newStats() {
  return { thrown: 0, landed: 0, blocked: 0, topSpeed: 0, topEnergy: 0, dealt: 0, taken: 0, oppThrown: 0, oppLanded: 0 };
}
game.stats = newStats();

// ---------------------------------------------------------------- contacts
const impulse = new THREE.Vector3();
const BODY_PARTS = ['head', 'neck', 'chest', 'belly', 'pelvis', 'shoulderL', 'shoulderR', 'hipL', 'hipR', 'kneeL', 'kneeR'];

world.collisionHook = (h, iter) => {
  for (const g of player.gloves) {
    for (const p of opp.list) {
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
  if (hp && !hp.hit && hp.phase === 'ext' && speed > 1) {
    hp.hit = true;
    game.stats.blocked++;
    player.stamina = Math.max(0, player.stamina - 3);
    sfx.block(speed / 8);
    showImpact('BLOCK', null);
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

  const counter = opp.isPunching();
  const mult = p.region === 'head' ? 1 : 0.6;
  const dmg = Math.max(0, speed - 2.2) * 2.2 * pu.power * mult * (counter ? 1.25 : 1);
  game.stats.landed++;
  game.stats.dealt += dmg;
  game.stats.topSpeed = Math.max(game.stats.topSpeed, speed);
  game.stats.topEnergy = Math.max(game.stats.topEnergy, energy);
  opp.takeHit(dmg, p.region);
  sfx.punch(speed / 9, p.region);
  arena.excitement += dmg / 20;
  const label = counter ? 'COUNTER!' : p.region === 'head' ? (dmg > 14 ? 'HUGE SHOT' : 'HEAD') : 'BODY';
  showImpact(label, speed, energy);
  if (opp.health <= 0) oppKnockdown();
}

function onPlayerStruck(hand, speed, imp, region) {
  if (player.mode !== 'fight') { player.takeHit(imp, 0, region); return; }
  const pu = hand.punch;
  let dmg = 0;
  if (pu && !pu.hit && (pu.phase === 'ext' || pu.phase === 'ret') && speed > 1.5) {
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

function oppKnockdown() {
  opp.knockDown();
  game.phase = 'knockdown';
  game.downWho = 'opp';
  game.count = 0; game.countT = 0;
  game.slowmo = 1.2;
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
    const s = game.stats;
    $('res-title').textContent = won === null ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT';
    $('res-detail').textContent = `${won === null ? '' : won ? 'Won' : 'Lost'} by ${method.toLowerCase()} · round ${game.round}`;
    const acc = s.thrown ? Math.round((100 * s.landed) / s.thrown) : 0;
    const rows = [
      ['Punches landed', `${s.landed} / ${s.thrown} (${acc}%)`],
      ['Damage dealt / taken', `${s.dealt.toFixed(0)} / ${s.taken.toFixed(0)}`],
      ['Hardest punch', `${s.topSpeed.toFixed(1)} m/s · ${s.topEnergy.toFixed(0)} J`],
      ['His punches blocked', `${s.blocked}`],
      ['Knockdowns (you / him)', `${opp.knockdowns || 0} / ${player.knockdowns}`],
    ];
    $('res-stats').innerHTML = rows.map(([a, b]) => `<div>${a}</div><div>${b}</div>`).join('');
    $('results').classList.remove('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
  }, 2600);
}

function toMenu() {
  game.phase = 'menu';
  $('results').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('menu').classList.remove('hidden');
  player.reset(0, 2.4, 0);
  opp.reset(0, 0, 0);
  setGlovesVisible(false);
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
  el.querySelector('.phys').textContent = speed == null ? '' : `${speed.toFixed(1)} m/s · ${energy.toFixed(0)} J`;
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

$('pause').addEventListener('click', () => { setPaused(false); lockPointer(); });

document.addEventListener('mousemove', (e) => {
  if (!inMatch() || game.paused) return;
  if (!document.pointerLockElement && !game.noLock) return;
  player.look(e.movementX || 0, e.movementY || 0);
});

canvas.addEventListener('mousedown', (e) => {
  if (!inMatch() || game.paused) return;
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
  if (e.code === 'KeyQ') player.requestPunch(0, 'hook');
  if (e.code === 'KeyE') player.requestPunch(1, 'hook');
  if (e.code === 'KeyP') setPaused(true);
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

player.onPunch = () => { game.stats.thrown++; opp.notifyIncoming(game.time); };
player.onSwing = () => sfx.whoosh(0.5);
opp.onSwing = () => { sfx.whoosh(0.3); game.stats.oppThrown++; };

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
  }
  renderer.render(scene, camera);
});

// handy for tinkering from the console
window.game = { game, player, opp, world, arena, startMatch };
