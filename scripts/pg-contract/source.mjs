/**
 * Reading a file the way the rules need it read: a test file's code, with everything that
 * is not code blanked. Every scan here steps over what `skipLiteral` reports, so a brace,
 * a bracket or a quote inside a string, a comment or a regex is never read as structure —
 * and a read of a variable is never lost behind one.
 */

/**
 * The names a literal may be and still count as a name: the variable itself, and the
 * environment object it is read from. `"DATABASE_URL"` and `"env"` in a subscript are those
 * names rather than prose, so they stay visible to the rules that look for a read.
 */
const BARE_NAMES = new Set(["DATABASE_URL", "env"]);

/** After which characters a `/` opens a regex literal rather than dividing. */
const REGEX_PRECEDES = new Set("(,=:[!&|?{};+-*%~^<>".split(""));

const lineEnd = (source, from) => {
  const end = source.indexOf("\n", from);
  return end === -1 ? source.length : end;
};

function quotedEnd(source, from, quote) {
  for (let i = from + 1; i < source.length; i += 1) {
    if (source[i] === "\\") i += 1;
    else if (source[i] === quote) return i + 1;
    else if (source[i] === "\n") return i;
  }
  return source.length;
}

function regexEnd(source, from) {
  let inClass = false;
  for (let i = from + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") i += 1;
    else if (char === "\n") return i;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return i + 1;
  }
  return source.length;
}

/**
 * A source file's code with comments and string bodies blanked, offsets and
 * newlines kept. A scan that cannot tell a comment from a string either invents a
 * read or misses one — and missing one is the direction that leaves a suite in no
 * job at all — so strings and regex literals are recognised before comments, and
 * every scan but a template literal stops at the end of its line. A misfire can
 * then blank no more than the line it started on, and a template's `${…}` is
 * scanned as code, where a read is a read.
 */
export function codeOnly(source) {
  const out = source.split("");
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  const interpolationDepths = [];
  let inTemplate = false;
  let previous = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (inTemplate) {
      if (char === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (char === "`") {
        blank(i, i + 1);
        inTemplate = false;
        previous = "`";
        i += 1;
        continue;
      }
      if (char === "$" && next === "{") {
        inTemplate = false;
        interpolationDepths.push(0);
        i += 2;
        continue;
      }
      blank(i, i + 1);
      i += 1;
      continue;
    }
    const depth = interpolationDepths.length;
    if (char === "}" && depth > 0 && interpolationDepths[depth - 1] === 0) {
      interpolationDepths.pop();
      inTemplate = true;
      i += 1;
      continue;
    }
    if (depth > 0 && char === "{") interpolationDepths[depth - 1] += 1;
    else if (depth > 0 && char === "}") interpolationDepths[depth - 1] -= 1;
    if (char === "/" && next === "/") {
      const end = lineEnd(source, i);
      blank(i, end);
      i = end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = quotedEnd(source, i, char);
      const closed = end > i + 1 && source[end - 1] === char;
      if (!(closed && BARE_NAMES.has(source.slice(i + 1, end - 1)))) blank(i, end);
      previous = char;
      i = end;
      continue;
    }
    if (char === "`") {
      // As with a quoted literal: a template whose whole content is a bare name is that
      // name, so the subscript spelling of the read stays visible.
      const close = source.indexOf("`", i + 1);
      if (close !== -1 && BARE_NAMES.has(source.slice(i + 1, close))) {
        previous = "`";
        i = close + 1;
        continue;
      }
      inTemplate = true;
      blank(i, i + 1);
      i += 1;
      continue;
    }
    if (char === "/" && (previous === "" || REGEX_PRECEDES.has(previous))) {
      const end = regexEnd(source, i);
      blank(i, end);
      i = end;
      continue;
    }
    if (!/\s/.test(char)) previous = char;
    i += 1;
  }
  return out.join("");
}

/**
 * Where a scan that steps over the comment or literal opening at `i` resumes: its last
 * character, or the newline that ends a line comment. Null when none opens there.
 */
export function skipLiteral(source, i) {
  const char = source[i];
  const next = source[i + 1];
  if (char === "/" && next === "/") return lineEnd(source, i);
  if (char === "/" && next === "*") {
    const end = source.indexOf("*/", i + 2);
    return end === -1 ? source.length : end + 1;
  }
  if (char === '"' || char === "'" || char === "`") return quotedEnd(source, i, char) - 1;
  return null;
}
