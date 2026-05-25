import { describe, expect, it, vi } from "vitest";
import { Git } from "./git.js";

vi.mock("node:child_process", () => ({
  exec: (
    cmd: string,
    _opts: unknown,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void
  ) => {
    capturedCommands.push(cmd);
    cb(null, { stdout: "", stderr: "" });
  },
}));

const capturedCommands: string[] = [];

describe("Git.pushForce", () => {
  it("invokes git push with --force-with-lease and no extraheader override when serverUrl is omitted", async () => {
    capturedCommands.length = 0;
    const git = new Git({ cwd: "/tmp" });
    await git.pushForce("target", "HEAD:refs/heads/branch");
    expect(capturedCommands).toEqual([
      "git push --force-with-lease target HEAD:refs/heads/branch",
    ]);
  });

  it("prepends -c http.<host>/.extraheader= to disable leftover header for github.com", async () => {
    capturedCommands.length = 0;
    const git = new Git({ cwd: "/tmp" });
    await git.pushForce("target", "HEAD:refs/heads/branch", "https://github.com");
    expect(capturedCommands).toEqual([
      "git -c http.https://github.com/.extraheader= push --force-with-lease target HEAD:refs/heads/branch",
    ]);
  });

  it("normalizes a serverUrl with a trailing slash", async () => {
    capturedCommands.length = 0;
    const git = new Git({ cwd: "/tmp" });
    await git.pushForce("target", "HEAD:refs/heads/b", "https://ghes.example/");
    expect(capturedCommands).toEqual([
      "git -c http.https://ghes.example/.extraheader= push --force-with-lease target HEAD:refs/heads/b",
    ]);
  });
});
