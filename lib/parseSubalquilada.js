/**
 * Libro FORMALETA SUBALQUILADA 2026.xlsx
 * Cada hoja = proveedor. Bloques de material con préstamo/salida y devolución/entrada.
 */
"use strict";
const ExcelJS = require("exceljs");

function stripAccents(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function upper(s) {
    return stripAccents(s).toUpperCase().replace(/\s+/g, " ").trim();
}
function numStrict(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const t = String(v).trim();
    if (!/^-?\d+([.,]\d+)?$/.test(t)) return null;
    const n = Number(t.replace(",", "."));
    return Number.isFinite(n) ? n : null;
}
function num(v) { return numStrict(v) || 0; }

function cellVal(row, c) {
    const cell = row.getCell(c);
    if (!cell || cell.value == null || cell.value === "") return "";
    const v = cell.value;
    if (typeof v === "object") {
        if (v instanceof Date && !Number.isNaN(v.getTime())) {
            if (v.getFullYear() < 1950) return v.toISOString().slice(11, 16);
            return v.toISOString().slice(0, 10);
        }
        if (v.result !== undefined && v.result !== null && v.result !== "undefined") {
            if (typeof v.result === "number") return v.result;
            if (v.result instanceof Date) return v.result.toISOString().slice(0, 10);
            return String(v.result);
        }
        if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join("");
        if (v.text) return v.text;
        return "";
    }
    return v;
}

function isDate(s) {
    const t = String(s).trim();
    return /^\d{4}-\d{2}-\d{2}/.test(t)
        || /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(t)
        || /^\d{1,2}-\d{2}\d{4}$/.test(t);
}

function junkTitle(a) {
    return !a
        || isDate(a)
        || /VIENE|OKEY|REPOSICION|CORTE AL|^DEL 20/.test(a);
}

async function parseSubalquiladaXlsx(fp) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fp);
    const movimientos = [];
    const bloques = [];

    for (const ws of wb.worksheets) {
        const proveedor = String(ws.name || "").replace(/\s+/g, " ").trim();
        if (!proveedor || upper(proveedor) === "HOJA1") continue;
        let block = null;
        const maxR = ws.rowCount || 0;
        for (let r = 1; r <= maxR; r++) {
            const row = ws.getRow(r);
            const vals = [];
            for (let c = 1; c <= 8; c++) vals.push(cellVal(row, c));
            const raw0 = vals[0] == null ? "" : String(vals[0]).replace(/\s+/g, " ").trim();
            const a = upper(raw0);
            if (!a && !vals.some(x => x !== "" && x != null)) continue;
            if (a === "FECHA") continue;
            const saldoHits = vals.filter(x => upper(x) === "SALDO").length;
            if (a === "SALDO" || saldoHits >= 3) {
                if (block) {
                    const escrito = numStrict(vals[5]);
                    if (escrito != null) block.saldo_escrito = escrito;
                }
                continue;
            }
            const titleRepeat = a && a === upper(vals[1]) && a.length > 2;
            if (titleRepeat) {
                if (junkTitle(a)) continue;
                if (block) bloques.push(block);
                block = { proveedor, material: raw0, movs: [], saldo_escrito: null };
                continue;
            }
            const salida = num(vals[3]);
            const entrada = num(vals[4]);
            const remito = String(vals[2] ?? "").trim();
            const isMov = isDate(raw0) || ((salida || entrada) && /^\d{3,}/.test(remito.replace(/\*/g, "")));
            if (!isMov || !block) continue;
            if (/ANULADA/.test(upper(vals[6]))) continue;
            if (!salida && !entrada) continue;
            block.movs.push({
                fecha: isDate(raw0) ? raw0 : "",
                hora: vals[1] == null ? "" : String(vals[1]).trim(),
                remito,
                salida,
                entrada,
                cliente_ref: vals[6] == null ? "" : String(vals[6]).replace(/\s+/g, " ").trim(),
                notas: vals[7] == null ? "" : String(vals[7]).replace(/\s+/g, " ").trim()
            });
        }
        if (block) bloques.push(block);
    }

    for (const b of bloques) {
        const computed = b.movs.reduce((s, m) => s + m.salida - m.entrada, 0);
        const saldo = b.saldo_escrito != null ? b.saldo_escrito : computed;
        b.saldo = saldo;
        for (const m of b.movs) {
            if (m.salida) {
                movimientos.push({
                    proveedor: b.proveedor,
                    material: b.material,
                    fecha: m.fecha,
                    hora: m.hora,
                    remito: m.remito,
                    cantidad: m.salida,
                    cliente_ref: m.cliente_ref,
                    notas: m.notas
                });
            }
            if (m.entrada) {
                movimientos.push({
                    proveedor: b.proveedor,
                    material: b.material,
                    fecha: m.fecha,
                    hora: m.hora,
                    remito: m.remito,
                    cantidad: -m.entrada,
                    cliente_ref: m.cliente_ref,
                    notas: m.notas
                });
            }
        }
    }

    const saldos = bloques
        .filter(b => b.movs.length || (b.saldo != null && b.saldo !== 0))
        .map(b => ({
            proveedor: b.proveedor,
            material: b.material,
            saldo: b.saldo,
            movimientos_n: b.movs.length
        }));

    return { bloques, movimientos, saldos };
}

module.exports = { parseSubalquiladaXlsx };
