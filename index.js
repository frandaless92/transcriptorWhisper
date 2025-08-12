const express = require("express");
const path = require("path");
const fs = require("fs");
const escenarioRoutes = require("./routes/escenarioRoutes");

const app = express();
const PORT = 3000;

// Asegurar carpeta uploads
const uploadsPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath, { recursive: true });

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir frontend y archivos generados
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadsPath));

// API
app.use("/escenario", escenarioRoutes);

// (Opcional) Redirigir raíz a la UI
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
