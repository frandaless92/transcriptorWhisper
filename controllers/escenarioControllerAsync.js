const fs = require("fs");
const path = require("path");
const xml2js = require("xml2js");
const AdmZip = require("adm-zip");
const { spawn } = require("child_process");
const { Document, Packer, Paragraph, TextRun } = require("docx");
const { createJob, getJob } = require("../queue/jobQueue");

// Ruta del whisper: primero toma la var de entorno, si no usa un default por SO.
const DEFAULT_WHISPER = {
  win32:
    "C:\\Users\\fglag\\AppData\\Local\\Programs\\Python\\Python313\\Scripts\\whisper.exe",
  linux: "/home/administrator/whisper_env/bin/whisper",
  darwin: "/opt/homebrew/bin/whisper",
};

const WHISPER_BIN =
  process.env.WHISPER_BIN || DEFAULT_WHISPER[process.platform] || "whisper";

const WHISPER_MODEL_DIR = process.env.WHISPER_MODEL_DIR || "";

// runner seguro cross-platform (sin comillas raras)
function runWhisperAsync(wavPath, outDir) {
  return new Promise((resolve, reject) => {
    const args = [
      wavPath,
      "--model",
      "small",
      "--language",
      "Spanish",
      "--temperature",
      "0",
      "--beam_size",
      "5",
      "--fp16",
      "False",
      "--initial_prompt",
      "Este audio es de comunicaciones de radio policiales. Usar abreviaturas y código Q. Corrección importante: - Si se escucha “y radio parte”, debe transcribirse como “irradió parte”. Abreviaturas y siglas: CPM (Central de Policía Metropolitana), S.I. (Servicio de Inteligencia), LRRP, móvil, patrulla, operativo, frecuencia segura, en tránsito, cambio y fuera. Código Q más frecuente: QSL (recibido), QRV (listo para operar), QTH (ubicación), QRM (interferencia), QRX (espere), QRT (terminar transmisión), QRP (potencia reducida), QRO (potencia alta), QSY (cambiar de frecuencia), QSA (calidad de señal), QSB (variación de señal), QTC (mensaje), QTR (hora).",
      "--output_dir",
      outDir,
      "--output_format",
      "txt",
    ];
    if (WHISPER_MODEL_DIR) {
      args.push("--model_dir", WHISPER_MODEL_DIR);
    }

    const child = spawn(WHISPER_BIN, args, { stdio: "ignore" });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Whisper salió con código ${code}`));
    });
  });
}

// utils
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
      )
        return full;
    }
  }
  return null;
}

// ===== Handler que ENCOLA el trabajo y responde jobId =====
async function encolarZip(req, res) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No se recibió ningún archivo .zip" });
    }
    // Guardamos ruta del zip para el runner
    const zipPath =
      req.file.path || path.join(req.file.destination || "", req.file.filename);
    if (!zipPath || !fs.existsSync(zipPath)) {
      return res
        .status(400)
        .json({ error: "No se pudo localizar el zip subido" });
    }

    // Crear job y devolver id
    const jobId = createJob((update) => runZipJob(zipPath, update));
    return res.status(202).json({ jobId });
  } catch (e) {
    console.error("❌ encolarZip:", e);
    return res.status(500).json({ error: "No se pudo encolar el trabajo" });
  }
}

// ===== Poll de estado =====
async function estadoZip(req, res) {
  const { jobId } = req.params;
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: "jobId no encontrado" });
  // Si terminó OK, exponemos el archivo
  const resp = {
    jobId: job.id,
    state: job.state,
    progress: job.progress,
    error: job.error || null,
    itemsDone: job.itemsDone || 0, // <-- nuevo
    totalItems: job.totalItems || 0, // <-- nuevo
  };
  if (job.state === "finished" && job.result) {
    resp.archivo = job.result.archivo; // ruta pública p/descargar
    resp.mensaje = job.result.mensaje || "OK";
  }
  return res.json(resp);
}

// ===== Runner del trabajo (tu lógica, con updates de progreso) =====
async function runZipJob(zipPath, update) {
  let itemsDone = 0;
  // tiempos largos → desactivar timeouts no aplica acá (no hay res), pero igual medimos progreso
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
    // 10%
    update({ progress: 5 });

    // Extraer
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(workDir, true);
    update({ progress: 15 });

    const xmlPrincipalPath = findFileRecursive(workDir, [
      "scenario.xml",
      "Scenario.xml",
    ]);
    if (!xmlPrincipalPath)
      throw new Error("No se encontró scenario.xml en el escenario");

    const carpetaBase = path.dirname(xmlPrincipalPath);
    const xmlData = fs.readFileSync(xmlPrincipalPath, "utf-8");
    const parser = new xml2js.Parser();
    const escenarioParsed = await parser.parseStringPromise(xmlData);

    const rutaRelativa =
      escenarioParsed?.Scenario?.Components?.[0]?.RecordedItems?.[0];
    if (!rutaRelativa || typeof rutaRelativa !== "string") {
      throw new Error("No se encontró la ruta de Recorded Items");
    }

    const rutaItemsXML = path.join(
      carpetaBase,
      rutaRelativa.replace(/\\/g, path.sep)
    );
    if (!fs.existsSync(rutaItemsXML)) {
      throw new Error("No se encontró el archivo Recorded Items.xml interno");
    }

    const itemsData = fs.readFileSync(rutaItemsXML, "utf-8");
    const itemsParsed = await parser.parseStringPromise(itemsData);
    const items = itemsParsed?.RecordedItems?.Item || [];
    const totalItems = items.length;
    if (totalItems === 0) {
      throw new Error("No se encontraron Items en Recorded Items.xml");
    }
    update({ totalItems, itemsDone: 0, progress: 20 });
    const folderItems = path.dirname(rutaItemsXML);
    const docParagraphs = [];

    // Progreso por item (del 20% al 80%)
    const startP = 20,
      endP = 80;
    for (let i = 0; i < items.length; i++) {
      const nombreItem = `Item${i + 1}`;

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
      if (!xmlItemPath || !fs.existsSync(xmlItemPath)) continue;

      const itemXML = fs.readFileSync(xmlItemPath, "utf-8");
      const parsed = await parser.parseStringPromise(itemXML);
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

      if (!fs.existsSync(wavPath)) {
        fs.writeFileSync(txtPath, "[ERROR AL TRANSCRIBIR] (WAV no encontrado)");
      } else if (!fs.existsSync(txtPath)) {
        try {
          await runWhisperAsync(wavPath, itemBaseDir);
        } catch {
          fs.writeFileSync(txtPath, "[ERROR AL TRANSCRIBIR]");
        }
      }

      let contenido = "[ERROR AL TRANSCRIBIR]";
      try {
        contenido = fs.readFileSync(txtPath, "utf-8");
      } catch {}

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
        // (podés reemplazar por la versión optimizada con agrupación de líneas si querés)
        ...contenido.split(/\r?\n/).map(
          (line) =>
            new Paragraph({
              children: [new TextRun({ text: (line || "").trim(), size: 24 })],
            })
        ),
        new Paragraph("────────────────────────────────────────────")
      );

      // actualizar progreso aproximado por item
      itemsDone++;
      const frac = itemsDone / totalItems;
      const prog = Math.floor(20 + (80 - 20) * frac);
      update({ progress: prog, itemsDone, totalItems });
    }

    // Empaquetar DOCX (80 → 95%)
    update({ progress: 90 });
    const doc = new Document({
      sections: [{ properties: {}, children: docParagraphs }],
    });
    const buffer = await Packer.toBuffer(doc);

    const fileName = `${base}.docx`;
    const docPath = path.join(jobDir, fileName);
    fs.writeFileSync(docPath, buffer);

    // Limpieza (zip + work)
    try {
      fs.unlinkSync(zipPath);
    } catch {}
    rmrf(workDir);

    // Final (95 → 100%)
    update({ progress: 99 });

    const publicPath = `/uploads/jobs/${path.basename(jobDir)}/${fileName}`;
    return {
      archivo: publicPath,
      mensaje: "Escenario transcripto completamente",
    };
  } catch (e) {
    // no borro workDir para inspección
    console.error("❌ runZipJob:", e);
    throw e;
  }
}

module.exports = { encolarZip, estadoZip };
