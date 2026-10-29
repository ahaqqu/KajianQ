/**
 * A single bare side-effect import, the form `import "@app/infra";`. The walker must see
 * it as an edge: it loads the module, so it gives the study a connection path even though
 * it binds no name.
 */
import "@app/infra";
