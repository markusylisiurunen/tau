import { BashJobRegistry } from "./bash_jobs.js";
import { CodeJobRegistry } from "./code_jobs.js";

type AgentJobs = {
  bashJobs: BashJobRegistry;
  codeJobs: CodeJobRegistry;
};

export class AgentJobRegistry {
  private readonly agents = new Set<AgentJobs>();
  private closed = false;

  create(): AgentJobs {
    if (this.closed) throw new Error("Background jobs are closed.");
    const jobs = { bashJobs: new BashJobRegistry(), codeJobs: new CodeJobRegistry() };
    this.agents.add(jobs);
    return jobs;
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
