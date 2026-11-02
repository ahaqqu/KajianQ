/**
 * The one code-point length test the bounded schema strings share.
 *
 * JSON Schema's `maxLength` counts code points, while `String.prototype.length`
 * counts UTF-16 code units, so a valibot `maxLength` action refuses a string the
 * published bound admits as soon as it carries an astral character. Counting
 * through `Array.from` keeps both readers on the published unit; a bounded
 * schema publishes its `maxLength` from the same cap constant as metadata, so
 * the served document and the parse cannot drift.
 */
export function isWithinCodePointCap(value: string, cap: number): boolean {
  return Array.from(value).length <= cap;
}
