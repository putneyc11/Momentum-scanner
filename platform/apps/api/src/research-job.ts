import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { queueResearch } from "./research.js";
const c = loadConfig();
const store = new Store(c.DATABASE_URL);
await store.init();
const id = await queueResearch(store, "cli");
console.log(`Research job queued: ${id}`);
await store.close();
