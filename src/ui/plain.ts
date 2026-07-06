/**
 * Brand styling for plain-stdout flows (remove, uninstall) that can't run
 * inside Ink because they own the terminal for readline confirmations.
 * Mirrors the Ink thread look: ┌ title, │ gutter, ◇/◆/▲ glyphs, └ footer.
 */

const ESC = "";
const RESET = `${ESC}[0m`;

const hasTrueColor = (): boolean =>
  process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit";

const useColor = (): boolean =>
  Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;

function wrap(open: string, text: string): string {
  return useColor() ? `${open}${text}${RESET}` : text;
}

export const paint = {
  /** Brand blue #0063a3, 256-color fallback. */
  brand: (text: string): string =>
    wrap(hasTrueColor() ? `${ESC}[38;2;0;99;163m` : `${ESC}[38;5;24m`, text),
  accent: (text: string): string => wrap(`${ESC}[36m`, text),
  bold: (text: string): string => wrap(`${ESC}[1m`, text),
  gray: (text: string): string => wrap(`${ESC}[37m`, text),
  green: (text: string): string => wrap(`${ESC}[32m`, text),
  yellow: (text: string): string => wrap(`${ESC}[33m`, text),
  red: (text: string): string => wrap(`${ESC}[31m`, text),
};

/** OSC-8 clickable hyperlink (plain text in terminals without support). */
export function link(url: string, label = url): string {
  if (!useColor()) {
    return label;
  }
  const osc = `${ESC}]8;;`;
  const bel = "";
  return `${osc}${url}${bel}${label}${osc}${bel}`;
}

export const glyph = {
  pending: (text: string): string => `${paint.gray("◇")} ${text}`,
  done: (text: string): string => `${paint.green("◆")} ${text}`,
  warn: (text: string): string => `${paint.yellow("▲")} ${text}`,
  fail: (text: string): string => `${paint.red("✖")} ${text}`,
};

/** A plain gutter row: `│ text`. */
export function line(text = ""): string {
  return `${paint.brand("│")} ${text}`.trimEnd();
}

/**
 * Render a thread section. Rows are pre-formatted strings (use line()/glyph.*);
 * a `│` spacer is interleaved between rows like the Ink Section.
 */
export function thread(title: string, rows: string[], footer = ""): string {
  const spacer = paint.brand("│");
  const body = rows.flatMap((row) => [spacer, row]);

  return [
    paint.brand("┌ ") + paint.bold(paint.accent(title)),
    ...body,
    spacer,
    paint.brand("└ ") + (footer ? paint.gray(footer) : ""),
  ].join("\n");
}
