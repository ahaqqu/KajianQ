export type JobHandler = () => Promise<void>;

export interface JobScheduler {
  register(name: string, handler: JobHandler): void;
  run(name: string): Promise<void>;
}

export function createJobScheduler(): JobScheduler {
  const jobs = new Map<string, JobHandler>();
  return {
    register(name, handler) {
      jobs.set(name, handler);
    },
    async run(name) {
      const h = jobs.get(name);
      if (!h) throw new Error(`job_missing:${name}`);
      await h();
    },
  };
}
