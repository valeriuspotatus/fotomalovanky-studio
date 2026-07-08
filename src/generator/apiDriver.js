import { GeneratorDriver, GeneratorNotImplementedError } from './driver.js';

// Scripted HTTP driver — reproduces the calls the generator's web UI already makes
// (upload -> job id -> poll -> download the 3 outputs). The exact endpoints and
// payload shapes come from the Phase-0 HAR capture (U2 spike). Stub until then.
export class ApiGeneratorDriver extends GeneratorDriver {
  constructor(config) {
    super();
    this.config = config;
  }

  async generate(photoPath, settings) {
    throw new GeneratorNotImplementedError(
      'API generator driver not implemented yet — pending the Phase-0 HAR capture that reveals the ' +
        'upload/job/poll/download endpoints. See README "Proving the seam".',
    );
  }
}
