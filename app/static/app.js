const state = {
  settings: {},
  clients: [],
  invoices: [],
  trash: { clients: [], invoices: [] },
  events: [],
  conceptFavorites: [],
  documentTasks: [],
  backups: [],
  selectedClientId: null,
};

const $ = (id) => document.getElementById(id);
const monthNames = [
  "ENERO",
  "FEBRERO",
  "MARZO",
  "ABRIL",
  "MAYO",
  "JUNIO",
  "JULIO",
  "AGOSTO",
  "SEPTIEMBRE",
  "OCTUBRE",
  "NOVIEMBRE",
  "DICIEMBRE",
];

function euro(value) {
  const number = Number(value || 0);
  const rounded = Math.round((number + Number.EPSILON) * 100) / 100;
  const hasCents = Math.abs(rounded - Math.round(rounded)) > 0.000001;
  return `${rounded.toLocaleString("es-ES", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  })} €`;
}

function amountText(value) {
  const number = Number(value || 0);
  const rounded = Math.round((number + Number.EPSILON) * 100) / 100;
  const hasCents = Math.abs(rounded - Math.round(rounded)) > 0.000001;
  // Sin separador de miles: este texto se reenvía al backend y "10.000" se
  // confundiría con 10,000 (diez con tres decimales).
  return rounded.toLocaleString("es-ES", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
    useGrouping: false,
  });
}

function pluralizeEs(word) {
  if (!word) return word;
  const upper = word === word.toUpperCase();
  const low = word.toLowerCase();
  if (low.endsWith("ión")) return word.slice(0, -3) + (upper ? "IONES" : "iones");
  if (/[aeiouáéíóú]$/.test(low)) return word + (upper ? "S" : "s");
  if (low.endsWith("z")) return word.slice(0, -1) + (upper ? "CES" : "ces");
  if (low.endsWith("s")) return word;
  return word + (upper ? "ES" : "es");
}

function pluralizePhrase(phrase) {
  const i = phrase.indexOf(" ");
  if (i === -1) return pluralizeEs(phrase);
  return pluralizeEs(phrase.slice(0, i)) + phrase.slice(i);
}

function conceptPhrase(defaultConcept) {
  const m = String(defaultConcept || "").match(/^\s*\d+\s+(.+)$/);
  const phrase = (m ? m[1] : String(defaultConcept || "")).trim();
  return phrase || "SERVICIO";
}

function conceptForQuantity(quantityValue, defaultConcept) {
  const count = Math.max(1, Math.round(parseAmount(quantityValue || 1)));
  const phrase = conceptPhrase(defaultConcept);
  const text = count === 1 ? phrase : pluralizePhrase(phrase);
  return `${count} ${text}`;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function isAutoConcept(value, defaultConcept) {
  const norm = normalizeText(value);
  if (!norm) return true;
  if (/^\d+\s+SERVICIOS?$/.test(norm)) return true;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const phrase = normalizeText(conceptPhrase(defaultConcept));
  const plural = normalizeText(pluralizePhrase(conceptPhrase(defaultConcept)));
  return new RegExp(`^\\d+\\s+${esc(phrase)}$`).test(norm)
    || new RegExp(`^\\d+\\s+${esc(plural)}$`).test(norm);
}

function syncConceptWithQuantity() {
  const dflt = (state.settings && state.settings.default_concept) || "";
  const concept = $("invoiceConcept").value.trim();
  if (!concept || isAutoConcept(concept, dflt)) {
    $("invoiceConcept").value = conceptForQuantity($("quantity").value, dflt);
  }
}

function parseAmount(value) {
  const text = String(value || "").trim().replaceAll(" ", "");
  if (text.includes(",") && text.includes(".")) {
    return Number(text.replaceAll(".", "").replace(",", ".")) || 0;
  }
  if (text.includes(".") && !text.includes(",")) {
    // Sin coma, el punto es separador de miles en notación española
    // ("1.000" = mil) cuando agrupa de 3 en 3 con parte entera no nula;
    // si no ("45.45", "0.5", "1.5"), se trata como decimal.
    const parts = text.replace(/^-/, "").split(".");
    const isThousands =
      parts.length > 1 &&
      !/^0*$/.test(parts[0]) &&
      parts[0].length <= 3 &&
      parts.slice(1).every((group) => group.length === 3);
    if (isThousands) {
      return Number(text.replaceAll(".", "")) || 0;
    }
  }
  return Number(text.replace(",", ".")) || 0;
}

function cleanAmountValue(id) {
  return amountText(parseAmount($(id).value));
}

function roundCents(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundCentsUp(value) {
  return Math.ceil((value - Number.EPSILON) * 100) / 100;
}

function vatCalculationMode() {
  return state.settings.vat_calculation_mode || "unit_ceil";
}

function calculateInvoiceTotals(quantity, unitPrice, vatRate, mode) {
  if (mode === "exempt") {
    const subtotal = roundCents(quantity * unitPrice);
    return { subtotal, vat: 0, total: subtotal };
  }

  if (mode === "vat_included") {
    const total = roundCents(quantity * unitPrice);
    const divisor = 1 + vatRate / 100;
    const subtotal = roundCents(divisor ? total / divisor : total);
    return { subtotal, vat: roundCents(total - subtotal), total };
  }

  const subtotal = roundCents(quantity * unitPrice);
  let vat = 0;
  if (mode === "unit_standard") {
    vat = roundCents(quantity * roundCents(unitPrice * vatRate / 100));
  } else if (mode === "line_ceil") {
    vat = roundCentsUp(subtotal * vatRate / 100);
  } else if (mode === "line_standard") {
    vat = roundCents(subtotal * vatRate / 100);
  } else {
    vat = roundCents(quantity * roundCentsUp(unitPrice * vatRate / 100));
  }
  return { subtotal, vat, total: roundCents(subtotal + vat) };
}

function today() {
  // Fecha local: con toISOString() (UTC) el formulario proponía el día
  // anterior entre las 00:00 y la 01:00/02:00 hora española.
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.add("show");
  window.setTimeout(() => node.classList.remove("show"), 2800);
}

function icon(name) {
  const paths = {
    word: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M8.4 11l1.1 6 1.5-4.2 1.5 4.2 1.1-6"/>',
    eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.4"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M7 7l1 14h8l1-14"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    edit: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M13.5 6.5l4 4"/>',
    invoice: '<path d="M6 3h12v18l-2-1.2-2 1.2-2-1.2-2 1.2-2-1.2L6 21z"/><path d="M9 8h6"/><path d="M9 12h6"/><path d="M9 16h4"/>',
    restore: '<path d="M4 7v5h5"/><path d="M5 12a7 7 0 1 0 2-5"/>',
  };
  return `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24">${paths[name] || ""}</svg>`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "No se pudo completar la accion.");
  }
  return payload;
}

function applyBootstrap(payload) {
  state.settings = payload.settings || state.settings;
  state.clients = payload.clients || [];
  state.invoices = payload.invoices || [];
  state.trash = payload.trash || { clients: [], invoices: [] };
  state.events = payload.events || [];
  state.conceptFavorites = payload.concept_favorites || [];
  state.documentTasks = payload.document_tasks || [];
  state.backups = payload.backups || [];
  state.cloudBackup = payload.cloud_backup || null;
}

async function refreshData() {
  const payload = await api("/api/bootstrap");
  applyBootstrap(payload);
  renderAll();
}

function renderAll() {
  fillSettings();
  renderClients();
  renderInvoices();
  renderDashboard();
  renderMaintenance();
  renderCloudBackup();
  renderConceptFavorites();
  renderPendingState();
}

async function openFacturasFolder() {
  const result = await api("/api/open-facturas-folder", { method: "POST" });
  toast(result.path ? `Carpeta abierta: ${result.path}` : "Carpeta de facturas abierta.");
}

function switchTab(tabId) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabId);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === tabId);
  });
  if (tabId === "dashboard") {
    renderDashboard();
  }
}

function renderPendingState() {
  const button = $("updatePendingButton");
  const count = state.documentTasks.length;
  button.classList.toggle("hidden", count === 0);
  button.disabled = count === 0;
  button.textContent = count ? `Actualizar cambios (${count})` : "Actualizar cambios";
}

function renderConceptFavorites() {
  $("conceptFavoritesList").innerHTML = state.conceptFavorites
    .map((item) => `<option value="${escapeHtml(item.text)}"></option>`)
    .join("");
}

function renderMaintenance() {
  renderPendingState();
  $("documentTasksList").innerHTML = state.documentTasks.length
    ? state.documentTasks.map((task) => `<div class="list-item warning"><strong>${escapeHtml(task.reason)}</strong><span>${escapeHtml(task.path || "")}</span></div>`).join("")
    : `<div class="list-item"><strong>Todo actualizado</strong><span>No hay documentos pendientes.</span></div>`;

  const trashClients = state.trash.clients || [];
  const trashInvoices = state.trash.invoices || [];
  $("trashList").innerHTML = [...trashClients.map((client) => ({
    type: "client",
    id: client.id,
    title: client.full_name,
    purgeLabel: client.full_name,
    detail: `Cliente eliminado ${formatDateTime(client.deleted_at)}`,
  })), ...trashInvoices.map((invoice) => ({
    type: "invoice",
    id: invoice.id,
    title: `Factura ${invoice.invoice_number}`,
    purgeLabel: invoice.invoice_number,
    detail: `${invoice.client_name || ""} · ${formatDateTime(invoice.deleted_at)}`,
  }))].map((item) => `
      <div class="list-item">
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.detail)}</span>
        <span class="row-actions trash-actions">
          <button type="button" class="edit-button" data-restore-${item.type}="${item.id}">${icon("restore")} Restaurar</button>
          <button type="button" class="delete-button" data-purge-${item.type}="${item.id}" data-purge-label="${escapeHtml(item.purgeLabel)}">${icon("trash")} Borrar definitivo</button>
        </span>
      </div>
    `).join("") || `<div class="list-item"><strong>Papelera vacía</strong><span>No hay elementos eliminados.</span></div>`;

  document.querySelectorAll("[data-restore-client]").forEach((button) => {
    button.addEventListener("click", () => restoreTrashItem("client", Number(button.dataset.restoreClient)));
  });
  document.querySelectorAll("[data-restore-invoice]").forEach((button) => {
    button.addEventListener("click", () => restoreTrashItem("invoice", Number(button.dataset.restoreInvoice)));
  });
  document.querySelectorAll("[data-purge-client]").forEach((button) => {
    button.addEventListener("click", () => purgeTrashItem("client", Number(button.dataset.purgeClient), button.dataset.purgeLabel));
  });
  document.querySelectorAll("[data-purge-invoice]").forEach((button) => {
    button.addEventListener("click", () => purgeTrashItem("invoice", Number(button.dataset.purgeInvoice), button.dataset.purgeLabel));
  });

  $("eventsList").innerHTML = state.events.length
    ? state.events.slice(0, 20).map((event) => `<div class="list-item ${event.level === "error" ? "danger-item" : ""}"><strong>${escapeHtml(event.message)}</strong><span>${formatDateTime(event.created_at)}</span></div>`).join("")
    : `<div class="list-item"><strong>Sin actividad</strong><span>La actividad aparecerá aquí.</span></div>`;

  $("backupsList").innerHTML = state.backups.length
    ? state.backups.slice(0, 8).map((backup) => `<div class="list-item"><strong>${escapeHtml(backup.name)}</strong><span>${formatDateTime(backup.updated_at)} · ${Math.round((backup.size || 0) / 1024)} KB</span></div>`).join("")
    : `<div class="list-item"><strong>Sin copias todavía</strong><span>Se crearán al arrancar la app.</span></div>`;
}

function renderCloudBackup() {
  const info = state.cloudBackup || {};
  const input = $("cloudBackupDir");
  if (input && document.activeElement !== input) {
    input.value = state.settings.cloud_backup_dir || "";
    input.placeholder = info.target_dir
      ? info.target_dir
      : "Automático (no se detectó ninguna nube)";
  }

  const box = $("cloudBackupStatus");
  if (!box) return;
  const last = info.last;
  const target = info.target_dir;
  const provider = info.provider || "carpeta";
  let html;
  if (!target) {
    html = `<div class="list-item warning"><strong>No se detectó ninguna nube</strong><span>No encuentro OneDrive, Google Drive ni Dropbox. Las copias solo se guardan en este equipo. Puedes escribir una carpeta manualmente arriba.</span></div>`;
  } else if (!info.dir_exists) {
    html = `<div class="list-item warning"><strong>Carpeta no disponible</strong><span>No encuentro ${escapeHtml(target)}. Revisa que la nube esté activa.</span></div>`;
  } else if (last && last.ok) {
    html = `<div class="list-item"><strong>Última copia en la nube: OK</strong><span>${formatDateTime(last.at)} · ${escapeHtml(target)} (${escapeHtml(provider)})</span></div>`;
  } else if (last && !last.ok) {
    html = `<div class="list-item danger-item"><strong>La última copia en la nube falló</strong><span>${escapeHtml(last.error || "Error desconocido")}</span></div>`;
  } else {
    html = `<div class="list-item"><strong>Ruta en uso</strong><span>${escapeHtml(target)} (${escapeHtml(provider)}) · aún sin copias subidas</span></div>`;
  }
  box.innerHTML = html;
}

function invoiceYear(invoice) {
  return Number(String(invoice.issue_date || "").slice(0, 4));
}

function invoiceMonth(invoice) {
  return Number(String(invoice.issue_date || "").slice(5, 7));
}

function selectedDashboardYear() {
  return Number($("dashboardYear").value || new Date().getFullYear());
}

function ensureDashboardYears() {
  const currentYear = new Date().getFullYear();
  const years = Array.from(new Set([currentYear, ...state.invoices.map(invoiceYear).filter(Boolean)])).sort((a, b) => b - a);
  const selected = $("dashboardYear").value || String(years[0]);
  $("dashboardYear").innerHTML = years.map((year) => `<option value="${year}">${year}</option>`).join("");
  $("dashboardYear").value = years.includes(Number(selected)) ? selected : String(years[0]);
}

function invoicesForYear(year) {
  return state.invoices.filter((invoice) => invoiceYear(invoice) === year);
}

function renderDashboard() {
  ensureDashboardYears();
  const year = selectedDashboardYear();
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const yearInvoices = invoicesForYear(year);
  const monthInvoices = state.invoices.filter(
    (invoice) => invoiceYear(invoice) === currentYear && invoiceMonth(invoice) === currentMonth
  );
  const monthRevenue = monthInvoices.reduce((sum, invoice) => sum + Number(invoice.total || 0), 0);
  const yearRevenue = yearInvoices.reduce((sum, invoice) => sum + Number(invoice.total || 0), 0);
  const averageInvoice = yearInvoices.length ? yearRevenue / yearInvoices.length : 0;

  $("metricMonthRevenue").textContent = euro(monthRevenue);
  $("metricYearRevenue").textContent = euro(yearRevenue);
  $("metricMonthInvoices").textContent = String(monthInvoices.length);
  $("metricAverageInvoice").textContent = euro(averageInvoice);

  const revenueByMonth = Array(12).fill(0);
  const countByMonth = Array(12).fill(0);
  const sessionsByMonth = Array(12).fill(0);
  yearInvoices.forEach((invoice) => {
    const index = invoiceMonth(invoice) - 1;
    if (index >= 0 && index < 12) {
      revenueByMonth[index] += Number(invoice.total || 0);
      countByMonth[index] += 1;
      sessionsByMonth[index] += Number(invoice.quantity || 0);
    }
  });
  const averagePriceByMonth = revenueByMonth.map((total, index) =>
    sessionsByMonth[index] ? total / sessionsByMonth[index] : 0
  );

  const revenueByClient = {};
  yearInvoices.forEach((invoice) => {
    const name = invoice.client_name || "Sin cliente";
    revenueByClient[name] = (revenueByClient[name] || 0) + Number(invoice.total || 0);
  });
  const topClients = Object.entries(revenueByClient)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  drawSessionsPriceChart("monthlyTrendChart", monthNames.map((name) => name.slice(0, 3)), sessionsByMonth, averagePriceByMonth);
  renderTopClient(topClients, yearInvoices);
  renderMonthlyExports(year, revenueByMonth, countByMonth);
}

function renderTopClient(topClients, invoices) {
  const [name, revenue] = topClients[0] || ["Sin datos", 0];
  const invoiceCount = invoices.filter((invoice) => (invoice.client_name || "Sin cliente") === name).length;
  $("topClientName").textContent = name;
  $("topClientRevenue").textContent = euro(revenue);
  $("topClientInvoices").textContent = `${invoiceCount} factura${invoiceCount === 1 ? "" : "s"}`;
}

function drawSessionsPriceChart(canvasId, labels, sessionValues, averagePriceValues) {
  const canvas = $(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width || canvas.parentElement?.clientWidth || 480));
  const height = Number(canvas.getAttribute("height")) || 260;
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.height = `${height}px`;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const compact = width < 420;
  const padding = { top: 34, right: compact ? 36 : 52, bottom: 40, left: compact ? 46 : 62 };
  const chartWidth = Math.max(1, width - padding.left - padding.right);
  const chartHeight = height - padding.top - padding.bottom;
  const maxSessions = Math.max(...sessionValues, 0);
  const maxAveragePrice = Math.max(...averagePriceValues, 0);
  const sessionScale = niceScale(maxSessions);
  const priceScale = niceScale(maxAveragePrice);
  const slotWidth = chartWidth / Math.max(labels.length, 1);
  const xFor = (index) => padding.left + slotWidth * (index + 0.5);
  const ySessions = (value) => padding.top + chartHeight - (value / sessionScale) * chartHeight;
  const yAveragePrice = (value) => padding.top + chartHeight - (value / priceScale) * chartHeight;

  ctx.strokeStyle = "#ebe5dc";
  ctx.lineWidth = 1;
  for (let index = 0; index <= 4; index += 1) {
    const y = padding.top + (chartHeight * index) / 4;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartWidth, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "#d8cbb8";
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + chartHeight);
  ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
  ctx.stroke();

  const barWidth = Math.max(10, Math.min(34, slotWidth * 0.54));
  const baseline = padding.top + chartHeight;
  ctx.fillStyle = "rgba(79, 124, 104, 0.2)";
  ctx.strokeStyle = "#4f7c68";
  ctx.lineWidth = 1;
  sessionValues.forEach((value, index) => {
    const x = xFor(index) - barWidth / 2;
    const y = ySessions(value);
    const heightValue = baseline - y;
    ctx.fillRect(x, y, barWidth, heightValue);
    ctx.strokeRect(x, y, barWidth, heightValue);
  });

  function drawSparseLine(values, yFor, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    let drawing = false;
    let hasPoints = false;
    ctx.beginPath();
    values.forEach((value, index) => {
      if (!sessionValues[index]) {
        drawing = false;
        return;
      }
      const x = xFor(index);
      const y = yFor(value);
      if (!drawing) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      drawing = true;
      hasPoints = true;
    });
    if (hasPoints) ctx.stroke();
    ctx.fillStyle = color;
    values.forEach((value, index) => {
      if (!sessionValues[index]) return;
      ctx.beginPath();
      ctx.arc(xFor(index), yFor(value), 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  drawSparseLine(averagePriceValues, yAveragePrice, "#c9805a");

  ctx.font = "12px Segoe UI, Arial";
  ctx.fillStyle = "#756f62";
  ctx.textAlign = "center";
  labels.forEach((label, index) => {
    if (compact && index % 2 === 1) return;
    ctx.fillText(label, xFor(index), height - 12);
  });

  ctx.font = "12px Segoe UI, Arial";
  ctx.textAlign = "left";
  ctx.fillStyle = "#4f7c68";
  ctx.fillText(maxSessions ? String(Math.round(sessionScale)) : "0", 4, padding.top + 8);
  drawLegendItem(ctx, padding.left, 15, "#4f7c68", "Sesiones");

  ctx.textAlign = "right";
  ctx.fillStyle = "#c9805a";
  ctx.fillText(maxAveragePrice ? euro(priceScale) : euro(0), width - 4, padding.top + 8);
  drawLegendItem(ctx, compact ? padding.left + 105 : padding.left + 135, 15, "#c9805a", "Precio medio");
}

function niceScale(value) {
  if (!value) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function drawLegendItem(ctx, x, y, color, label) {
  ctx.textAlign = "left";
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y - 4, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillText(label, x + 10, y);
}

function renderMonthlyExports(year, revenueByMonth, countByMonth) {
  $("monthlyExportsTable").innerHTML = monthNames
    .map((name, index) => {
      const month = index + 1;
      const count = countByMonth[index];
      const total = revenueByMonth[index];
      const wordButton = count
        ? `<button class="edit-button" data-monthly-open="${year}-${month}" type="button">${icon("word")} Abrir Word</button>`
        : `<button class="edit-button" type="button" disabled>Sin facturas</button>`;
      return `
        <tr>
          <td><strong>${name} ${year}</strong></td>
          <td>${count}</td>
          <td>${euro(total)}</td>
          <td>${wordButton}</td>
        </tr>
      `;
    })
    .join("");

  document.querySelectorAll("[data-monthly-open]").forEach((button) => {
    button.addEventListener("click", () => {
      const [exportYear, exportMonth] = button.dataset.monthlyOpen.split("-").map(Number);
      openMonthlyWord(exportYear, exportMonth);
    });
  });
}

async function openMonthlyWord(year, month) {
  try {
    const result = await api("/api/monthly-export/open", {
      method: "POST",
      body: JSON.stringify({ year, month }),
    });
    toast(result.path ? `Word abierto: ${result.path}` : "Word mensual abierto.");
  } catch (error) {
    toast(error.message);
  }
}

function clientPayload() {
  return {
    full_name: $("clientName").value,
    tax_id: $("clientTaxId").value,
    address: $("clientAddress").value,
    postal_code: $("clientPostalCode").value,
    city: $("clientCity").value,
    email: $("clientEmail").value,
    phone: $("clientPhone").value,
    notes: $("clientNotes").value,
  };
}

function fillClientForm(client = null) {
  $("clientId").value = client?.id || "";
  $("clientFormTitle").textContent = client ? "Editar cliente" : "Nuevo cliente";
  $("clientName").value = client?.full_name || "";
  $("clientTaxId").value = client?.tax_id || "";
  $("clientAddress").value = client?.address || "";
  $("clientPostalCode").value = client?.postal_code || "";
  $("clientCity").value = client?.city || "";
  $("clientEmail").value = client?.email || "";
  $("clientPhone").value = client?.phone || "";
  $("clientNotes").value = client?.notes || "";
}

function renderClients() {
  const query = $("clientSearch").value.trim().toLowerCase();
  const rows = state.clients.filter((client) => {
    const haystack = `${client.full_name} ${client.tax_id} ${client.email} ${client.phone}`.toLowerCase();
    return haystack.includes(query);
  });

  $("clientsTable").innerHTML = rows
    .map(
      (client) => `
        <tr>
          <td><strong>${escapeHtml(client.full_name)}</strong><br><span class="muted">${escapeHtml(client.address || "")}</span></td>
          <td>${escapeHtml(client.tax_id || "")}</td>
          <td>${escapeHtml(client.email || client.phone || "")}</td>
          <td>
            <span class="row-actions">
              <button class="edit-button" data-invoice-client="${client.id}" type="button">${icon("invoice")} Facturar</button>
              <span class="action-menu">
                <button class="edit-button menu-trigger" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Más acciones">⋯</button>
                <span class="menu-list hidden" role="menu">
                  <button type="button" role="menuitem" data-edit-client="${client.id}">${icon("edit")} Editar</button>
                  <button type="button" role="menuitem" data-profile-client="${client.id}">${icon("eye")} Ficha</button>
                  <button type="button" role="menuitem" class="menu-danger" data-delete-client="${client.id}">${icon("trash")} Eliminar</button>
                </span>
              </span>
            </span>
          </td>
        </tr>
      `
    )
    .join("");

  document.querySelectorAll("[data-edit-client]").forEach((button) => {
    button.addEventListener("click", () => {
      const client = state.clients.find((item) => item.id === Number(button.dataset.editClient));
      fillClientForm(client);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  document.querySelectorAll("[data-invoice-client]").forEach((button) => {
    button.addEventListener("click", () => {
      startInvoiceForClient(Number(button.dataset.invoiceClient));
    });
  });

  document.querySelectorAll("[data-profile-client]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedClientId = Number(button.dataset.profileClient);
      renderClientProfile();
      $("clientProfile").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  document.querySelectorAll("[data-delete-client]").forEach((button) => {
    button.addEventListener("click", () => {
      const client = state.clients.find((item) => item.id === Number(button.dataset.deleteClient));
      if (client) {
        deleteClient(client);
      }
    });
  });

  renderClientOptions();
  renderClientProfile();
}

function renderClientProfile() {
  const panel = $("clientProfile");
  const client = state.clients.find((item) => item.id === state.selectedClientId);
  if (!client) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }
  const invoices = state.invoices.filter((invoice) => invoice.client_id === client.id);
  const total = invoices.reduce((sum, invoice) => sum + Number(invoice.total || 0), 0);
  const lastInvoice = invoices[0];
  panel.classList.remove("hidden");
  panel.innerHTML = `
    <div class="section-title compact">
      <h3>Ficha de ${escapeHtml(client.full_name)}</h3>
      <button type="button" class="ghost" id="closeClientProfile">Cerrar</button>
    </div>
    <div class="profile-grid">
      <div><span>Total facturado</span><strong>${euro(total)}</strong></div>
      <div><span>Facturas</span><strong>${invoices.length}</strong></div>
      <div><span>Última factura</span><strong>${lastInvoice ? escapeHtml(lastInvoice.invoice_number) : "-"}</strong></div>
      <div><span>Contacto</span><strong>${escapeHtml(client.email || client.phone || "-")}</strong></div>
    </div>
    <div class="compact-list">
      ${invoices.slice(0, 8).map((invoice) => `<div class="list-item"><strong>Factura ${escapeHtml(invoice.invoice_number)} · ${euro(invoice.total)}</strong><span>${formatDisplayDate(invoice.issue_date)} · ${escapeHtml(invoice.concept || "")}</span></div>`).join("") || `<div class="list-item"><strong>Sin facturas</strong><span>Todavía no hay facturas para este cliente.</span></div>`}
    </div>
  `;
  $("closeClientProfile").addEventListener("click", () => {
    state.selectedClientId = null;
    renderClientProfile();
  });
}

function renderClientOptions() {
  const selectedClient = $("invoiceClient").value;
  $("invoiceClient").innerHTML =
    `<option value="">Selecciona cliente</option>` +
    state.clients
      .map((client) => `<option value="${client.id}">${escapeHtml(client.full_name)}</option>`)
      .join("");
  if (selectedClient && state.clients.some((client) => client.id === Number(selectedClient))) {
    $("invoiceClient").value = selectedClient;
  }
  $("invoiceHint").textContent = state.clients.length
    ? `${state.clients.length} cliente(s) disponibles`
    : "Crea un cliente antes de generar facturas";
  renderInvoiceWarnings();
}

function renderInvoiceWarnings() {
  const client = state.clients.find((item) => item.id === Number($("invoiceClient").value));
  const box = $("invoiceWarnings");
  if (!client) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  const missing = [];
  if (!client.tax_id) missing.push("DNI/NIF");
  if (!client.address) missing.push("dirección");
  if (!client.postal_code) missing.push("código postal");
  if (!client.city) missing.push("ciudad");
  if (!missing.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = `<strong>Aviso:</strong> faltan ${missing.join(", ")} del cliente. Puedes facturar igualmente.`;
}

const postalCities = {
  "28001": "Madrid",
  "28002": "Madrid",
  "28003": "Madrid",
  "28004": "Madrid",
  "28005": "Madrid",
  "28006": "Madrid",
  "28007": "Madrid",
  "28008": "Madrid",
  "28009": "Madrid",
  "28010": "Madrid",
  "28011": "Madrid",
  "28012": "Madrid",
  "28013": "Madrid",
  "28014": "Madrid",
  "28015": "Madrid",
  "28016": "Madrid",
  "28017": "Madrid",
  "28018": "Madrid",
  "28019": "Madrid",
  "28020": "Madrid",
  "28021": "Madrid",
  "28022": "Madrid",
  "28023": "Madrid",
  "28024": "Madrid",
  "28025": "Madrid",
  "28026": "Madrid",
  "28027": "Madrid",
  "28028": "Madrid",
  "28029": "Madrid",
  "28030": "Madrid",
  "28031": "Madrid",
  "28032": "Madrid",
  "08001": "Barcelona",
  "08002": "Barcelona",
  "08003": "Barcelona",
  "08004": "Barcelona",
  "08005": "Barcelona",
  "08006": "Barcelona",
  "08007": "Barcelona",
  "08008": "Barcelona",
  "08009": "Barcelona",
  "34504": "Barcelona",
};

function autocompleteCityFromPostalCode() {
  const code = $("clientPostalCode").value.trim();
  if (!$("clientCity").value.trim() && postalCities[code]) {
    $("clientCity").value = postalCities[code];
  }
}

function startInvoiceForClient(clientId) {
  renderClientOptions();
  $("invoiceClient").value = String(clientId);
  switchTab("invoices");
  $("invoiceClient").focus();
  toast("Cliente seleccionado para facturar.");
}

function renderInvoices() {
  const query = normalizeText($("invoiceSearch").value);
  const dateFrom = $("invoiceDateFrom").value;
  const dateTo = $("invoiceDateTo").value;
  const minTotal = parseAmount($("invoiceMinTotal").value);
  const maxTotal = parseAmount($("invoiceMaxTotal").value);
  const hasMin = $("invoiceMinTotal").value.trim() !== "";
  const hasMax = $("invoiceMaxTotal").value.trim() !== "";
  const rows = state.invoices.filter((invoice) => {
    const haystack = normalizeText(`${invoice.invoice_number} ${invoice.client_name} ${invoice.concept}`);
    if (query && !haystack.includes(query)) return false;
    if (dateFrom && invoice.issue_date < dateFrom) return false;
    if (dateTo && invoice.issue_date > dateTo) return false;
    if (hasMin && Number(invoice.total || 0) < minTotal) return false;
    if (hasMax && Number(invoice.total || 0) > maxTotal) return false;
    return true;
  });

  $("invoicesTable").innerHTML = rows
    .map(
      (invoice) => `
        <tr>
          <td><strong>${escapeHtml(invoice.invoice_number)}</strong></td>
          <td>${escapeHtml(invoice.client_name)}</td>
          <td>${escapeHtml(invoice.issue_date)}</td>
          <td>${euro(invoice.total)}</td>
          <td>
            <span class="row-actions">
              <button class="edit-button" data-open-word="${invoice.id}" type="button">${icon("word")} Word</button>
              <span class="action-menu">
                <button class="edit-button menu-trigger" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Más acciones">⋯</button>
                <span class="menu-list hidden" role="menu">
                  <button type="button" role="menuitem" data-preview-invoice="${invoice.id}">${icon("eye")} Vista previa</button>
                  ${invoice.pdf_url ? `<a role="menuitem" href="${invoice.pdf_url}">${icon("word")} PDF</a>` : ""}
                  <button type="button" role="menuitem" class="menu-danger" data-delete-invoice="${invoice.id}">${icon("trash")} Eliminar</button>
                </span>
              </span>
            </span>
          </td>
        </tr>
      `
    )
    .join("");

  document.querySelectorAll("[data-open-word]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const result = await api(`/api/invoices/${button.dataset.openWord}/open-word`, { method: "POST" });
        toast(result.path ? `Word abierto: ${result.path}` : "Word abierto.");
      } catch (error) {
        toast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-preview-invoice]").forEach((button) => {
    button.addEventListener("click", () => {
      const invoice = state.invoices.find((item) => item.id === Number(button.dataset.previewInvoice));
      if (invoice) {
        showInvoicePreview(invoice);
      }
    });
  });

  document.querySelectorAll("[data-delete-invoice]").forEach((button) => {
    button.addEventListener("click", () => {
      const invoice = state.invoices.find((item) => item.id === Number(button.dataset.deleteInvoice));
      if (invoice) {
        deleteInvoice(invoice);
      }
    });
  });
}

function showInvoicePreview(invoice) {
  const issuer = state.settings;
  const clientCity = [invoice.client_postal_code, invoice.client_city].filter(Boolean).join(", ");
  $("previewTitle").textContent = `Vista previa factura ${invoice.invoice_number}`;
  $("invoicePreviewBody").innerHTML = `
    <div class="preview-sheet">
      <div class="preview-parties">
        <div>
          <strong>${escapeHtml(issuer.issuer_name || "")}</strong>
          <span>DNI: ${escapeHtml(issuer.issuer_tax_id || "")}</span>
          <span>${escapeHtml(issuer.issuer_address || "")}</span>
          <span>${escapeHtml(issuer.issuer_postal_city || "")}</span>
        </div>
        <div>
          <strong>${escapeHtml(invoice.client_name || "")}</strong>
          <span>DNI: ${escapeHtml(invoice.client_tax_id || "")}</span>
          <span>${escapeHtml(invoice.client_address || "")}</span>
          <span>${escapeHtml(clientCity)}</span>
        </div>
      </div>
      <div class="preview-row four">
        <span>Nº FACTURA</span><strong>${escapeHtml(invoice.invoice_number)}</strong>
        <span>FECHA</span><strong>${formatDisplayDate(invoice.issue_date)}</strong>
      </div>
      <div class="preview-row concept">
        <span>CONCEPTO</span><strong>${escapeHtml(invoice.concept || "")}</strong>
        <span>IMPORTE</span><strong>${amountText(invoice.subtotal)}</strong>
      </div>
      <div class="preview-spacer"></div>
      <div class="preview-totals">
        <span>SUMA</span><strong>${amountText(invoice.subtotal)}</strong>
        <span>${Number(invoice.vat_rate) ? `${amountText(invoice.vat_rate)}% I.V.A:` : "I.V.A. exento:"}</span><strong>${amountText(invoice.vat_amount)}</strong>
        <span class="total-label">TOTAL</span><strong class="total-value">${amountText(invoice.total)}€</strong>
      </div>
    </div>
  `;
  $("invoicePreviewModal").classList.remove("hidden");
}

function closeInvoicePreview() {
  $("invoicePreviewModal").classList.add("hidden");
}

function formatDisplayDate(value) {
  const parts = String(value || "").split("-");
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return value || "";
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
}

async function purgeTrashItem(type, id, label) {
  const target = type === "client"
    ? `el cliente "${label}" y todas sus facturas`
    : `la factura ${label}`;
  const first = window.confirm(
    `¿Borrar definitivamente ${target}?\n\nSe eliminarán también sus Word/PDF generados. Esta acción no se puede deshacer.`
  );
  if (!first) return;
  try {
    const endpoint = type === "client" ? `/api/trash/clients/${id}` : `/api/trash/invoices/${id}`;
    await api(endpoint, {
      method: "DELETE",
      body: JSON.stringify({ confirm: "ELIMINAR" }),
    });
    await refreshData();
    toast(type === "client" ? "Cliente borrado definitivamente." : "Factura borrada definitivamente.");
  } catch (error) {
    toast(`No se pudo borrar: ${error.message}`);
  }
}

async function restoreTrashItem(type, id) {
  try {
    const endpoint = type === "client" ? `/api/trash/clients/${id}/restore` : `/api/trash/invoices/${id}/restore`;
    const result = await api(endpoint, { method: "PUT" });
    await refreshData();
    if (type === "client") {
      toast("Cliente restaurado.");
    } else if (result && result.client_restored) {
      toast(`Factura restaurada. También se restauró su cliente ${result.client_name || ""}.`.trim());
    } else {
      toast("Factura restaurada.");
    }
  } catch (error) {
    toast(`No se pudo restaurar: ${error.message}`);
  }
}

async function updatePendingDocuments() {
  const result = await api("/api/documents/update-pending", { method: "POST" });
  state.documentTasks = result.document_tasks || [];
  await refreshData();
  toast(state.documentTasks.length ? "Quedan documentos pendientes. Cierra Word y vuelve a intentarlo." : "Cambios actualizados.");
}

async function deleteClient(client) {
  const relatedInvoices = state.invoices.filter((invoice) => invoice.client_id === client.id);
  const invoiceWarning = relatedInvoices.length
    ? `\n\nEste cliente tiene ${relatedInvoices.length} factura(s); irán también a la papelera. Podrás restaurarlo todo desde Ajustes → Papelera, o borrarlo definitivamente desde allí.`
    : "\n\nIrá a la papelera y podrás restaurarlo desde Ajustes → Papelera.";
  const first = window.confirm(`¿Eliminar el cliente "${client.full_name}"?${invoiceWarning}`);
  if (!first) return;
  const second = window.prompt(`Para confirmar definitivamente, escribe ELIMINAR`);
  if (second !== "ELIMINAR") {
    toast("Eliminación cancelada.");
    return;
  }
  try {
    const result = await api(`/api/clients/${client.id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirm: "ELIMINAR" }),
    });
    await refreshData();
    toast(`Cliente enviado a papelera. Facturas afectadas: ${result.deleted_invoices}.`);
  } catch (error) {
    toast(`No se pudo eliminar: ${error.message}`);
  }
}

async function deleteInvoice(invoice) {
  const first = window.confirm(
    `¿Eliminar la factura ${invoice.invoice_number} de ${invoice.client_name}?\n\nIrá a la papelera y podrás restaurarla desde Ajustes → Papelera.`
  );
  if (!first) return;
  const second = window.prompt(`Para confirmar, escribe el número de factura: ${invoice.invoice_number}`);
  if (second !== invoice.invoice_number) {
    toast("Eliminación cancelada.");
    return;
  }
  try {
    await api(`/api/invoices/${invoice.id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirm: "ELIMINAR", invoice_number: invoice.invoice_number }),
    });
    await refreshData();
    toast(`Factura ${invoice.invoice_number} enviada a papelera.`);
  } catch (error) {
    toast(`No se pudo eliminar: ${error.message}`);
  }
}

function fillSettings() {
  $("issuerName").value = state.settings.issuer_name || "";
  $("issuerTaxId").value = state.settings.issuer_tax_id || "";
  $("issuerAddress").value = state.settings.issuer_address || "";
  $("issuerPostalCity").value = state.settings.issuer_postal_city || "";
  $("invoiceNextNumber").value = state.settings.invoice_next_number || "1";
  $("invoiceSeries").value = state.settings.invoice_series || "";
  $("defaultConcept").value = state.settings.default_concept || "";
  $("defaultUnitPrice").value = state.settings.default_unit_price || "0";
  $("defaultVatRate").value = state.settings.default_vat_rate || "21";
  $("vatCalculationMode").value = vatCalculationMode();

  $("invoiceDate").value = today();
  $("paymentMethod").value = "Efectivo";
  $("invoiceConcept").value = state.settings.default_concept || conceptForQuantity($("quantity").value, state.settings.default_concept);
  $("unitPrice").value = state.settings.default_unit_price || "0";
  $("vatRate").value = vatCalculationMode() === "exempt" ? "0" : state.settings.default_vat_rate || "21";
  updateTotals();
}

function settingsPayload() {
  return {
    issuer_name: $("issuerName").value,
    issuer_tax_id: $("issuerTaxId").value,
    issuer_address: $("issuerAddress").value,
    issuer_postal_city: $("issuerPostalCity").value,
    invoice_next_number: $("invoiceNextNumber").value,
    invoice_series: $("invoiceSeries").value,
    default_concept: $("defaultConcept").value,
    default_unit_price: $("defaultUnitPrice").value,
    default_vat_rate: $("defaultVatRate").value,
    vat_calculation_mode: $("vatCalculationMode").value,
    cloud_backup_dir: $("cloudBackupDir").value,
  };
}

function invoicePayload() {
  syncConceptWithQuantity();
  return {
    client_id: $("invoiceClient").value,
    issue_date: $("invoiceDate").value,
    payment_method: $("paymentMethod").value,
    concept: $("invoiceConcept").value,
    quantity: cleanAmountValue("quantity"),
    unit_price: cleanAmountValue("unitPrice"),
    vat_rate: cleanAmountValue("vatRate"),
    vat_calculation_mode: vatCalculationMode(),
    subtotal: cleanAmountValue("subtotalAmount"),
    vat_amount: cleanAmountValue("vatAmount"),
    total: cleanAmountValue("totalAmount"),
  };
}

function updateTotals() {
  syncConceptWithQuantity();
  const quantity = parseAmount($("quantity").value || 0);
  const unitPrice = parseAmount($("unitPrice").value || 0);
  const vatRate = parseAmount($("vatRate").value || 0);
  const { subtotal, vat, total } = calculateInvoiceTotals(quantity, unitPrice, vatRate, vatCalculationMode());
  $("subtotalAmount").value = amountText(subtotal);
  $("vatAmount").value = amountText(vat);
  $("totalAmount").value = amountText(total);
}

function updateTotalFromManualBaseAndVat() {
  const subtotal = parseAmount($("subtotalAmount").value);
  const vat = parseAmount($("vatAmount").value);
  $("totalAmount").value = amountText(roundCents(subtotal + vat));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function closeActionMenus() {
  // Los menús abiertos viven en document.body (portal); al cerrar vuelven
  // junto a su botón, o se descartan si la fila ya no existe tras un render.
  document.querySelectorAll("body > .menu-list").forEach((menu) => {
    const home = menu._homeParent;
    menu.classList.add("hidden");
    if (home && home.isConnected) {
      home.appendChild(menu);
    } else {
      menu.remove();
    }
  });
  document.querySelectorAll('.menu-trigger[aria-expanded="true"]').forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
}

function positionActionMenu(trigger, menu) {
  const rect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - menuRect.height - 6);
  }
  menu.style.left = `${Math.max(8, rect.right - menuRect.width)}px`;
  menu.style.top = `${top}px`;
}

document.addEventListener("click", (event) => {
  const trigger = event.target.closest(".menu-trigger");
  if (trigger) {
    const menu = trigger.parentElement.querySelector(".menu-list");
    closeActionMenus();
    if (menu) {
      // Portal a body: fuera de los stacking contexts y contenedores con
      // scroll/backdrop-filter, para que nada lo tape ni lo recorte.
      menu._homeParent = trigger.parentElement;
      document.body.appendChild(menu);
      menu.classList.remove("hidden");
      trigger.setAttribute("aria-expanded", "true");
      positionActionMenu(trigger, menu);
    }
    return;
  }
  closeActionMenus();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeActionMenus();
});
window.addEventListener("scroll", closeActionMenus, true);
window.addEventListener("resize", closeActionMenus);

async function load() {
  const payload = await api("/api/bootstrap");
  applyBootstrap(payload);
  renderAll();
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

$("openFacturasFolder").addEventListener("click", async () => {
  try {
    await openFacturasFolder();
  } catch (error) {
    toast(error.message);
  }
});

$("dashboardYear").addEventListener("change", renderDashboard);

let dashboardResizeTimer;
window.addEventListener("resize", () => {
  if (!$("dashboard").classList.contains("active")) return;
  window.clearTimeout(dashboardResizeTimer);
  dashboardResizeTimer = window.setTimeout(renderDashboard, 120);
});

$("clientSearch").addEventListener("input", renderClients);
$("clearClient").addEventListener("click", () => fillClientForm());
$("clientPostalCode").addEventListener("blur", autocompleteCityFromPostalCode);
$("closePreview").addEventListener("click", closeInvoicePreview);
$("invoicePreviewModal").addEventListener("click", (event) => {
  if (event.target.id === "invoicePreviewModal") {
    closeInvoicePreview();
  }
});

$("updatePendingButton").addEventListener("click", async () => {
  try {
    await updatePendingDocuments();
  } catch (error) {
    toast(error.message);
  }
});

$("forceUpdateDocuments").addEventListener("click", async () => {
  try {
    await updatePendingDocuments();
  } catch (error) {
    toast(error.message);
  }
});

$("cloudBackupDir").addEventListener("change", async () => {
  try {
    const result = await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ cloud_backup_dir: $("cloudBackupDir").value }),
    });
    state.settings = result.settings;
    await refreshData();
    toast("Carpeta de la nube guardada.");
  } catch (error) {
    toast(error.message);
  }
});

$("cloudBackupNow").addEventListener("click", async () => {
  const button = $("cloudBackupNow");
  button.disabled = true;
  try {
    const result = await api("/api/backup/cloud", { method: "POST" });
    state.cloudBackup = result.cloud;
    renderCloudBackup();
    const last = result.cloud && result.cloud.last;
    if (last && last.ok) {
      toast("Copia en la nube realizada.");
    } else if (last && !last.ok) {
      toast(`No se pudo copiar a la nube: ${last.error || "error desconocido"}`);
    } else {
      toast("No hay carpeta de nube configurada.");
    }
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

$("importClientsButton").addEventListener("click", async () => {
  try {
    const result = await api("/api/import/clients", {
      method: "POST",
      body: JSON.stringify({ csv: $("importClientsCsv").value }),
    });
    state.clients = result.clients;
    $("importClientsCsv").value = "";
    $("importClientsFile").value = "";
    await refreshData();
    toast(`Clientes importados: ${result.imported}. Omitidos: ${result.skipped}.`);
  } catch (error) {
    toast(error.message);
  }
});

function wireCsvFile(fileId, textareaId) {
  $(fileId).addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      $(textareaId).value = await file.text();
      toast(`Archivo cargado: ${file.name}. Pulsa el botón para importar.`);
    } catch (error) {
      toast("No pude leer el archivo.");
    }
  });
}
wireCsvFile("importClientsFile", "importClientsCsv");
wireCsvFile("importInvoicesFile", "importInvoicesCsv");

$("importInvoicesButton").addEventListener("click", async () => {
  try {
    const result = await api("/api/import/invoices", {
      method: "POST",
      body: JSON.stringify({ csv: $("importInvoicesCsv").value }),
    });
    $("importInvoicesCsv").value = "";
    $("importInvoicesFile").value = "";
    await refreshData();
    let msg = `Facturas importadas: ${result.imported}. Omitidas: ${result.skipped}.`;
    if (result.unmatched && result.unmatched.length) {
      const sample = result.unmatched.slice(0, 3).join(", ");
      msg += ` Sin cliente: ${result.unmatched.length} (${sample}${result.unmatched.length > 3 ? "…" : ""}).`;
    }
    toast(msg);
  } catch (error) {
    toast(error.message);
  }
});

$("importSettingsButton").addEventListener("click", async () => {
  const file = $("importSettingsFile").files[0];
  if (!file) {
    toast("Selecciona un archivo de configuracion.");
    return;
  }

  try {
    const payload = JSON.parse(await file.text());
    const result = await api("/api/settings/import", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.settings = result.settings;
    fillSettings();
    $("importSettingsFile").value = "";
    toast("Configuracion importada.");
  } catch (error) {
    toast(error.message);
  }
});

["invoiceSearch", "invoiceDateFrom", "invoiceDateTo", "invoiceMinTotal", "invoiceMaxTotal"].forEach((id) => {
  $(id).addEventListener("input", renderInvoices);
});

$("clearInvoiceFilters").addEventListener("click", () => {
  ["invoiceSearch", "invoiceDateFrom", "invoiceDateTo", "invoiceMinTotal", "invoiceMaxTotal"].forEach((id) => {
    $(id).value = "";
  });
  renderInvoices();
});

$("invoiceClient").addEventListener("change", renderInvoiceWarnings);

$("clientForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const id = $("clientId").value;
    const payload = clientPayload();
    const result = id
      ? await api(`/api/clients/${id}`, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/api/clients", { method: "POST", body: JSON.stringify(payload) });
    const index = state.clients.findIndex((client) => client.id === result.client.id);
    if (index >= 0) {
      state.clients[index] = result.client;
    } else {
      state.clients.push(result.client);
    }
    await refreshData();
    toast("Cliente guardado.");
  } catch (error) {
    toast(error.message);
  }
});

$("settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/settings", {
      method: "POST",
      body: JSON.stringify(settingsPayload()),
    });
    state.settings = result.settings;
    fillSettings();
    toast("Ajustes guardados.");
  } catch (error) {
    toast(error.message);
  }
});

["quantity", "unitPrice", "vatRate"].forEach((id) => {
  $(id).addEventListener("input", updateTotals);
  $(id).addEventListener("change", updateTotals);
});

["subtotalAmount", "vatAmount"].forEach((id) => {
  $(id).addEventListener("input", updateTotalFromManualBaseAndVat);
});

$("invoiceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (!$("invoiceClient").value) {
      toast("Selecciona un cliente antes de generar la factura.");
      $("invoiceClient").focus();
      return;
    }
    const result = await api("/api/invoices", {
      method: "POST",
      body: JSON.stringify(invoicePayload()),
    });
    await refreshData();
    const pendingMessage = state.documentTasks.length ? " Hay cambios pendientes por un Word abierto." : " Word mensual actualizado.";
    toast(`Factura ${result.invoice.invoice_number} generada.${pendingMessage}`);
  } catch (error) {
    toast(error.message);
  }
});

load().catch((error) => toast(error.message));
