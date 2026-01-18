import { describe, expect, it } from "vitest";
import {
  normalizeSandboxMountPath,
  resolveSandboxWorkdir,
} from "../dist/core/utils/sandbox_paths.js";

describe("sandbox path resolution", () => {
  it("normalizes mount paths", () => {
    expect(normalizeSandboxMountPath()).toBe("/workspace");
    expect(normalizeSandboxMountPath("")).toBe("/workspace");
    expect(normalizeSandboxMountPath("/workspace/")).toBe("/workspace");
    expect(normalizeSandboxMountPath("/custom/root/")).toBe("/custom/root");
  });

  it("maps repo subdir to mount path", () => {
    const workdir = resolveSandboxWorkdir({
      rootReal: "/Code/repo",
      cwdReal: "/Code/repo/backend",
      mountPath: "/workspace",
    });
    expect(workdir).toBe("/workspace/backend");
  });

  it("maps repo root to mount path", () => {
    const workdir = resolveSandboxWorkdir({
      rootReal: "/Code/repo",
      cwdReal: "/Code/repo",
      mountPath: "/workspace",
    });
    expect(workdir).toBe("/workspace");
  });

  it("falls back to mount path when cwd is outside the root", () => {
    const workdir = resolveSandboxWorkdir({
      rootReal: "/Code/repo",
      cwdReal: "/Code",
      mountPath: "/workspace",
    });
    expect(workdir).toBe("/workspace");
  });

  it("maps non-repo cwd to mount path", () => {
    const workdir = resolveSandboxWorkdir({
      rootReal: "/some/path",
      cwdReal: "/some/path",
      mountPath: "/workspace",
    });
    expect(workdir).toBe("/workspace");
  });
});
