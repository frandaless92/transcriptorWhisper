// queue/jobQueue.js
const crypto = require("crypto");

const jobs = new Map();
const queue = [];
let running = false;

function genId() {
  return crypto.randomBytes(8).toString("hex");
}

function createJob(runFn) {
  const id = genId();
  const now = Date.now();
  const job = {
    id,
    state: "queued", // queued | processing | finished | failed
    progress: 0,
    // 👇 inicializamos contadores
    itemsDone: 0,
    totalItems: 0,

    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    run: runFn,
  };
  jobs.set(id, job);
  queue.push(id);
  tick();
  return id;
}

async function tick() {
  if (running || !queue.length) return;
  running = true;

  const id = queue.shift();
  const job = jobs.get(id);
  if (!job) {
    running = false;
    return tick();
  }

  job.state = "processing";
  job.updatedAt = Date.now();

  const update = (patch = {}) => {
    Object.assign(job, patch);
    // clamp del progreso (defensivo)
    if (typeof job.progress === "number") {
      job.progress = Math.max(0, Math.min(100, Math.round(job.progress)));
    }
    job.updatedAt = Date.now();
  };

  try {
    const result = await job.run(update);
    update({ state: "finished", progress: 100, result });
  } catch (err) {
    update({ state: "failed", error: err?.message || String(err) });
  } finally {
    running = false;
    setImmediate(tick);
  }
}

function getJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  // 👇 incluir contadores en la respuesta
  return {
    id: job.id,
    state: job.state,
    progress: job.progress,
    itemsDone: job.itemsDone,
    totalItems: job.totalItems,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

module.exports = { createJob, getJob };
