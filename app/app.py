from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unicodedata
import urllib.parse
import zipfile
import csv
import io
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_HALF_UP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = Path(__file__).resolve().parent / "static"


def configured_path(env_name: str, default: Path) -> Path:
    return Path(os.environ.get(env_name) or default)


DB_PATH = configured_path("FACTURACION_DB_PATH", ROOT / "data" / "facturacion.db")
GENERATED_DIR = configured_path("FACTURACION_GENERATED_DIR", ROOT / "generated")
FACTURAS_DIR = configured_path("FACTURACION_FACTURAS_DIR", ROOT / "facturas")
BACKUPS_DIR = configured_path("FACTURACION_BACKUPS_DIR", ROOT / "backups")
TEMPLATE_PATH = configured_path("FACTURACION_TEMPLATE_PATH", ROOT / "PLANTILLA_FACTURA.docx")


DEFAULT_SETTINGS = {
    "issuer_name": "NOMBRE DEL EMISOR",
    "issuer_tax_id": "DNI/NIF",
    "issuer_address": "DIRECCION DEL EMISOR",
    "issuer_postal_city": "CP, CIUDAD",
    "invoice_next_number": "1",
    "invoice_series": "{year}-",
    "default_concept": "1 SERVICIO",
    "default_unit_price": "0",
    "default_vat_rate": "21",
    "vat_calculation_mode": "unit_ceil",
}

PAYMENT_METHODS = {"Efectivo", "Transferencia", "Bizum"}
VAT_CALCULATION_MODES = {"unit_ceil", "line_standard", "unit_standard", "line_ceil", "vat_included", "exempt"}

MONTH_NAMES = {
    1: "ENERO",
    2: "FEBRERO",
    3: "MARZO",
    4: "ABRIL",
    5: "MAYO",
    6: "JUNIO",
    7: "JULIO",
    8: "AGOSTO",
    9: "SEPTIEMBRE",
    10: "OCTUBRE",
    11: "NOVIEMBRE",
    12: "DICIEMBRE",
}

LEGACY_DEFAULT_SETTINGS = {}


def money(value: Decimal | str | float | int, field_name: str = "importe") -> Decimal:
    return parse_decimal(value, field_name).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def money_up(value: Decimal | str | float | int, field_name: str = "importe") -> Decimal:
    return parse_decimal(value, field_name).quantize(Decimal("0.01"), rounding=ROUND_CEILING)


def calculate_invoice_totals(
    quantity: Decimal,
    unit_price: Decimal,
    vat_rate: Decimal,
    mode: str,
) -> tuple[Decimal, Decimal, Decimal]:
    if mode not in VAT_CALCULATION_MODES:
        mode = DEFAULT_SETTINGS["vat_calculation_mode"]

    if mode == "exempt":
        subtotal = money(quantity * unit_price, "base calculada")
        return subtotal, Decimal("0.00"), subtotal

    if mode == "vat_included":
        total = money(quantity * unit_price, "total calculado")
        divisor = Decimal("1") + (vat_rate / Decimal("100"))
        subtotal = money(total / divisor if divisor else total, "base calculada")
        vat_amount = money(total - subtotal, "IVA calculado")
        return subtotal, vat_amount, total

    subtotal = money(quantity * unit_price, "base calculada")
    if mode == "unit_ceil":
        unit_vat_amount = money_up(unit_price * vat_rate / Decimal("100"), "IVA por unidad")
        vat_amount = money(quantity * unit_vat_amount, "IVA calculado")
    elif mode == "unit_standard":
        unit_vat_amount = money(unit_price * vat_rate / Decimal("100"), "IVA por unidad")
        vat_amount = money(quantity * unit_vat_amount, "IVA calculado")
    elif mode == "line_ceil":
        vat_amount = money_up(subtotal * vat_rate / Decimal("100"), "IVA calculado")
    else:
        vat_amount = money(subtotal * vat_rate / Decimal("100"), "IVA calculado")
    total = money(subtotal + vat_amount, "total calculado")
    return subtotal, vat_amount, total


def parse_decimal(value: Decimal | str | float | int, field_name: str = "importe") -> Decimal:
    if isinstance(value, Decimal):
        return value
    text = str(value or "").strip()
    text = (
        text.replace("€", "")
        .replace("\u00a0", "")
        .replace("\u202f", "")
        .replace(" ", "")
    )
    text = re.sub(r"[^0-9,.\-]", "", text)
    if "," in text and "." in text:
        text = text.replace(".", "").replace(",", ".")
    else:
        text = text.replace(",", ".")
    try:
        return Decimal(text or "0")
    except (InvalidOperation, ValueError):
        raise ValueError(f"No puedo leer el campo {field_name}: {value!r}. Usa un número tipo 45,45.")


def format_invoice_amount(value: Decimal | str | float | int) -> str:
    amount = money(value)
    if amount == amount.to_integral_value():
        return str(amount.quantize(Decimal("1")))
    return f"{amount:.2f}".replace(".", ",")


def now_iso() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def backup_database(reason: str = "auto") -> Path | None:
    if not DB_PATH.exists():
        return None
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = BACKUPS_DIR / f"facturacion_{reason}_{stamp}.db"
    source = sqlite3.connect(DB_PATH)
    try:
        target = sqlite3.connect(backup_path)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()
    backups = sorted(BACKUPS_DIR.glob("facturacion_*.db"), key=lambda path: path.stat().st_mtime, reverse=True)
    for old_backup in backups[30:]:
        old_backup.unlink(missing_ok=True)
    return backup_path


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    if column not in table_columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def init_db() -> None:
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    FACTURAS_DIR.mkdir(parents=True, exist_ok=True)
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    backup_database("startup")
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS clients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                full_name TEXT NOT NULL,
                tax_id TEXT,
                address TEXT,
                postal_code TEXT,
                city TEXT,
                email TEXT,
                phone TEXT,
                notes TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS invoices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_number TEXT NOT NULL UNIQUE,
                issue_date TEXT NOT NULL,
                client_id INTEGER NOT NULL REFERENCES clients(id),
                concept TEXT NOT NULL,
                quantity REAL NOT NULL,
                unit_price REAL NOT NULL,
                vat_rate REAL NOT NULL,
                subtotal REAL NOT NULL,
                vat_amount REAL NOT NULL,
                total REAL NOT NULL,
                payment_method TEXT,
                status TEXT NOT NULL DEFAULT 'emitida',
                docx_path TEXT,
                pdf_path TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS app_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                level TEXT NOT NULL DEFAULT 'info',
                message TEXT NOT NULL,
                entity_type TEXT,
                entity_id TEXT
            );

            CREATE TABLE IF NOT EXISTS concept_favorites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS document_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_key TEXT NOT NULL UNIQUE,
                task_type TEXT NOT NULL,
                year INTEGER,
                month INTEGER,
                invoice_id INTEGER,
                path TEXT,
                reason TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                resolved_at TEXT
            );

            CREATE TABLE IF NOT EXISTS invoice_counters (
                year INTEGER PRIMARY KEY,
                next_number INTEGER NOT NULL
            );
            """
        )
        add_column_if_missing(conn, "clients", "deleted_at", "TEXT")
        add_column_if_missing(conn, "invoices", "deleted_at", "TEXT")
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)",
                (key, value),
            )
            legacy_value = LEGACY_DEFAULT_SETTINGS.get(key)
            if legacy_value:
                conn.execute(
                    "UPDATE settings SET value = ? WHERE key = ? AND value = ?",
                    (value, key, legacy_value),
                )
        for concept in ("1 SERVICIO", "2 SERVICIOS", "5 SERVICIOS", "10 SERVICIOS"):
            conn.execute(
                "INSERT OR IGNORE INTO concept_favorites(text, created_at) VALUES(?, ?)",
                (concept, now_iso()),
            )


def rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict]:
    return [dict(row) for row in rows]


def get_settings(conn: sqlite3.Connection) -> dict[str, str]:
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    settings = DEFAULT_SETTINGS.copy()
    settings.update({row["key"]: row["value"] for row in rows})
    return settings


def current_year() -> int:
    return datetime.now().year


def invoice_series_for_year(settings: dict[str, str], year: int) -> str:
    raw = (settings.get("invoice_series") or "").strip() or "{year}-"
    if "{year}" in raw:
        return raw.replace("{year}", str(year))
    match = re.match(r"^\d{4}(.*)$", raw)
    if match:
        return f"{year}{match.group(1)}"
    return raw


def invoice_number_value(invoice_number: str, series: str) -> int | None:
    value = str(invoice_number or "").strip()
    if series:
        if not value.startswith(series):
            return None
        value = value[len(series):]
    if not value.isdigit():
        return None
    return int(value)


def inferred_next_invoice_number(conn: sqlite3.Connection, year: int, series: str, settings: dict[str, str]) -> int:
    fallback = 1
    if year == current_year():
        try:
            fallback = max(1, int((settings.get("invoice_next_number") or "1").strip()))
        except ValueError:
            fallback = 1
    rows = conn.execute(
        "SELECT invoice_number FROM invoices WHERE strftime('%Y', issue_date) = ?",
        (str(year),),
    ).fetchall()
    existing_numbers = [
        number
        for row in rows
        if (number := invoice_number_value(row["invoice_number"], series)) is not None
    ]
    if not existing_numbers and series:
        existing_numbers = [
            number
            for row in rows
            if (number := invoice_number_value(row["invoice_number"], "")) is not None
        ]
    return max(fallback, max(existing_numbers, default=0) + 1)


def next_number_for_year(conn: sqlite3.Connection, year: int, settings: dict[str, str]) -> int:
    row = conn.execute("SELECT next_number FROM invoice_counters WHERE year = ?", (year,)).fetchone()
    if row:
        return int(row["next_number"])
    return inferred_next_invoice_number(conn, year, invoice_series_for_year(settings, year), settings)


def public_settings(conn: sqlite3.Connection) -> dict[str, str]:
    settings = get_settings(conn)
    year = current_year()
    settings["invoice_series"] = invoice_series_for_year(settings, year)
    settings["invoice_next_number"] = str(next_number_for_year(conn, year, settings))
    return settings


def save_settings(conn: sqlite3.Connection, settings: dict) -> dict[str, str]:
    allowed = set(DEFAULT_SETTINGS)
    for key, value in settings.items():
        if key in allowed:
            if key == "vat_calculation_mode" and value not in VAT_CALCULATION_MODES:
                raise ValueError("El modo de IVA no es valido.")
            conn.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, str(value).strip()),
            )
    if "invoice_next_number" in settings:
        try:
            next_number = max(1, int(str(settings.get("invoice_next_number") or "1").strip()))
        except ValueError:
            raise ValueError("El siguiente numero debe ser un numero entero.")
        conn.execute(
            "INSERT INTO invoice_counters(year, next_number) VALUES(?, ?) "
            "ON CONFLICT(year) DO UPDATE SET next_number = excluded.next_number",
            (current_year(), next_number),
        )
    return public_settings(conn)


def normalize_settings_import(payload: dict) -> dict[str, str]:
    raw_settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else payload
    if not isinstance(raw_settings, dict):
        raise ValueError("El archivo no contiene una configuracion valida.")

    allowed = set(DEFAULT_SETTINGS)
    settings = {
        key: value
        for key, value in raw_settings.items()
        if key in allowed and value is not None
    }
    if not settings:
        raise ValueError("No encuentro ningun ajuste valido para importar.")
    return settings


def log_event(
    conn: sqlite3.Connection,
    message: str,
    level: str = "info",
    entity_type: str | None = None,
    entity_id: str | int | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO app_events(created_at, level, message, entity_type, entity_id)
        VALUES(?, ?, ?, ?, ?)
        """,
        (now_iso(), level, message, entity_type, str(entity_id) if entity_id is not None else None),
    )


def register_document_task(
    task_type: str,
    reason: str,
    year: int | None = None,
    month: int | None = None,
    invoice_id: int | None = None,
    path: Path | str | None = None,
) -> None:
    if task_type == "monthly":
        task_key = f"monthly:{year}:{month}"
    elif task_type == "invoice":
        task_key = f"invoice:{invoice_id}"
    else:
        task_key = f"{task_type}:{year}:{month}:{invoice_id}:{path}"
    with db() as conn:
        conn.execute(
            """
            INSERT INTO document_tasks(task_key, task_type, year, month, invoice_id, path, reason, status, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
            ON CONFLICT(task_key) DO UPDATE SET
                reason = excluded.reason,
                path = excluded.path,
                status = 'pending',
                updated_at = excluded.updated_at,
                resolved_at = NULL
            """,
            (task_key, task_type, year, month, invoice_id, str(path) if path else None, reason, now_iso(), now_iso()),
        )
        event_entity_id = invoice_id
        if event_entity_id is None and year and month:
            event_entity_id = f"{year}-{month:02d}"
        log_event(conn, reason, "warning", task_type, event_entity_id)


def resolve_document_task(task_type: str, year: int | None = None, month: int | None = None, invoice_id: int | None = None) -> None:
    if task_type == "monthly":
        task_key = f"monthly:{year}:{month}"
    else:
        task_key = f"invoice:{invoice_id}"
    with db() as conn:
        conn.execute(
            """
            UPDATE document_tasks
            SET status = 'resolved', updated_at = ?, resolved_at = ?
            WHERE task_key = ?
            """,
            (now_iso(), now_iso(), task_key),
        )


def next_invoice_number(conn: sqlite3.Connection, issue_date: str) -> str:
    settings = get_settings(conn)
    year, _ = invoice_year_month(issue_date)
    series = invoice_series_for_year(settings, year)
    number = next_number_for_year(conn, year, settings)
    invoice_number = f"{series}{number}" if series else str(number)
    while conn.execute("SELECT 1 FROM invoices WHERE invoice_number = ?", (invoice_number,)).fetchone():
        number += 1
        invoice_number = f"{series}{number}" if series else str(number)
    conn.execute(
        "INSERT INTO invoice_counters(year, next_number) VALUES(?, ?) "
        "ON CONFLICT(year) DO UPDATE SET next_number = excluded.next_number",
        (year, number + 1),
    )
    if year == current_year():
        conn.execute(
            "UPDATE settings SET value = ? WHERE key = 'invoice_next_number'",
            (str(number + 1),),
        )
    return invoice_number


def format_date_for_invoice(date_value: str) -> str:
    try:
        return datetime.strptime(date_value, "%Y-%m-%d").strftime("%d-%m-%Y")
    except ValueError:
        return date_value


def normalize_issue_date(date_value: str) -> str:
    value = (date_value or "").strip()
    for pattern in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(value, pattern).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return datetime.now().strftime("%Y-%m-%d")


def invoice_year_month(issue_date: str) -> tuple[int, int]:
    parsed = datetime.strptime(normalize_issue_date(issue_date), "%Y-%m-%d")
    return parsed.year, parsed.month


def monthly_docx_path(year: int, month: int) -> Path:
    if month < 1 or month > 12:
        raise ValueError("Mes invalido.")
    return FACTURAS_DIR / str(year) / f"{MONTH_NAMES[month]} {year}.docx"


def sync_monthly_docx(year: int, month: int) -> Path | None:
    with db() as conn:
        count = conn.execute(
            """
            SELECT COUNT(*)
            FROM invoices
            JOIN clients ON clients.id = invoices.client_id
            WHERE strftime('%Y', issue_date) = ? AND strftime('%m', issue_date) = ?
              AND invoices.deleted_at IS NULL AND clients.deleted_at IS NULL
            """,
            (str(year), f"{month:02d}"),
        ).fetchone()[0]

    output_path = monthly_docx_path(year, month)
    if count:
        try:
            path = combine_monthly_docx(year, month)
            resolve_document_task("monthly", year=year, month=month)
            return path
        except PermissionError:
            register_document_task(
                "monthly",
                f"No se pudo actualizar {MONTH_NAMES[month]} {year} porque el Word está abierto.",
                year=year,
                month=month,
                path=output_path,
            )
            return output_path if output_path.exists() else None
    if output_path.is_file():
        try:
            output_path.unlink()
            resolve_document_task("monthly", year=year, month=month)
        except PermissionError:
            register_document_task(
                "monthly",
                f"No se pudo borrar {MONTH_NAMES[month]} {year} porque el Word está abierto.",
                year=year,
                month=month,
                path=output_path,
            )
            return output_path
    return None


def normalize_text(value: str) -> str:
    without_accents = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", without_accents.upper()).strip()


def auto_concept_for_quantity(quantity: Decimal) -> str:
    count = max(1, int(quantity.to_integral_value(rounding=ROUND_HALF_UP)))
    label = "SERVICIO" if count == 1 else "SERVICIOS"
    return f"{count} {label}"


def is_auto_service_concept(concept: str) -> bool:
    normalized = normalize_text(concept)
    return bool(re.fullmatch(r"\d+\s+SERVICIOS?", normalized))


def friendly_error(exc: Exception) -> str:
    if isinstance(exc, InvalidOperation) or "ConversionSyntax" in str(exc):
        return "Hay un importe con formato no válido. Revisa cantidad, precio base, IVA, base, IVA calculado y total."
    return str(exc)


def log_error_safely(exc: Exception, context: str = "") -> None:
    try:
        with db() as conn:
            message = friendly_error(exc)
            if context:
                message = f"{context}: {message}"
            log_event(conn, message, "error", "system", None)
    except Exception:
        pass


def xml_escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def replace_text_node(xml: str, old: str, new: str) -> str:
    pattern = re.compile(r"(<w:t(?:\s[^>]*)?>)" + re.escape(old) + r"(</w:t>)")
    return pattern.sub(lambda m: f"{m.group(1)}{xml_escape(new)}{m.group(2)}", xml)


def replace_xml_row(xml: str, marker: str, transform) -> str:
    marker_index = xml.find(marker)
    if marker_index == -1:
        return xml
    row_start = xml.rfind("<w:tr", 0, marker_index)
    row_end = xml.find("</w:tr>", marker_index)
    if row_start == -1 or row_end == -1:
        return xml
    row_end += len("</w:tr>")
    row = xml[row_start:row_end]
    return f"{xml[:row_start]}{transform(row)}{xml[row_end:]}"


def center_row_text(row_xml: str) -> str:
    return re.sub(r'<w:jc w:val="[^"]+"\/>', '<w:jc w:val="center"/>', row_xml)


def improve_invoice_table_layout(xml: str) -> str:
    def detail_row(row: str) -> str:
        row = center_row_text(row)
        row = row.replace('<w:vAlign w:val="top"/>', '<w:vAlign w:val="center"/>')
        return row

    xml = replace_xml_row(xml, "<w:t>CONCEPTO</w:t>", detail_row)
    xml = replace_xml_row(xml, "<w:t>Nº FACTURA</w:t>", center_row_text)
    xml = replace_xml_row(xml, "<w:t>SUMA</w:t>", center_row_text)
    xml = replace_xml_row(xml, "<w:t>21% I.V.A:</w:t>", center_row_text)
    xml = replace_xml_row(xml, "<w:t>TOTAL</w:t>", center_row_text)
    return xml


def remove_second_invoice_block(xml: str) -> str:
    parts = extract_invoice_xml_parts(xml)
    if not parts:
        return xml
    before_body, invoice_table, sect_pr, after_body = parts
    return f"{before_body}{invoice_table}{sect_pr}{after_body}"


def extract_invoice_xml_parts(xml: str) -> tuple[str, str, str, str] | None:
    body_match = re.search(r"<w:body\b[^>]*>", xml)
    if not body_match:
        return None
    body_close = xml.rfind("</w:body>")
    if body_close == -1:
        return None

    body_start = body_match.end()
    body_content = xml[body_start:body_close]
    table_start = body_content.find("<w:tbl>")
    if table_start == -1:
        return None
    table_end = find_matching_table_end(body_content, table_start)
    if table_end == -1:
        return None

    sect_match = re.search(r"<w:sectPr\b.*?</w:sectPr>", body_content, flags=re.DOTALL)
    if not sect_match:
        return None

    before_body = xml[:body_start]
    invoice_table = body_content[table_start:table_end]
    sect_pr = sect_match.group(0)
    after_body = xml[body_close:]
    return before_body, invoice_table, sect_pr, after_body


def find_matching_table_end(xml: str, start: int) -> int:
    token_re = re.compile(r"</?w:tbl(?:\s[^>]*)?>")
    depth = 0
    for match in token_re.finditer(xml, start):
        token = match.group(0)
        if token.startswith("</"):
            depth -= 1
            if depth == 0:
                return match.end()
        else:
            depth += 1
    return -1


def page_break_xml() -> str:
    return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'


def invoice_number_sort_key(invoice_number: str) -> tuple:
    parts = re.split(r"(\d+)", invoice_number or "")
    sortable_parts = []
    for part in parts:
        if not part:
            continue
        if part.isdigit():
            sortable_parts.append((0, int(part)))
        else:
            sortable_parts.append((1, normalize_text(part)))
    return tuple(sortable_parts)


def open_local_folder(path: Path) -> Path:
    target = path.resolve()
    target.mkdir(parents=True, exist_ok=True)
    if sys.platform.startswith("win"):
        os.startfile(str(target))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(target)])
    else:
        subprocess.Popen(["xdg-open", str(target)])
    return target


def open_local_file(path: Path) -> Path:
    target = path.resolve()
    if not target.is_file():
        raise FileNotFoundError(f"No existe el archivo: {target}")
    if sys.platform.startswith("win"):
        os.startfile(str(target))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(target)])
    else:
        subprocess.Popen(["xdg-open", str(target)])
    return target


def render_docx(
    invoice: dict,
    client: dict,
    settings: dict,
    output_dir: Path | None = None,
    create_pdf: bool = True,
) -> tuple[str, str | None]:
    if not TEMPLATE_PATH.exists():
        raise FileNotFoundError(f"No existe la plantilla: {TEMPLATE_PATH}")

    safe_number = re.sub(r"[^A-Za-z0-9_-]+", "_", invoice["invoice_number"])
    stem = f"factura_{safe_number}_{client['full_name'].strip().replace(' ', '_')}"
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", stem)[:80]
    target_dir = output_dir or GENERATED_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    docx_path = target_dir / f"{stem}.docx"
    pdf_path = target_dir / f"{stem}.pdf"

    subtotal = money(invoice["subtotal"], "base")
    vat_amount = money(invoice["vat_amount"], "IVA")
    total = money(invoice["total"], "total")
    subtotal_text = format_invoice_amount(subtotal)
    vat_amount_text = format_invoice_amount(vat_amount)
    total_text = format_invoice_amount(total)
    client_postal_city = ", ".join(
        part
        for part in [
            (client.get("postal_code") or "").strip(),
            (client.get("city") or "").strip().upper(),
        ]
        if part
    )

    replacements = {
        "NOMBRE DEL EMISOR": settings["issuer_name"],
        "DNI: DNI/NIF EMISOR": f"DNI: {settings['issuer_tax_id']}",
        "DIRECCION DEL EMISOR": settings["issuer_address"],
        "CP, CIUDAD EMISOR": settings["issuer_postal_city"],
        "NOMBRE DEL CLIENTE": client["full_name"].upper(),
        "DNI: DNI/NIF CLIENTE": f"DNI: {(client.get('tax_id') or '').strip()}",
        "DIRECCION DEL CLIENTE": (client.get("address") or "").upper(),
        "CP, CIUDAD CLIENTE": client_postal_city,
        "      0000": invoice["invoice_number"],
        "   DD-MM-AAAA": format_date_for_invoice(invoice["issue_date"]),
        "  SERVICIO": invoice["concept"].upper(),
        "  0,00": subtotal_text,
        "        0,00": subtotal_text,
        "         0,00": vat_amount_text,
        "         TOTAL_FACTURA": f"{total_text}€",
    }

    with zipfile.ZipFile(TEMPLATE_PATH, "r") as zin:
        with zipfile.ZipFile(docx_path, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                content = zin.read(item.filename)
                if item.filename == "word/document.xml":
                    xml = content.decode("utf-8")
                    for old, new in replacements.items():
                        xml = replace_text_node(xml, old, str(new))
                    xml = improve_invoice_table_layout(xml)
                    xml = remove_second_invoice_block(xml)
                    content = xml.encode("utf-8")
                zout.writestr(item, content)

    created_pdf = convert_to_pdf(docx_path, pdf_path) if create_pdf else None
    return str(docx_path), str(created_pdf) if created_pdf else None


def combine_monthly_docx(year: int, month: int) -> Path:
    if month < 1 or month > 12:
        raise ValueError("Mes inválido.")

    with db() as conn:
        rows = conn.execute(
            """
            SELECT invoices.*, clients.full_name AS client_name, clients.tax_id, clients.address,
                   clients.postal_code, clients.city, clients.email, clients.phone, clients.notes
            FROM invoices
            JOIN clients ON clients.id = invoices.client_id
            WHERE strftime('%Y', issue_date) = ? AND strftime('%m', issue_date) = ?
              AND invoices.deleted_at IS NULL AND clients.deleted_at IS NULL
            ORDER BY invoice_number ASC, issue_date ASC, invoices.id ASC
            """,
            (str(year), f"{month:02d}"),
        ).fetchall()
        if not rows:
            raise ValueError("No hay facturas para ese mes.")

        rows = sorted(rows, key=lambda row: (invoice_number_sort_key(row["invoice_number"]), row["issue_date"], row["id"]))
        settings = get_settings(conn)

    with tempfile.TemporaryDirectory() as tmp:
        temp_dir = Path(tmp)
        docx_paths = []
        for row in rows:
            invoice = dict(row)
            client = {
                "full_name": invoice["client_name"],
                "tax_id": invoice["tax_id"],
                "address": invoice["address"],
                "postal_code": invoice["postal_code"],
                "city": invoice["city"],
                "email": invoice["email"],
                "phone": invoice["phone"],
                "notes": invoice["notes"],
            }
            docx, _ = render_docx(invoice, client, settings, output_dir=temp_dir, create_pdf=False)
            docx_paths.append(Path(docx))

        base_path = docx_paths[0]
        with zipfile.ZipFile(base_path, "r") as base_zip:
            base_xml = base_zip.read("word/document.xml").decode("utf-8")
            base_parts = extract_invoice_xml_parts(base_xml)
            if not base_parts:
                raise ValueError("No se pudo leer la factura base.")
            before_body, _, sect_pr, after_body = base_parts

            invoice_tables = []
            for index, docx_path in enumerate(docx_paths):
                with zipfile.ZipFile(docx_path, "r") as invoice_zip:
                    invoice_xml = invoice_zip.read("word/document.xml").decode("utf-8")
                    invoice_parts = extract_invoice_xml_parts(invoice_xml)
                    if invoice_parts:
                        invoice_tables.append(invoice_parts[1])
            if not invoice_tables:
                raise ValueError("No se pudieron leer las facturas del mes.")

            body_xml = ""
            for index, invoice_table in enumerate(invoice_tables):
                if index:
                    body_xml += page_break_xml()
                body_xml += invoice_table
            monthly_document_xml = f"{before_body}{body_xml}{sect_pr}{after_body}"

            output_path = monthly_docx_path(year, month)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as out_zip:
                for item in base_zip.infolist():
                    content = base_zip.read(item.filename)
                    if item.filename == "word/document.xml":
                        content = monthly_document_xml.encode("utf-8")
                    out_zip.writestr(item, content)

    return output_path


def convert_to_pdf(docx_path: Path, expected_pdf: Path) -> Path | None:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        return None

    with tempfile.TemporaryDirectory() as tmp:
        cmd = [
            soffice,
            "--headless",
            "--convert-to",
            "pdf",
            "--outdir",
            tmp,
            str(docx_path),
        ]
        try:
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except Exception:
            return None
        generated_pdf = Path(tmp) / f"{docx_path.stem}.pdf"
        if generated_pdf.exists():
            shutil.copyfile(generated_pdf, expected_pdf)
            return expected_pdf
    return None


def json_body(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length == 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def csv_response(rows: list[dict], fieldnames: list[str]) -> bytes:
    buffer = io.StringIO()
    buffer.write("\ufeff")
    writer = csv.DictWriter(buffer, fieldnames=fieldnames, extrasaction="ignore", delimiter=";")
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return buffer.getvalue().encode("utf-8")


def parse_csv_text(text: str) -> list[dict]:
    sample = text[:2048]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=";,")
    except csv.Error:
        dialect = csv.excel
        dialect.delimiter = ";"
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    return [{(key or "").strip(): (value or "").strip() for key, value in row.items()} for row in reader]


class Handler(BaseHTTPRequestHandler):
    server_version = "Facturacion/0.1"

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/":
            return self.serve_file(STATIC_DIR / "index.html")
        if path.startswith("/static/"):
            return self.serve_file(STATIC_DIR / path.removeprefix("/static/"))
        if path.startswith("/generated/"):
            return self.serve_file(GENERATED_DIR / path.removeprefix("/generated/"), attachment=True)
        if path == "/api/monthly-export":
            query = urllib.parse.parse_qs(parsed.query)
            year = int((query.get("year") or ["0"])[0])
            month = int((query.get("month") or ["0"])[0])
            try:
                return self.serve_file(combine_monthly_docx(year, month), attachment=True)
            except Exception as exc:
                log_error_safely(exc, path)
                return self.send_json({"error": friendly_error(exc)}, status=400)
        if path == "/api/bootstrap":
            return self.send_json(self.bootstrap())
        if path == "/api/clients":
            return self.send_json(self.list_clients())
        if path == "/api/invoices":
            return self.send_json(self.list_invoices())
        if path == "/api/export/clients.csv":
            return self.send_bytes(self.export_clients_csv(), "text/csv; charset=utf-8", "clientes.csv", attachment=True)
        if path == "/api/export/invoices.csv":
            return self.send_bytes(self.export_invoices_csv(), "text/csv; charset=utf-8", "facturas.csv", attachment=True)
        self.send_error(404, "No encontrado")

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/settings":
                return self.send_json(self.update_settings(json_body(self)))
            if path == "/api/settings/import":
                return self.send_json(self.import_settings(json_body(self)))
            if path == "/api/clients":
                return self.send_json(self.create_client(json_body(self)), status=201)
            if path == "/api/invoices":
                return self.send_json(self.create_invoice(json_body(self)), status=201)
            if path == "/api/open-facturas-folder":
                opened_path = open_local_folder(FACTURAS_DIR)
                return self.send_json({"opened": True, "path": str(opened_path)})
            if path == "/api/monthly-export/open":
                payload = json_body(self)
                year = int(payload.get("year") or 0)
                month = int(payload.get("month") or 0)
                docx_path = combine_monthly_docx(year, month)
                opened_path = open_local_file(docx_path)
                return self.send_json({"opened": True, "path": str(opened_path)})
            if path == "/api/import/clients":
                return self.send_json(self.import_clients(json_body(self)))
            if path == "/api/documents/update-pending":
                return self.send_json(self.update_pending_documents())
            match = re.match(r"^/api/invoices/(\d+)/open-word$", path)
            if match:
                return self.send_json(self.open_invoice_word(int(match.group(1))))
        except Exception as exc:
            log_error_safely(exc, path)
            return self.send_json({"error": friendly_error(exc)}, status=400)
        self.send_error(404, "No encontrado")

    def do_PUT(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            match = re.match(r"^/api/clients/(\d+)$", path)
            if match:
                return self.send_json(self.update_client(int(match.group(1)), json_body(self)))
            match = re.match(r"^/api/trash/clients/(\d+)/restore$", path)
            if match:
                return self.send_json(self.restore_client(int(match.group(1))))
            match = re.match(r"^/api/trash/invoices/(\d+)/restore$", path)
            if match:
                return self.send_json(self.restore_invoice(int(match.group(1))))
        except Exception as exc:
            log_error_safely(exc, path)
            return self.send_json({"error": friendly_error(exc)}, status=400)
        self.send_error(404, "No encontrado")

    def do_DELETE(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            match = re.match(r"^/api/clients/(\d+)$", path)
            if match:
                return self.send_json(self.delete_client(int(match.group(1)), json_body(self)))
            match = re.match(r"^/api/invoices/(\d+)$", path)
            if match:
                return self.send_json(self.delete_invoice(int(match.group(1)), json_body(self)))
        except Exception as exc:
            log_error_safely(exc, path)
            return self.send_json({"error": friendly_error(exc)}, status=400)
        self.send_error(404, "No encontrado")

    def bootstrap(self) -> dict:
        self.detect_missing_documents()
        with db() as conn:
            return {
                "settings": public_settings(conn),
                "clients": self._clients(conn),
                "invoices": self._invoices(conn),
                "trash": self._trash(conn),
                "events": self._events(conn),
                "concept_favorites": self._concept_favorites(conn),
                "document_tasks": self._document_tasks(conn),
                "backups": self._backups(),
            }

    def list_clients(self) -> dict:
        with db() as conn:
            return {"clients": self._clients(conn)}

    def list_invoices(self) -> dict:
        with db() as conn:
            return {"invoices": self._invoices(conn)}

    def update_settings(self, payload: dict) -> dict:
        with db() as conn:
            settings = save_settings(conn, payload)
            return {"settings": settings}

    def import_settings(self, payload: dict) -> dict:
        imported_settings = normalize_settings_import(payload)
        with db() as conn:
            settings = save_settings(conn, imported_settings)
            log_event(conn, "Configuracion importada", "info", "settings", None)
            return {"settings": settings, "imported": sorted(imported_settings)}

    def create_client(self, payload: dict) -> dict:
        full_name = (payload.get("full_name") or "").strip()
        if not full_name:
            raise ValueError("El nombre del cliente es obligatorio.")
        timestamp = now_iso()
        fields = (
            full_name,
            (payload.get("tax_id") or "").strip(),
            (payload.get("address") or "").strip(),
            (payload.get("postal_code") or "").strip(),
            (payload.get("city") or "").strip(),
            (payload.get("email") or "").strip(),
            (payload.get("phone") or "").strip(),
            (payload.get("notes") or "").strip(),
            timestamp,
            timestamp,
        )
        with db() as conn:
            cur = conn.execute(
                """
                INSERT INTO clients(
                    full_name, tax_id, address, postal_code, city, email, phone,
                    notes, created_at, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                fields,
            )
            log_event(conn, f"Cliente creado: {full_name}", "info", "client", cur.lastrowid)
            return {"client": dict(conn.execute("SELECT * FROM clients WHERE id = ?", (cur.lastrowid,)).fetchone())}

    def update_client(self, client_id: int, payload: dict) -> dict:
        full_name = (payload.get("full_name") or "").strip()
        if not full_name:
            raise ValueError("El nombre del cliente es obligatorio.")
        with db() as conn:
            existing = conn.execute("SELECT id FROM clients WHERE id = ?", (client_id,)).fetchone()
            if not existing:
                raise ValueError("Cliente no encontrado.")
            conn.execute(
                """
                UPDATE clients
                SET full_name = ?, tax_id = ?, address = ?, postal_code = ?, city = ?,
                    email = ?, phone = ?, notes = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    full_name,
                    (payload.get("tax_id") or "").strip(),
                    (payload.get("address") or "").strip(),
                    (payload.get("postal_code") or "").strip(),
                    (payload.get("city") or "").strip(),
                    (payload.get("email") or "").strip(),
                    (payload.get("phone") or "").strip(),
                    (payload.get("notes") or "").strip(),
                    now_iso(),
                    client_id,
                ),
            )
            log_event(conn, f"Cliente actualizado: {full_name}", "info", "client", client_id)
            return {"client": dict(conn.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone())}

    def create_invoice(self, payload: dict) -> dict:
        client_id = int(payload.get("client_id") or 0)
        concept = (payload.get("concept") or "").strip()
        if not client_id:
            raise ValueError("Selecciona un cliente.")

        quantity = parse_decimal(payload.get("quantity") or "1", "cantidad")
        if not concept or is_auto_service_concept(concept):
            concept = auto_concept_for_quantity(quantity)
        if not concept:
            raise ValueError("El concepto es obligatorio.")
        unit_price = parse_decimal(payload.get("unit_price") or "0", "precio base")
        vat_rate = parse_decimal(payload.get("vat_rate") or "0", "IVA %")
        calculated_subtotal = money(quantity * unit_price, "base calculada")
        unit_vat_amount = money_up(unit_price * vat_rate / Decimal("100"), "IVA por sesión")
        calculated_vat_amount = money(quantity * unit_vat_amount, "IVA calculado")
        calculated_total = money(calculated_subtotal + calculated_vat_amount, "total calculado")
        calculated_subtotal, calculated_vat_amount, calculated_total = calculate_invoice_totals(
            quantity,
            unit_price,
            vat_rate,
            payload.get("vat_calculation_mode") or DEFAULT_SETTINGS["vat_calculation_mode"],
        )
        subtotal = money(payload.get("subtotal") or calculated_subtotal, "base")
        vat_amount = money(payload.get("vat_amount") or calculated_vat_amount, "IVA")
        total = money(payload.get("total") or calculated_total, "total")
        issue_date = normalize_issue_date(payload.get("issue_date") or datetime.now().strftime("%Y-%m-%d"))
        monthly_year, monthly_month = invoice_year_month(issue_date)

        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            client = conn.execute("SELECT * FROM clients WHERE id = ? AND deleted_at IS NULL", (client_id,)).fetchone()
            if not client:
                raise ValueError("Cliente no encontrado.")
            settings = get_settings(conn)
            invoice_number = next_invoice_number(conn, issue_date)
            payment_method = (payload.get("payment_method") or "Efectivo").strip()
            if payment_method not in PAYMENT_METHODS:
                raise ValueError("Forma de pago no valida. Usa Efectivo, Transferencia o Bizum.")
            invoice = {
                "invoice_number": invoice_number,
                "issue_date": issue_date,
                "client_id": client_id,
                "concept": concept,
                "quantity": float(quantity),
                "unit_price": float(money(unit_price, "precio base")),
                "vat_rate": float(vat_rate),
                "subtotal": float(subtotal),
                "vat_amount": float(vat_amount),
                "total": float(total),
                "payment_method": payment_method,
                "status": "emitida",
            }
            docx_path, pdf_path = render_docx(invoice, dict(client), settings)
            cur = conn.execute(
                """
                INSERT INTO invoices(
                    invoice_number, issue_date, client_id, concept, quantity,
                    unit_price, vat_rate, subtotal, vat_amount, total,
                    payment_method, status, docx_path, pdf_path, created_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    invoice_number,
                    issue_date,
                    client_id,
                    concept,
                    float(quantity),
                    float(money(unit_price, "precio base")),
                    float(vat_rate),
                    float(subtotal),
                    float(vat_amount),
                    float(total),
                    invoice["payment_method"],
                    "emitida",
                    docx_path,
                    pdf_path,
                    now_iso(),
                ),
            )
            conn.execute(
                "INSERT OR IGNORE INTO concept_favorites(text, created_at) VALUES(?, ?)",
                (concept.upper(), now_iso()),
            )
            log_event(conn, f"Factura {invoice_number} creada", "info", "invoice", cur.lastrowid)
            created_invoice = self._invoice_by_id(conn, cur.lastrowid)
        monthly_path = sync_monthly_docx(monthly_year, monthly_month)
        return {"invoice": created_invoice, "monthly_docx_path": str(monthly_path) if monthly_path else None}

    def delete_client(self, client_id: int, payload: dict) -> dict:
        if payload.get("confirm") != "ELIMINAR":
            raise ValueError("Confirmación inválida.")
        with db() as conn:
            client = conn.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone()
            if not client:
                raise ValueError("Cliente no encontrado.")
            invoices = conn.execute("SELECT * FROM invoices WHERE client_id = ? AND deleted_at IS NULL", (client_id,)).fetchall()
            affected_months = {invoice_year_month(invoice["issue_date"]) for invoice in invoices}
            deleted_at = now_iso()
            conn.execute("UPDATE invoices SET deleted_at = ? WHERE client_id = ? AND deleted_at IS NULL", (deleted_at, client_id))
            conn.execute("UPDATE clients SET deleted_at = ?, updated_at = ? WHERE id = ?", (deleted_at, deleted_at, client_id))
            deleted_invoices = len(invoices)
            log_event(conn, f"Cliente enviado a papelera: {client['full_name']}", "warning", "client", client_id)
        monthly_paths = [sync_monthly_docx(year, month) for year, month in sorted(affected_months)]
        return {
            "deleted": True,
            "client_id": client_id,
            "deleted_invoices": deleted_invoices,
            "monthly_docx_paths": [str(path) for path in monthly_paths if path],
        }

    def delete_invoice(self, invoice_id: int, payload: dict) -> dict:
        if payload.get("confirm") != "ELIMINAR":
            raise ValueError("Confirmación inválida.")
        with db() as conn:
            invoice = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
            if not invoice:
                raise ValueError("Factura no encontrada.")
            invoice = dict(invoice)
            if (payload.get("invoice_number") or "") != invoice["invoice_number"]:
                raise ValueError("El número de factura no coincide.")
            monthly_year, monthly_month = invoice_year_month(invoice["issue_date"])
            conn.execute("UPDATE invoices SET deleted_at = ? WHERE id = ?", (now_iso(), invoice_id))
            log_event(conn, f"Factura {invoice['invoice_number']} enviada a papelera", "warning", "invoice", invoice_id)
        monthly_path = sync_monthly_docx(monthly_year, monthly_month)
        return {"deleted": True, "invoice_id": invoice_id, "monthly_docx_path": str(monthly_path) if monthly_path else None}

    def restore_client(self, client_id: int) -> dict:
        with db() as conn:
            client = conn.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone()
            if not client:
                raise ValueError("Cliente no encontrado.")
            conn.execute("UPDATE clients SET deleted_at = NULL, updated_at = ? WHERE id = ?", (now_iso(), client_id))
            log_event(conn, f"Cliente restaurado: {client['full_name']}", "info", "client", client_id)
            restored = dict(conn.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone())
        return {"client": restored}

    def restore_invoice(self, invoice_id: int) -> dict:
        with db() as conn:
            invoice = conn.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
            if not invoice:
                raise ValueError("Factura no encontrada.")
            invoice = dict(invoice)
            conn.execute("UPDATE clients SET deleted_at = NULL, updated_at = ? WHERE id = ?", (now_iso(), invoice["client_id"]))
            conn.execute("UPDATE invoices SET deleted_at = NULL WHERE id = ?", (invoice_id,))
            log_event(conn, f"Factura {invoice['invoice_number']} restaurada", "info", "invoice", invoice_id)
            restored = self._invoice_by_id(conn, invoice_id)
        year, month = invoice_year_month(invoice["issue_date"])
        sync_monthly_docx(year, month)
        return {"invoice": restored}

    def regenerate_invoice_docx(self, invoice_id: int) -> Path:
        with db() as conn:
            row = conn.execute(
                """
                SELECT invoices.*, clients.full_name AS client_name, clients.tax_id, clients.address,
                       clients.postal_code, clients.city, clients.email, clients.phone, clients.notes
                FROM invoices
                JOIN clients ON clients.id = invoices.client_id
                WHERE invoices.id = ? AND invoices.deleted_at IS NULL AND clients.deleted_at IS NULL
                """,
                (invoice_id,),
            ).fetchone()
            if not row:
                raise ValueError("Factura no encontrada.")
            invoice = dict(row)
            settings = get_settings(conn)
            client = {
                "full_name": invoice["client_name"],
                "tax_id": invoice["tax_id"],
                "address": invoice["address"],
                "postal_code": invoice["postal_code"],
                "city": invoice["city"],
                "email": invoice["email"],
                "phone": invoice["phone"],
                "notes": invoice["notes"],
            }
            docx, pdf = render_docx(invoice, client, settings)
            conn.execute("UPDATE invoices SET docx_path = ?, pdf_path = ? WHERE id = ?", (docx, pdf, invoice_id))
            log_event(conn, f"Factura {invoice['invoice_number']} regenerada", "info", "invoice", invoice_id)
        resolve_document_task("invoice", invoice_id=invoice_id)
        return Path(docx)

    def open_invoice_word(self, invoice_id: int) -> dict:
        with db() as conn:
            row = conn.execute(
                """
                SELECT invoices.*, clients.full_name AS client_name, clients.tax_id, clients.address,
                       clients.postal_code, clients.city, clients.email, clients.phone, clients.notes
                FROM invoices
                JOIN clients ON clients.id = invoices.client_id
                WHERE invoices.id = ? AND invoices.deleted_at IS NULL AND clients.deleted_at IS NULL
                """,
                (invoice_id,),
            ).fetchone()
            if not row:
                raise ValueError("Factura no encontrada.")
            invoice = dict(row)
            docx_path = Path(invoice["docx_path"] or "")
            if not docx_path.is_file():
                docx_path = self.regenerate_invoice_docx(invoice_id)
            log_event(conn, f"Word abierto: factura {invoice['invoice_number']}", "info", "invoice", invoice_id)
        opened = open_local_file(docx_path)
        return {"opened": True, "path": str(opened)}

    def detect_missing_documents(self) -> None:
        with db() as conn:
            invoices = conn.execute("SELECT id, invoice_number, docx_path FROM invoices WHERE deleted_at IS NULL").fetchall()
        for invoice in invoices:
            path = Path(invoice["docx_path"] or "")
            if not path.is_file():
                register_document_task(
                    "invoice",
                    f"Falta el Word de la factura {invoice['invoice_number']}.",
                    invoice_id=invoice["id"],
                    path=path if str(path) else None,
                )

    def update_pending_documents(self) -> dict:
        regenerated = []
        with db() as conn:
            tasks = conn.execute("SELECT * FROM document_tasks WHERE status = 'pending' ORDER BY created_at").fetchall()
        for task in tasks:
            task = dict(task)
            try:
                if task["task_type"] == "invoice" and task["invoice_id"]:
                    regenerated.append(str(self.regenerate_invoice_docx(int(task["invoice_id"]))))
                elif task["task_type"] == "monthly" and task["year"] and task["month"]:
                    path = combine_monthly_docx(int(task["year"]), int(task["month"]))
                    resolve_document_task("monthly", year=int(task["year"]), month=int(task["month"]))
                    regenerated.append(str(path))
            except PermissionError:
                continue
        self.detect_missing_documents()
        with db() as conn:
            pending = self._document_tasks(conn)
            log_event(conn, f"Actualizar cambios ejecutado. Pendientes: {len(pending)}", "info", "documents", None)
        return {"regenerated": regenerated, "document_tasks": pending}

    def import_clients(self, payload: dict) -> dict:
        rows = parse_csv_text(payload.get("csv") or "")
        imported = 0
        skipped = 0
        with db() as conn:
            for row in rows:
                full_name = (row.get("full_name") or row.get("nombre") or row.get("Nombre") or "").strip()
                tax_id = row.get("tax_id") or row.get("dni") or row.get("DNI") or ""
                if not full_name:
                    skipped += 1
                    continue
                existing = conn.execute(
                    "SELECT id FROM clients WHERE full_name = ? AND IFNULL(tax_id, '') = ? AND deleted_at IS NULL",
                    (full_name, tax_id),
                ).fetchone()
                if existing:
                    skipped += 1
                    continue
                timestamp = now_iso()
                conn.execute(
                    """
                    INSERT INTO clients(full_name, tax_id, address, postal_code, city, email, phone, notes, created_at, updated_at)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        full_name,
                        tax_id,
                        row.get("address") or row.get("direccion") or row.get("Dirección") or "",
                        row.get("postal_code") or row.get("cp") or row.get("CP") or "",
                        row.get("city") or row.get("ciudad") or row.get("Ciudad") or "",
                        row.get("email") or row.get("Email") or "",
                        row.get("phone") or row.get("telefono") or row.get("Teléfono") or "",
                        row.get("notes") or row.get("notas") or "",
                        timestamp,
                        timestamp,
                    ),
                )
                imported += 1
            log_event(conn, f"Importación de clientes: {imported} importados, {skipped} omitidos", "info", "import", None)
            clients = self._clients(conn)
        return {"imported": imported, "skipped": skipped, "clients": clients}

    def export_clients_csv(self) -> bytes:
        with db() as conn:
            rows = self._clients(conn)
        fields = ["full_name", "tax_id", "address", "postal_code", "city", "email", "phone", "notes"]
        return csv_response(rows, fields)

    def export_invoices_csv(self) -> bytes:
        with db() as conn:
            rows = self._invoices(conn)
        fields = ["invoice_number", "issue_date", "client_name", "client_tax_id", "concept", "quantity", "unit_price", "vat_rate", "subtotal", "vat_amount", "total", "payment_method", "created_at"]
        return csv_response(rows, fields)

    def _trash(self, conn: sqlite3.Connection) -> dict:
        clients = conn.execute(
            "SELECT * FROM clients WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
        ).fetchall()
        invoices = conn.execute(
            """
            SELECT invoices.*, clients.full_name AS client_name
            FROM invoices
            JOIN clients ON clients.id = invoices.client_id
            WHERE invoices.deleted_at IS NOT NULL
            ORDER BY invoices.deleted_at DESC
            """
        ).fetchall()
        return {"clients": rows_to_dicts(clients), "invoices": rows_to_dicts(invoices)}

    def _events(self, conn: sqlite3.Connection) -> list[dict]:
        rows = conn.execute(
            "SELECT * FROM app_events ORDER BY created_at DESC, id DESC LIMIT 80"
        ).fetchall()
        return rows_to_dicts(rows)

    def _concept_favorites(self, conn: sqlite3.Connection) -> list[dict]:
        rows = conn.execute(
            "SELECT * FROM concept_favorites ORDER BY text COLLATE NOCASE"
        ).fetchall()
        return rows_to_dicts(rows)

    def _document_tasks(self, conn: sqlite3.Connection) -> list[dict]:
        rows = conn.execute(
            "SELECT * FROM document_tasks WHERE status = 'pending' ORDER BY updated_at DESC"
        ).fetchall()
        return rows_to_dicts(rows)

    def _backups(self) -> list[dict]:
        backups = []
        for path in sorted(BACKUPS_DIR.glob("facturacion_*.db"), key=lambda item: item.stat().st_mtime, reverse=True)[:20]:
            backups.append(
                {
                    "name": path.name,
                    "path": str(path),
                    "size": path.stat().st_size,
                    "updated_at": datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"),
                }
            )
        return backups

    def _clients(self, conn: sqlite3.Connection) -> list[dict]:
        rows = conn.execute("SELECT * FROM clients WHERE deleted_at IS NULL ORDER BY full_name COLLATE NOCASE").fetchall()
        return rows_to_dicts(rows)

    def _invoices(self, conn: sqlite3.Connection) -> list[dict]:
        rows = conn.execute(
            """
            SELECT invoices.*, clients.full_name AS client_name, clients.tax_id AS client_tax_id,
                   clients.address AS client_address, clients.postal_code AS client_postal_code,
                   clients.city AS client_city, clients.email AS client_email, clients.phone AS client_phone
            FROM invoices
            JOIN clients ON clients.id = invoices.client_id
            WHERE invoices.deleted_at IS NULL AND clients.deleted_at IS NULL
            ORDER BY invoices.created_at DESC
            """
        ).fetchall()
        return [self._with_links(dict(row)) for row in rows]

    def _invoice_by_id(self, conn: sqlite3.Connection, invoice_id: int) -> dict:
        row = conn.execute(
            """
            SELECT invoices.*, clients.full_name AS client_name, clients.tax_id AS client_tax_id,
                   clients.address AS client_address, clients.postal_code AS client_postal_code,
                   clients.city AS client_city, clients.email AS client_email, clients.phone AS client_phone
            FROM invoices
            JOIN clients ON clients.id = invoices.client_id
            WHERE invoices.id = ? AND invoices.deleted_at IS NULL AND clients.deleted_at IS NULL
            """,
            (invoice_id,),
        ).fetchone()
        return self._with_links(dict(row))

    def _with_links(self, invoice: dict) -> dict:
        for key in ("docx_path", "pdf_path"):
            value = invoice.get(key)
            if value:
                invoice[key.replace("_path", "_url")] = "/generated/" + Path(value).name
            else:
                invoice[key.replace("_path", "_url")] = None
        return invoice

    def _delete_invoice_files(self, invoice: dict) -> None:
        generated_root = GENERATED_DIR.resolve()
        for key in ("docx_path", "pdf_path"):
            value = invoice.get(key)
            if not value:
                continue
            path = Path(value).resolve()
            if str(path).startswith(str(generated_root)) and path.is_file():
                path.unlink()

    def serve_file(self, path: Path, attachment: bool = False) -> None:
        try:
            resolved = path.resolve()
            allowed_roots = [STATIC_DIR.resolve(), GENERATED_DIR.resolve(), FACTURAS_DIR.resolve()]
            if not any(str(resolved).startswith(str(root)) for root in allowed_roots):
                raise FileNotFoundError
            if not resolved.is_file():
                raise FileNotFoundError
            content_type = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            if attachment:
                quoted_name = urllib.parse.quote(resolved.name)
                self.send_header(
                    "Content-Disposition",
                    f'attachment; filename="{resolved.name}"; filename*=UTF-8\'\'{quoted_name}',
                )
            self.end_headers()
            with resolved.open("rb") as f:
                shutil.copyfileobj(f, self.wfile)
        except FileNotFoundError:
            self.send_error(404, "Archivo no encontrado")

    def send_json(self, payload: dict, status: int = 200) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def send_bytes(self, payload: bytes, content_type: str, filename: str | None = None, attachment: bool = False) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        if attachment and filename:
            quoted_name = urllib.parse.quote(filename)
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{filename}"; filename*=UTF-8\'\'{quoted_name}',
            )
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args) -> None:
        if sys.stderr:
            sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), format % args))


def main() -> None:
    init_db()
    port = int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    if sys.stdout:
        print(f"Facturación lista en http://127.0.0.1:{port}")
        print(f"Base de datos: {DB_PATH}")
    server.serve_forever()


if __name__ == "__main__":
    main()
