import readline from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import type { ModelCatalog } from "./types.ts";

type TerminalInput = ReadStream;
type TerminalOutput = WriteStream;
type PickerKey = "up" | "down" | "space";

interface PickerState {
  cursor: number;
  selectedModels: string[];
}

interface Keypress {
  ctrl?: boolean;
  name?: string;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function parseModelSelection(input: unknown, availableModels: string[]): string[] | null {
  const models = unique(availableModels);
  const normalized = String(input ?? "").trim();
  if (!normalized) return null;
  if (normalized.toLowerCase() === "all") return models;
  if (normalized.toLowerCase() === "none") return [];

  const selected = new Set();
  const tokens = normalized.split(",").map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) return null;

  for (const token of tokens) {
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < 1 || start > models.length || end > models.length) {
        throw new Error(`Selection range is outside 1-${models.length}: ${token}`);
      }
      const step = start <= end ? 1 : -1;
      for (let index = start; ; index += step) {
        selected.add(models[index - 1]);
        if (index === end) break;
      }
      continue;
    }

    if (/^\d+$/.test(token)) {
      const index = Number(token);
      if (index < 1 || index > models.length) {
        throw new Error(`Selection number is outside 1-${models.length}: ${token}`);
      }
      selected.add(models[index - 1]);
      continue;
    }

    if (!models.includes(token)) {
      throw new Error(`Unknown model ID: ${token}`);
    }
    selected.add(token);
  }

  return models.filter((model) => selected.has(model));
}

export function applyModelPickerKey(
  state: PickerState,
  key: PickerKey,
  availableModels: string[],
): PickerState {
  if (key === "up") return { ...state, cursor: Math.max(0, state.cursor - 1) };
  if (key === "down") {
    return { ...state, cursor: Math.min(availableModels.length - 1, state.cursor + 1) };
  }

  const model = availableModels[state.cursor];
  const selected = new Set(state.selectedModels);
  if (selected.has(model)) selected.delete(model);
  else selected.add(model);
  return {
    cursor: state.cursor,
    selectedModels: availableModels.filter((item) => selected.has(item)),
  };
}

function renderModelPicker(
  availableModels: string[],
  state: PickerState,
  output: TerminalOutput,
  previousLines: number,
  message = "",
): number {
  const visibleCount = Math.min(availableModels.length, Math.max(1, (output.rows || 24) - 3));
  const start = Math.min(
    Math.max(0, state.cursor - Math.floor(visibleCount / 2)),
    availableModels.length - visibleCount,
  );
  const end = start + visibleCount;
  const selected = new Set(state.selectedModels);
  const lines = [
    `Available CLIProxy models (${start + 1}-${end}/${availableModels.length}):`,
    ...availableModels.slice(start, end).map((model, offset) => {
      const index = start + offset;
      const pointer = index === state.cursor ? ">" : " ";
      const marker = selected.has(model) ? "x" : " ";
      return `${pointer} [${marker}] ${String(index + 1).padStart(3, " ")}. ${model}`;
    }),
    "↑/↓ move  Space toggle  Enter confirm  Ctrl+C cancel",
    message || `Selected: ${state.selectedModels.length}`,
  ];

  if (previousLines > 0) output.write(`\x1b[${previousLines}F\x1b[0J`);
  output.write(`${lines.join("\n")}\n`);
  return lines.length;
}

function chooseModelsWithKeyboard(
  availableModels: string[],
  currentSelection: string[],
  requireNonEmpty: boolean,
  input: TerminalInput,
  output: TerminalOutput,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let state: PickerState = { cursor: 0, selectedModels: currentSelection };
    let renderedLines = 0;
    const wasRaw = input.isRaw;

    const cleanup = (): void => {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write("\x1b[?25h");
    };

    const onKeypress = (value: string, key: Keypress): void => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Model selection cancelled"));
        return;
      }

      if (key.name === "up" || key.name === "down" || key.name === "space" || value === " ") {
        const pickerKey: PickerKey = value === " " ? "space" : key.name as PickerKey;
        state = applyModelPickerKey(state, pickerKey, availableModels);
        renderedLines = renderModelPicker(availableModels, state, output, renderedLines);
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        if (requireNonEmpty && state.selectedModels.length === 0) {
          renderedLines = renderModelPicker(
            availableModels,
            state,
            output,
            renderedLines,
            "Select at least one model.",
          );
          return;
        }
        cleanup();
        resolve(state.selectedModels);
      }
    };

    readline.emitKeypressEvents(input);
    input.on("keypress", onKeypress);
    input.setRawMode(true);
    input.resume();
    output.write("\x1b[?25l");
    renderedLines = renderModelPicker(availableModels, state, output, renderedLines);
  });
}

interface ChooseModelsOptions {
  availableModels: string[];
  currentSelection?: string[];
  selector?: string;
  requireNonEmpty?: boolean;
  input?: TerminalInput;
  output?: TerminalOutput;
}

export async function chooseModels({
  availableModels,
  currentSelection = [],
  selector,
  requireNonEmpty = false,
  input = process.stdin,
  output = process.stdout,
}: ChooseModelsOptions): Promise<string[]> {
  const available = unique(availableModels);
  if (available.length === 0) throw new Error("CLIProxy returned no models");

  const current = available.filter((model) => currentSelection.includes(model));
  if (selector !== undefined) {
    const selected = parseModelSelection(selector, available);
    if (selected === null) throw new Error("--select must not be empty");
    if (requireNonEmpty && selected.length === 0) throw new Error("Select at least one CLIProxy model");
    return selected;
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive model selection requires a terminal; use --select all, model IDs, or number ranges");
  }

  return chooseModelsWithKeyboard(available, current, requireNonEmpty, input, output);
}

export function selectedModelsFromCatalog(catalog: ModelCatalog, prefix = "cliproxy/"): string[] {
  if (!catalog || !Array.isArray(catalog.models)) return [];
  return catalog.models
    .map((model) => model?.slug)
    .filter((slug) => typeof slug === "string" && slug.startsWith(prefix))
    .map((slug) => slug.slice(prefix.length))
    .filter(Boolean);
}
