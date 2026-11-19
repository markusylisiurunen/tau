import { readFileSync } from "node:fs";
import type { z } from "zod";
import { codeModeError } from "../../code_mode/errors.js";
import type {
  TauCodeModeApi,
  TauCodeModeHandlerContext,
  TauCodeModePackage,
} from "../../code_mode/runtime.js";
import { formatZodError } from "../utils/zod.js";

/** A Tau package such as `@tau/web`, with the one-line summary the code tool description lists. */
export type CodeModePackage = TauCodeModePackage & { description: string };

export type CodeModeMethod = {
  parameters: z.ZodTuple;
  run(args: unknown[], context: TauCodeModeHandlerContext): unknown;
};

/** Declares one exported function: its positional parameters and what it does with them. */
export function method<const P extends z.ZodTuple>(
  parameters: P,
  run: (args: z.output<P>, context: TauCodeModeHandlerContext) => unknown,
): CodeModeMethod {
  return { parameters, run: run as CodeModeMethod["run"] };
}

const documentation = new Map<string, string>();

/**
 * Builds `@tau/<name>` with its reference from `static/code_mode/docs/<name>.md`. Every method
 * checks cancellation and validates its arguments before it runs, so invalid calls fail with
 * `invalid_arguments` and no side effects.
 */
export function definePackage(
  name: string,
  description: string,
  methods: Record<string, CodeModeMethod>,
): CodeModePackage {
  const packageName = `@tau/${name}`;
  const api: TauCodeModeApi = {};
  for (const [key, { parameters, run }] of Object.entries(methods)) {
    api[key] = async (args, context) => {
      context.signal.throwIfAborted();
      const parsed = parameters.safeParse(args);
      if (!parsed.success) {
        throw codeModeError(
          "invalid_arguments",
          `Invalid arguments for ${key} in ${packageName}: ${formatZodError(parsed.error)}`,
        );
      }
      return run(parsed.data, context);
    };
  }
  return { name: packageName, description, documentation: readPage(name), api };
}

export function readPage(name: string): string {
  let page = documentation.get(name);
  if (page === undefined) {
    page = readFileSync(new URL(`../static/code_mode/docs/${name}.md`, import.meta.url), "utf8");
    documentation.set(name, page);
  }
  return page;
}
