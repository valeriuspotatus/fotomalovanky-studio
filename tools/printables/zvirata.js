// The "Zvířata" free printable set — 8 A4 coloring pages, the lead magnet the blog article
// "omalovánky zvířata k vytisknutí" hands out (see src/blog/keywordMap.js).
//
// Each page names its subject (Czech, for filenames and the PR table) and carries the ENGLISH prompt
// for the source photo. The rules below are rules because the FIRST run broke each of them and the
// pages showed it:
//   1. photorealistic — the generator traces a photo, not a drawing. Feed it art and it traces art.
//   2. PORTRAIT, and the animal fills the frame. Run 1 asked for nothing and got 16:9 sources, so the
//      drawing landed as a band across the middle third of a tall A4 sheet. The aspect is now also
//      requested through the API and checked in code before a generator job is ever spent.
//   3. NOTHING but the animal on plain white. Run 1 said "plain softly blurred background" and got a
//      park, a meadow, a flower — and the generator faithfully traced all of it into background
//      clutter. "Plain white background, no scene, no ground, no props" is the wording that holds.
//      No shadow either: a cast shadow comes back as a solid black shape.
//   4. no people, no faces, no branded or copyrighted characters — nothing we don't own ships in a
//      free download.
// Soft, even, shadowless light is asked for on purpose: hard shadows and very dark markings come back
// as solid black fill. deblob() cleans what survives, but not asking for it is cheaper than cleaning it.

/** Asked for through generationConfig.imageConfig, not the prompt text — models ignore prose aspect. */
export const SOURCE_ASPECT = '3:4';

/** Shared tail: the isolation rules every page needs, written once. */
const ISOLATED =
  'The animal is the only object in the picture, centred and filling most of the frame from top to bottom. ' +
  'Plain pure white background, completely empty — no scenery, no landscape, no sky, no plants, no ground, ' +
  'no floor, no surface, no props, no cast shadow. Studio product photography on a white sweep, soft even ' +
  'shadowless lighting. No people, no hands, no text, no logos, no watermarks.';

export default {
  name: 'zvirata',
  title: 'Zvířata',
  // The set description the blog draft is written around — keep the two in step.
  setDescription: '8 stran zvířat: pes, kočka, kůň, liška, sova, ježek, motýl, rybičky',
  aspectRatio: SOURCE_ASPECT,
  pages: [
    {
      subject: 'pes',
      prompt: `A photorealistic full-body studio photograph of a friendly golden retriever dog standing in profile, head turned toward the camera, ears and fur clearly defined. ${ISOLATED}`,
    },
    {
      subject: 'kočka',
      prompt: `A photorealistic full-body studio photograph of a domestic short-haired cat sitting upright, tail curled around its front paws, facing the camera, whiskers and fur clearly defined. Pale even coat with soft low-contrast markings. ${ISOLATED}`,
    },
    {
      subject: 'kůň',
      prompt: `A photorealistic full-body studio photograph of a horse standing in profile, head slightly raised, mane and tail clearly defined. ${ISOLATED}`,
    },
    {
      subject: 'liška',
      prompt: `A photorealistic full-body studio photograph of a red fox standing in profile, head turned toward the camera, bushy tail fully visible. ${ISOLATED}`,
    },
    {
      subject: 'sova',
      prompt: `A photorealistic studio photograph of an owl standing upright and facing the camera, wings folded, feather pattern and large round eyes clearly defined. ${ISOLATED}`,
    },
    {
      subject: 'ježek',
      prompt: `A photorealistic studio photograph of a European hedgehog seen from the side, spines and small face clearly defined. ${ISOLATED}`,
    },
    {
      subject: 'motýl',
      prompt:
        'A photorealistic close-up studio photograph of a single butterfly with its wings fully open and flat, seen from directly above, wing veins and outlines clearly defined. ' +
        'The wing pattern is pale and delicate with fine outlined markings — no large dark patches, no heavy black areas, no solid black eyespots. ' +
        `${ISOLATED}`,
    },
    {
      subject: 'rybičky',
      prompt: `A photorealistic studio photograph of three tropical fish seen from the side, arranged one above another so none overlaps, fins and scale pattern clearly defined as fine outlines. ${ISOLATED}`,
    },
  ],
};
