// controllers/historialController.js
const fs = require("fs");
const path = require("path");

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0,
    n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
}

async function listarTrabajos(req, res) {
  try {
    // Rutas absolutas seguras
    const PROJECT_ROOT = path.resolve(__dirname, "..");
    const UPLOADS_ROOT = path.join(PROJECT_ROOT, "uploads");
    const jobsRoot = path.join(UPLOADS_ROOT, "jobs");

    if (!fs.existsSync(jobsRoot)) return res.json({ items: [] });

    const limit = Math.max(0, Math.min(500, Number(req.query.limit) || 100));
    const items = [];

    const jobDirs = fs
      .readdirSync(jobsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const dir of jobDirs) {
      const absDir = path.join(jobsRoot, dir);
      let files = [];
      try {
        files = fs
          .readdirSync(absDir, { withFileTypes: true })
          .filter((f) => f.isFile() && f.name.toLowerCase().endsWith(".docx"))
          .map((f) => f.name);
      } catch {}

      for (const file of files) {
        const absFile = path.join(absDir, file);
        let stat;
        try {
          stat = fs.statSync(absFile);
        } catch {
          continue;
        }

        items.push({
          jobId: dir,
          file: file,
          url: `/uploads/jobs/${dir}/${file}`,
          size: stat.size,
          sizeHuman: humanSize(stat.size),
          mtime: stat.mtimeMs,
          mtimeISO: new Date(stat.mtimeMs).toISOString(),
        });
      }
    }

    // Orden: más reciente primero
    items.sort((a, b) => b.mtime - a.mtime);
    res.json({ items: items.slice(0, limit) });
  } catch (e) {
    console.error("❌ listarTrabajos:", e);
    res.status(500).json({ error: "No se pudo listar el historial" });
  }
}

module.exports = { listarTrabajos };
