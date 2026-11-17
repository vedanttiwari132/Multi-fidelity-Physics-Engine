// A fighter's look and weight class.
//
// Weight decides how a fighter fights, not just how big they look: a heavyweight hits like a
// truck but winds up, punches and moves slowly; a flyweight is quick with everything but hits
// softer and is easier to knock off balance. Looks are colours plus a hair style and facial hair.

export const SKIN = [0xf3d2b8, 0xe8b48e, 0xd9a27c, 0xb87a55, 0x8d5a3b, 0x6a3f27, 0x4a2a1a];
export const GLOVES = [0xd42a2a, 0x2a66e0, 0x1b1b20, 0xf4f1ea, 0xf0b81a, 0x2fb34a, 0x8a3fd6, 0xf06aa8];
export const SHORTS = [0x9c1020, 0x1840c0, 0x16161a, 0xf4f1ea, 0xe0a010, 0x1f8a3c, 0x6a2fb0, 0xe85d9a, 0x2a2a2a, 0x1fa3b8];
export const TRIM = [0xf4f1ea, 0x16161a, 0xf0b81a, 0xd42a2a, 0x2a66e0, 0x2fb34a];
export const HAIR_COLORS = [0x1b1210, 0x3a2414, 0x6b4426, 0xb07a3c, 0xe2c27a, 0xb03a1a, 0x9a9a9a, 0xf2f2f2, 0x2a66e0, 0xe0407a];
export const HAIR = ['bald', 'buzz', 'crop', 'mohawk', 'afro', 'bun', 'spikes'];
export const HAIR_LABEL = { bald: 'BALD', buzz: 'BUZZ CUT', crop: 'CROP', mohawk: 'MOHAWK', afro: 'AFRO', bun: 'MAN BUN', spikes: 'SPIKES' };
export const BEARD = ['none', 'stubble', 'moustache', 'goatee', 'full'];
export const BEARD_LABEL = { none: 'NONE', stubble: 'STUBBLE', moustache: 'MOUSTACHE', goatee: 'GOATEE', full: 'FULL BEARD' };

// weight classes (kg): the slider runs from the lightest to the heaviest
export const CLASSES = [
  [57, 'FLYWEIGHT'], [61, 'BANTAMWEIGHT'], [66, 'FEATHERWEIGHT'], [70, 'LIGHTWEIGHT'], [77, 'WELTERWEIGHT'],
  [84, 'MIDDLEWEIGHT'], [93, 'LIGHT HEAVYWEIGHT'], [120, 'HEAVYWEIGHT'],
];
export const KG_MIN = 57, KG_MAX = 120;
export const className = (kg) => (CLASSES.find(([lim]) => kg <= lim) || CLASSES[CLASSES.length - 1])[1];

export const DEFAULT_PROFILE = {
  kg: 80, skin: 0xd9a27c, gloves: 0x2a66e0, shorts: 0x1840c0, trim: 0xf4f1ea,
  hair: 'crop', hairColor: 0x2a1a10, beard: 'none', beardColor: 0x2a1a10,
};

/**
 * What a weight does to a fighter (1 = a welterweight-ish middle).
 *   power: damage and knockback of every strike     speed: how fast strikes wind up and land
 *   move: footwork, dashes and turning               tough: resistance to being swept or knocked off balance
 *   stamina: how fast it comes back                  mass: body mass (×, of the 75 kg the body is built at)
 *   girth / limbs: how bulky the torso and the arms and legs look (and their hitboxes)
 */
export function statsFor(kg) {
  const w = Math.min(1, Math.max(0, (kg - KG_MIN) / (KG_MAX - KG_MIN)));
  return {
    w,
    power: 0.62 + 1.28 * Math.pow(w, 1.25),
    speed: 1.32 - 0.62 * w,
    move: 1.26 - 0.56 * w,
    tough: 0.7 + 0.75 * w,
    stamina: 1.22 - 0.42 * w,
    mass: kg / 75,
    girth: 0.86 + 0.5 * w,
    limbs: 0.88 + 0.34 * w,
  };
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];
/** A random fighter (for the AI). */
export function randomProfile(exclude = null) {
  let gloves = pick(GLOVES);
  if (exclude && gloves === exclude.gloves) gloves = GLOVES[(GLOVES.indexOf(gloves) + 3) % GLOVES.length];
  return {
    kg: Math.round(KG_MIN + Math.random() * (KG_MAX - KG_MIN)), skin: pick(SKIN), gloves, shorts: pick(SHORTS), trim: pick(TRIM),
    hair: pick(HAIR), hairColor: pick(HAIR_COLORS.slice(0, 8)), beard: pick(BEARD), beardColor: pick(HAIR_COLORS.slice(0, 8)),
  };
}

/** A ring name that suits the weight. */
export function nickname(kg) {
  const light = ['"THE BLUR"', '"FLASH"', '"WASP"', '"MONGOOSE"', '"VIPER"'], mid = ['"THE BRICK"', '"HAMMER"', '"THE WALL"', '"PITBULL"'],
    heavy = ['"THE FRIDGE"', '"MOUNTAIN"', '"BULLDOZER"', '"THE TANK"'];
  return pick(kg < 70 ? light : kg < 95 ? mid : heavy);
}

// ---------------------------------------------------------------- saving and sending
const color = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : d);
/** A profile from anywhere (saved, or sent by the other player): every field checked, defaults for the rest. */
export function cleanProfile(p) {
  const d = DEFAULT_PROFILE;
  if (!p || typeof p !== 'object') return { ...d };
  const kg = typeof p.kg === 'number' && Number.isFinite(p.kg) ? Math.round(Math.min(KG_MAX, Math.max(KG_MIN, p.kg))) : d.kg;
  return {
    kg, skin: color(p.skin, d.skin), gloves: color(p.gloves, d.gloves), shorts: color(p.shorts, d.shorts), trim: color(p.trim, d.trim),
    hair: HAIR.includes(p.hair) ? p.hair : d.hair, hairColor: color(p.hairColor, d.hairColor),
    beard: BEARD.includes(p.beard) ? p.beard : d.beard, beardColor: color(p.beardColor, d.beardColor),
  };
}
export function loadProfile() {
  try { return cleanProfile(JSON.parse(localStorage.getItem('km-profile') || 'null')); } catch { return { ...DEFAULT_PROFILE }; }
}
export function saveProfile(p) {
  try { localStorage.setItem('km-profile', JSON.stringify(p)); } catch { /* private window: it just isn't kept */ }
}
/** Compact form for the network: [kg, skin, gloves, shorts, trim, hair index, hair colour, beard index, beard colour]. */
export const packProfile = (p) => [p.kg, p.skin, p.gloves, p.shorts, p.trim, HAIR.indexOf(p.hair), p.hairColor, BEARD.indexOf(p.beard), p.beardColor];
export function unpackProfile(a) {
  if (!Array.isArray(a) || a.length !== 9) return null;
  return cleanProfile({ kg: a[0], skin: a[1], gloves: a[2], shorts: a[3], trim: a[4], hair: HAIR[a[5]], hairColor: a[6], beard: BEARD[a[7]], beardColor: a[8] });
}
export const hex = (c) => '#' + c.toString(16).padStart(6, '0');
