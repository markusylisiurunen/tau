import { z } from "zod";

const environmentVariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const environmentVariableValueSchema = z.string().refine((value) => !value.includes("\0"));

export const environmentVariablesSchema = z
  .record(environmentVariableNameSchema, environmentVariableValueSchema)
  .refine((value) => !("HOME" in value), "HOME is controlled by the execution environment");
