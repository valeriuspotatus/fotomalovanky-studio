// The "Auta" free printable set — 8 A4 coloring pages, the lead magnet for the blog article
// "omalovánky auta k vytisknutí" (see src/blog/keywordMap.js).
//
// Built on the same template as zvířata (tools/printables/template.js), so every rule that set paid
// for in three runs applies here for free: closed inventory, an empty top third and only that, nothing
// cropped by the frame, no cast shadows, pale markings, natural orientation.
//
// Vehicles add two problems animals never had, both handled by VEHICLE_RULES:
//   - A vehicle is a product. Asked for "a fire engine" the model reaches for a real one, badge and
//     all, and a brand we do not own cannot ship in a free download. The ban is explicit and repeated.
//   - Tyres, windscreens and headlights are the dark parts of a vehicle, and dark traces as solid
//     black fill — the one thing a colouring page must not have. They are asked for as outlines.
//
// Every vehicle faces LEFT and sits level on its wheels, so the eight pages read as one set rather
// than eight unrelated pictures.

import { buildScenePrompt as composeScene, VEHICLE_RULES, SOURCE_ASPECT } from './template.js';

export { SOURCE_ASPECT };

/** This theme's prompt: the shared template plus the vehicle rules. A vehicle's roof is the part that
 *  should reach the top third, not a head. */
export function buildScenePrompt(composition) {
  return composeScene(composition, { topPart: 'roof', kindRules: VEHICLE_RULES });
}

/** Every prop is a plain roadside object with no writing on it — a sign is named as blank on purpose,
 *  because a sign is exactly where a model puts text nobody asked for. */
const COMPOSITIONS = [
  {
    subject: 'hasičské auto',
    composition: {
      subject: 'a generic unbranded fire engine seen from the side, front facing left, with a ladder on its roof',
      elements: ['one traffic cone', 'one coiled fire hose lying on the ground', 'one fire hydrant'],
      ground: 'the bottom edge of the picture, standing directly on it, with no drawn horizon line and no horizontal rule anywhere in the picture',
    },
  },
  {
    subject: 'policejní auto',
    composition: {
      subject: 'a generic unbranded police car seen from the side, front facing left, with a light bar on its roof',
      elements: ['one traffic cone', 'one traffic light on a post', 'one blank road sign on a post with no writing on it'],
      ground: 'the bottom edge of the picture, standing directly on it, with no drawn horizon line and no horizontal rule anywhere in the picture',
    },
  },
  {
    subject: 'traktor na poli',
    composition: {
      subject: 'a generic unbranded farm tractor seen from the side, front facing left, with a cab and large rear wheel',
      elements: ['three rows of low crop plants', 'one wooden fence post', 'two small bushes'],
      ground: 'the bottom edge of the picture, standing directly on it, with no drawn horizon line and no horizontal rule anywhere in the picture',
    },
  },
  {
    subject: 'bagr na stavbě',
    composition: {
      subject: 'a generic unbranded excavator seen from the side, front facing left, with its digging arm and bucket lowered to the ground',
      elements: ['one low pile of earth', 'two stacked concrete pipes', 'one traffic cone'],
      ground: 'the bottom edge of the picture, standing directly on it, with no drawn horizon line and no horizontal rule anywhere in the picture',
    },
  },
  {
    subject: 'závodní auto',
    composition: {
      subject: 'a generic unbranded racing car seen from the side, front facing left, low and streamlined with a rear wing, no sponsor markings',
      elements: ['two low racing cones', 'one plain flag on a pole', 'one spare wheel standing upright'],
      ground: 'the bottom edge of the picture, standing directly on it, with no drawn horizon line and no horizontal rule anywhere in the picture',
    },
  },
  {
    subject: 'popelářské auto',
    composition: {
      subject: 'a generic unbranded refuse lorry seen from the side, front facing left, with a loading hopper at the back',
      elements: ['two wheeled rubbish bins', 'one lamp post', 'two small bushes'],
      ground: 'the bottom edge of the picture, standing directly on it, with no drawn horizon line and no horizontal rule anywhere in the picture',
    },
  },
  {
    subject: 'autobus',
    composition: {
      subject: 'a generic unbranded single-decker city bus seen from the side, front facing left, with a row of windows along its length',
      elements: ['one blank bus stop sign on a post with no writing on it', 'one bench', 'one lamp post'],
      ground: 'the bottom edge of the picture, standing directly on it, with no drawn horizon line and no horizontal rule anywhere in the picture',
    },
  },
  {
    subject: 'náklaďák s vlekem',
    composition: {
      subject: 'a generic unbranded lorry with a separate box trailer coupled behind it, seen from the side, front facing left, both level on their wheels',
      elements: ['two wooden crates', 'one traffic cone'],
      ground: 'the bottom edge of the picture, standing directly on it, with no drawn horizon line and no horizontal rule anywhere in the picture',
    },
  },
];

export default {
  name: 'auta',
  title: 'Auta',
  // The set description the blog draft is written around — keep the two in step.
  setDescription:
    '8 stran aut: hasičské auto, policejní auto, traktor, bagr, závodní auto, popelářské auto, autobus, náklaďák s vlekem',
  aspectRatio: SOURCE_ASPECT,
  pages: COMPOSITIONS.map(({ subject, composition }) => ({
    subject,
    composition,
    prompt: buildScenePrompt(composition),
  })),
};
