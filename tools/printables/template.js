// The shared source-photo prompt template every printable theme composes against.
//
// Extracted from the zvířata theme once a second theme needed the same rules. The rules are not
// stylistic preferences; each one is a defect that shipped and had to be fixed:
//
//   closed inventory      v1 asked for "a plain softly blurred background" and got a park, a meadow
//                         and a flower bed, all faithfully traced into clutter. Naming every object
//                         the picture may contain — twice, once as a list and once as a prohibition —
//                         is the difference between a composed scene and an invented one.
//   empty top third only  "the upper third is empty" was read as permission and came back as an empty
//                         upper HALF with the subject shrunk into the bottom. It is a limit, not a
//                         licence, and the subject has to be told to fill the rest.
//   nothing cropped       props kept getting sliced by the frame edge.
//   no cast shadows       a shadow traces as a solid black shape.
//   pale markings         dark patterning (a butterfly's eyespots, a tabby's stripes) traces as solid
//                         black fill, which is the one thing a colouring page must not have.
//   natural orientation   the fish came back standing on their tails, swimming up the page, because a
//                         tall subject in a tall frame invites the model to rotate it to fit.
//
// `kindRules` carries whatever is specific to what is being drawn — animals stand and perch, vehicles
// have wheels and must not wear a brand — so the universal rules stay in one place and each theme adds
// only what its own subject needs.

/** Asked for through generationConfig.imageConfig, not the prompt text — models ignore prose aspect. */
export const SOURCE_ASPECT = '3:4';

/**
 * Compose one page's source-photo prompt from its explicit inventory.
 *
 * @param {{subject: string, elements: string[], ground: string}} composition
 * @param {object} [o]
 * @param {string} [o.topPart]   the part of the subject that should reach the top third ("head", "roof")
 * @param {string[]} [o.kindRules] subject-kind rules, inserted before the closing prohibitions
 */
export function buildScenePrompt({ subject, elements, ground }, { topPart = 'head', kindRules = [] } = {}) {
  return [
    `A photorealistic photograph of ${subject}.`,
    `The picture contains exactly these things and nothing else: ${subject}; ${elements.join('; ')}; ${ground}.`,
    `Everything rests on ${ground}.`,
    'ONLY the top third of the picture is empty white space — no sky, no clouds, no horizon, no trees,',
    'no hills, no buildings, no scenery of any kind behind or above the subject.',
    'The subject and its named objects together fill the lower two thirds of the picture, edge to edge,',
    `and the subject itself is big — its ${topPart} reaches up to the top third. Do not leave the middle of`,
    'the picture empty. Every named object is fully inside the frame and nothing is cropped by the edges.',
    'Plain pure white background. Soft, even, shadowless lighting with no cast shadows.',
    'All markings and patterning are pale and finely outlined — no large dark patches, no solid black areas.',
    'The subject is sharply defined.',
    ...kindRules,
    'Do not add any object, plant, animal or detail that is not named above.',
    'No people, no hands, no faces, no text, no logos, no watermarks.',
  ].join(' ');
}

/** The orientation rules for living subjects. */
export const ANIMAL_RULES = Object.freeze([
  'Every animal is in its natural orientation, side view, as it would really stand, sit, perch or swim.',
  'Never rotate, tilt or stand an animal on end to make it fit the tall frame. If the animal is wider',
  'than it is tall, keep it that way and fill the remaining height with the named objects instead.',
]);

/**
 * The rules for vehicles. Two problems animals never had:
 *  - a vehicle is a product, so the model reaches for a real one with a badge on it. Nothing we do not
 *    own may ship in a free download, so the brand ban is explicit and repeated.
 *  - tyres, windscreens and headlights are the dark parts of a car and trace as solid black fill,
 *    which is exactly what a colouring page cannot have. They have to be asked for as outlines.
 */
export const VEHICLE_RULES = Object.freeze([
  // A strict side ELEVATION, said in the language of drawing rather than photography: the first probe
  // returned a three-quarter view with perspective on the front, which is a perfectly good photograph
  // and makes a set of eight pages look like eight unrelated pictures.
  'The vehicle is drawn as a strict flat side elevation, photographed square-on from the side, level,',
  'with both wheels on the ground and the front facing left. No three-quarter angle, no perspective on',
  'the front or back, no view from above; the side of the vehicle faces the camera completely flat.',
  'Never tilt, rotate or angle the vehicle to fill the tall frame; keep it level and fill the height with the named objects.',
  // A vehicle is wide and short, so a tall frame leaves space above it unless the scale is stated.
  // Probe page 2 put a small car in the bottom third under an empty upper half.
  'The vehicle is LARGE and spans almost the full width of the picture, from edge to edge.',
  'The tall named objects such as posts, signs, lights and hydrants stand beside the vehicle and reach',
  'well above its roof, so that only the top third of the picture is left empty.',
  'The vehicle is generic and completely unbranded: no manufacturer badge, no brand name, no model name,',
  'no writing on the bodywork, no advertising, no number plate text, and no emergency-service insignia copied from a real force.',
  'Wheels, tyres, windows, windscreen and headlights are drawn as clean outlines with white interiors,',
  'never filled dark — no black tyres, no black glass.',
]);
