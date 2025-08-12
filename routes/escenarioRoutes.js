const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { procesarZip } = require("../controllers/escenarioController");

// Asegurar carpetas
const inboxDir = path.join(__dirname, "..", "uploads", "inbox");
fs.mkdirSync(inboxDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, inboxDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/\s+/g, "_");
    cb(null, `${base}-${Date.now()}${ext}`); // nombre único
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
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB opcional
});

// POST /escenario/cargarZip (campo: "archivo")
router.post("/cargarZip", upload.single("archivo"), procesarZip);

module.exports = router;
