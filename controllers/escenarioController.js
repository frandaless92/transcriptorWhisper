const fs = require("fs");
const path = require("path");
const xml2js = require("xml2js");
const AdmZip = require("adm-zip");
const { execSync } = require("child_process");
const { Document, Packer, Paragraph, TextRun } = require("docx");

// === Config Whisper ===
const WHISPER_BIN =
  process.env.WHISPER_BIN || "/home/administrator/whisper_env/bin/whisper";
const WHISPER_MODEL_DIR = process.env.WHISPER_MODEL_DIR || ""; // opcional para cache de modelos
function whisperCmd(wavPath, outDir) {
  const modelDirArg = WHISPER_MODEL_DIR
    ? ` --model_dir "${WHISPER_MODEL_DIR}"`
    : "";
  return `"${WHISPER_BIN}" "${wavPath}" --model small --language Spanish --output_dir "${outDir}" --output_format txt${modelDirArg}`;
}
if (!fs.existsSync(WHISPER_BIN)) {
  console.error("❌ No se encontró WHISPER_BIN en:", WHISPER_BIN);
}

// === Rutas absolutas seguras (no dependen del cwd) ===
const PROJECT_ROOT = path.resolve(__dirname, ".."); // carpeta raíz del proyecto
const UPLOADS_ROOT = path.join(PROJECT_ROOT, "uploads"); // /opt/transcriptor/.../uploads

// util: borrar recursivo seguro
function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}
// util: buscar archivo por nombre (case-insensitive) dentro de baseDir
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

const procesarZip = async (req, res) => {
  let zipPath, jobDir, workDir, docPath;

  try {
    if (!req.file)
      return res
        .status(400)
        .json({ error: "No se recibió ningún archivo .zip" });

    // 1) Localizar ZIP subido por multer
    zipPath =
      req.file.path || path.join(req.file.destination || "", req.file.filename);
    if (!zipPath || !fs.existsSync(zipPath)) {
      return res
        .status(400)
        .json({ error: "No se pudo localizar el zip subido" });
    }

    // 2) Crear carpeta de trabajo única dentro de uploads/jobs
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

    // 3) Extraer ZIP dentro de work/
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(workDir, true);

    // 4) scenario.xml SOLO dentro de work/
    const xmlPrincipalPath = findFileRecursive(workDir, [
      "scenario.xml",
      "Scenario.xml",
    ]);
    if (!xmlPrincipalPath) {
      return res
        .status(404)
        .json({ error: "No se encontró scenario.xml en el escenario" });
    }

    const carpetaBase = path.dirname(xmlPrincipalPath);
    const xmlData = fs.readFileSync(xmlPrincipalPath, "utf-8");
    const parser = new xml2js.Parser();
    const escenarioParsed = await parser.parseStringPromise(xmlData);

    const rutaRelativa =
      escenarioParsed?.Scenario?.Components?.[0]?.RecordedItems?.[0];
    if (!rutaRelativa || typeof rutaRelativa !== "string") {
      return res
        .status(400)
        .json({ error: "No se encontró la ruta de Recorded Items" });
    }

    const rutaItemsXML = path.join(
      carpetaBase,
      rutaRelativa.replace(/\\/g, path.sep)
    );
    if (!fs.existsSync(rutaItemsXML)) {
      return res
        .status(404)
        .json({
          error: "No se encontró el archivo Recorded Items.xml interno",
        });
    }

    const itemsData = fs.readFileSync(rutaItemsXML, "utf-8");
    const itemsParsed = await parser.parseStringPromise(itemsData);
    const items = itemsParsed?.RecordedItems?.Item;
    if (!items || items.length === 0) {
      return res
        .status(400)
        .json({ error: "No se encontraron Items en Recorded Items.xml" });
    }

    const folderItems = path.dirname(rutaItemsXML);
    const docParagraphs = [];

    for (let i = 0; i < items.length; i++) {
      const nombreItem = `Item${i + 1}`;

      // localizar XML del item: carpeta ItemN/ o ItemN.xml
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

      // **Nuevo**: si no existe el WAV, no intentes transcribir
      if (!fs.existsSync(wavPath)) {
        fs.writeFileSync(txtPath, "[ERROR AL TRANSCRIBIR] (WAV no encontrado)");
      }

      if (!fs.existsSync(txtPath)) {
        try {
          execSync(whisperCmd(wavPath, itemBaseDir), { stdio: "ignore" });
        } catch (e) {
          console.error("❌ Whisper falló:", e?.message || e);
          fs.writeFileSync(txtPath, "[ERROR AL TRANSCRIBIR]");
        }
      }

      let contenido = "[ERROR AL TRANSCRIBIR]";
      try {
        contenido = fs.readFileSync(txtPath, "utf-8").toUpperCase();
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
        ...contenido.split("\n").map(
          (line) =>
            new Paragraph({
              children: [new TextRun({ text: line.trim(), size: 24 })],
            }) // 12pt
        ),
        new Paragraph("────────────────────────────────────────────")
      );
    }

    // 5) Guardar DOCX en jobDir (fuera de work/)
    const doc = new Document({
      sections: [{ properties: {}, children: docParagraphs }],
    });
    const buffer = await Packer.toBuffer(doc);

    const fileName = `transcripcion-${base}.docx`;
    docPath = path.join(jobDir, fileName);
    fs.writeFileSync(docPath, buffer);

    // 6) LIMPIEZA: borrar ZIP original y carpeta work/
    try {
      fs.unlinkSync(zipPath);
    } catch {}
    rmrf(workDir);

    // 7) Devolver URL correcta (tu Express sirve /uploads estático)
    const publicPath = `/uploads/jobs/${path.basename(jobDir)}/${fileName}`;
    return res
      .status(200)
      .json({
        mensaje: "Escenario transcripto completamente",
        archivo: publicPath,
      });
  } catch (err) {
    console.error("❌ Error al procesar el escenario:", err);
    return res.status(500).json({ error: "Error al procesar el archivo zip" });
  }
};

module.exports = { procesarZip };
