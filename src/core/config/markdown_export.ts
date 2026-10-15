import { z } from "zod";

export function parseMarkdownExportUrl(value: string): URL | undefined {
  if (/[\s\p{C}]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

export const markdownExportConfigSchema = z
  .object({
    url: z.string().refine((value) => {
      const url = parseMarkdownExportUrl(value);
      return (
        url !== undefined &&
        !url.hash &&
        (url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      );
    }),
    token: z
      .string()
      .trim()
      .min(1)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
    tokenEnv: z.string().trim().min(1).optional(),
  })
  .strict();

export type MarkdownExportConfig = z.infer<typeof markdownExportConfigSchema>;
