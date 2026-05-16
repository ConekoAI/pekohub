import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../scheduler.js';

describe('Scheduler', () => {
  let scheduler: Scheduler;
  const mockLogger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger.info.mockClear();
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    scheduler = new Scheduler(mockLogger);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('does not run jobs before start()', () => {
    const fn = vi.fn();
    scheduler.addJob('test', 1000, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs a job immediately when start() is called', () => {
    const fn = vi.fn();
    scheduler.addJob('test', 1000, fn);
    scheduler.start();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs jobs at the correct interval', () => {
    const fn = vi.fn();
    scheduler.addJob('test', 5000, fn);
    scheduler.start();

    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('supports multiple jobs with different intervals', () => {
    const fastFn = vi.fn();
    const slowFn = vi.fn();

    scheduler.addJob('fast', 1000, fastFn);
    scheduler.addJob('slow', 3000, slowFn);
    scheduler.start();

    expect(fastFn).toHaveBeenCalledTimes(1);
    expect(slowFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(fastFn).toHaveBeenCalledTimes(2);
    expect(slowFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(fastFn).toHaveBeenCalledTimes(4);
    expect(slowFn).toHaveBeenCalledTimes(2);
  });

  it('cleans up all intervals on stop()', () => {
    const fn = vi.fn();
    scheduler.addJob('test', 1000, fn);
    scheduler.start();

    scheduler.stop();
    vi.advanceTimersByTime(10000);
    expect(fn).toHaveBeenCalledTimes(1); // only the immediate run
  });

  it('does not crash when a job throws', () => {
    const throwingFn = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const normalFn = vi.fn();

    scheduler.addJob('thrower', 1000, throwingFn);
    scheduler.addJob('normal', 1000, normalFn);
    scheduler.start();

    expect(throwingFn).toHaveBeenCalledTimes(1);
    expect(normalFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(throwingFn).toHaveBeenCalledTimes(2);
    expect(normalFn).toHaveBeenCalledTimes(2);
  });

  it('logs errors when a job fails', () => {
    const throwingFn = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });

    scheduler.addJob('thrower', 1000, throwingFn);
    scheduler.start();

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Scheduled job failed: thrower',
      'boom'
    );
  });

  it('warns when overwriting an existing job', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();

    scheduler.addJob('dup', 1000, fn1);
    scheduler.addJob('dup', 2000, fn2);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Job "dup" already exists, overwriting'
    );
  });

  it('starts a job added after start() is called', () => {
    const fn = vi.fn();
    scheduler.start();
    scheduler.addJob('late', 1000, fn);

    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('supports async jobs', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    scheduler.addJob('async', 1000, fn);
    scheduler.start();

    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('logs async job errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('async boom'));
    scheduler.addJob('async-thrower', 1000, fn);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Scheduled job failed: async-thrower',
      'async boom'
    );
  });

  it('removeJob stops the job timer', () => {
    const fn = vi.fn();
    scheduler.addJob('removable', 1000, fn);
    scheduler.start();

    scheduler.removeJob('removable');
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
