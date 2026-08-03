import { isAbsolute, resolve } from "node:path";
import type { TSchema } from "typebox";
import { z } from "zod";
import type { ConfigLevel } from "./paths.js";

export type CommandClientToolConfig = {
  name: string;
  defaultEnabled: boolean;
  description: string;
  parameters: TSchema;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  executionTimeoutMs?: number;
};

const jsonSchemaTypeSchema = z.enum([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "integer",
  "string",
]);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const jsonSchemaRegexSchema = z.string().refine((value) => {
  try {
    new RegExp(value, "u");
    return true;
  } catch {
    return false;
  }
}, "must be a valid Unicode regular expression");
const jsonSchemaThenKeyword = "then";
const jsonSchemaSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.boolean(),
    z
      .object({
        $id: z.string().optional(),
        $schema: z.string().optional(),
        $ref: z.string().optional(),
        $anchor: z.string().optional(),
        $dynamicRef: z.string().optional(),
        $dynamicAnchor: z.string().optional(),
        $comment: z.string().optional(),
        $defs: z.record(z.string(), jsonSchemaSchema).optional(),
        definitions: z.record(z.string(), jsonSchemaSchema).optional(),
        type: z.union([jsonSchemaTypeSchema, z.array(jsonSchemaTypeSchema).min(1)]).optional(),
        enum: z.array(z.unknown()).min(1).optional(),
        const: z.unknown().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        default: z.unknown().optional(),
        examples: z.array(z.unknown()).optional(),
        readOnly: z.boolean().optional(),
        writeOnly: z.boolean().optional(),
        deprecated: z.boolean().optional(),
        multipleOf: z.number().positive().optional(),
        maximum: z.number().optional(),
        exclusiveMaximum: z.number().optional(),
        minimum: z.number().optional(),
        exclusiveMinimum: z.number().optional(),
        maxLength: nonNegativeIntegerSchema.optional(),
        minLength: nonNegativeIntegerSchema.optional(),
        pattern: jsonSchemaRegexSchema.optional(),
        format: z.string().optional(),
        contentEncoding: z.string().optional(),
        contentMediaType: z.string().optional(),
        contentSchema: jsonSchemaSchema.optional(),
        maxItems: nonNegativeIntegerSchema.optional(),
        minItems: nonNegativeIntegerSchema.optional(),
        uniqueItems: z.boolean().optional(),
        maxContains: nonNegativeIntegerSchema.optional(),
        minContains: nonNegativeIntegerSchema.optional(),
        items: z.union([jsonSchemaSchema, z.array(jsonSchemaSchema)]).optional(),
        additionalItems: jsonSchemaSchema.optional(),
        prefixItems: z.array(jsonSchemaSchema).optional(),
        contains: jsonSchemaSchema.optional(),
        maxProperties: nonNegativeIntegerSchema.optional(),
        minProperties: nonNegativeIntegerSchema.optional(),
        required: z.array(z.string()).optional(),
        properties: z.record(z.string(), jsonSchemaSchema).optional(),
        patternProperties: z.record(jsonSchemaRegexSchema, jsonSchemaSchema).optional(),
        additionalProperties: jsonSchemaSchema.optional(),
        dependentRequired: z.record(z.string(), z.array(z.string())).optional(),
        dependentSchemas: z.record(z.string(), jsonSchemaSchema).optional(),
        propertyNames: jsonSchemaSchema.optional(),
        unevaluatedProperties: jsonSchemaSchema.optional(),
        allOf: z.array(jsonSchemaSchema).min(1).optional(),
        anyOf: z.array(jsonSchemaSchema).min(1).optional(),
        oneOf: z.array(jsonSchemaSchema).min(1).optional(),
        not: jsonSchemaSchema.optional(),
        if: jsonSchemaSchema.optional(),
        [jsonSchemaThenKeyword]: jsonSchemaSchema.optional(),
        else: jsonSchemaSchema.optional(),
      })
      .passthrough(),
  ]),
);

const commandClientToolParametersSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => value.type === "object", "must be an object JSON Schema with type 'object'")
  .refine((value) => jsonSchemaSchema.safeParse(value).success, "must be a valid JSON Schema")
  .transform((value) => value as TSchema);

const CommandClientToolSchema = z
  .object({
    name: z.string().trim().min(1),
    defaultEnabled: z.boolean(),
    description: z.string().trim().min(1),
    parameters: commandClientToolParametersSchema,
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    executionTimeoutMs: z.number().int().positive().optional(),
  })
  .strip();

export function parseCommandClientToolsConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: CommandClientToolConfig[]; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }
  if (!Array.isArray(raw)) {
    return { errors: [`${sourceLabel}: 'clientTools' must be an array.`] };
  }

  const config: CommandClientToolConfig[] = [];
  const errors: string[] = [];
  const names = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const parsed = CommandClientToolSchema.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path[0];
      const path = typeof field === "string" ? `.${field}` : "";
      errors.push(
        `${sourceLabel}: clientTools[${index}]${path} ${formatClientToolIssue(field, issue?.message)}.`,
      );
      continue;
    }

    if (names.has(parsed.data.name)) {
      errors.push(
        `${sourceLabel}: clientTools[${index}].name duplicates client tool '${parsed.data.name}'.`,
      );
      continue;
    }

    names.add(parsed.data.name);
    config.push(parsed.data);
  }

  return {
    ...(config.length > 0 ? { config } : {}),
    errors,
  };
}

export function parseEnabledClientToolsConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: string[]; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }
  if (!Array.isArray(raw)) {
    return { errors: [`${sourceLabel}: 'enabledClientTools' must be an array.`] };
  }

  const config: string[] = [];
  const errors: string[] = [];
  const names = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      errors.push(`${sourceLabel}: enabledClientTools[${index}] must be a non-empty string.`);
      continue;
    }

    const name = entry.trim();
    if (!names.has(name)) {
      names.add(name);
      config.push(name);
    }
  }

  return { config, errors };
}

export function selectCommandClientTools(
  tools: CommandClientToolConfig[],
  enabledNames?: string[],
): CommandClientToolConfig[] {
  if (enabledNames === undefined) {
    return tools.filter((tool) => tool.defaultEnabled);
  }

  const enabled = new Set(enabledNames);
  return tools.filter((tool) => enabled.has(tool.name));
}

export function resolveCommandClientToolsConfig(
  level: ConfigLevel,
  config: CommandClientToolConfig[],
): CommandClientToolConfig[] {
  return config.map((tool) => ({
    ...tool,
    command: resolveCommand(level.levelRoot, tool.command),
    ...(tool.args ? { args: [...tool.args] } : {}),
    ...(tool.env ? { env: { ...tool.env } } : {}),
  }));
}

function formatClientToolIssue(
  field: PropertyKey | undefined,
  message: string | undefined,
): string {
  switch (field) {
    case "name":
      return "must be a non-empty string";
    case "defaultEnabled":
      return "must be a boolean";
    case "description":
      return "must be a non-empty string";
    case "parameters":
      return message ?? "must be a valid object JSON Schema";
    case "command":
      return "must be a non-empty string";
    case "args":
      return "must be a string array";
    case "env":
      return "must be an object of string values";
    case "executionTimeoutMs":
      return "must be a positive integer";
    default:
      return message ?? "is invalid";
  }
}

function resolveCommand(levelRoot: string, command: string): string {
  if (isAbsolute(command)) {
    return command;
  }

  if (command.startsWith("./") || command.startsWith("../") || command.includes("/")) {
    return resolve(levelRoot, command);
  }

  return command;
}
