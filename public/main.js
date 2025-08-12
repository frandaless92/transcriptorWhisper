// === CONFIG ===
const ENDPOINT = "/escenario/cargarZip"; // Ruta donde expongas procesarZip

// === UI refs ===
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const btnUpload = document.getElementById("btnUpload");
const btnCancel = document.getElementById("btnCancel");
const progressBar = document.getElementById("progressBar");
const statusText = document.getElementById("statusText");
const fileName = document.getElementById("fileName");
const resultBox = document.getElementById("resultBox");

let currentXHR = null;
let selectedFile = null;

function resetUI() {
  progressBar.style.width = "0%";
  progressBar.textContent = "0%";
  statusText.textContent = "Esperando archivo…";
  btnUpload.disabled = !selectedFile;
  btnCancel.disabled = true;
  if (!selectedFile) fileName.textContent = "";
}

function setUploadingUI() {
  btnUpload.disabled = true;
  btnCancel.disabled = false;
  statusText.textContent = "Subiendo .zip y esperando resultado del servidor…";
}

// Dropzone interactions
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () =>
  dropzone.classList.remove("dragover")
);
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    const file = e.dataTransfer.files[0];
    if (!file.name.toLowerCase().endsWith(".zip")) {
      Swal.fire(
        "Formato inválido",
        "Por favor subí un archivo .zip",
        "warning"
      );
      return;
    }
    selectedFile = file;
    fileName.textContent =
      file.name + " (" + Math.round(file.size / 1024 / 1024) + " MB)";
    btnUpload.disabled = false;
    statusText.textContent = "Listo para subir.";
  }
});

fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".zip")) {
    Swal.fire("Formato inválido", "Por favor subí un archivo .zip", "warning");
    fileInput.value = "";
    return;
  }
  selectedFile = file;
  fileName.textContent =
    file.name + " (" + Math.round(file.size / 1024 / 1024) + " MB)";
  btnUpload.disabled = false;
  statusText.textContent = "Listo para subir.";
});

// Upload handler (XMLHttpRequest para mostrar progreso de subida)
btnUpload.addEventListener("click", async () => {
  if (!selectedFile) return;
  setUploadingUI();

  const formData = new FormData();
  formData.append("archivo", selectedFile);

  currentXHR = new XMLHttpRequest();
  currentXHR.open("POST", ENDPOINT, true);

  currentXHR.upload.onprogress = function (e) {
    if (e.lengthComputable) {
      const percent = Math.round((e.loaded / e.total) * 100);
      progressBar.style.width = percent + "%";
      progressBar.textContent = percent + "%";
      statusText.textContent = "Subiendo… " + percent + "%";
    }
  };

  currentXHR.onreadystatechange = function () {
    if (currentXHR.readyState === 4) {
      btnCancel.disabled = true;
      if (currentXHR.status >= 200 && currentXHR.status < 300) {
        try {
          const resp = JSON.parse(currentXHR.responseText);
          // resp: { mensaje, archivo }
          statusText.textContent = "Completado";
          progressBar.style.width = "100%";
          progressBar.textContent = "100%";
          renderResult(resp);
          Swal.fire("Listo", "Escenario transcripto correctamente", "success");
        } catch (err) {
          onError("Respuesta inválida del servidor");
        }
      } else {
        try {
          const err = JSON.parse(currentXHR.responseText);
          onError(err.error || "Error en el procesamiento");
        } catch (_) {
          onError("Error en el procesamiento");
        }
      }
      currentXHR = null;
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
    Swal.fire("Cancelado", "Se canceló la subida del archivo.", "info");
    resetUI();
  }
});

function onError(message) {
  Swal.fire("Error", message, "error");
  statusText.textContent = "Error: " + message;
  progressBar.style.width = "0%";
  progressBar.textContent = "0%";
  btnUpload.disabled = false;
  btnCancel.disabled = true;
}

function renderResult({ mensaje, archivo }) {
  // Intenta construir un enlace descargable si el backend sirve /uploads como estático.
  // Si "archivo" ya es una URL absoluta, la usa tal cual.
  let href = archivo;
  if (archivo && !/^https?:\/\//i.test(archivo)) {
    // Normalizar: si el backend devuelve "uploads/..."
    if (archivo.startsWith("uploads")) {
      href = "/" + archivo.replace(/^\/+/, "");
    }
  }

  resultBox.innerHTML = `
          <div class="alert alert-dark" role="alert">
            <div class="mb-1">${mensaje || "Proceso finalizado."}</div>
            ${
              href
                ? `
              <a class="btn btn-success btn-sm" href="${href}" download>
                ⬇️ Descargar transcripcion.docx
              </a>
              <div class="small mt-2 text-secondary">Ruta del archivo: <code>${archivo}</code></div>
            `
                : `
              <div class="text-warning">El backend no devolvió una ruta descargable. Ver consola/servidor.</div>
            `
            }
          </div>
        `;
}

// Ejemplo de integración futura (backend asíncrono con jobId):
/*
      async function pollStatus(jobId) {
        const interval = 3000;
        const timer = setInterval(async () => {
          const r = await fetch(`/api/estado/${jobId}`);
          const data = await r.json();
          // data: { state: 'queued'|'processing'|'finished'|'failed', progress: 0-100, archivo? }
          progressBar.style.width = (data.progress||0) + '%';
          progressBar.textContent = (data.progress||0) + '%';
          statusText.textContent = `Estado: ${data.state}…`;
          if (data.state === 'finished') { clearInterval(timer); renderResult(data); }
          if (data.state === 'failed') { clearInterval(timer); onError('Falló el procesamiento'); }
        }, interval);
      }
      */

// Init
resetUI();
