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
  return rounded.toLocaleString("es-ES", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

function autoConceptForQuantity(quantityValue) {
  const quantity = Math.max(1, Math.round(parseAmount(quantityValue || 1)));
  const serviceLabel = quantity === 1 ? "SERVICIO" : "SERVICIOS";
  return `${quantity} ${serviceLabel}`;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function isAutoConcept(value) {
  const normalized = normalizeText(value);
  return /^\d+\s+SERVICIOS?$/.test(normalized);
}

function syncConceptWithQuantity() {
  const concept = $("invoiceConcept").value.trim();
  if (!concept || isAutoConcept(concept)) {
    $("invoiceConcept").value = autoConceptForQuantity($("quantity").value);
  }
}

function parseAmount(value) {
  const text = String(value || "").trim().replaceAll(" ", "");
  if (text.includes(",") && text.includes(".")) {
    return Number(text.replaceAll(".", "").replace(",", ".")) || 0;
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

function today() {
  return new Date().toISOString().slice(0, 10);
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
    detail: `Cliente eliminado ${formatDateTime(client.deleted_at)}`,
  })), ...trashInvoices.map((invoice) => ({
    type: "invoice",
    id: invoice.id,
    title: `Factura ${invoice.invoice_number}`,
    detail: `${invoice.client_name || ""} · ${formatDateTime(invoice.deleted_at)}`,
  }))].map((item) => `
      <div class="list-item">
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.detail)}</span>
        <button type="button" class="edit-button" data-restore-${item.type}="${item.id}">${icon("restore")} Restaurar</button>
      </div>
    `).join("") || `<div class="list-item"><strong>Papelera vacía</strong><span>No hay elementos eliminados.</span></div>`;

  document.querySelectorAll("[data-restore-client]").forEach((button) => {
    button.addEventListener("click", () => restoreTrashItem("client", Number(button.dataset.restoreClient)));
  });
  document.querySelectorAll("[data-restore-invoice]").forEach((button) => {
    button.addEventListener("click", () => restoreTrashItem("invoice", Number(button.dataset.restoreInvoice)));
  });

  $("eventsList").innerHTML = state.events.length
    ? state.events.slice(0, 20).map((event) => `<div class="list-item ${event.level === "error" ? "danger-item" : ""}"><strong>${escapeHtml(event.message)}</strong><span>${formatDateTime(event.created_at)}</span></div>`).join("")
    : `<div class="list-item"><strong>Sin actividad</strong><span>La actividad aparecerá aquí.</span></div>`;

  $("backupsList").innerHTML = state.backups.length
    ? state.backups.slice(0, 8).map((backup) => `<div class="list-item"><strong>${escapeHtml(backup.name)}</strong><span>${formatDateTime(backup.updated_at)} · ${Math.round((backup.size || 0) / 1024)} KB</span></div>`).join("")
    : `<div class="list-item"><strong>Sin copias todavía</strong><span>Se crearán al arrancar la app.</span></div>`;
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
  yearInvoices.forEach((invoice) => {
    const index = invoiceMonth(invoice) - 1;
    if (index >= 0 && index < 12) {
      revenueByMonth[index] += Number(invoice.total || 0);
      countByMonth[index] += 1;
    }
  });

  const revenueByClient = {};
  yearInvoices.forEach((invoice) => {
    const name = invoice.client_name || "Sin cliente";
    revenueByClient[name] = (revenueByClient[name] || 0) + Number(invoice.total || 0);
  });
  const topClients = Object.entries(revenueByClient)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  drawCombinedTrendChart("monthlyTrendChart", monthNames.map((name) => name.slice(0, 3)), revenueByMonth, countByMonth);
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

function drawCombinedTrendChart(canvasId, labels, revenueValues, countValues) {
  const canvas = $(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.clientWidth || 480;
  const height = Number(canvas.getAttribute("height")) || 260;
  canvas.width = width * window.devicePixelRatio;
  canvas.height = height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  ctx.clearRect(0, 0, width, height);

  const padding = { top: 26, right: 42, bottom: 38, left: 56 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maxRevenue = Math.max(...revenueValues, 1);
  const maxCount = Math.max(...countValues, 1);
  const xFor = (index) => padding.left + (chartWidth * index) / Math.max(labels.length - 1, 1);
  const yRevenue = (value) => padding.top + chartHeight - (value / maxRevenue) * chartHeight;
  const yCount = (value) => padding.top + chartHeight - (value / maxCount) * chartHeight;

  ctx.strokeStyle = "#d9d4ca";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + chartHeight);
  ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
  ctx.stroke();

  function drawLine(values, yFor, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    values.forEach((value, index) => {
      const x = xFor(index);
      const y = yFor(value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = color;
    values.forEach((value, index) => {
      ctx.beginPath();
      ctx.arc(xFor(index), yFor(value), 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  drawLine(revenueValues, yRevenue, "#116466");
  drawLine(countValues, yCount, "#c79a35");

  ctx.fillStyle = "#687175";
  ctx.font = "12px Segoe UI, Arial";
  ctx.textAlign = "center";
  labels.forEach((label, index) => {
    ctx.fillText(label, xFor(index), height - 12);
  });

  ctx.textAlign = "left";
  ctx.fillStyle = "#116466";
  ctx.fillText(euro(maxRevenue), 4, padding.top + 8);
  ctx.fillText("Ingresos", padding.left, 15);

  ctx.textAlign = "right";
  ctx.fillStyle = "#c79a35";
  ctx.fillText(String(Math.round(maxCount)), width - 4, padding.top + 8);
  ctx.fillText("Facturas", padding.left + 155, 15);
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
              <button class="edit-button" data-edit-client="${client.id}" type="button">Editar</button>
              <button class="edit-button" data-profile-client="${client.id}" type="button">${icon("eye")} Ficha</button>
              <button class="edit-button" data-invoice-client="${client.id}" type="button">Facturar</button>
              <button class="delete-button" data-delete-client="${client.id}" type="button">Eliminar</button>
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
              ${invoice.pdf_url ? `<a class="link-button" href="${invoice.pdf_url}">PDF</a>` : ""}
              <button class="edit-button" data-preview-invoice="${invoice.id}" type="button">${icon("eye")} Preview</button>
              <button class="delete-button" data-delete-invoice="${invoice.id}" type="button">${icon("trash")} Eliminar</button>
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
        <span>${amountText(invoice.vat_rate)}% I.V.A:</span><strong>${amountText(invoice.vat_amount)}</strong>
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

async function restoreTrashItem(type, id) {
  const endpoint = type === "client" ? `/api/trash/clients/${id}/restore` : `/api/trash/invoices/${id}/restore`;
  await api(endpoint, { method: "PUT" });
  await refreshData();
  toast(type === "client" ? "Cliente restaurado." : "Factura restaurada.");
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
    ? `\n\nEste cliente tiene ${relatedInvoices.length} factura(s). También se eliminarán esas facturas y sus Word/PDF generados.`
    : "";
  const first = window.confirm(`¿Eliminar el cliente "${client.full_name}"?${invoiceWarning}`);
  if (!first) return;
  const second = window.prompt(`Para confirmar definitivamente, escribe ELIMINAR`);
  if (second !== "ELIMINAR") {
    toast("Eliminación cancelada.");
    return;
  }
  const result = await api(`/api/clients/${client.id}`, {
    method: "DELETE",
    body: JSON.stringify({ confirm: "ELIMINAR" }),
  });
  await refreshData();
  toast(`Cliente enviado a papelera. Facturas afectadas: ${result.deleted_invoices}.`);
}

async function deleteInvoice(invoice) {
  const first = window.confirm(`¿Eliminar la factura ${invoice.invoice_number} de ${invoice.client_name}?`);
  if (!first) return;
  const second = window.prompt(`Para confirmar, escribe el número de factura: ${invoice.invoice_number}`);
  if (second !== invoice.invoice_number) {
    toast("Eliminación cancelada.");
    return;
  }
  await api(`/api/invoices/${invoice.id}`, {
    method: "DELETE",
    body: JSON.stringify({ confirm: "ELIMINAR", invoice_number: invoice.invoice_number }),
  });
  await refreshData();
  toast(`Factura ${invoice.invoice_number} enviada a papelera.`);
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

  $("invoiceDate").value = today();
  $("paymentMethod").value = "Efectivo";
  $("invoiceConcept").value = state.settings.default_concept || autoConceptForQuantity($("quantity").value);
  $("unitPrice").value = state.settings.default_unit_price || "0";
  $("vatRate").value = state.settings.default_vat_rate || "21";
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
  const subtotal = roundCents(quantity * unitPrice);
  const unitVat = roundCentsUp(unitPrice * vatRate / 100);
  const vat = roundCents(quantity * unitVat);
  $("subtotalAmount").value = amountText(subtotal);
  $("vatAmount").value = amountText(vat);
  $("totalAmount").value = amountText(roundCents(subtotal + vat));
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

$("importClientsButton").addEventListener("click", async () => {
  try {
    const result = await api("/api/import/clients", {
      method: "POST",
      body: JSON.stringify({ csv: $("importClientsCsv").value }),
    });
    state.clients = result.clients;
    $("importClientsCsv").value = "";
    await refreshData();
    toast(`Clientes importados: ${result.imported}. Omitidos: ${result.skipped}.`);
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
