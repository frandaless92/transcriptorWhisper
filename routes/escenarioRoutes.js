// routes/escenarioRoutes.js
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const { procesarZip } = require("../controllers/escenarioController"); // tu sync (si la querés conservar)
const {
  encolarZip,
  estadoZip,
} = require("../controllers/escenarioControllerAsync");
const { listarTrabajos } = require("../controllers/historialController");

const router = express.Router();

// Asegurar inbox
const inboxDir = path.join(__dirname, "..", "uploads", "inbox");
fs.mkdirSync(inboxDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, inboxDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/\s+/g, "_");
    cb(null, `${base}-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === "application/zip" ||
      file.originalname.toLowerCase().endsWith(".zip");
    cb(ok ? null : new Error("El archivo debe ser .zip"), ok);
  },
  limits: { fileSize: 1024 * 1024 * 1024 },
});

// === SINCRÓNICO (opcional, como lo tenías)
router.post("/cargarZip", upload.single("archivo"), procesarZip);

// === ASINCRÓNICO (nuevo)
router.post("/cargarZipAsync", upload.single("archivo"), encolarZip);
router.get("/estado/:jobId", estadoZip);
router.get("/historial", listarTrabajos);

module.exports = router;
