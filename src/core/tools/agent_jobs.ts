import { BashJobRegistry } from "./bash_jobs.js";
import { CodeJobRegistry } from "./code_jobs.js";

export type AgentJobs = {
  bashJobs: BashJobRegistry;
  codeJobs: CodeJobRegistry;
  release(): void;
};

export class AgentJobRegistry {
  private readonly agents = new Set<AgentJobs>();
  private closed = false;

  create(): AgentJobs {
    if (this.closed) throw new Error("Background jobs are closed.");
    const jobs: AgentJobs = {
      bashJobs: new BashJobRegistry(),
      codeJobs: new CodeJobRegistry(),
      release: () => {
        void this.release(jobs);
      },
    };
    this.agents.add(jobs);
    return jobs;
  }

  private async release(jobs: AgentJobs): Promise<void> {
    while (jobs.bashJobs.hasRunning || jobs.codeJobs.hasRunning) {
      const results = await Promise.allSettled([
        jobs.codeJobs.waitForIdle(),
        jobs.bashJobs.waitForIdle(),
      ]);
      // Keep failed cleanup tracked so session disposal can report it.
      if (results.some((result) => result.status === "rejected")) return;
    }
    this.agents.delete(jobs);
  }

  get hasRunning(): boolean {
    return [...this.agents].some((jobs) => jobs.bashJobs.hasRunning || jobs.codeJobs.hasRunning);
  }

  async waitForIdle(): Promise<void> {
    while (this.hasRunning) {
      await Promise.all(
        [...this.agents].flatMap((jobs) => [
          jobs.codeJobs.waitForIdle(),
          jobs.bashJobs.waitForIdle(),
        ]),
      );
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const code = await Promise.allSettled([...this.agents].map((jobs) => jobs.codeJobs.dispose()));
    const bash = await Promise.allSettled([...this.agents].map((jobs) => jobs.bashJobs.dispose()));
    const errors = [...code, ...bash].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "failed to stop background jobs");
  }
}
