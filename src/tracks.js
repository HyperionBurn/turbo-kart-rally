// Track catalogue: layout (control points), lagoon, features and visual theme per circuit.
// track.js builds any of these; the event settings screen lets the host pick one (or rotate).
//
// points: [x, y, z] control points (x/z multiplied by `scale`), race direction = list order,
//         point 0 = start/finish line on a straight heading +Z. Validated for drivability
//         (tightest corner radius, clearance between neighbouring parts of the track).
// lake:   lagoon in world coordinates; wherever the road crosses it, a bridge is built.
// pads:   boost pads as [controlPointPosition, stepsAlongTrack (16 m each), lateral | 'race'].
// ramps:  jump ramps as [controlPointPosition, halfWidth?, height?].
// itemRows: control-point positions of the five-wide item box rows.

export const THEMES = {
  // the original look (defaults in environment.js match these)
  day: {},
  sunset: {
    sky: { top: 0x3a2f78, horizon: 0xffb36b, bottom: 0xf28d5c, sun: 0xffc27a },
    sunDir: [0.62, 0.36, -0.7],
    hemi: { sky: 0xffcfa6, ground: 0x6d5844, intensity: 1.05 },
    sunLight: { color: 0xffa65c, intensity: 2.5 },
    envGround: 0x7a6a3c,
    exposure: 0.95,
    terrain: { g1: 0x7aa83a, g2: 0xa7c45a, g3: 0x5c8a35, sand: 0xf3cf94, sandWet: 0xcf9f68, rock: 0xa08a78, under: 0x8a8a70 },
    water: { deep: 0x2a3d7c, shallow: 0x4fb7c2, sky: 0xffc59a },
    greens: [0x6aa83a, 0x86b844, 0x5a9a33, 0x9cc251, 0x7aae3f, 0xb3c95a],
    mountains: { grass: 0x6a7a45, rock: 0x8a7f86, snow: 0xffe7d4 },
  },
  frost: {
    sky: { top: 0x6f9fd8, horizon: 0xe9f2fb, bottom: 0xd6e5f5, sun: 0xffffff },
    sunDir: [0.4, 0.62, -0.68],
    hemi: { sky: 0xe8f2ff, ground: 0xb4c2d2, intensity: 1.35 },
    sunLight: { color: 0xf1f6ff, intensity: 2.6 },
    envGround: 0xdfe8f2,
    terrain: { g1: 0xeef4fb, g2: 0xdbe7f3, g3: 0xc7d6e6, sand: 0xe3eaf2, sandWet: 0xb9c8d8, rock: 0x8b939f, under: 0x9fb2c4 },
    water: { deep: 0x2f6f9c, shallow: 0xa9e3f2, sky: 0xe3f2ff },
    greens: [0x2f6b4a, 0x3a7a55, 0x285f42, 0x447f5a, 0x336f4d, 0x4c8a62],
    mountains: { grass: 0xcfdbe8, rock: 0x7f8794, snow: 0xffffff },
    verge: { base: '#e6eef7', speckles: ['#d5e1ee', '#f4f8fc', '#c9d7e6', '#ffffff', '#dbe6f1'], flowers: false },
    palms: false,
    flowers: false,
  },
  // night-time pinball machine: deep violet void, neon walls, no scenery
  neon: {
    sky: { top: 0x0e0826, horizon: 0x3a1a6e, bottom: 0x180c38, sun: 0xff7af0 },
    sunDir: [0.25, 0.85, -0.45],
    hemi: { sky: 0x8a6cff, ground: 0x1a0f33, intensity: 0.8 },
    sunLight: { color: 0xd9bcff, intensity: 1.5 },
    envGround: 0x1a1238,
    terrain: { g1: 0x1b1442, g2: 0x231a56, g3: 0x140e33, sand: 0x2b2060, sandWet: 0x221a4a, rock: 0x2a2452, under: 0x1a1440 },
    water: { deep: 0x1a0838, shallow: 0x5a1fa8, sky: 0xb46cff },
    mountains: { grass: 0x241a4a, rock: 0x2e2660, snow: 0xff5ce0 },
    walls: { color: 0xffffff, emissive: 0xff2fd0, emissiveIntensity: 0.85 },
    verge: { base: '#1d1546', speckles: ['#2a1d63', '#3a2a8a', '#16103a', '#00e5ff', '#ff3df2'], flowers: false },
    hide: ['vegetation', 'grandstands', 'crowd', 'flags', 'lighthouse', 'boat', 'mountains'],
    palms: false,
    flowers: false,
  },
  // fortress over lava: ember sky, dark stone, a glowing lava lake
  lava: {
    sky: { top: 0x1a0505, horizon: 0x7a1f0a, bottom: 0x3a0d05, sun: 0xff8a3d },
    sunDir: [0.3, 0.7, -0.6],
    hemi: { sky: 0xff9a6b, ground: 0x3a1208, intensity: 0.95 },
    sunLight: { color: 0xffb27a, intensity: 2.1 },
    envGround: 0x2a1a14,
    terrain: { g1: 0x2b2422, g2: 0x3a302c, g3: 0x1e1816, sand: 0x3a2a22, sandWet: 0x5a2a12, rock: 0x4a3f3a, under: 0x7a2a0a },
    water: { deep: 0xff3d00, shallow: 0xffb020, sky: 0xff5a10 },
    mountains: { grass: 0x2a1d18, rock: 0x3a2a24, snow: 0xff6a2a },
    walls: { color: 0x9a948e, emissive: 0x501000, emissiveIntensity: 0.6 },
    verge: { base: '#2e2622', speckles: ['#3a302c', '#241e1b', '#4a3f3a', '#ff6a1a', '#1c1614'], flowers: false },
    hide: ['vegetation', 'grandstands', 'crowd', 'flags', 'lighthouse', 'boat'],
    palms: false,
    flowers: false,
  },
  // above the clouds: the whole circuit floats on decks over a cloud sea
  sky: {
    sky: { top: 0x3d8be8, horizon: 0xdff1ff, bottom: 0xffffff, sun: 0xfff6dd },
    sunDir: [0.35, 0.75, -0.55],
    hemi: { sky: 0xe9f4ff, ground: 0xffffff, intensity: 1.4 },
    sunLight: { color: 0xfff4e0, intensity: 2.6 },
    envGround: 0xffffff,
    water: { deep: 0xc9d9ee, shallow: 0xffffff, sky: 0xffffff },
    walls: { color: 0xffffff, emissive: 0x3d6bd8, emissiveIntensity: 0.25 },
    hide: ['terrain', 'vegetation', 'grandstands', 'crowd', 'flags', 'lighthouse', 'boat', 'mountains'],
    palms: false,
    flowers: false,
  },
};

export const TRACKS = [
  {
    id: 'palm-cove',
    name: 'Palm Cove Circuit',
    blurb: 'Seaside classic · bridge, hairpin, two jumps',
    theme: 'day',
    scale: 1.15,
    lake: { x: 405, z: -205, r: 125 },
    points: [
      [0, 0, -60], [0, 0, 60], [2, 0, 175], [22, 1, 258], [80, 3, 302], [160, 5, 296],
      [230, 6, 252], [262, 6, 182], [238, 5, 118], [292, 4, 64], [258, 4, 4], [296, 6, -62],
      [304, 10, -140], [284, 10, -212], [226, 6, -262], [150, 3, -284], [66, 1, -300],
      [-20, 0, -318], [-96, 0, -322], [-128, 0, -292], [-106, 0, -256], [-50, 0, -236],
      [-8, 0, -196], [0, 0, -140],
    ],
    pads: [
      [10.45, 0, -6], [10.45, 1, 0], [10.45, 2, 6],      // S-bend exit, staggered trio
      [20.55, 0, -4.5], [20.55, 0, 4.5], [20.55, 2, 0],  // hairpin exit
      [4.15, 0, 'race'], [4.15, 1, 'race'],               // lined up before the sweeper jump
    ],
    ramps: [[14.35], [4.65, 9, 1.5]],
    itemRows: [1.25, 6.5, 9.2, 12.5, 16.4, 21.6],
  },
  {
    id: 'sunset-speedway',
    name: 'Sunset Speedway',
    blurb: 'Flat-out oval at golden hour · lake bridge kink',
    theme: 'sunset',
    scale: 1.15,
    lake: { x: 470, z: -30, r: 125 },
    points: [
      [0, 0, -100], [0, 0, 40], [8, 1, 150], [55, 3, 232], [150, 4, 266], [245, 4, 236],
      [296, 4, 152], [306, 6, 62], [322, 8, -18], [296, 6, -92], [304, 4, -172],
      [262, 3, -252], [170, 2, -292], [80, 1, -280], [28, 0, -232], [4, 0, -170],
    ],
    pads: [
      [1.5, 0, -5], [1.5, 0, 5],                        // down the front straight
      [9.4, 0, 'race'], [9.4, 1, 'race'],               // off the bridge
      [13.3, 0, -4], [13.3, 1, 4],                      // last-turn exit
    ],
    ramps: [[6.4, 10, 1.6], [12.4, 10, 1.5]],
    itemRows: [1.3, 5.5, 9.0, 12.5],
  },
  {
    id: 'frosty-peaks',
    name: 'Frosty Peaks',
    blurb: 'Snowy mountain switchbacks · technical, hilly',
    theme: 'frost',
    scale: 1.15,
    lake: { x: 260, z: -40, r: 110 },
    points: [
      [0, 0, -60], [0, 0, 60], [-10, 2, 160], [-60, 5, 235], [-150, 8, 262], [-240, 10, 235],
      [-285, 11, 160], [-262, 12, 85], [-195, 11, 48], [-150, 9, -15], [-185, 9, -85],
      [-255, 11, -120], [-280, 12, -200], [-220, 13, -262], [-125, 12, -252], [-60, 8, -288],
      [25, 5, -300], [92, 4, -258], [95, 3, -190], [38, 1, -170], [0, 0, -125],
    ],
    pads: [
      [3.5, 0, 'race'], [3.5, 1, 'race'],
      [10.4, 0, -4.5], [10.4, 0, 4.5],
      [16.3, 0, -5], [16.3, 1, 0], [16.3, 2, 5],
    ],
    ramps: [[1.6, 10, 1.5], [15.5, 9, 1.6]],
    itemRows: [1.3, 5.0, 9.5, 13.5, 17.5],
  },
];

// Original circuits in the spirit of three classic kart-racer themes (names, layouts and
// art are our own): a night-time pinball machine, a fortress over lava, a skyway above the
// clouds. Hazards (hazards.js) carry each one's signature set-piece.
TRACKS.push(
  {
    id: 'pinball-palace',
    name: 'Pinball Palace',
    blurb: 'Neon pinball table · rolling balls, pop bumpers, plunger launch',
    theme: 'neon',
    scale: 1.15,
    lake: { x: 900, z: 900, r: 10 },
    points: [
      [200, 14, -60], [200, 22, 60], [195, 30, 170], [160, 34, 250], [80, 36, 290], [-20, 36, 290],
      [-110, 34, 260], [-140, 30, 190], [-100, 26, 130], [20, 22, 110], [70, 18, 60], [40, 15, 0],
      [-60, 12, -20], [-120, 9, -80], [-100, 6, -150], [-20, 4, -200], [80, 2, -250], [160, 2, -260],
      [200, 6, -190],
    ],
    pads: [
      [17.5, 0, 0], [17.5, 1, 0], [17.5, 2, 0], // the plunger lane: launches you up the return climb
      [9.4, 0, 'race'], [12.5, 0, -4], [12.5, 1, 4],
    ],
    ramps: [[4.5, 10, 1.6], [15.4, 9, 1.5]],
    itemRows: [1.4, 8.5, 12.5, 16.5],
    hazards: [
      // chrome balls rolling back up the table, against the race
      { type: 'ball', t0: 0.43, t1: 0.70, lat: -4, count: 2, speed: 0.0068, radius: 2.4 },
      { type: 'ball', t0: 0.43, t1: 0.70, lat: 5, count: 1, speed: 0.0058, radius: 2.4 },
      // pop bumpers near the edges of the table
      { type: 'bumper', t: 0.50, lat: -8, color: 0xff3df2 },
      { type: 'bumper', t: 0.545, lat: 7.5, color: 0x00e5ff },
      { type: 'bumper', t: 0.60, lat: -6.5, color: 0xffe14d },
      { type: 'bumper', t: 0.69, lat: 8, color: 0xff3df2 },
      { type: 'bumper', t: 0.745, lat: -7, color: 0x00e5ff },
      { type: 'bumper', t: 0.255, lat: 7.5, color: 0xffe14d },
    ],
  },
  {
    id: 'magma-keep',
    name: 'Magma Keep',
    blurb: 'Fortress over lava · crusher blocks, lava bridge jump',
    theme: 'lava',
    scale: 1.15,
    lake: { x: 110, z: -260, r: 95 },
    points: [
      [0, 0, -60], [0, 0, 70], [20, 1, 150], [90, 2, 180], [190, 3, 170], [240, 4, 110], [240, 5, 10],
      [200, 6, -50], [130, 6, -60], [90, 5, -110], [120, 4, -180], [200, 3, -210], [230, 6, -270],
      [170, 8, -320], [60, 8, -320], [-30, 6, -280], [-55, 3, -210], [-4, 0, -138],
    ],
    pads: [[5.5, 0, 'race'], [10.5, 0, -4], [10.5, 0, 4]],
    ramps: [[12.4, 10, 1.6]],
    itemRows: [1.3, 4.5, 8.5, 13.5],
    hazards: [
      { type: 'crusher', t: 0.205, lat: -5, period: 3.4, phase: 0 },
      { type: 'crusher', t: 0.228, lat: 5, period: 3.4, phase: 0.5 },
      { type: 'crusher', t: 0.44, lat: 0, period: 3.0, phase: 0.2 },
      { type: 'crusher', t: 0.482, lat: -6, period: 3.6, phase: 0.65 },
      { type: 'crusher', t: 0.915, lat: 4, period: 3.2, phase: 0.35 },
    ],
  },
  {
    id: 'skyway-cruise',
    name: 'Skyway Cruise',
    blurb: 'Floating skyway over a sea of clouds · sweeping climbs, cloud bumpers, jump gaps',
    theme: 'sky',
    scale: 1.15,
    lake: { x: 85, z: -60, r: 700 },
    points: [
      [0, 30, -60], [0, 32, 60], [30, 36, 160], [110, 42, 210], [200, 48, 190], [250, 50, 110],
      [230, 46, 20], [160, 40, -20], [100, 36, -80], [120, 34, -170], [190, 30, -230], [160, 26, -310],
      [60, 24, -330], [-40, 26, -290], [-55, 28, -225], [-4, 29, -145],
    ],
    pads: [[7.4, 0, 'race'], [7.4, 1, 'race'], [13.6, 0, -4], [13.6, 0, 4]],
    ramps: [[3.5, 10, 1.8], [11.5, 10, 1.7]],
    itemRows: [1.3, 5.0, 9.5, 13.0],
    hazards: [
      { type: 'bumper', style: 'cloud', t: 0.30, lat: 7, radius: 2.0 },
      { type: 'bumper', style: 'cloud', t: 0.36, lat: -7, radius: 2.0 },
      { type: 'bumper', style: 'cloud', t: 0.60, lat: 6.5, radius: 2.0 },
      { type: 'bumper', style: 'cloud', t: 0.80, lat: -6.5, radius: 2.0 },
      { type: 'bumper', style: 'cloud', t: 0.865, lat: 7, radius: 2.0 },
    ],
  },
);

export const DEFAULT_TRACK = TRACKS[0].id;
// ROTATE order: the classic first, then the new themed circuits, then the rest
export const ROTATION = ['palm-cove', 'pinball-palace', 'magma-keep', 'skyway-cruise', 'sunset-speedway', 'frosty-peaks'];

/** Track definition by id (unknown/missing ids fall back to Palm Cove). */
export function getTrackDef(id) {
  return TRACKS.find((t) => t.id === id) || TRACKS[0];
}

/** For "rotate": the track used for race number `raceIndex` (0-based). */
export function rotatingTrackId(raceIndex) {
  const n = ROTATION.length;
  return ROTATION[(((raceIndex | 0) % n) + n) % n];
}
