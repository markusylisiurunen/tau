import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import { TOOL_NAME_DIFF_REVIEW } from "../tools/tool_names.js";
import { formatZodError } from "../utils/zod.js";
import { type DiffReviewSnapshotSource, formatDiffReviewScope } from "./snapshot.js";

const DIFF_REVIEW_DESCRIPTION = [
  "Launch an interactive diff review tool for the user and wait for the user to return review feedback.",
  "Use this tool only when the user explicitly asks you to open, run, or start a diff review.",
  "Do not use it for ordinary diff inspection; use shell/file tools only for inspection instead.",
].join(" ");

const DIFF_REVIEW_SOURCE_DESCRIPTION =
  "Review source. Prefer 'git_diff' for normal reviews because the diff is captured directly from git. Use 'patch_files' only when you need more control than git diff args provide, such as selected hunks, a hand-curated subset of a large file, or multiple custom patches.";

const DIFF_REVIEW_ARGS_DESCRIPTION = [
  "Arguments to pass to git diff when source is 'git_diff'. Use [] to review the current working tree.",
  'Common patterns: staged changes ["--staged"], full branch diff against main ["main...HEAD"], path-limited current changes ["--", "path/to/file"], path-limited branch diff ["main...HEAD", "--", "path/to/file"].',
].join(" ");

const DIFF_REVIEW_PATCH_FILES_DESCRIPTION =
  "Patch files to review when source is 'patch_files'. Required for patch_files. Files may be absolute or relative to the current working directory. Each file must contain git unified diff sections with diff --git headers. Use this for selected hunks or custom review scopes. Patch files may be generated in any way as long as they adhere to that format, for example with git commands, by running code that emits a patch, or by manually editing a temporary patch file. One common approach is using `mktemp` to create a patch file in the platform temporary directory, writing selected `git diff` output to it, and passing the reported path. Multiple patch files are allowed.";

const DIFF_REVIEW_LABEL_DESCRIPTION =
  "Optional human-readable label for patch-file reviews, for example 'selected hunks from src/foo.ts'.";

export const DIFF_REVIEW_TOOL: Tool = {
  name: TOOL_NAME_DIFF_REVIEW,
  description: DIFF_REVIEW_DESCRIPTION,
  parameters: Type.Object(
    {
      source: Type.String({
        description: DIFF_REVIEW_SOURCE_DESCRIPTION,
        enum: ["git_diff", "patch_files"],
      }),
      diffArgs: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: DIFF_REVIEW_ARGS_DESCRIPTION,
        }),
      ),
      patchFiles: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: DIFF_REVIEW_PATCH_FILES_DESCRIPTION,
        }),
      ),
      label: Type.Optional(
        Type.String({
          description: DIFF_REVIEW_LABEL_DESCRIPTION,
        }),
      ),
    },
    { additionalProperties: false },
  ),
};

const diffReviewArgsSchema = z
  .object({
    source: z.enum(["git_diff", "patch_files"]),
    diffArgs: z.array(z.string().trim().min(1)).optional(),
    patchFiles: z.array(z.string().trim().min(1)).optional(),
    label: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source === "patch_files" && (!value.patchFiles || value.patchFiles.length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["patchFiles"],
        message: "patchFiles must contain at least one file when source is 'patch_files'",
      });
    }
  });

export type ParsedDiffReviewToolArgs = {
  source: DiffReviewSnapshotSource;
  command: string;
};

export function parseDiffReviewToolArgs(
  raw: unknown,
): { ok: true; data: ParsedDiffReviewToolArgs } | { ok: false; error: string; command: string } {
  const parsed = diffReviewArgsSchema.safeParse(raw);
  const rawRecord = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const rawDiffArgs = Array.isArray(rawRecord.diffArgs)
    ? rawRecord.diffArgs.filter((arg): arg is string => typeof arg === "string")
    : [];
  const rawPatchFiles = Array.isArray(rawRecord.patchFiles)
    ? rawRecord.patchFiles.filter((arg): arg is string => typeof arg === "string")
    : [];
  const command =
    rawRecord.source === "patch_files"
      ? formatPatchFilesScope(
          rawPatchFiles,
          typeof rawRecord.label === "string" ? rawRecord.label : undefined,
        )
      : formatDiffReviewScope(rawDiffArgs);

  if (!parsed.success) {
    return {
      ok: false,
      error: formatZodError(parsed.error),
      command,
    };
  }

  if (parsed.data.source === "git_diff") {
    const diffArgs = parsed.data.diffArgs ?? [];
    return {
      ok: true,
      data: {
        source: { kind: "git_diff", diffArgs },
        command: formatDiffReviewScope(diffArgs),
      },
    };
  }

  const patchFiles = parsed.data.patchFiles ?? [];
  const scopeLabel = formatPatchFilesScope(patchFiles, parsed.data.label);
  return {
    ok: true,
    data: {
      source: {
        kind: "patch_files",
        patchFiles,
        scopeLabel,
      },
      command: scopeLabel,
    },
  };
}

function formatPatchFilesScope(patchFiles: string[], label?: string): string {
  const trimmedLabel = label?.trim();
  if (trimmedLabel) {
    return trimmedLabel;
  }
  if (patchFiles.length === 1) {
    return `patch file ${patchFiles[0]}`;
  }
  return `${patchFiles.length} patch files`;
}
