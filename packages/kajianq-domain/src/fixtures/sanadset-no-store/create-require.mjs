/**
 * A loader built at runtime: `createRequire` returns a function the walker cannot follow
 * to a specifier, so its presence makes the graph opaque even though the call it returns
 * looks like an ordinary function call on the next line.
 */
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const modulePath = "./suffix-helper.js";
load(modulePath);
