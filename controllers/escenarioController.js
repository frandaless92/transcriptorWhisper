/* controllers/escenarioController.js — versión con LOGS detallados */
const fs = require("fs");
const path = require("path");
const xml2js = require("xml2js");
const AdmZip = require("adm-zip");
const { execSync } = require("child_process");
const { Document, Packer, Paragraph, TextRun } = require("docx");

// ========= Helpers de logging =========
const nowISO = () => new Date().toISOString();
const log = (...args) => console.log(nowISO(), "[TRANSCRIPCION]", ...args);
const logErr = (...args) =>
  console.error(nowISO(), "❌[TRANSCRIPCION]", ...args);
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
const WHISPER_BIN =
  process.env.WHISPER_BIN || "/home/administrator/whisper_env/bin/whisper";
const WHISPER_MODEL_DIR = process.env.WHISPER_MODEL_DIR || "";
function whisperCmd(wavPath, outDir) {
  const modelDirArg = WHISPER_MODEL_DIR
    ? ` --model_dir "${WHISPER_MODEL_DIR}"`
    : "";
  return `"${WHISPER_BIN}" "${wavPath}" --model small --language Spanish --output_dir "${outDir}" --output_format txt${modelDirArg}`;
}
if (!fs.existsSync(WHISPER_BIN)) {
  logErr("No se encontró WHISPER_BIN en:", WHISPER_BIN);
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
      )
        return full;
    }
  }
  return null;
}

// ========= Handler principal =========
const procesarZip = async (req, res) => {
  // evitar timeouts en requests largos
  try {
    req.setTimeout(0);
  } catch {}
  try {
    res.setTimeout(0);
  } catch {}

  let zipPath, jobDir, workDir, docPath;
  const t0 = Date.now();

  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No se recibió ningún archivo .zip" });
    }

    // 1) Localizar ZIP
    zipPath =
      req.file.path || path.join(req.file.destination || "", req.file.filename);
    if (!zipPath || !fs.existsSync(zipPath)) {
      return res
        .status(400)
        .json({ error: "No se pudo localizar el zip subido" });
    }
    const zipStat = fs.statSync(zipPath);
    log(`ZIP recibido -> ${zipPath} (${fmtB(zipStat.size)})`);

    // 2) Directorios absolutos (independientes del cwd)
    const PROJECT_ROOT = path.resolve(__dirname, "..");
    const UPLOADS_ROOT = path.join(PROJECT_ROOT, "uploads");
    fs.mkdirSync(UPLOADS_ROOT, { recursive: true });

    const jobsRoot = path.join(UPLOADS_ROOT, "jobs");
    fs.mkdirSync(jobsRoot, { recursive: true });

    const base = path
      .basename(zipPath, path.extname(zipPath))
      .replace(/\s+/g, "_");
    const jobId = `${base}-${Date.now()}`;
    jobDir = path.join(jobsRoot, jobId);
    workDir = path.join(jobDir, "work");
    fs.mkdirSync(workDir, { recursive: true });

    log(`JOB ${jobId} creado -> jobDir=${jobDir}`);
    memLog("inicio");

    // 3) Extraer ZIP
    const tUnzip0 = Date.now();
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(workDir, true);
    const tUnzip1 = Date.now();
    log(`Unzip OK en ${tUnzip1 - tUnzip0} ms -> workDir=${workDir}`);

    // 4) Buscar scenario.xml
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
    if (!xmlPrincipalPath) {
      return res
        .status(404)
        .json({ error: "No se encontró scenario.xml en el escenario" });
    }

    // 5) Parsear scenario.xml
    const carpetaBase = path.dirname(xmlPrincipalPath);
    const xmlData = fs.readFileSync(xmlPrincipalPath, "utf-8");
    const parser = new xml2js.Parser();

    const tParseScenario0 = Date.now();
    const escenarioParsed = await parser.parseStringPromise(xmlData);
    const tParseScenario1 = Date.now();
    log(`Parse scenario.xml: ${tParseScenario1 - tParseScenario0} ms`);

    const rutaRelativa =
      escenarioParsed?.Scenario?.Components?.[0]?.RecordedItems?.[0];
    log("RecordedItems path leído del XML:", rutaRelativa);
    if (!rutaRelativa || typeof rutaRelativa !== "string") {
      return res
        .status(400)
        .json({ error: "No se encontró la ruta de Recorded Items" });
    }

    // 6) Abrir Recorded Items.xml
    const rutaItemsXML = path.join(
      carpetaBase,
      rutaRelativa.replace(/\\/g, path.sep)
    );
    log("Ruta absoluta de Recorded Items:", rutaItemsXML);
    if (!fs.existsSync(rutaItemsXML)) {
      return res
        .status(404)
        .json({
          error: "No se encontró el archivo Recorded Items.xml interno",
        });
    }

    const itemsData = fs.readFileSync(rutaItemsXML, "utf-8");
    const tParseItems0 = Date.now();
    const itemsParsed = await parser.parseStringPromise(itemsData);
    const tParseItems1 = Date.now();
    const items = itemsParsed?.RecordedItems?.Item;
    log(
      `Parse Recorded Items.xml: ${tParseItems1 - tParseItems0} ms | Items: ${
        items ? items.length : 0
      }`
    );

    if (!items || items.length === 0) {
      return res
        .status(400)
        .json({ error: "No se encontraron Items en Recorded Items.xml" });
    }

    const folderItems = path.dirname(rutaItemsXML);
    const docParagraphs = [];
    let itemsProcesados = 0,
      transOk = 0,
      transError = 0;

    // 7) Procesar cada Item
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
      log(`XML ${nombreItem}: ${xmlItemPath || "NO ENCONTRADO"}`);
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

      if (!fs.existsSync(wavPath)) {
        logErr(`${nombreItem}: WAV no encontrado, escribo TXT de error`);
        try {
          fs.writeFileSync(
            txtPath,
            "[ERROR AL TRANSCRIBIR] (WAV no encontrado)"
          );
        } catch {}
        transError++;
      } else {
        // si no hay txt, invocar whisper
        if (!fs.existsSync(txtPath)) {
          const cmd = whisperCmd(wavPath, itemBaseDir);
          log(`${nombreItem}: Invocando Whisper -> ${cmd}`);
          const tWh0 = Date.now();
          try {
            execSync(cmd, { stdio: "ignore" });
            const tWh1 = Date.now();
            log(`${nombreItem}: Whisper OK en ${tWh1 - tWh0} ms`);
            transOk++;
          } catch (e) {
            const tWh1 = Date.now();
            logErr(
              `${nombreItem}: Whisper FALLÓ en ${tWh1 - tWh0} ms ::`,
              e?.message || e
            );
            try {
              fs.writeFileSync(txtPath, "[ERROR AL TRANSCRIBIR]");
            } catch {}
            transError++;
          }
        } else {
          log(`${nombreItem}: TXT ya existía, no re-transcribo`);
        }
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
      // construir párrafos (mantengo tu enfoque 1:1 para no cambiar lógica)
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
        ...contenido
          .split(/\r?\n/)
          .map(
            (line) =>
              new Paragraph({
                children: [
                  new TextRun({ text: (line || "").trim(), size: 24 }),
                ],
              })
          ),
        new Paragraph("────────────────────────────────────────────")
      );
      const tParas1 = Date.now();
      log(
        `${nombreItem}: construir párrafos ${tParas1 - tParas0} ms (líneas=${
          (contenido.match(/\r?\n/g) || []).length + 1
        })`
      );

      itemsProcesados++;
      const tItem1 = Date.now();
      memLog(`${nombreItem} fin`);
      log(`← ${nombreItem} OK en ${tItem1 - tItem0} ms`);
    }

    log(
      `Items procesados=${itemsProcesados} | trans OK=${transOk} | trans ERROR=${transError}`
    );
    memLog("antes de Packer");

    // 8) Packer (docx)
    const doc = new Document({
      sections: [{ properties: {}, children: docParagraphs }],
    });

    const tPack0 = Date.now();
    let buffer;
    try {
      buffer = await Packer.toBuffer(doc);
    } catch (e) {
      logErr("Packer falló:", e?.message || e);
      // Fallback mínimo para no dejar colgado el request
      const mini = new Document({
        sections: [
          {
            children: [
              new Paragraph(
                "Transcripción generada parcialmente (packer falló)."
              ),
            ],
          },
        ],
      });
      buffer = await Packer.toBuffer(mini);
    }
    const tPack1 = Date.now();
    log(
      `Packer.toBuffer ${tPack1 - tPack0} ms | docParagraphs=${
        docParagraphs.length
      } | buffer=${fmtB(buffer.length)}`
    );
    memLog("post Packer");

    // 9) Escribir archivo final
    const fileName = `transcripcion-${base}.docx`;
    docPath = path.join(jobDir, fileName);

    const tWrite0 = Date.now();
    fs.writeFileSync(docPath, buffer);
    const tWrite1 = Date.now();
    log(`Escritura DOCX ${tWrite1 - tWrite0} ms -> ${docPath}`);

    // 10) Limpieza
    const tClean0 = Date.now();
    try {
      fs.unlinkSync(zipPath);
      log("ZIP eliminado:", zipPath);
    } catch {}
    rmrf(workDir);
    log("work/ eliminado:", workDir);
    const tClean1 = Date.now();
    log(`Limpieza ${tClean1 - tClean0} ms`);

    // 11) Respuesta
    const publicPath = `/uploads/jobs/${path.basename(jobDir)}/${fileName}`;
    const t1 = Date.now();
    log(`JOB ${path.basename(jobDir)} FIN en ${t1 - t0} ms`);
    memLog("fin job");
    return res
      .status(200)
      .json({
        mensaje: "Escenario transcripto completamente",
        archivo: publicPath,
      });
  } catch (err) {
    logErr("Error no controlado:", err?.stack || err?.message || err);
    // en error, no borramos work/ para inspección
    return res.status(500).json({ error: "Error al procesar el archivo zip" });
  }
};

module.exports = { procesarZip };
