"use strict";

/* controllers/escenarioQueueController.js — versión corregida y robusta */

const fs = require("fs");
const path = require("path");
const xml2js = require("xml2js");
const AdmZip = require("adm-zip");
const { spawn } = require("child_process");
const { Document, Packer, Paragraph, TextRun } = require("docx");
const { createJob, getJob } = require("../queue/jobQueue");

// ========= Helpers de logging =========
const nowISO = () => new Date().toISOString();
const log = (...args) =>
  console.log(nowISO(), "[QUEUE-TRANSCRIPCION]", ...args);
const logErr = (...args) =>
  console.error(nowISO(), "❌[QUEUE-TRANSCRIPCION]", ...args);
const fmtB = (n) => `${(n / (1024 * 1024)).toFixed(2)} MB`;

function memLog(tag) {
  const m = process.memoryUsage();
  log(
    `MEM ${tag} heapUsed=${fmtB(m.heapUsed)} rss=${fmtB(m.rss)} ext=${fmtB(
      m.external
    )}`
  );
}

// ========= Config Whisper =========
// Rutas por plataforma, con posibilidad de override por env
const DEFAULT_WHISPER = {
  win32:
    "C:\\Users\\fglag\\AppData\\Local\\Programs\\Python\\Python313\\Scripts\\whisper.exe",
  linux: "/home/administrator/whisper_env/bin/whisper",
  darwin: "/opt/homebrew/bin/whisper",
};

const WHISPER_BIN =
  process.env.WHISPER_BIN || DEFAULT_WHISPER[process.platform] || "whisper";

const WHISPER_MODEL_DIR = process.env.WHISPER_MODEL_DIR || "";

// Prompt ASCII-safe (evita comillas “tipográficas” y guiones largos)
const INITIAL_PROMPT_ASCII =
  "Audio de comunicaciones de radio policiales. Usar abreviaturas y codigo Q. " +
  "Correccion importante: si se escucha 'y radio parte', transcribir 'irradio parte'. " +
  "Abreviaturas/siglas: CPM (Central de Policia Metropolitana), S.I. (Servicio de Inteligencia), " +
  "LRRP, movil, patrulla, operativo, frecuencia segura, en transito, cambio y fuera. " +
  "Codigo Q frecuente: QSL, QRV, QTH, QRM, QRX, QRT, QRP, QRO, QSY, QSA, QSB, QTC, QTR.";

// Permite desactivar el prompt por env (diagnostico/flexibilidad)
const USE_INITIAL_PROMPT =
  String(process.env.WHISPER_USE_PROMPT || "true").toLowerCase() !== "false";

// ========= Invocacion robusta de Whisper (captura stdout/stderr, UTF-8 forzado) =========
function runWhisperAsync(wavPath, outDir) {
  return new Promise((resolve, reject) => {
    const args = [
      wavPath,
      "--model",
      // Podés cambiar a "large-v3" si lo tenés disponible; acá dejamos "large" por compatibilidad.
      process.env.WHISPER_MODEL || "large",
      "--language",
      process.env.WHISPER_LANG || "Spanish",
      "--output_dir",
      outDir,
      "--output_format",
      "txt",
    ];

    if (USE_INITIAL_PROMPT) {
      args.push("--initial_prompt", INITIAL_PROMPT_ASCII);
    }
    if (WHISPER_MODEL_DIR) {
      args.push("--model_dir", WHISPER_MODEL_DIR);
    }

    // Aseguramos PATH y locale UTF-8 (muy importante en servicios systemd)
    const env = {
      ...process.env,
      PATH: `/usr/bin:/bin:/usr/local/bin:${process.env.PATH || ""}`,
      LANG: process.env.LANG || "en_US.UTF-8",
      LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
      PYTHONUTF8: "1",
    };

    log("Invocando Whisper:", WHISPER_BIN, args.join(" "));

    const child = spawn(WHISPER_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stderr = "";
    let stdout = "";

    child.stdout?.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      // Si querés menos ruido, comentá el log siguiente:
      log("[WHISPER:STDOUT]", s.trim());
    });

    child.stderr?.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      logErr("[WHISPER:STDERR]", s.trim());
    });

    child.on("error", (err) => {
      logErr("Falló spawn whisper:", err?.message || err);
      reject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const msg = `Whisper salio con codigo ${code}. STDERR:\n${stderr}`;
        logErr(msg);
        reject(new Error(msg));
      }
    });
  });
}

// ========= Utils =========
function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function findFileRecursive(baseDir, targetNamesLower = ["scenario.xml"]) {
  const stack = [baseDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (
        ent.isFile() &&
        targetNamesLower.includes(ent.name.toLowerCase())
      ) {
        return full;
      }
    }
  }
  return null;
}

// ========= Handlers HTTP (cola) =========

// Encola el zip y devuelve jobId
async function encolarZip(req, res) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No se recibió ningún archivo .zip" });
    }

    const zipPath =
      req.file.path || path.join(req.file.destination || "", req.file.filename);
    if (!zipPath || !fs.existsSync(zipPath)) {
      return res
        .status(400)
        .json({ error: "No se pudo localizar el zip subido" });
    }

    const jobId = createJob((update) => runZipJob(zipPath, update));
    log("Job encolado:", jobId, "zip:", zipPath);
    return res.status(202).json({ jobId });
  } catch (e) {
    logErr("encolarZip:", e);
    return res.status(500).json({ error: "No se pudo encolar el trabajo" });
  }
}

// Consulta estado por jobId
async function estadoZip(req, res) {
  const { jobId } = req.params;
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: "jobId no encontrado" });

  const resp = {
    jobId: job.id,
    state: job.state,
    progress: job.progress,
    error: job.error || null,
    itemsDone: job.itemsDone || 0,
    totalItems: job.totalItems || 0,
  };

  if (job.state === "finished" && job.result) {
    resp.archivo = job.result.archivo;
    resp.mensaje = job.result.mensaje || "OK";
  }
  return res.json(resp);
}

// ========= Runner del trabajo (ejecuta en el worker de la cola) =========
async function runZipJob(zipPath, update) {
  let itemsDone = 0;

  const PROJECT_ROOT = path.resolve(__dirname, "..");
  const UPLOADS_ROOT = path.join(PROJECT_ROOT, "uploads");
  fs.mkdirSync(UPLOADS_ROOT, { recursive: true });

  const jobsRoot = path.join(UPLOADS_ROOT, "jobs");
  fs.mkdirSync(jobsRoot, { recursive: true });

  const base = path
    .basename(zipPath, path.extname(zipPath))
    .replace(/\s+/g, "_");
  const jobId = `${base}-${Date.now()}`;
  const jobDir = path.join(jobsRoot, jobId);
  const workDir = path.join(jobDir, "work");
  fs.mkdirSync(workDir, { recursive: true });

  try {
    update({ progress: 5 });
    memLog("inicio");

    // 1) Extraer ZIP
    const zipStat = fs.statSync(zipPath);
    log(`Procesando ZIP -> ${zipPath} (${fmtB(zipStat.size)})`);
    const tUnzip0 = Date.now();
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(workDir, true);
    const tUnzip1 = Date.now();
    log(`Unzip OK en ${tUnzip1 - tUnzip0} ms -> workDir=${workDir}`);
    update({ progress: 15 });

    // 2) Buscar scenario.xml
    const tFindScenario0 = Date.now();
    const xmlPrincipalPath = findFileRecursive(workDir, [
      "scenario.xml",
      "Scenario.xml",
    ]);
    const tFindScenario1 = Date.now();
    log(
      `Buscar scenario.xml: ${tFindScenario1 - tFindScenario0} ms -> ${
        xmlPrincipalPath || "NO ENCONTRADO"
      }`
    );
    if (!xmlPrincipalPath)
      throw new Error("No se encontró scenario.xml en el escenario");

    // 3) Parsear scenario.xml
    const carpetaBase = path.dirname(xmlPrincipalPath);
    const xmlData = fs.readFileSync(xmlPrincipalPath, "utf-8");
    const parser = new xml2js.Parser();

    const tParseScenario0 = Date.now();
    const escenarioParsed = await parser.parseStringPromise(xmlData);
    const tParseScenario1 = Date.now();
    log(`Parse scenario.xml: ${tParseScenario1 - tParseScenario0} ms`);

    const rutaRelativa =
      escenarioParsed?.Scenario?.Components?.[0]?.RecordedItems?.[0];
    log("RecordedItems (ruta relativa):", rutaRelativa);

    if (!rutaRelativa || typeof rutaRelativa !== "string") {
      throw new Error("No se encontró la ruta de Recorded Items");
    }

    // 4) Abrir Recorded Items.xml
    const rutaItemsXML = path.join(
      carpetaBase,
      rutaRelativa.replace(/\\/g, path.sep)
    );
    log("Recorded Items (ruta absoluta):", rutaItemsXML);
    if (!fs.existsSync(rutaItemsXML)) {
      throw new Error("No se encontró el archivo Recorded Items.xml interno");
    }

    const itemsData = fs.readFileSync(rutaItemsXML, "utf-8");
    const tParseItems0 = Date.now();
    const itemsParsed = await parser.parseStringPromise(itemsData);
    const tParseItems1 = Date.now();
    const items = itemsParsed?.RecordedItems?.Item || [];
    log(
      `Parse Recorded Items.xml: ${tParseItems1 - tParseItems0} ms | Items: ${
        items.length
      }`
    );

    if (items.length === 0)
      throw new Error("No se encontraron Items en Recorded Items.xml");

    const folderItems = path.dirname(rutaItemsXML);
    const docParagraphs = [];

    update({ totalItems: items.length, itemsDone: 0, progress: 20 });

    // 5) Procesar Items (20% -> 80%)
    for (let i = 0; i < items.length; i++) {
      const nombreItem = `Item${i + 1}`;
      const tItem0 = Date.now();
      log(`→ Procesando ${nombreItem}`);

      // localizar XML del item
      let xmlItemPath = null;
      const itemDir = path.join(folderItems, nombreItem);
      if (fs.existsSync(itemDir)) {
        const archivoXML = fs
          .readdirSync(itemDir)
          .find((f) => f.toLowerCase().endsWith(".xml"));
        if (archivoXML) xmlItemPath = path.join(itemDir, archivoXML);
      } else {
        const posible = path.join(folderItems, `${nombreItem}.xml`);
        if (fs.existsSync(posible)) xmlItemPath = posible;
      }

      log(`${nombreItem}: XML=${xmlItemPath || "NO ENCONTRADO"}`);
      if (!xmlItemPath || !fs.existsSync(xmlItemPath)) {
        log(`⚠️ Saltando ${nombreItem} (sin XML)`);
        continue;
      }

      // parse del item
      const tParseItem0 = Date.now();
      const itemXML = fs.readFileSync(xmlItemPath, "utf-8");
      const parsed = await parser.parseStringPromise(itemXML);
      const tParseItem1 = Date.now();
      log(`${nombreItem}: parse XML en ${tParseItem1 - tParseItem0} ms`);

      const result = parsed?.Item;
      const audio =
        result?.AudioItem?.[0]?.LoggerRecordings?.[0]?.Recording?.[0];
      const start =
        result?.RecordedItem?.[0]?.SearchResults?.[0]?.SearchResult?.[0]
          ?.CallId?.[0]?.StartTime?.[0];

      const archivo = audio?.WaveFileName?.[0] || "-";
      const itemBaseDir = path.dirname(xmlItemPath);
      const wavPath = path.join(itemBaseDir, archivo);
      const txtPath = path.join(itemBaseDir, archivo.replace(/\.\w+$/, ".txt"));

      log(`${nombreItem}: WAV=${wavPath}`);

      // transcribir si es necesario
      if (!fs.existsSync(wavPath)) {
        logErr(`${nombreItem}: WAV no encontrado, escribo TXT de error`);
        try {
          fs.writeFileSync(
            txtPath,
            "[ERROR AL TRANSCRIBIR] (WAV no encontrado)"
          );
        } catch {}
      } else if (!fs.existsSync(txtPath)) {
        try {
          await runWhisperAsync(wavPath, itemBaseDir);
          log(`${nombreItem}: Whisper OK`);
        } catch (e) {
          logErr(`${nombreItem}: Whisper FALLÓ ::`, e?.message || e);
          try {
            fs.writeFileSync(txtPath, "[ERROR AL TRANSCRIBIR]");
          } catch {}
        }
      } else {
        log(`${nombreItem}: TXT ya existía, no re-transcribo`);
      }

      // leer txt
      let contenido = "[ERROR AL TRANSCRIBIR]";
      const tReadTxt0 = Date.now();
      try {
        contenido = fs.readFileSync(txtPath, "utf-8");
      } catch {}
      const tReadTxt1 = Date.now();
      log(
        `${nombreItem}: leer TXT ${tReadTxt1 - tReadTxt0} ms | size=${
          fs.existsSync(txtPath) ? fmtB(fs.statSync(txtPath).size) : "n/a"
        }`
      );

      // metadatos
      const metadatos =
        result?.RecordedItem?.[0]?.SearchResults?.[0]?.SearchResult?.[0]
          ?.Fields?.[0]?.Field || [];
      const extra = metadatos.reduce((acc, field) => {
        const nombre = field?.["$"]?.Name;
        const valor = field?.Value?.[0];
        if (
          [
            "CallType",
            "CallPriority",
            "TrunkGroup_Name",
            "IndividualAlias",
            "Agent_Name",
            "UnitID",
            "Stop_Time",
          ].includes(nombre)
        ) {
          acc[nombre] = valor;
        }
        return acc;
      }, {});

      // construir párrafos
      const tParas0 = Date.now();
      docParagraphs.push(
        new Paragraph({ text: `🎧 Item: ${nombreItem}`, bold: true }),
        new Paragraph({ text: `🕒 Inicio: ${start || "-"}`, bold: true }),
        new Paragraph({
          text: `🕒 Fin: ${extra.Stop_Time || "-"}`,
          bold: true,
        }),
        new Paragraph({
          text: `👤 Alias: ${extra.IndividualAlias || "-"}`,
          bold: true,
        }),
        new Paragraph({ text: `👤 ID: ${extra.UnitID || "-"}`, bold: true }),
        new Paragraph({ text: `📝 Transcripción:` }),
        ...contenido.split(/\r?\n/).map(
          (line) =>
            new Paragraph({
              children: [new TextRun({ text: (line || "").trim(), size: 24 })],
            })
        ),
        new Paragraph("────────────────────────────────────────────")
      );
      const tParas1 = Date.now();
      log(
        `${nombreItem}: construir párrafos ${tParas1 - tParas0} ms (lineas=${
          (contenido.match(/\r?\n/g) || []).length + 1
        })`
      );

      // progreso
      itemsDone++;
      const frac = itemsDone / items.length;
      const prog = Math.floor(20 + (80 - 20) * frac);
      update({ progress: prog, itemsDone, totalItems: items.length });

      const tItem1 = Date.now();
      memLog(`${nombreItem} fin`);
      log(`← ${nombreItem} OK en ${tItem1 - tItem0} ms`);
    }

    // 6) Armar DOCX (80% -> 95%)
    update({ progress: 90 });
    const doc = new Document({
      sections: [{ properties: {}, children: docParagraphs }],
    });

    let buffer;
    try {
      buffer = await Packer.toBuffer(doc);
    } catch (e) {
      logErr("Packer falló:", e?.message || e);
      const mini = new Document({
        sections: [
          { children: [new Paragraph("Transcripción generada parcialmente.")] },
        ],
      });
      buffer = await Packer.toBuffer(mini);
    }

    const fileName = `${base}.docx`;
    const docPath = path.join(jobDir, fileName);
    fs.writeFileSync(docPath, buffer);
    log("DOCX escrito:", docPath);

    // 7) Limpieza
    try {
      fs.unlinkSync(zipPath);
      log("ZIP eliminado:", zipPath);
    } catch {}
    rmrf(workDir);
    log("work/ eliminado:", workDir);

    update({ progress: 99 });

    // 8) Resultado público
    const publicPath = `/uploads/jobs/${path.basename(jobDir)}/${fileName}`;
    log("FIN job:", path.basename(jobDir), "archivo:", publicPath);
    memLog("fin job");

    return {
      archivo: publicPath,
      mensaje: "Escenario transcripto completamente",
    };
  } catch (e) {
    // no borro workDir para inspección en caso de error
    logErr("runZipJob ERROR:", e?.stack || e?.message || e);
    throw e;
  }
}

// ========= Exports =========
module.exports = { encolarZip, estadoZip };
