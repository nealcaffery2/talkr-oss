// Bare-bones declaration for pdf-parse's lib subpath import. The package
// publishes types for the default entry but not the lib path we have to use
// to dodge its self-test loader bug.
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: any;
    metadata: any;
    text: string;
    version: string;
  }
  function pdfParse(buffer: Buffer): Promise<PdfParseResult>;
  export default pdfParse;
}
