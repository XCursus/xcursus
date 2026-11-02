/**
 * Numeric semantics of the impress.js 2.0.0 baseline (`src/lib/util.js` and
 * `validateOrder` in `src/impress.js`), reproduced exactly because the
 * attributes are interpreted by them: `Number()` coercion, a fallback only
 * for NaN (`fallback || 0`), `w`/`h` multiples of the configured size.
 */
export function toNumber(
  value: string | null | undefined,
  fallback?: number,
): number {
  const n = value === undefined ? Number.NaN : Number(value);
  return Number.isNaN(n) ? fallback || 0 : n;
}

export interface SizeConfig {
  width: number;
  height: number;
}
export function toNumberAdvanced(
  value: string | null | undefined,
  config: SizeConfig,
  fallback?: number,
): number {
  if (typeof value !== "string") return toNumber(value, fallback);
  const ratio = /^([+-]*[\d.]+)([wh])$/.exec(value);
  if (!ratio) return toNumber(value, fallback);
  return (
    Number.parseFloat(ratio[1]!) *
    (ratio[2] === "w" ? config.width : config.height)
  );
}

/**
 * `validateOrder`: keeps the first occurrence of each of `x`, `y`, `z` in
 * order, drops every other character, and falls back to `xyz` when nothing
 * is left. A partial result such as `zx` is valid upstream and applies only
 * the listed rotations.
 */
export function validateOrder(order: string | undefined): string {
  let valid = "xyz",
    result = "";
  if (typeof order === "string")
    for (const c of order)
      if (valid.includes(c)) {
        result += c;
        valid = valid.split(c).join("");
      }
  return result || "xyz";
}

/** `String(n)` of an attribute written by the rel plugin, read back as text. */
export const attributeText = (n: number): string => String(n);
