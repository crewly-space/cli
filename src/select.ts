import { readLine, stdin } from "./tty.ts";
import { dim } from "./ui.ts";

export interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
}

const ESC = "\u001b";

const isInteractive = (): boolean =>
  process.stdin.isTTY === true &&
  process.stdout.isTTY === true &&
  typeof process.stdin.setRawMode === "function";

/**
 * Choose one option.
 *
 * On a terminal this is an arrow-key list: up/down (or j/k) to move, a digit to
 * jump straight to an entry, Enter to confirm. Anywhere else -- a pipe, CI, a
 * `--yes` script -- it degrades to the numbered prompt this CLI has always used.
 *
 * Either way an unusable answer re-asks instead of throwing. Mistyping a menu
 * key should not cost you the whole command.
 */
export async function select<T>(
  title: string,
  options: SelectOption<T>[],
  defaultIndex = 0,
): Promise<T> {
  if (options.length === 0) throw new Error("select() needs at least one option");
  const fallback = Math.min(Math.max(defaultIndex, 0), options.length - 1);
  return isInteractive()
    ? await selectInteractive(title, options, fallback)
    : await selectNumbered(title, options, fallback);
}

function renderRow<T>(option: SelectOption<T>, index: number, active: boolean): string {
  const marker = active ? "›" : " ";
  // The active row uses inverse video, so keep its hint plain to avoid a reset
  // code cutting the highlight short. Inactive hints are dimmed for hierarchy.
  const hint = option.hint ? `  ${active ? option.hint : dim(option.hint)}` : "";
  const row = `  ${marker} ${index + 1}. ${option.label}${hint}`;
  return active ? `${ESC}[7m${row}${ESC}[0m` : row;
}

async function selectInteractive<T>(
  title: string,
  options: SelectOption<T>[],
  defaultIndex: number,
): Promise<T> {
  let active = defaultIndex;
  process.stdout.write(`${title}\n`);

  const footer = dim("  ↑/↓ or j/k move · 1-9 jump · Enter choose · q quit");
  const draw = (): void => {
    for (const [index, option] of options.entries()) {
      process.stdout.write(`${renderRow(option, index, index === active)}\n`);
    }
    process.stdout.write(`${footer}\n`);
  };
  const clear = (): void => {
    process.stdout.write(`${ESC}[${options.length + 1}A${ESC}[0J`);
  };

  draw();
  process.stdin.setRawMode(true);
  try {
    for (;;) {
      const byte = await stdin.readByte();
      if (byte === null) break;
      if (byte === 0x03 || byte === 0x71) {
        process.stdout.write("\n");
        process.exit(130);
      }
      if (byte === 0x0d || byte === 0x0a) {
        clear();
        break;
      }

      let next = active;
      if (byte === 0x1b) {
        // An arrow key arrives as ESC [ A/B. A bare Escape press is ignored.
        if ((await stdin.readByte()) !== 0x5b) continue;
        const key = await stdin.readByte();
        if (key === 0x41) next = active === 0 ? options.length - 1 : active - 1;
        else if (key === 0x42) next = active === options.length - 1 ? 0 : active + 1;
        else continue;
      } else if (byte === 0x6b) {
        next = active === 0 ? options.length - 1 : active - 1;
      } else if (byte === 0x6a) {
        next = active === options.length - 1 ? 0 : active + 1;
      } else if (byte >= 0x31 && byte <= 0x39) {
        const index = byte - 0x31;
        if (index >= options.length) continue;
        next = index;
      } else {
        continue;
      }

      active = next;
      clear();
      draw();
    }
  } finally {
    process.stdin.setRawMode(false);
  }
  return options[active]!.value;
}

async function selectNumbered<T>(
  title: string,
  options: SelectOption<T>[],
  defaultIndex: number,
): Promise<T> {
  process.stdout.write(`${title}\n`);
  for (const [index, option] of options.entries()) {
    const hint = option.hint ? `  ${dim(option.hint)}` : "";
    process.stdout.write(`  ${index + 1}. ${option.label}${hint}\n`);
  }
  for (;;) {
    const answer = await readLine(`Choose [${defaultIndex + 1}]: `);
    if (answer === "") return options[defaultIndex]!.value;
    const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) {
      return options[index]!.value;
    }
    process.stdout.write(`  Enter a number from 1 to ${options.length}.\n`);
  }
}

/** Yes/no that re-asks rather than treating an unclear answer as consent. */
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  for (;;) {
    const answer = (await readLine(`${question} ${suffix} `)).toLowerCase();
    if (answer === "") return defaultYes;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    process.stdout.write("  Answer y or n.\n");
  }
}
