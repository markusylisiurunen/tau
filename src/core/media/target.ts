import type { ApiKeysConfig } from "../config/schema.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import { describeMediaError } from "./media.js";

export type MediaContext = {
  backend: ToolExecutionBackend;
  config: ApiKeysConfig;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
};

async function targetScript(ctx: MediaContext, script: string, args: string[], stdin?: Buffer) {
  const result = await ctx.backend.runNodeScript(
    'const fs=require("node:fs"), path=require("node:path"); const args=process.argv.slice(1);\n' +
      `(async()=>{${script}})().catch(({code,path,message})=>{console.error(JSON.stringify({code,path,message}));process.exitCode=1})`,
    ["--", ...args],
    { signal: ctx.signal, stdin, timeoutMs: 600000 },
  );
  if (result.exitCode !== 0 || result.truncated || result.aborted || result.timedOut) {
    let detail: NodeJS.ErrnoException;
    try {
      detail = JSON.parse(result.stderr);
    } catch {
      throw new Error(result.stderr || "media file operation failed");
    }
    const error = Object.assign(new Error(detail.message), detail);
    error.message = describeMediaError(error);
    throw error;
  }
  return result.stdout;
}

export async function prepareOutput(ctx: MediaContext, output: string) {
  const path = JSON.parse(
    await targetScript(
      ctx,
      `const output = path.resolve(args[0]);
       if (fs.lstatSync(output, {throwIfNoEntry: false})) throw Object.assign(Error(),{code:'EEXIST',path:output});
       fs.mkdirSync(output + '.parts', {mode: 0o700});
       console.log(JSON.stringify(output));`,
      [output],
    ),
  ) as string;
  return { path, parts: `${path}.parts` };
}

export async function publish(ctx: MediaContext, artifact: string, path: string) {
  await targetScript(ctx, "fs.linkSync(args[0],args[1]);", [artifact, path]);
}

export async function writeNew(ctx: MediaContext, path: string, bytes: Buffer) {
  await targetScript(
    ctx,
    "fs.writeFileSync(args[0],fs.readFileSync(0),{flag:'wx',mode:0o600})",
    [path],
    bytes,
  );
}

export async function assembleSpeechWav(
  ctx: MediaContext,
  paths: string[],
  output: string,
  bytes: number,
  sampleRate: number,
) {
  if (bytes > 0xffffffff - 36) throw new Error("WAV size exceeds limit");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(bytes + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  await targetScript(
    ctx,
    `
       const header = fs.readFileSync(0);
       const expected = header.readUInt32LE(40);
       const file = await fs.promises.open(args[0], 'wx', 0o600);
       try {
         await file.writeFile(header);
         let copied = 0;
         for (const path of args.slice(1)) {
           for await (const chunk of fs.createReadStream(path)) {
             copied += chunk.length;
             if (copied > expected) throw Error('PCM size changed during assembly');
             await file.writeFile(chunk);
           }
         }
         if (copied !== expected) throw Error('PCM size changed during assembly');
       } finally { await file.close(); }
     `,
    [output, ...paths],
    header,
  );
}

export async function createPdfDirectory(ctx: MediaContext, outputDir?: string) {
  const dir: string = JSON.parse(
    await targetScript(
      ctx,
      `const dir = args.length ? path.resolve(args[0]) : fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tau-pdf-unpack-'));
       if (args.length) fs.mkdirSync(dir, {mode: 0o700});
       console.log(JSON.stringify(dir));`,
      outputDir ? [outputDir] : [],
    ),
  );
  return dir;
}

export async function createDir(ctx: MediaContext, path: string) {
  await targetScript(ctx, "fs.mkdirSync(args[0])", [path]);
}

export async function removeTree(ctx: MediaContext, path: string) {
  await targetScript(ctx, "fs.rmSync(args[0],{recursive:true,force:true})", [path]);
}

export async function replaceFile(ctx: MediaContext, from: string, to: string) {
  await targetScript(ctx, "fs.renameSync(...args)", [from, to]);
}

export async function removeFile(ctx: MediaContext, path: string) {
  await targetScript(ctx, "fs.unlinkSync(args[0])", [path]);
}

export async function appendBytes(ctx: MediaContext, path: string, bytes: Buffer) {
  await targetScript(ctx, "fs.appendFileSync(args[0],fs.readFileSync(0))", [path], bytes);
}
