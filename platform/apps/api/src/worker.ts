import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { Runtime } from "./runtime.js";
const c = loadConfig();
if (c.APP_MODE !== "paper")
  throw new Error("Market worker requires APP_MODE=paper");
const store = new Store(c.DATABASE_URL);
await store.init();
const runtime = new Runtime(c, store);
await runtime.start();
store.events.once("lease-lost", () => {
  runtime.stop();
  setTimeout(() => process.exit(1), 3000).unref();
  void store.close().finally(() => process.exit(1));
});
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => {
    runtime.stop();
    void store.close().then(() => process.exit(0));
  });
