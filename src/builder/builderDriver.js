// Drives the print builder (fotomalovanky-service): load an order folder of
// <base>.jpg + <base>_bw.svg pairs, set title/rotation, export the A4 PDF.
// The mechanism (native export action vs. browser print pipeline) is resolved by
// the Phase-0 builder spike. Stub until then. (playwright imported lazily later.)
export class BuilderNotImplementedError extends Error {}

export class BuilderDriver {
  constructor(config) {
    this.config = config;
  }

  /**
   * @param {string} orderDir  folder of <base>.jpg + <base>_bw.svg pairs
   * @param {object} options   { title, dedication, outPdfPath }
   * @returns {Promise<{ pdfPath: string }>}
   */
  async buildPdf(orderDir, options) {
    throw new BuilderNotImplementedError(
      "Builder driver not implemented yet — pending Phase-0 observation of the builder's " +
        'folder-load + PDF-export mechanism. See README "Proving the seam".',
    );
  }
}
