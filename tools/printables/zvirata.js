// The "Zvířata" free printable set — 8 A4 coloring pages, the lead magnet the blog article
// "omalovánky zvířata k vytisknutí" hands out (see src/blog/keywordMap.js).
//
// Each page names its subject (Czech, for filenames and the PR table) and carries the ENGLISH prompt
// for the source photo. The prompts follow four rules, and they are rules because breaking any one of
// them produces a page the generator cannot turn into a usable coloring sheet:
//   1. photorealistic — the generator traces a photo, not a drawing. Feed it art and it traces art.
//   2. one subject, whole animal in frame — a crop or a second animal makes the line art ambiguous.
//   3. plain, simple background — busy scenery becomes a mess of lines a child cannot colour.
//   4. no people, no faces, no branded or copyrighted characters — nothing we don't own ships in a
//      free download.
// Soft, even daylight is asked for on purpose: hard shadows come back as solid black fill, which is
// the exact defect qc.js flags.

export default {
  name: 'zvirata',
  title: 'Zvířata',
  // The set description the blog draft is written around — keep the two in step.
  setDescription: '8 stran zvířat: pes, kočka, kůň, liška, sova, ježek, motýl, rybičky',
  pages: [
    {
      subject: 'pes',
      prompt:
        'A photorealistic full-body portrait of a friendly golden retriever dog standing on short grass, seen from the side, head turned toward the camera, ears and fur clearly defined. Plain softly blurred light background, soft even daylight, no harsh shadows. The whole animal is inside the frame. No people, no text, no logos, no collar tags.',
    },
    {
      subject: 'kočka',
      prompt:
        'A photorealistic full-body photo of a domestic short-haired cat sitting upright, tail curled around its front paws, facing the camera, whiskers and fur clearly defined. Plain light neutral background, soft even daylight, no harsh shadows. The whole animal is inside the frame. No people, no text, no logos.',
    },
    {
      subject: 'kůň',
      prompt:
        'A photorealistic full-body photo of a horse standing in a meadow, seen from the side, head slightly raised, mane and tail clearly defined. Plain softly blurred background of grass and sky, soft even daylight, no harsh shadows. The whole animal is inside the frame. No people, no riders, no saddle, no text, no logos.',
    },
    {
      subject: 'liška',
      prompt:
        'A photorealistic full-body photo of a red fox standing on a forest floor, seen from the side, head turned toward the camera, bushy tail fully visible. Plain softly blurred background, soft even daylight, no harsh shadows. The whole animal is inside the frame. No people, no text, no logos.',
    },
    {
      subject: 'sova',
      prompt:
        'A photorealistic photo of an owl perched on a bare tree branch, facing the camera, wings folded, feather pattern and large round eyes clearly defined. Plain softly blurred light background, soft even daylight, no harsh shadows. The whole bird is inside the frame. No people, no text, no logos.',
    },
    {
      subject: 'ježek',
      prompt:
        'A photorealistic photo of a European hedgehog walking on short grass, seen from the side at ground level, spines and small face clearly defined. Plain softly blurred background, soft even daylight, no harsh shadows. The whole animal is inside the frame. No people, no text, no logos.',
    },
    {
      subject: 'motýl',
      prompt:
        'A photorealistic close-up photo of a single butterfly resting on a flower with its wings fully open and flat, wing pattern and veins clearly defined, seen from directly above. Plain softly blurred light background, soft even daylight, no harsh shadows. The whole butterfly is inside the frame. No people, no text, no logos.',
    },
    {
      subject: 'rybičky',
      prompt:
        'A photorealistic photo of three tropical fish swimming side by side in clear water, seen from the side, fins and scale pattern clearly defined, arranged so none overlaps another. Plain evenly lit light blue background with no plants or rocks, soft even light, no harsh shadows. All three fish are inside the frame. No people, no text, no logos.',
    },
  ],
};
