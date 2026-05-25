import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

export interface GitOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export class Git {
  constructor(private opts: GitOptions) {}

  async run(args: string[]): Promise<string> {
    const cmd = ["git", ...args.map(quote)].join(" ");
    const { stdout } = await exec(cmd, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  }

  async showCommitMessage(ref: string): Promise<string> {
    return this.run(["log", "-1", "--pretty=%B", ref]);
  }

  async showCommitSha(ref: string): Promise<string> {
    return this.run(["rev-parse", ref]);
  }

  async amendCommitMessage(message: string): Promise<void> {
    await this.run(["commit", "--amend", "--no-edit", "-m", message]);
  }

  async addRemote(name: string, url: string): Promise<void> {
    await this.run(["remote", "remove", name]).catch(() => undefined);
    await this.run(["remote", "add", name, url]);
  }

  async pushForce(remote: string, refspec: string, serverUrl?: string): Promise<void> {
    const args: string[] = [];
    if (serverUrl) {
      const prefix = serverUrl.replace(/\/+$/, "") + "/";
      args.push("-c", `http.${prefix}.extraheader=`);
    }
    args.push("push", "--force-with-lease", remote, refspec);
    await this.run(args);
  }

  async configIdentity(name: string, email: string): Promise<void> {
    await this.run(["config", "user.name", name]);
    await this.run(["config", "user.email", email]);
  }

  async checkoutDetached(sha: string): Promise<void> {
    await this.run(["checkout", "--detach", sha]);
  }
}

function quote(arg: string): string {
  if (/^[A-Za-z0-9_\-./@:=+]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
