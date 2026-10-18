import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { createScanner } from "typescript/unstable/ast/scanner";
import { ContractsBarrelError } from "./errors.mjs";
import { BARREL_FILE, SRC_DIR } from "./tree.mjs";

/**
 * The barrel's own entries — the one file this gate reads as text.
 *
 * Every module is imported and its namespace is the truth, but the barrel publishes
 * from specifiers the runtime does not expose: a star entry adds names no line of
 * the file reviews, and an `export type` entry adds no value at all. Both are
 * refused, so the barrel names each value it publishes. The tokens come from the
 * compiler's own scanner, so a comment is trivia and a template is one token: an
 * inline comment inside a star entry cannot hide it, and no text inside a comment or
 * a template can fake one.
 */

/**
 * The scanner's end token. The native enum's member is `undefined` under bun's
 * module interop while the scanner still returns it, so the value the compiler's
 * enum fixes is the fallback.
 */
const END_OF_FILE = SyntaxKind.EndOfFileToken ?? 1;

/**
 * The barrel's entries that are not value entries: a star (`export * from`,
 * `export * as ns from`) and an `export type` declaration. Read with the compiler's
 * scanner, so trivia cannot fake one and a template is a single token.
 */
export function refusedEntries(root = process.cwd()) {
  const text = readBarrel(root);
  const lines = text.split("\n");
  const scanner = createScanner(true, LanguageVariant.Standard, text);
  const refused = [];
  let token = scanner.scan();
  while (token !== END_OF_FILE) {
    if (token === SyntaxKind.ExportKeyword) {
      const start = scanner.getTokenStart();
      const next = scanner.scan();
      let reason = "";
      if (next === SyntaxKind.AsteriskToken) reason = "star";
      else if (next === SyntaxKind.TypeKeyword) {
        const afterType = scanner.scan();
        if (afterType === SyntaxKind.AsteriskToken || afterType === SyntaxKind.OpenBraceToken) {
          reason = "type-only";
        }
      }
      if (reason) {
        const line = text.slice(0, start).split("\n").length;
        refused.push({ line, text: lines[line - 1].trim(), reason });
      }
    }
    token = scanner.scan();
  }
  return refused;
}

/** The barrel's text, refused rather than read as empty when it is not there. */
function readBarrel(root) {
  try {
    return readFileSync(join(root, BARREL_FILE), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (!existsSync(join(root, SRC_DIR))) {
        throw new ContractsBarrelError(
          `no ${SRC_DIR} under ${root}: there is no module tree for this gate to read`,
        );
      }
      throw new ContractsBarrelError(
        `no ${BARREL_FILE} under ${root}: the gate cannot read what it checks`,
      );
    }
    throw new ContractsBarrelError(`${BARREL_FILE} cannot be read: ${error.message}`);
  }
}
