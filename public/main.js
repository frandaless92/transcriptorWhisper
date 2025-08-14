/* main.js — Frontend Transcriptor */

//
// === Config de endpoints ===
//
const ENDPOINT = "/escenario/cargarZipAsync";
const STATUS_URL = (id) => `/escenario/estado/${id}`;
const HISTORIAL_ENDPOINT = "/escenario/historial";

//
// === Referencias a la UI ===
//
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const btnUpload = document.getElementById("btnUpload");
const btnCancel = document.getElementById("btnCancel");
const progressBar = document.getElementById("progressBar");
const statusText = document.getElementById("statusText");
const fileName = document.getElementById("fileName");
const resultBox = document.getElementById("resultBox");

const historialBox = document.getElementById("historialBox");
const historialEmpty = document.getElementById("historialEmpty");
const btnRefreshHistorial = document.getElementById("btnRefreshHistorial");

//
// === Estado ===
//
let currentXHR = null;
let selectedFile = null;
let pollTimer = null;

//
// === Helpers de UI ===
//
function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function resetUI() {
  stopPolling();
  progressBar.style.width = "0%";
  progressBar.textContent = "0%";
  progressBar.setAttribute("aria-valuenow", "0");
  statusText.textContent = "Esperando archivo…";
  btnUpload.disabled = !selectedFile;
  btnCancel.disabled = true;
  if (!selectedFile) fileName.textContent = "";

  // Mensaje base en resultados
  resultBox.innerHTML = `
    <p class="text-secondary">
      Acá vas a ver el enlace de descarga del <strong>.docx</strong> cuando termine el proceso.
    </p>
  `;
}

function setUploadingUI() {
  btnUpload.disabled = true;
  btnCancel.disabled = false;
  statusText.textContent = "Subiendo .zip…";
  resultBox.innerHTML = `
    <div class="small text-secondary">Archivo enviado. Preparando procesamiento…</div>
  `;
}

function onError(message) {
  stopPolling();
  if (window.Swal) Swal.fire("Error", message, "error");
  statusText.textContent = "Error: " + message;
  progressBar.style.width = "0%";
  progressBar.textContent = "0%";
  progressBar.setAttribute("aria-valuenow", "0");
  btnUpload.disabled = false;
  btnCancel.disabled = true;
}

function niceState(state) {
  const map = {
    queued: "En cola",
    processing: "Procesando",
    finished: "Finalizado",
    failed: "Falló",
  };
  return map[state] || state || "procesando";
}

function fmtFecha(iso) {
  try {
    return new Date(iso).toLocaleString("es-AR", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso || "";
  }
}

//
// === Historial ===
//
async function cargarHistorial() {
  try {
    historialBox.innerHTML = `<div class="small text-secondary p-2">Cargando…</div>`;
    const r = await fetch(`${HISTORIAL_ENDPOINT}?limit=50`, {
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const items = Array.isArray(data.items) ? data.items : [];

    historialBox.innerHTML = "";
    if (!items.length) {
      historialEmpty.style.display = "";
      return;
    }
    historialEmpty.style.display = "none";

    for (const it of items) {
      const url = it.url.startsWith("/") ? it.url : "/" + it.url;
      const el = document.createElement("div");
      el.className = "hist-item list-group-item";

      el.innerHTML = `
        <div class="hist-name">
          📄 ${it.file}
          <div class="small-muted">Job: ${it.jobId}</div>
        </div>
        <div class="hist-meta">
          <span>${it.sizeHuman || ""}</span>
          <span>${fmtFecha(it.mtimeISO)}</span>
          <a class="btn-download" href="${url}" download="${
        it.file
      }">Descargar</a>
        </div>
      `;
      historialBox.appendChild(el);
    }
  } catch (e) {
    historialBox.innerHTML = `<div class="text-danger small p-2">Error al cargar historial</div>`;
  }
}

btnRefreshHistorial?.addEventListener("click", cargarHistorial);
document.addEventListener("DOMContentLoaded", cargarHistorial);

//
// === Render del resultado final ===
//
function renderResult({ mensaje, archivo }) {
  stopPolling();
  btnCancel.disabled = true;
  btnUpload.disabled = false;

  // Normalizar href
  let href = archivo || "";
  if (href && !/^https?:\/\//i.test(href)) {
    href = href.startsWith("/") ? href : "/" + href;
  }

  resultBox.innerHTML = `
    <div class="alert alert-dark" role="alert">
      <div class="mb-2">${mensaje || "Proceso finalizado."}</div>
      ${
        href
          ? `<a class="btn btn-success btn-sm" href="${href}" download>
               ⬇️ Descargar transcripción
             </a>`
          : `<div class="text-warning">El backend no devolvió una ruta descargable.</div>`
      }
    </div>
  `;

  // refrescar historial al terminar
  cargarHistorial();
}

//
// === Poll de estado ===
//
async function pollStatus(jobId) {
  try {
    const r = await fetch(STATUS_URL(jobId), { cache: "no-store" });
    if (!r.ok) throw new Error(`Estado HTTP ${r.status}`);
    const data = await r.json();

    // % seguro (0–100)
    if (typeof data.progress === "number") {
      const pct = Math.max(0, Math.min(100, Math.round(data.progress)));
      progressBar.style.width = pct + "%";
      progressBar.textContent = pct + "%";
      progressBar.setAttribute("aria-valuenow", String(pct));
    }

    // estado + conteo (si viene)
    if (
      Number.isFinite(data.itemsDone) &&
      Number.isFinite(data.totalItems) &&
      data.totalItems > 0
    ) {
      statusText.textContent = `Estado: ${niceState(data.state)} — Audios: ${
        data.itemsDone
      }/${data.totalItems}`;
    } else {
      statusText.textContent = `Estado: ${niceState(data.state)}`;
    }

    // terminales
    if (data.state === "finished") {
      if (data.archivo) {
        renderResult({ mensaje: data.mensaje || "OK", archivo: data.archivo });
      } else {
        onError("Trabajo finalizado pero sin archivo disponible.");
      }
      return;
    }
    if (data.state === "failed") {
      onError(data.error || "Falló el procesamiento");
      return;
    }

    // seguir consultando
    stopPolling();
    pollTimer = setTimeout(() => pollStatus(jobId), 3000);
  } catch (e) {
    // backoff suave
    stopPolling();
    pollTimer = setTimeout(() => pollStatus(jobId), 5000);
  }
}

//
// === Dropzone & carga ===
//
dropzone.addEventListener("click", () => fileInput.click());

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragover");
});

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    const file = e.dataTransfer.files[0];
    if (!file.name.toLowerCase().endsWith(".zip")) {
      window.Swal &&
        Swal.fire(
          "Formato inválido",
          "Por favor subí un archivo .zip",
          "warning"
        );
      return;
    }
    selectedFile = file;
    fileName.textContent = `${file.name} (${Math.round(
      file.size / 1024 / 1024
    )} MB)`;
    btnUpload.disabled = false;
    statusText.textContent = "Listo para subir.";
  }
});

fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".zip")) {
    window.Swal &&
      Swal.fire(
        "Formato inválido",
        "Por favor subí un archivo .zip",
        "warning"
      );
    fileInput.value = "";
    return;
  }
  selectedFile = file;
  fileName.textContent = `${file.name} (${Math.round(
    file.size / 1024 / 1024
  )} MB)`;
  btnUpload.disabled = false;
  statusText.textContent = "Listo para subir.";
});

btnUpload.addEventListener("click", () => {
  if (!selectedFile) return;
  setUploadingUI();

  const formData = new FormData();
  formData.append("archivo", selectedFile); // <- campo de multer

  currentXHR = new XMLHttpRequest();
  currentXHR.open("POST", ENDPOINT, true);

  // progreso de subida
  currentXHR.upload.onprogress = function (e) {
    if (e.lengthComputable) {
      const percent = Math.round((e.loaded / e.total) * 100);
      progressBar.style.width = percent + "%";
      progressBar.textContent = percent + "%";
      progressBar.setAttribute("aria-valuenow", String(percent));
      statusText.textContent = "Subiendo… " + percent + "%";
    }
  };

  // respuesta del POST
  currentXHR.onreadystatechange = function () {
    if (currentXHR.readyState === 4) {
      // ya no hay upload en curso
      btnCancel.disabled = true;

      if (currentXHR.status >= 200 && currentXHR.status < 300) {
        let resp;
        try {
          resp = JSON.parse(currentXHR.responseText || "{}");
        } catch {
          onError("Respuesta del servidor no es JSON");
          return;
        }

        if (resp.jobId) {
          statusText.textContent = "Trabajo encolado. Procesando…";
          // reset un poco la barra si quedó en 100% de subida
          if (progressBar.textContent === "100%") {
            progressBar.style.width = "15%";
            progressBar.textContent = "15%";
            progressBar.setAttribute("aria-valuenow", "15");
          }
          pollStatus(resp.jobId);
        } else if (resp.archivo) {
          // compat con endpoint síncrono
          renderResult(resp);
        } else {
          onError("Respuesta inesperada del servidor");
        }
      } else {
        let msg = "Error " + currentXHR.status;
        try {
          const j = JSON.parse(currentXHR.responseText || "{}");
          if (j && j.error) msg = j.error;
        } catch {}
        onError(msg);
      }
    }
  };

  currentXHR.onerror = function () {
    onError("Falla de red durante la carga");
  };

  try {
    currentXHR.send(formData);
  } catch (e) {
    onError("No se pudo iniciar la carga");
  }
});

btnCancel.addEventListener("click", () => {
  if (currentXHR) {
    currentXHR.abort();
    currentXHR = null;
    window.Swal &&
      Swal.fire("Cancelado", "Se canceló la subida del archivo.", "info");
    resetUI();
  }
});

//
// === Arranque ===
//
resetUI();
