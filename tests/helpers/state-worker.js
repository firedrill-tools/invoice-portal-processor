import fs from "node:fs";
import { Store } from "../../src/state.js";
import { locked } from "../../src/source-lock.js";
const file = process.argv[2];
process.send({ ready: true });
process.once("message", (message) => {
  try {
    if (message.kind === "hold") {
      locked(file, () => {
        process.send({ locked: true });
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          message.holdMs ?? 1500,
        );
      });
      process.send({ ok: true, held: true });
    } else {
      const store = new Store(
        file,
        message.crash === "after"
          ? {
              rename: (from, to) => {
                fs.renameSync(from, to);
                process.exit(82);
              },
            }
          : {},
      );
      const result = store.submit(message.sourceId, message.input, {
        guard: ({ phase }) => {
          if (message.crash === "before" && phase === "before_publish")
            process.exit(81);
        },
      });
      process.send({ ok: true, result });
    }
  } catch (error) {
    process.send({ ok: false, error: error.message, code: error.code });
  } finally {
    process.disconnect();
  }
});
