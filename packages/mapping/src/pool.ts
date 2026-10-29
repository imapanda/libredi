import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { MappingError, type MappingErrorCode } from "./errors.ts";
import { DEFAULT_LIMITS, type Limits, type Mapping } from "./evaluate.ts";
import type { Job, Reply } from "./worker.ts";

export interface PoolOptions {
  /** Most worker threads. Default: one per core the process may use. */
  readonly size?: number;
  /** The limits of one document; those not given are {@link DEFAULT_LIMITS}. */
  readonly limits?: Partial<Limits>;
  /** Most heap of a worker, in MiB (`resourceLimits.maxOldGenerationSizeMb`). Default 128. */
  readonly memoryMb?: number;
  /**
   * How long after `timeoutMs` a worker that has not answered is terminated, in milliseconds.
   * JSONata checks the time limit between two steps and reports it first; this stops a single step
   * that does not end, such as a regular expression that backtracks. Default 100.
   */
  readonly graceMs?: number;
}

/** Runs mappings in worker threads that can be stopped: Node.js only. */
export interface MappingPool {
  /**
   * The output of `mapping` for `input`, or a {@link MappingError}. The mapping is read when it is
   * first given: changing the object afterwards changes nothing.
   */
  run(mapping: Mapping, input: unknown): Promise<Record<string, unknown>>;
  /** Stops every worker. The documents not mapped yet fail with `WORKER_FAILED`. */
  close(): Promise<void>;
}

interface Pending {
  readonly job: Job;
  readonly resolve: (output: Record<string, unknown>) => void;
  readonly reject: (error: MappingError) => void;
}

interface Slot {
  readonly worker: Worker;
  current: Pending | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The worker has loaded its code: until then, the time it takes to start does not count. */
  ready: boolean;
}

const failure = (code: MappingErrorCode, message: string): MappingError =>
  new MappingError({ code, message, field: null, position: null });

export function createMappingPool(options: PoolOptions = {}): MappingPool {
  const size = options.size ?? availableParallelism();
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const memoryMb = options.memoryMb ?? 128;
  const graceMs = options.graceMs ?? 100;
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError(`The pool needs at least one worker, not ${size}`);
  }

  // The mapping as JSON, taken when it is first given, and a key for the workers' caches.
  const sources = new WeakMap<Mapping, { key: number; source: string }>();
  let nextKey = 0;
  let nextJob = 0;
  const slots = new Set<Slot>();
  const queue: Pending[] = [];
  let closed = false;

  const settle = (slot: Slot): Pending | undefined => {
    const pending = slot.current;
    clearTimeout(slot.timer);
    slot.current = undefined;
    slot.timer = undefined;
    return pending;
  };

  /** Removes a worker that cannot go on, fails its document, and starts the next one. */
  const discard = (slot: Slot, error: MappingError): void => {
    if (!slots.delete(slot)) return;
    settle(slot)?.reject(error);
    void slot.worker.terminate();
    dispatch();
  };

  const start = (): Slot => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: limits,
      resourceLimits: { maxOldGenerationSizeMb: memoryMb },
    });
    const slot: Slot = { worker, current: undefined, timer: undefined, ready: false };
    worker.on("message", (reply: Reply | "ready") => {
      if (reply === "ready") {
        slot.ready = true;
        if (slot.current !== undefined) arm(slot);
        return;
      }
      if (slot.current?.job.id !== reply.id) return;
      const pending = settle(slot);
      if (reply.ok) pending?.resolve(reply.output);
      else pending?.reject(new MappingError(reply.error));
      worker.unref();
      dispatch();
    });
    worker.on("error", (error: NodeJS.ErrnoException) => {
      discard(
        slot,
        error.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? failure("OUT_OF_MEMORY", `The document needed more than ${memoryMb} MiB of memory.`)
          : failure("WORKER_FAILED", `The worker stopped: ${error.message}`),
      );
    });
    worker.on("exit", (code) => {
      discard(slot, failure("WORKER_FAILED", `The worker exited with status ${code}.`));
    });
    slots.add(slot);
    return slot;
  };

  const arm = (slot: Slot): void => {
    slot.timer = setTimeout(() => {
      discard(slot, failure("TIMEOUT", `The document took longer than ${limits.timeoutMs} ms.`));
    }, limits.timeoutMs + graceMs);
  };

  const send = (slot: Slot, pending: Pending): void => {
    slot.current = pending;
    slot.worker.ref();
    if (slot.ready) arm(slot);
    try {
      slot.worker.postMessage(pending.job);
    } catch (thrown) {
      // The input cannot be copied to a worker (a function, a symbol): the worker is fine.
      settle(slot)?.reject(failure("WORKER_FAILED", `The input cannot be sent: ${String(thrown)}`));
      slot.worker.unref();
    }
  };

  const dispatch = (): void => {
    while (queue.length > 0) {
      let slot = [...slots].find((candidate) => candidate.current === undefined);
      if (slot === undefined) {
        if (slots.size >= size) return;
        slot = start();
      }
      send(slot, queue.shift() as Pending);
    }
  };

  return {
    run(mapping, input) {
      if (closed) return Promise.reject(failure("WORKER_FAILED", "The pool is closed."));
      let known = sources.get(mapping);
      if (known === undefined) {
        known = { key: nextKey++, source: JSON.stringify(mapping) };
        sources.set(mapping, known);
      }
      const job: Job = { id: nextJob++, key: known.key, source: known.source, input };
      return new Promise((resolve, reject) => {
        queue.push({ job, resolve, reject });
        dispatch();
      });
    },

    async close() {
      closed = true;
      for (const pending of queue.splice(0)) {
        pending.reject(failure("WORKER_FAILED", "The pool is closed."));
      }
      const stopping = [...slots].map((slot) => {
        slots.delete(slot);
        settle(slot)?.reject(failure("WORKER_FAILED", "The pool is closed."));
        return slot.worker.terminate();
      });
      await Promise.all(stopping);
    },
  };
}
