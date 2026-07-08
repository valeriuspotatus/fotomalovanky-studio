import { GeneratorDriver, GeneratorNotImplementedError } from './driver.js';

// Playwright UI driver — drives the visible generator app (upload, pick variant,
// set prompts, process, download the 3 outputs). Used only if the HAR spike shows
// the HTTP API can't be reproduced. Stub until Phase-0 observation of the live UI.
// (playwright is imported lazily inside generate() so this module loads without it.)
export class BrowserGeneratorDriver extends GeneratorDriver {
  constructor(config) {
    super();
    this.config = config;
  }

  async generate(photoPath, settings) {
    throw new GeneratorNotImplementedError(
      'Browser generator driver not implemented yet — pending Phase-0 observation of the live ' +
        'generator UI. See README "Proving the seam".',
    );
  }
}
