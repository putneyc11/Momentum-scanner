import { parentPort, workerData } from "node:worker_threads";
import { runResearch } from "@momentum/engine";
try {
  parentPort?.postMessage(runResearch(workerData.days, workerData.config));
} catch (e: any) {
  parentPort?.postMessage({ error: e.message });
}
