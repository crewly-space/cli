/**
 * Terminal styling layer: semantic colour, status glyphs, and a progress spinner.
 *
 * Colour is opt-in and self-disabling. It turns off for pipes and CI, honours
 * NO_COLOR / FORCE_COLOR, and every state is also carried by a glyph or label so
 * nothing relies on colour alone. Output stays clean and parseable when redirected.
 */

const ESC = "\u001b";
const RESET = `${ESC}[0m`;

function flag(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

/** Whether ANSI colour is appropriate for the current output stream. */
export const colorEnabled: boolean =
  !flag("NO_COLOR") && (flag("FORCE_COLOR") || process.stdout.isTTY === true);

function paint(open: string, text: string): string {
  return colorEnabled ? `${open}${text}${RESET}` : text;
}

export const bold = (text: string): string => paint(`${ESC}[1m`, text);
export const dim = (text: string): string => paint(`${ESC}[2m`, text);
export const green = (text: string): string => paint(`${ESC}[32m`, text);
export const red = (text: string): string => paint(`${ESC}[31m`, text);
export const yellow = (text: string): string => paint(`${ESC}[33m`, text);
export const cyan = (text: string): string => paint(`${ESC}[36m`, text);

/** The brand accent: a warm amber, distinct from warning yellow. */
export function amber(text: string): string {
  return paint(`${ESC}[38;5;208m`, text);
}

/** The Crewly wordmark and other branded highlights. */
export function brand(text: string): string {
  return bold(amber(text));
}

/** Pass/fail glyph for checks: a green check or a red cross. */
export function mark(ok: boolean): string {
  return ok ? green("✓") : red("✗");
}

export type RuntimeState = "ok" | "warn" | "missing";

/** Three-state glyph for runtimes and other present / partial / absent rows. */
export function stateMark(state: RuntimeState): string {
  if (state === "ok") return green("✓");
  if (state === "warn") return yellow("!");
  return dim("·");
}

/** A section title with a dim rule underneath. */
export function heading(title: string): void {
  console.log(`\n${bold(title)}`);
  console.log(dim("─".repeat(title.length)));
}

/** A left-aligned label/value row for dashboards and status output. */
export function row(label: string, value: string, pad = 22): void {
  console.log(`  ${dim(label.padEnd(pad))} ${value}`);
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A single-line progress indicator. On an interactive terminal it animates in
 * place; anywhere else it stays quiet until the result is known, so logs and CI
 * output never contain half-finished animation frames.
 */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;

  constructor(private readonly message: string) {}

  start(): void {
    if (!this.interactive()) return;
    process.stdout.write(`${dim(FRAMES[this.frame]!)} ${this.message}`);
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      process.stdout.write(`\r${dim(FRAMES[this.frame]!)} ${this.message}${ESC}[0K`);
    }, 80);
  }

  succeed(finalMessage = this.message): void {
    this.finish(green("✓"), finalMessage);
  }

  fail(finalMessage = this.message): void {
    this.finish(red("✗"), finalMessage);
  }

  warn(finalMessage = this.message): void {
    this.finish(yellow("!"), finalMessage);
  }

  /** Clears the animated line without printing a result, so a thrown error can follow cleanly. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.interactive()) process.stdout.write(`\r${ESC}[0K`);
  }

  private interactive(): boolean {
    return colorEnabled && process.stdout.isTTY === true;
  }

  private finish(symbol: string, finalMessage: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.interactive()) {
      process.stdout.write(`\r${symbol} ${finalMessage}${ESC}[0K\n`);
    } else {
      process.stdout.write(`${symbol} ${finalMessage}\n`);
    }
  }
}
