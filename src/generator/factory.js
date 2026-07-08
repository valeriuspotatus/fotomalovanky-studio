import { GeneratorNotImplementedError } from './driver.js';
import { ApiGeneratorDriver } from './apiDriver.js';
import { BrowserGeneratorDriver } from './browserDriver.js';

/** Pick the generator driver from config.generator.mode. The mode is decided by
 *  the Phase-0 HAR spike ("api" if the HTTP calls reproduce, else "browser"). */
export function createGeneratorDriver(config) {
  const mode = config?.generator?.mode ?? null;
  if (mode === 'api') return new ApiGeneratorDriver(config);
  if (mode === 'browser') return new BrowserGeneratorDriver(config);
  throw new GeneratorNotImplementedError(
    'generator.mode is unset. Run the Phase-0 HAR spike (see README "Proving the seam") to decide ' +
      '"api" vs "browser", then set generator.mode in config.json.',
  );
}
