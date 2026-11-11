// On-screen controls for phones and tablets.
//
// Left half of the screen: a floating joystick (appears where your thumb lands).
// Right half: drag to look. Buttons on the right:
//   LEFT / RIGHT  one per glove. Tap = straight, swipe sideways = hook,
//                 swipe up = uppercut, swipe down = body hook.
//   GUARD, DUCK   hold.
//   SLIP < >      slip your head and sidestep left / right.
//   JUMP          jump (punch in the air for a superman punch).
//   KICK          tap = right kick, swipe left = left kick.
// When you're knocked down, tapping any button helps you get up.

const SWIPE = 28;        // px before a press counts as a swipe
const STICK = 60;        // joystick radius in px
const LOOK_GAIN = 1.5;   // look speed relative to mouse pixels

/** Keep receiving a finger's moves even if it slides off the button (not every browser allows it). */
function capture(el, e) { try { el.setPointerCapture(e.pointerId); } catch { /* fine without */ } }

export const isTouchDevice = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(hover: none) and (pointer: coarse)').matches;

export class TouchControls {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root     container (#touch)
   * @param {object} o.player
   * @param {() => boolean} o.active  whether fight input is accepted right now
   * @param {() => void} o.onPress    any button pressed (used to get up after a knockdown)
   * @param {() => void} o.onPause
   */
  constructor({ root, player, active, onPress, onPause, onJump }) {
    Object.assign(this, { root, player, active, onPress, onPause, onJump: onJump || (() => player.requestJump()) });
    this.stick = null;   // { id, x0, y0 }
    this.look = null;    // { id, x, y }
    this.build();
  }

  build() {
    const r = this.root;
    r.innerHTML = `
      <div class="t-stick" hidden><div class="t-knob"></div></div>
      <div class="t-stick-hint">MOVE</div>
      <button class="t-btn t-pause" aria-label="Pause">II</button>
      <div class="t-pad">
        <div class="t-row">
          <button class="t-btn t-small" data-slip="left" aria-label="Slip left">◀ SLIP</button>
          <button class="t-btn t-small" data-slip="right" aria-label="Slip right">SLIP ▶</button>
        </div>
        <div class="t-row">
          <button class="t-btn t-hold t-jump" data-jump="1">JUMP</button>
          <button class="t-btn t-hold" data-key="KeyC">DUCK</button>
          <button class="t-btn t-hold" data-key="ShiftLeft">GUARD</button>
        </div>
        <div class="t-row">
          <button class="t-btn t-hold t-kick" data-kick="1">KICK</button>
          <button class="t-btn t-punch" data-hand="0">LEFT</button>
          <button class="t-btn t-punch" data-hand="1">RIGHT</button>
        </div>
        <div class="t-legend">tap jab · swipe ↔ hook · ↑ upper · ↓ body · jump + punch: superman</div>
      </div>`;
    this.stickEl = r.querySelector('.t-stick');
    this.knobEl = r.querySelector('.t-knob');

    // background: joystick (left half) or look (right half)
    r.addEventListener('pointerdown', (e) => this.down(e));
    r.addEventListener('pointermove', (e) => this.move(e));
    for (const ev of ['pointerup', 'pointercancel']) r.addEventListener(ev, (e) => this.up(e));

    r.querySelector('.t-pause').addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.onPause(); });

    for (const b of r.querySelectorAll('[data-slip]')) {
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        this.onPress();
        if (this.active()) this.player.requestDash(b.dataset.slip);
      });
    }

    const jump = r.querySelector('[data-jump]');
    jump.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      this.onPress();
      if (this.active()) this.onJump();
    });

    // KICK: tap = right (rear) leg, swipe left = left (lead) leg
    const kick = r.querySelector('[data-kick]');
    let kickStart = null;
    kick.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      capture(kick, e);
      this.onPress();
      kickStart = e.clientX;
      kick.classList.add('on');
    });
    const endKick = (e) => {
      e.stopPropagation();
      if (kickStart === null) return;
      const side = e.clientX - kickStart < -SWIPE ? -1 : 1;
      kickStart = null;
      kick.classList.remove('on');
      if (this.active()) this.player.requestKick(side);
    };
    kick.addEventListener('pointerup', endKick);
    kick.addEventListener('pointercancel', () => { kickStart = null; kick.classList.remove('on'); });

    for (const b of r.querySelectorAll('[data-key]')) {
      const key = b.dataset.key;
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        capture(b, e);
        this.onPress();
        if (this.active()) { this.player.keys.add(key); b.classList.add('on'); }
      });
      const release = (e) => { e.stopPropagation(); this.player.keys.delete(key); b.classList.remove('on'); };
      b.addEventListener('pointerup', release);
      b.addEventListener('pointercancel', release);
    }

    for (const b of r.querySelectorAll('[data-hand]')) {
      const hand = +b.dataset.hand;
      let start = null;
      const fire = (type) => { if (this.active()) this.player.requestPunch(hand, type); start = null; b.classList.remove('on'); };
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        capture(b, e);
        this.onPress();
        start = { x: e.clientX, y: e.clientY };
        b.classList.add('on');
      });
      b.addEventListener('pointermove', (e) => {
        if (!start) return;
        e.stopPropagation();
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) < SWIPE) return;
        // throw as soon as the swipe is clear, for a snappier punch
        fire(Math.abs(dx) > Math.abs(dy) ? 'hook' : dy < 0 ? 'uppercut' : 'bodyhook');
      });
      b.addEventListener('pointerup', (e) => { e.stopPropagation(); if (start) fire('straight'); });
      b.addEventListener('pointercancel', () => { start = null; b.classList.remove('on'); });
    }
  }

  down(e) {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    capture(this.root, e);
    if (e.clientX < window.innerWidth * 0.45) {
      if (this.stick) return;
      this.stick = { id: e.pointerId, x0: e.clientX, y0: e.clientY };
      this.stickEl.hidden = false;
      this.stickEl.style.left = `${e.clientX}px`;
      this.stickEl.style.top = `${e.clientY}px`;
      this.knobEl.style.transform = 'translate(-50%, -50%)';
    } else if (!this.look) {
      this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
    }
  }

  move(e) {
    if (this.stick && e.pointerId === this.stick.id) {
      let dx = e.clientX - this.stick.x0, dy = e.clientY - this.stick.y0;
      const d = Math.hypot(dx, dy);
      if (d > STICK) { dx *= STICK / d; dy *= STICK / d; }
      this.knobEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      // small dead zone, then forward/back and strafe
      const m = d < 8 ? 0 : 1;
      this.player.touchMove = { x: (dx / STICK) * m, y: (-dy / STICK) * m };
    } else if (this.look && e.pointerId === this.look.id) {
      const dx = e.clientX - this.look.x, dy = e.clientY - this.look.y;
      this.look.x = e.clientX; this.look.y = e.clientY;
      if (this.active()) this.player.look(dx * LOOK_GAIN, dy * LOOK_GAIN);
    }
  }

  up(e) {
    if (this.stick && e.pointerId === this.stick.id) {
      this.stick = null;
      this.stickEl.hidden = true;
      this.player.touchMove = null;
    }
    if (this.look && e.pointerId === this.look.id) this.look = null;
  }

  setVisible(v) {
    if (this.root.hidden === !v) return;
    this.root.hidden = !v;
    if (!v) {
      this.stick = this.look = null;
      this.stickEl.hidden = true;
      this.player.touchMove = null;
      this.player.keys.delete('ShiftLeft'); this.player.keys.delete('KeyC');
      for (const b of this.root.querySelectorAll('.on')) b.classList.remove('on');
    }
  }
}
