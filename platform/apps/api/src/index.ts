import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { seedDemo } from "./demo.js";
import { createApp } from "./app.js";
import { Runtime } from "./runtime.js";
const config = loadConfig();
const store = new Store(config.DATABASE_URL);
await store.init();
if (config.APP_MODE === "demo") await seedDemo(store);
let runtime: Runtime | undefined;
if (config.APP_MODE === "paper" && config.SERVICE_ROLE === "combined") {
  runtime = new Runtime(config, store);
  await runtime.start();
}
const server = createApp(config, store).listen(config.PORT, "0.0.0.0", () =>
  console.log(
    `Momentum API listening on ${config.PORT}; mode=${config.APP_MODE}`,
  ),
);
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => {
    runtime?.stop();
    server.close(() => void store.close().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  });
