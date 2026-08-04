// The "Zvířata" free printable set — 8 A4 coloring pages, the lead magnet the blog article
// "omalovánky zvířata k vytisknutí" hands out (see src/blog/keywordMap.js).
//
// THREE RUNS OF EVIDENCE ARE BAKED INTO THIS FILE. Do not undo them casually:
//
// v1 asked for "a plain softly blurred background" and got a park, a meadow and a flower bed. The
// generator traces what it is given, so every page came back with background clutter, and three of
// eight tripped the solid-fill check.
//
// v2 went to the other extreme — a lone animal on an empty white sweep. Every page passed QC, and
// every page read as empty. Clean is not the same as good.
//
// v3 (this) is the middle: a COMPOSED sparse scene. Each page names its subject, 2–4 supporting
// props and a ground line, and nothing else may appear. Naming the whole inventory is the difference
// between a composition and an invented background — the v1 failure was never "a background", it was
// "a background nobody chose". The upper third stays deliberately empty: it is where a busy sky would
// otherwise turn into a wall of traced lines, and white space is what makes a colouring page inviting.
//
// Two other rules earned their place:
//   - Pale, finely-outlined markings. Dark patterning (a butterfly's eyespots, a tabby's stripes)
//     traces as solid black fill. Asking for pale markings fixed v1's one genuine defect at source.
//   - No cast shadows, soft even light. A shadow comes back as a solid black shape.
//
// Standing rules: photorealistic source (the generator traces a photo, not a drawing), no people, no
// faces, no branded or copyrighted characters — nothing we don't own ships in a free download.

/** Asked for through generationConfig.imageConfig, not the prompt text — models ignore prose aspect. */
export const SOURCE_ASPECT = '3:4';

/**
 * Compose one page's source-photo prompt from its explicit inventory.
 *
 * Every noun the picture is allowed to contain appears in `elements` or `subject`. The prompt then
 * says so twice — once as the list, once as a prohibition — because "and nothing else" is the whole
 * point of the exercise and a single mention gets averaged away.
 */
export function buildScenePrompt({ subject, elements, ground }) {
  return [
    `A photorealistic photograph of ${subject}.`,
    `The picture contains exactly these things and nothing else: ${subject}; ${elements.join('; ')}; ${ground}.`,
    `Everything rests on ${ground}.`,
    'ONLY the top third of the picture is empty white space — no sky, no clouds, no horizon, no trees,',
    'no hills, no buildings, no scenery of any kind behind or above the subject.',
    'The subject and its named objects together fill the lower two thirds of the picture, edge to edge,',
    'and the subject itself is big — its head reaches up to the top third. Do not leave the middle of',
    'the picture empty. Every named object is fully inside the frame and nothing is cropped by the edges.',
    'Plain pure white background. Soft, even, shadowless lighting with no cast shadows.',
    'All markings and patterning are pale and finely outlined — no large dark patches, no solid black areas.',
    'The subject is sharply defined.',
    'Do not add any object, plant, animal or detail that is not named above.',
    'No people, no hands, no faces, no text, no logos, no watermarks.',
  ].join(' ');
}

/** subject + 2–4 named supporting elements + a ground line. Nothing unnamed may appear. */
const COMPOSITIONS = [
  {
    subject: 'pes',
    composition: {
      subject: 'a golden retriever dog standing in profile with its head turned toward the camera',
      elements: ['one ball lying beside the dog', 'one bone on the ground', 'two small tufts of grass'],
      ground: 'a simple straight ground line',
    },
  },
  {
    // parent-and-young 1 of 3
    subject: 'kočka s koťaty',
    composition: {
      subject: 'a mother cat lying down with two kittens beside her, all facing the camera',
      elements: ['one round wicker basket', 'one ball of yarn', 'three small tufts of grass'],
      ground: 'a simple straight ground line',
    },
  },
  {
    // parent-and-young 2 of 3
    subject: 'kůň s hříbětem',
    composition: {
      subject: 'a mare standing in profile with her foal standing close beside her',
      elements: ['one simple two-rail wooden fence behind them', 'one wooden bucket', 'three small tufts of grass'],
      ground: 'a simple straight ground line',
    },
  },
  {
    subject: 'liška',
    composition: {
      subject: 'a fox standing in profile with its bushy tail fully visible',
      elements: ['one tree stump', 'two mushrooms', 'three small tufts of grass'],
      // v3 first cut named "a simple straight ground line" and got a full-width rule drawn at the
      // fox's feet with the stump stranded BELOW it — two disconnected registers on one page. Naming
      // a line invites a horizon; naming the bottom edge gives the baseline that was actually wanted.
      ground: 'the bottom edge of the picture, standing directly on it, with no drawn horizon line and no horizontal rule anywhere in the picture',
    },
  },
  {
    subject: 'sova',
    composition: {
      subject: 'an owl perched upright and facing the camera with its wings folded',
      elements: ['one bare horizontal branch the owl is perched on', 'two oak leaves on the branch', 'two acorns'],
      ground: 'a simple straight ground line below the branch',
    },
  },
  {
    subject: 'ježek',
    composition: {
      subject: 'a hedgehog seen from the side with its spines and small face clearly defined',
      elements: ['one apple', 'three fallen leaves', 'two small tufts of grass'],
      // Same fix as liška: the named line came back as a spurious rule across the hedgehog's back.
      ground: 'the bottom edge of the picture, standing directly on it, with no drawn horizon line and no horizontal rule anywhere in the picture',
    },
  },
  {
    subject: 'motýl',
    composition: {
      subject: 'a butterfly with its wings fully open and flat, seen from directly above, its wing veins finely outlined',
      elements: ['one daisy flower below the butterfly', 'two long grass blades', 'one small stone'],
      ground: 'a simple straight ground line',
    },
  },
  {
    // a small group rather than a lone fish
    subject: 'rybičky',
    composition: {
      subject: 'three fish of the same kind swimming side by side in a row, seen from the side, none overlapping another',
      elements: ['two upright water plants', 'three rounded pebbles', 'one small shell'],
      ground: 'a simple straight sandy bottom line',
    },
  },
];

export default {
  name: 'zvirata',
  title: 'Zvířata',
  // The set description the blog draft is written around — keep the two in step.
  setDescription: '8 stran zvířat: pes, kočka s koťaty, kůň s hříbětem, liška, sova, ježek, motýl, rybičky',
  aspectRatio: SOURCE_ASPECT,
  // `composition` is the editable source of truth; `prompt` is derived from it so the "nothing else"
  // rule is written once and cannot drift page to page.
  pages: COMPOSITIONS.map(({ subject, composition }) => ({
    subject,
    composition,
    prompt: buildScenePrompt(composition),
  })),
};
