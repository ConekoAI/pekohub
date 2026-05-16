export interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
}

interface Job {
  name: string;
  intervalMs: number;
  fn: () => void | Promise<void>;
  timer: ReturnType<typeof setInterval> | null;
}

export class Scheduler {
  private jobs = new Map<string, Job>();
  private running = false;

  constructor(private logger: Logger) {}

  addJob(name: string, intervalMs: number, fn: () => void | Promise<void>): void {
    if (this.jobs.has(name)) {
      this.logger.warn(`Job "${name}" already exists, overwriting`);
      this.removeJob(name);
    }

    const job: Job = { name, intervalMs, fn, timer: null };
    this.jobs.set(name, job);

    if (this.running) {
      this.startJob(job);
    }
  }

  removeJob(name: string): void {
    const job = this.jobs.get(name);
    if (!job) return;

    if (job.timer) {
      clearInterval(job.timer);
      job.timer = null;
    }

    this.jobs.delete(name);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    for (const job of this.jobs.values()) {
      this.startJob(job);
    }

    this.logger.info('Scheduler started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const job of this.jobs.values()) {
      if (job.timer) {
        clearInterval(job.timer);
        job.timer = null;
      }
    }

    this.logger.info('Scheduler stopped');
  }

  private startJob(job: Job): void {
    // Run immediately on start, then on interval
    this.runJob(job);
    job.timer = setInterval(() => {
      this.runJob(job);
    }, job.intervalMs);
  }

  private async runJob(job: Job): Promise<void> {
    this.logger.info(`Running scheduled job: ${job.name}`);
    try {
      await job.fn();
      this.logger.info(`Scheduled job completed: ${job.name}`);
    } catch (err) {
      this.logger.error(
        `Scheduled job failed: ${job.name}`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}
