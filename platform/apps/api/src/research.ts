import { Worker } from "node:worker_threads";
import crypto from "node:crypto";
import {
  strategyCatalog,
  type ResearchDay,
  type ResearchReport,
} from "@momentum/engine";
import { Store } from "./store.js";
export async function executeResearch(store: Store, id: string) {
  const run = await store.get<any>(`research:${id}`, {
    id,
    startedAt: new Date().toISOString(),
    status: "queued",
  });
  await store.put(`research:${id}`, {
    ...run,
    status: "running",
    stages: [
      {
        name: "Discover",
        status: "running",
        detail: "Loading recorded real market sessions",
      },
    ],
  });
  await store.publish("research", { id, status: "running" });
  try {
    const days = await store.days<ResearchDay>();
    const consumed = await store.get<string[]>(
      "researchConsumedHoldoutDates",
      [],
    );
    const report: ResearchReport = await new Promise((resolve, reject) => {
      const url = new URL(
        import.meta.url.endsWith(".ts")
          ? "./research-thread.ts"
          : "./research-thread.js",
        import.meta.url,
      );
      const worker = new Worker(url, {
        workerData: {
          days,
          config: {
            consumedHoldoutDates: consumed,
            allowPaperPromotion: false,
          },
        },
      });
      const timeout = setTimeout(() => {
        void worker.terminate();
        reject(new Error("Research exceeded 20-minute time budget"));
      }, 20 * 60000);
      worker.once("message", (m) => {
        clearTimeout(timeout);
        m.error ? reject(new Error(m.error)) : resolve(m);
      });
      worker.once("error", (e) => {
        clearTimeout(timeout);
        reject(e);
      });
      worker.once("exit", (code) => {
        if (code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`Research process exited ${code}`));
        }
      });
    });
    const complete = report.status === "COMPLETED";
    const results = report.candidates.map((c) => ({
      strategyId: c.strategyId,
      name: strategyCatalog.find((s) => s.id === c.strategyId)?.name,
      decision: c.status,
      reason:
        c.rejectionReasons.join("; ") ||
        "Challenger eligible for shadow observation only",
      trainScore: c.train.profitFactor,
      validationScore: c.validation?.profitFactor ?? null,
      holdoutScore: c.holdout?.profitFactor ?? null,
      sampleSize: c.validation?.trades || 0,
      parameters: c.parameters,
    }));
    const record = {
      ...run,
      status: complete ? "completed" : "blocked",
      completedAt: new Date().toISOString(),
      candidates: report.candidates.length,
      accepted: report.challengers.length,
      rejected: report.candidates.filter((c) => c.status === "REJECTED").length,
      summary: complete
        ? `${report.challengers.length} challengers selected for shadow; no funded version changed.`
        : report.warnings.join(" "),
      stages: [
        {
          name: "Discover",
          status: "complete",
          detail: `${report.realSessions} real sessions; ${report.rejectedData.length} data exclusions`,
        },
        {
          name: "Train",
          status: complete ? "complete" : "blocked",
          detail: `${report.split.train.length} chronological sessions`,
        },
        {
          name: "Validate",
          status: complete ? "complete" : "blocked",
          detail: `${report.split.validation.length} sessions; ${report.split.embargo.length} embargoed`,
        },
        {
          name: "Holdout",
          status: complete ? "complete" : "blocked",
          detail: `${report.split.holdout.length} unseen sessions`,
        },
        {
          name: "Promote",
          status: "blocked",
          detail: "Promotion requires review and subsequent paper observations",
        },
      ],
      results,
      report,
    };
    await store.put(`research:${id}`, record);
    for (const c of report.challengers)
      await store.put(`candidate:${c.strategyId}:${c.id}`, {
        id: c.id,
        version: c.version,
        strategyId: c.strategyId,
        status: "shadow",
        createdAt: new Date().toISOString(),
        parameters: c.parameters,
        notes:
          "Nightly challenger: validation selected; holdout is reported without adapting this search",
        researchId: id,
      });
    if (complete)
      await store.put("researchConsumedHoldoutDates", [
        ...new Set([...consumed, ...report.split.holdout]),
      ]);
    await store.audit("research-worker", "research-completed", {
      id,
      status: record.status,
      fingerprint: report.datasetFingerprint,
    });
    await store.publish("research", { id, status: record.status });
  } catch (e: any) {
    await store.put(`research:${id}`, {
      ...run,
      status: "failed",
      completedAt: new Date().toISOString(),
      summary: e.message,
      candidates: 0,
      accepted: 0,
      rejected: 0,
      results: [],
      stages: [{ name: "Research", status: "failed", detail: e.message }],
    });
    await store.publish("research", { id, status: "failed" });
  }
}
export async function queueResearch(
  store: Store,
  actor: string,
  scheduledId?: string,
) {
  const id = scheduledId || crypto.randomUUID();
  const run = {
    id,
    startedAt: new Date().toISOString(),
    status: "queued",
    candidates: 0,
    accepted: 0,
    rejected: 0,
    summary: "Queued for independent research worker",
    stages: [],
    results: [],
  };
  if (await store.insertOnce(`research:${id}`, run)) {
    await store.audit(actor, "research-queued", { id });
    await store.publish("research", { id, status: "queued" });
  }
  return id;
}
