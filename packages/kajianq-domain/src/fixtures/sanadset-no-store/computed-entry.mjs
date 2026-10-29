/** A dynamic import the walker cannot resolve statically: an opaque edge is a broken graph. */
const modulePath = "./suffix-helper.js";
await import(modulePath);
