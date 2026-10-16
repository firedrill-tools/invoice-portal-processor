export const errorInfo = (error) => ({
  name: error instanceof Error ? error.name : "Error",
  message: error instanceof Error ? error.message : String(error),
});
export async function untilAbort(work, signal, late) {
  return new Promise((resolve, reject) => {
    let stopped = false;
    const abort = () => {
      stopped = true;
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Operation aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work)
      .then(
        (value) => {
          if (stopped) late?.(value);
          else resolve(value);
        },
        (error) => {
          if (!stopped) reject(error);
        },
      )
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => {});
    if (signal.aborted) abort();
  });
}
export async function within(work, milliseconds, label) {
  const controller = new AbortController(),
    timer = setTimeout(
      () => controller.abort(new Error(`${label} deadline exceeded`)),
      milliseconds,
    );
  try {
    return await untilAbort(work, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
export class RunOwner {
  constructor(signal, timeoutMs = 120000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000)
      throw new Error("Run deadline must be positive and at most 120000 ms");
    this.controller = new AbortController();
    this.active = true;
    this.deadline = performance.now() + timeoutMs;
    this.parent = signal;
    this.cancel = () =>
      this.controller.abort(
        signal.reason ?? new Error("Invoice run cancelled"),
      );
    signal?.addEventListener("abort", this.cancel, { once: true });
    if (signal?.aborted) this.cancel();
    this.timer = setTimeout(
      () => this.controller.abort(new Error("Invoice run deadline exceeded")),
      timeoutMs,
    );
  }
  get signal() {
    return this.controller.signal;
  }
  guard() {
    if (!this.active) throw new Error("Invoice run owner is closed");
    if (performance.now() >= this.deadline)
      this.controller.abort(new Error("Invoice run deadline exceeded"));
    this.signal.throwIfAborted();
  }
  close() {
    this.active = false;
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.cancel);
    this.controller.abort(new Error("Invoice run owner closed"));
    return {
      run_closed: true,
      deadline_timer_cleared: true,
      parent_listener_removed: true,
      owned_provider_operations_aborted: true,
      fetch_pool_owner: "runtime_or_injected_caller",
    };
  }
}
