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

export const DEFAULT_TRACK = TRACKS[0].id;

/** Track definition by id (unknown/missing ids fall back to Palm Cove). */
export function getTrackDef(id) {
  return TRACKS.find((t) => t.id === id) || TRACKS[0];
}

/** For "rotate": the track used for race number `raceIndex` (0-based). */
export function rotatingTrackId(raceIndex) {
  const n = TRACKS.length;
  return TRACKS[(((raceIndex | 0) % n) + n) % n].id;
}
