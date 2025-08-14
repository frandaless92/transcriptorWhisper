"use strict";

/* controllers/escenarioQueueController.js — con FFmpeg preprocesado + Whisper */

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

// ========= Config FFmpeg =========
const DEFAULT_FFMPEG = {
  win32: "ffmpeg.exe",
  linux: "/usr/bin/ffmpeg",
  darwin: "/opt/homebrew/bin/ffmpeg",
};
const FFMPEG_BIN =
  process.env.FFMPEG_BIN || DEFAULT_FFMPEG[process.platform] || "ffmpeg";

// ========= Config Whisper =========
const DEFAULT_WHISPER = {
  win32:
    "C:\\Users\\fglag\\AppData\\Local\\Programs\\Python\\Python313\\Scripts\\whisper.exe",
  linux: "/home/administrator/whisper_env/bin/whisper",
  darwin: "/opt/homebrew/bin/whisper",
};
const WHISPER_BIN =
  process.env.WHISPER_BIN || DEFAULT_WHISPER[process.platform] || "whisper";
const WHISPER_MODEL_DIR = process.env.WHISPER_MODEL_DIR || "";

const INITIAL_PROMPT_ASCII =
  "Audio de comunicaciones de radio policiales. Usar abreviaturas y codigo Q. " +
  "Abreviaturas/siglas" +
  "Codigo Q frecuente: QSL, QRV, QTH, QRM, QRX, QRT, QRP, QRO, QSY, QSA, QSB, QTC, QTR.";

const USE_INITIAL_PROMPT =
  String(process.env.WHISPER_USE_PROMPT || "true").toLowerCase() !== "false";

// ========= Entorno base para subprocesos =========
function baseEnv() {
  return {
    ...process.env,
    PATH: `/usr/bin:/bin:/usr/local/bin:${process.env.PATH || ""}`,
    LANG: process.env.LANG || "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
    PYTHONUTF8: "1",
  };
}

// ========= FFmpeg: preprocesar a WAV mono 16k PCM s16le =========
function preprocessAudioAsync(inputPath, outDir) {
  return new Promise((resolve, reject) => {
    const base = path.basename(inputPath, path.extname(inputPath));
    const sanitizedPath = path.join(outDir, `${base}.san.wav`);

    // Argumentos conservadores y portables:
    const args = [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-y", // overwrite
      "-i",
      inputPath, // input
      "-vn",
      "-sn",
      "-dn", // sin video/sub/ data
      "-map_metadata",
      "-1", // sin metadata
      "-ac",
      "1", // mono
      "-ar",
      "16000", // 16 kHz
      "-c:a",
      "pcm_s16le", // PCM 16-bit
      sanitizedPath,
    ];

    log("Invocando FFmpeg:", FFMPEG_BIN, args.join(" "));
    const child = spawn(FFMPEG_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: baseEnv(),
    });

    let stderr = "";
    let stdout = "";

    child.stdout?.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      log("[FFMPEG:STDOUT]", s.trim());
    });
    child.stderr?.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      logErr("[FFMPEG:STDERR]", s.trim());
    });

    child.on("error", (err) => {
      logErr("Falló spawn ffmpeg:", err?.message || err);
      reject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(sanitizedPath);
      } else {
        const msg = `FFmpeg salió con código ${code}. STDERR:\n${stderr}`;
        logErr(msg);
        reject(new Error(msg));
      }
    });
  });
}

// ========= Whisper: transcribir =========
function runWhisperAsync(wavPath, outDir) {
  return new Promise((resolve, reject) => {
    const args = [
      wavPath,
      "--model",
      "large-v3",
      "--language",
      process.env.WHISPER_LANG || "Spanish",
      "--fp16",
      "False",
      "--output_dir",
      outDir,
      "--output_format",
      "txt",
    ];
    if (USE_INITIAL_PROMPT) {
      args.push("--initial_prompt", INITIAL_PROMPT_ASCII);
    }
    // if (WHISPER_MODEL_DIR) {
    //   args.push("--model_dir", WHISPER_MODEL_DIR);
    // }

    log("Invocando Whisper:", WHISPER_BIN, args.join(" "));
    const child = spawn(WHISPER_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: baseEnv(),
    });

    let stderr = "";
    let stdout = "";

    child.stdout?.on("data", (d) => {
      const s = d.toString();
      stdout += s;
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
        const msg = `Whisper salió con código ${code}. STDERR:\n${stderr}`;
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

// ========= Runner del trabajo =========
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
      const wavPathOriginal = path.join(itemBaseDir, archivo);

      // TXT "clásico" (por si existe de antes)
      const txtPathFromOriginal = path.join(
        itemBaseDir,
        path.basename(wavPathOriginal, path.extname(wavPathOriginal)) + ".txt"
      );

      log(`${nombreItem}: WAV original=${wavPathOriginal}`);

      let wavSanitizado;

      if (!fs.existsSync(wavPathOriginal)) {
        logErr(`${nombreItem}: WAV no encontrado, escribo TXT de error`);
        try {
          fs.writeFileSync(
            txtPathFromOriginal,
            "[ERROR AL TRANSCRIBIR] (WAV no encontrado)"
          );
        } catch {}
      } else {
        // (A) Preprocesar con FFmpeg -> genera .san.wav
        wavSanitizado = null;
        try {
          const tF0 = Date.now();
          wavSanitizado = await preprocessAudioAsync(
            wavPathOriginal,
            itemBaseDir
          );
          const tF1 = Date.now();
          log(
            `${nombreItem}: FFmpeg sanitizado OK en ${
              tF1 - tF0
            } ms -> ${wavSanitizado}`
          );
        } catch (e) {
          logErr(`${nombreItem}: FFmpeg FALLÓ ::`, e?.message || e);
          // Si falló el san, intentamos igual con el original
          wavSanitizado = wavPathOriginal;
        }

        // TXT esperado del WAV realmente usado por Whisper
        const baseNameFinal = path.basename(
          wavSanitizado || wavPathOriginal,
          path.extname(wavSanitizado || wavPathOriginal)
        );
        const txtPathFromSanitized = path.join(
          itemBaseDir,
          baseNameFinal + ".txt"
        );

        // (B) Si no hay TXT (ni del sanitizado ni del original), transcribir con Whisper
        if (
          !fs.existsSync(txtPathFromSanitized) &&
          !fs.existsSync(txtPathFromOriginal)
        ) {
          try {
            const tW0 = Date.now();
            await runWhisperAsync(wavSanitizado, itemBaseDir);
            const tW1 = Date.now();
            log(`${nombreItem}: Whisper OK en ${tW1 - tW0} ms`);
          } catch (e) {
            logErr(`${nombreItem}: Whisper FALLÓ ::`, e?.message || e);
            try {
              const targetTxt = txtPathFromSanitized || txtPathFromOriginal;
              fs.writeFileSync(targetTxt, "[ERROR AL TRANSCRIBIR]");
            } catch {}
          }
        } else {
          log(`${nombreItem}: TXT ya existía, no re-transcribo`);
        }

        // (C) Limpieza opcional del .san.wav
        try {
          if (
            wavSanitizado &&
            wavSanitizado !== wavPathOriginal &&
            fs.existsSync(wavSanitizado)
          ) {
            fs.unlinkSync(wavSanitizado);
            log(`${nombreItem}: .san.wav eliminado`);
          }
        } catch {}
      }

      // Determinar el TXT exacto que debería haber generado Whisper según el WAV usado
      let txtPath;
      try {
        // Si sanitizamos, el archivo final fue *.san.wav => *.san.txt
        // (Si FFmpeg falló, wavSanitizado == wavPathOriginal)
        const baseNameFinal = path.basename(
          wavSanitizado || wavPathOriginal,
          path.extname(wavSanitizado || wavPathOriginal)
        );
        const txtPathFromSanitized = path.join(
          itemBaseDir,
          baseNameFinal + ".txt"
        );

        // Preferimos el TXT del WAV realmente usado (sanitizado). Si no existe, probamos el "clásico".
        if (fs.existsSync(txtPathFromSanitized)) {
          txtPath = txtPathFromSanitized;
        } else if (fs.existsSync(txtPathFromOriginal)) {
          txtPath = txtPathFromOriginal;
        } else {
          // Si no hay ninguno, dejamos elegido el esperado (sanitizado) para loguear size=n/a
          txtPath = txtPathFromSanitized;
        }

        log(`[DEBUG] Esperando TXT en: ${txtPath}`);
      } catch (err) {
        logErr(`[DEBUG] No se pudo construir ruta TXT: ${err?.message || err}`);
      }

      // leer txt
      let contenido = "[ERROR AL TRANSCRIBIR]";
      const tReadTxt0 = Date.now();
      try {
        if (fs.existsSync(txtPath)) {
          const raw = fs.readFileSync(txtPath, "utf-8");
          contenido = (raw || "").trim() || "[ERROR AL TRANSCRIBIR]";
        }
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
    logErr("runZipJob ERROR:", e?.stack || e?.message || e);
    throw e;
  }
}

// ========= Exports =========
module.exports = { encolarZip, estadoZip };
