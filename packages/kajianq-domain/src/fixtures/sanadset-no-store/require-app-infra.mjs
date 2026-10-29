/**
 * A CommonJS `require` of the denied workspace package. The package is ESM, so this form
 * would not run; the walker still has to see the edge it names rather than reading the
 * file as a module with no imports.
 */
require("@app/infra");
