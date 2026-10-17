// dsh-patch-edit.mjs — splice an edit into a cordis-patch layer file.
//
// A layer file is a YAML patch list, and the harness rewrites it too (the Web
// editor saves through the same path), so an edit is spliced into the block
// that owns it rather than re-serialised: the rest of the file — comments
// included — survives byte for byte. The block helpers below locate an entry
// and a nested key by indentation, which is how the file's own shape is
// preserved without parsing and re-emitting it.
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { POLICY_ENTRY, unquote } from "./dsh-compose.mjs";

/** The entry block of a layer file's patch list, as a line range. The entry is
 * an `- id:` row at any depth — a top-level patch entry or a row inside an
 * `- insert:` list — and its block runs to the next line no deeper than the row
 * itself. */
export function entryBlock(lines, entryId) {
  let found = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s+id:\s*(.+?)\s*$/);
    if (m && unquote(m[2]) === entryId) {
      found = { idx: i, indent: m[1].length };
      break;
    }
  }
  if (!found) return null;
  let end = found.idx + 1;
  for (let i = found.idx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) {
      end = i + 1;
      continue;
    }
    if (lines[i].length - lines[i].trimStart().length <= found.indent) break;
    end = i + 1;
  }
  return { idx: found.idx, indent: found.indent, end };
}

/** A `key:` block nested deeper than `minIndent` inside [start, end). */
export function blockUnder(lines, start, end, key, minIndent) {
  for (let i = start; i < end; i++) {
    const m = lines[i].match(/^(\s*)([^\s#][^:]*):\s*$/);
    if (!m || m[2].trim() !== key) continue;
    const indent = m[1].length;
    if (indent < minIndent) continue;
    let blockEnd = i + 1;
    for (let j = i + 1; j < end; j++) {
      if (!lines[j].trim()) {
        blockEnd = j + 1;
        continue;
      }
      if (lines[j].length - lines[j].trimStart().length <= indent) break;
      blockEnd = j + 1;
    }
    return { idx: i, indent, end: blockEnd };
  }
  return null;
}

/** A declaration entry for one model id, at the dash indentation its siblings
 * carry. Capability metadata (contextWindow, maxTokens) is deliberately absent:
 * the script cannot know the real values per id, and a false capability is
 * worse than the harness's own default. */
export function entryLines(id, dashIndent) {
  const pad = " ".repeat(dashIndent);
  return [
    `${pad}- id: ${id}`,
    `${pad}  reasoningEfforts:`,
    `${pad}    off: none`,
    `${pad}    low: low`,
    `${pad}    medium: medium`,
    `${pad}    high: high`,
    `${pad}    max: max`,
  ];
}

/** The complete patch entry that turns the policy on with every route given —
 * the owner pastes it into the layer that owns the policy. A patch replaces
 * the entry's config wholesale, so the block carries the whole list. */
export function policyPatchLines(routes) {
  return [
    `- id: ${POLICY_ENTRY}`,
    "  config:",
    "    enabled: true",
    "    allowedModels:",
    ...routes.flatMap((route) => {
      const [provider, model] = route.split("/");
      return [`      - provider: ${provider}`, `        model: ${model}`];
    }),
  ];
}

/** Replace a layer file with edited text: write a timestamped backup of the
 * original beside it, then the new text through a temp file and a rename, so a
 * reader never sees a half-written config. Returns the backup path. */
export async function replaceLayerFile(file, { updated, original }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const backup = `${file}.bak-${stamp}`;
  await writeFile(backup, original);
  await writeFile(`${file}.tmp`, updated);
  await rename(`${file}.tmp`, file);
  return backup;
}

/** Read a layer file as its lines, or an empty list when it is not there. */
export async function readLayerLines(file) {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8")).split("\n");
}
