/**
 * Parser 2026: CSV crudos de Equioriente_Data → data/canon/
 *
 *   node build_canon_2026.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { parseCsv, writeCsv } = require("./lib/csvUtil");

const ROOT = path.join(__dirname, "Equioriente_Data");
const OUT = path.join(__dirname, "data", "canon");

const MESES = {
    ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6,
    JULIO: 7, AGOSTO: 8, SEPTIEMBRE: 9, OCTUBRE: 10, NOVIEMBRE: 11, DICIEMBRE: 12
};

const SKIP_NAMES = /^(HORA|HORAS|TRANSPORTE|TRANSORTE|MATERIAL|SALDO|P\.?M\.?|A\.?M\.?|DETALLES|COSTOS|DIAS|CANTIDAD|VALOR|RECOGIDA|PLACA)$/i;
const SKIP_MATERIAL = /TOTAL MATERIAL|MATERIAL NO ENTREGADO|TOTAL A PAGAR|MATERIAL A DAÑADO|MATERIAL ADAÑADO|A LA FECHA|VALOR DIA|SUB-?TOTAL|LLEVADA Y|TOTAL DIAS|TOTAL DIARIO|VALOR DIARIO|PESO MATERIAL|IVA\s*19|A DEVOLVER|^PERIODO$/i;
const NOTE_ROW = /ABONO|CANCELO|CANCELADO|NEQUI|DEPOSITO|VALOR DIA|TOTAL/;
const SKIP_INV = /VALOR TOTAL|AVALUO|^TOTAL MATERIAL$|INVENTARIO MATERIAL/;

function stripAccents(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function upper(s) { return stripAccents(s).toUpperCase().replace(/\s+/g, " ").trim(); }

function cell(rows, r, c) {
    if (r < 0 || r >= rows.length) return "";
    const v = rows[r][c];
    return v == null ? "" : String(v).replace(/\s+/g, " ").trim();
}
function rowHas(rows, r) {
    return rows[r] && rows[r].some(x => String(x || "").trim() !== "");
}

function parseNum(s) {
    if (s == null || s === "") return null;
    if (typeof s === "number") return Number.isFinite(s) ? s : null;
    const t = String(s).trim();
    if (!t) return null;
    if (/[A-Za-z]/.test(t) && !/^-?\d/.test(t)) return null;
    let n;
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) n = Number(t.replace(/\./g, "").replace(",", "."));
    else if (/^-?\d+,\d+$/.test(t)) n = Number(t.replace(",", "."));
    else n = Number(t.replace(/[$\s]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
}

function parseDate(s) {
    if (!s) return null;
    const t = String(s).trim();
    const m = t.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const d = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (d) return `${d[3]}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}`;
    return null;
}

function parseTime(s) {
    if (s == null || s === "") return null;
    const t = String(s).trim();
    if (/^(AM|PM|A\.?M\.?|P\.?M\.?)$/i.test(t)) return null;
    const hm = t.match(/^(\d{1,2})[:.](\d{2})/);
    if (hm) {
        const h = Number(hm[1]), m = Number(hm[2]);
        if (h >= 0 && h < 24 && m >= 0 && m < 60) {
            return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
        }
    }
    const n = parseNum(t);
    if (n != null && n > 0 && n < 1) {
        const totalMin = Math.round(n * 24 * 60);
        const h = Math.floor(totalMin / 60) % 24;
        const m = totalMin % 60;
        return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
    }
    return null;
}

function looksMerged(rows, r, maxC) {
    const first = cell(rows, r, 0);
    if (!first) return false;
    let same = 0, filled = 0;
    for (let c = 0; c < Math.min(maxC, 8); c++) {
        const t = cell(rows, r, c);
        if (t) { filled++; if (t === first) same++; }
    }
    return filled >= 3 && same === filled;
}

function extractPhone(s) {
    const m = String(s || "").replace(/\s/g, "").match(/(\d{7,12})/);
    return m ? m[1] : null;
}
function extractMoney(s) {
    const t = String(s || "").replace(/\./g, "").replace(/,/g, "");
    const m = t.match(/(\d{4,12})/);
    return m ? Number(m[1]) : null;
}

function periodFromPath(rel) {
    const u = upper(rel);
    let year = null, month = null;
    const y = u.match(/\b(20\d{2})\b/);
    if (y) year = Number(y[1]);
    for (const [name, num] of Object.entries(MESES)) {
        if (u.includes(name)) { month = num; break; }
    }
    return {
        year: year || 0,
        month: month || 0,
        key: `${year || 0}-${String(month || 0).padStart(2, "0")}`
    };
}

function fileTipo(rel) {
    const n = upper(path.basename(rel));
    if (n.includes("SEGUIMIENTO")) return "seguimiento";
    if (n.includes("NO FISCAL") || n.includes("NI FISCAL") || n.includes("ALQUIER NO")) return "no_fiscal";
    if (n.includes("FISCAL")) return "fiscal";
    return "seguimiento";
}

function walkFiles(dir, acc = []) {
    if (!fs.existsSync(dir)) return acc;
    for (const name of fs.readdirSync(dir)) {
        if (name.startsWith("~$") || name === "System Volume Information" || name === "desktop.ini") continue;
        const full = path.join(dir, name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.isDirectory()) walkFiles(full, acc);
        else acc.push(full);
    }
    return acc;
}

const ALIAS = {
    "YAZMIN PACHECO": "JAZMIN PACHECO",
    "LUDWIN ANGULO": "LUDWING ANGULO",
    "LUWING ANGULO": "LUDWING ANGULO",
    "LUDWIN ANDGULO": "LUDWING ANGULO",
    "ANDREI": "ANDREI CADENA",
    "CESAR AUGUSTO": "CESAR AUGUSTO MIRADORES",
    "CICOM INGENIERIA": "CICOM INGENIEROS",
    "CICOM INGENIEROS KARIME": "CICOM INGENIEROS",
    "CICOM KARIME": "CICOM INGENIEROS",
    "CONSORCIO LA VICTORIA 2": "CONSORCIO LA VICTORIA",
    "LUZ MARINA DUARTE": "LUZ MARINA PEREZ",
    "LUZ MARINA": "LUZ MARINA PEREZ",
    "GUSTAVO ADOLFO": "GUSTAVO ADOLFO RUBIO",
    "TEJIDO": "TEJIDO ARQUITECTONICO",
    "DIEGO GUTIERRREZ": "DIEGO GUTIERREZ",
    "BIOCOMBUSTIBLE": "BIOCOMBUSTIBLES",
    "ALFONSO GARCIAJHON": "ALFONSO GARCIA",
    "ALFONSO GARCIA MAESTRO JHON": "ALFONSO GARCIA",
    "SERGIO MIRADORES": "SERGIO",
    "SERGIO LUIS": "SERGIO",
    "SERGIO LUIS MARTIN FORERO": "SERGIO",
    "ANGELIKA": "ANGELICA",
    "ANGELICA CONCORDIA": "ANGELICA",
    "EDISON MEDINA DELGADO": "EDINSON CARRILLO",
    "EDINSON CARIILLO": "EDINSON CARRILLO",
    "EDINSON MEDINA": "EDINSON CARRILLO"
};

function normClientName(s) {
    let t = upper(s);
    t = t.replace(/JIMMY JAIMES\s*:?\s*[\d,.]*/g, " ");
    t = t.split(":")[0];
    t = t.replace(/\d{7,}/g, " ");
    t = t.replace(/\.+$/g, "");
    t = t.replace(/-\d+$/g, "");
    t = t.replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    if (ALIAS[t]) return ALIAS[t];
    return t;
}

function clientFromFilename(fp) {
    const base = path.basename(fp, ".csv");
    const m = base.match(/__(.+)$/);
    const raw = (m ? m[1] : base).replace(/-\d+$/, "").trim();
    return normClientName(raw);
}

function isOpCsv(rel) {
    const u = upper(rel);
    if (!u.endsWith(".CSV")) return null;
    if (u.includes("COPIA DE ") || path.basename(rel).startsWith("~$")) return null;
    if (u.includes("CONSORCIO SEGUIMIENTO FEBRERO 2026") && u.includes("SEGUIMIENTO CONSORCIO")) {
        return { period: "2026-02", tipo: "seguimiento" };
    }
    const inAlq = /ALQUILER\s+2026/.test(u) || /SEPTIEMBRE 2026/.test(u);
    if (!inAlq) return null;
    const p = periodFromPath(rel);
    if (p.year !== 2026) return null;
    if (p.month < 5 || p.month > 9) return null;
    const tipo = fileTipo(rel);
    if (!tipo) return null;
    return { period: p.key, tipo };
}

const OPERACION_PERIODOS = new Set(["2026-02", "2026-05", "2026-06", "2026-07", "2026-09"]);

function isDebtHeader(text) {
    const a = upper(text);
    return /MATERIAL NO ENTREGADO|ADEUDADO|TOTAL MATERIAL|TOTAL A PAGAR|PREFACTURA|VALOR TOTAL/.test(a);
}

function monthNameFromYm(ym) {
    const n = Number(String(ym || "").slice(5, 7));
    return Object.keys(MESES).find(k => MESES[k] === n) || "";
}

function remitoPertenecePeriodo(fecha, periodo) {
    if (!fecha || String(fecha).length < 7 || !periodo) return true;
    const fym = String(fecha).slice(0, 7);
    if (fym === periodo) return true;
    if (fym < periodo && OPERACION_PERIODOS.has(fym)) return false;
    if (fym > periodo) return false;
    return true;
}

function parseClientSheet(rows, meta) {
    const maxR = Math.min(rows.length, 400);
    const maxC = rows.reduce((m, r) => Math.max(m, r.length), 0);
    if (maxR < 3) return null;

    const titles = [];
    for (let r = 0; r < Math.min(6, maxR); r++) {
        const t = cell(rows, r, 0);
        if (t) titles.push(t);
    }

    let cliente = meta.clienteArchivo || titles[0] || "SIN NOMBRE";
    if (/^JIMMY JAIMES|^EQUIORIENTE/.test(upper(cliente))) {
        const alt = titles.find(t => t && !/^JIMMY|^EQUIORIENTE|CRA|CALLE|MOVIMIENTO|MATERIAL/i.test(upper(t)));
        if (alt) cliente = alt.split(":")[0].trim();
        else if (meta.clienteArchivo) cliente = meta.clienteArchivo;
    }
    cliente = normClientName(cliente);
    if (!cliente || cliente.length < 2) cliente = meta.clienteArchivo || "SIN NOMBRE";

    let direccion = "";
    let telefono = extractPhone(titles.join(" "));
    const second = titles[1] || "";
    if (second && upper(second) !== upper(titles[0]) && !/MOVIMIENTO|MATERIAL|SALDO/i.test(second)) {
        direccion = second.replace(/TEL:?\s*\d+/i, "").trim();
        telefono = telefono || extractPhone(second);
    }
    for (let r = 0; r < Math.min(30, maxR); r++) {
        const t = cell(rows, r, 0);
        const u = upper(t);
        if (/TEL:?/i.test(t)) telefono = telefono || extractPhone(t);
        if (/CRA|CALLE|CARRERA|AV\.|AVENIDA|BARRIO|VEREDA|#\d|CONJUNTO|EDIFICIO|TRANSICION|INDEPENDENCIA|COMUNEROS/i.test(t)
            && !/MOVIMIENTO|MATERIAL/i.test(u)) {
            if (!direccion || direccion.length < 8) direccion = t.replace(/TEL:?\s*\d+/i, "").trim();
            telefono = telefono || extractPhone(t);
        }
        const phoneLine = t.match(/^([A-ZÁÉÍÓÚÑ ]{3,}):\s*(\d{7,12})$/i);
        if (phoneLine) {
            telefono = telefono || phoneLine[2];
            if (/^JIMMY|^EQUIORIENTE/.test(upper(cliente))) cliente = normClientName(phoneLine[1]);
        }
    }

    const blocks = [];
    for (let r = 0; r < maxR; r++) {
        const a = upper(cell(rows, r, 0));
        if (isDebtHeader(a) || isDebtHeader([0, 1, 2, 3].map(c => cell(rows, r, c)).join(" "))) continue;
        const headerVals = [];
        for (let c = 0; c < maxC; c++) headerVals.push({ c, t: cell(rows, r, c), n: parseNum(cell(rows, r, c)) });
        const hasRemito = headerVals.some(h => h.n && h.n >= 10000 && h.n <= 19999);
        const hasSaldo = headerVals.some(h => upper(h.t) === "SALDO" || upper(h.t).includes("SALDO"));
        const nextHasDate = headerVals.some(h => parseDate(cell(rows, r + 1, h.c)));
        const next = [0, 1, 2, 3, 4, 5].map(c => upper(cell(rows, r + 1, c))).join(" ");
        const here = headerVals.map(h => upper(h.t)).join(" ");
        const hasBilling = (/DIAS/.test(here) || /CANTIDAD/.test(here) ||
            (next.includes("DIAS") && next.includes("CANTIDAD"))) && !hasRemito;
        const isMaterial = a === "MATERIAL" || a.startsWith("MATERIAL");
        if ((hasRemito || hasSaldo) && (isMaterial || nextHasDate || hasSaldo)) {
            if (!blocks.some(b => b.type === "mov" && b.headerRow === r))
                blocks.push({ type: "mov", headerRow: r });
        }
        if (hasBilling && isMaterial && !hasRemito && !blocks.some(b => b.type === "cobro" && Math.abs(b.headerRow - r) <= 1))
            blocks.push({ type: "cobro", headerRow: r });
        if (upper(cell(rows, r, 1)) === "DIAS" && /CANTIDAD/.test(upper(cell(rows, r, 2)))) {
            if (!isDebtHeader(a) && !blocks.some(b => b.type === "cobro" && Math.abs(b.headerRow - r) <= 1))
                blocks.push({ type: "cobro", headerRow: r > 0 ? r - 1 : r });
        }
    }

    const remitos = [];
    const saldoByMat = new Map();
    const cobros = [];
    const pagos = [];
    const notas = [];
    let transporteTotal = 0;
    const revision = [];

    function addRemito(numero, fecha) {
        if (!numero) return null;
        if (!remitoPertenecePeriodo(fecha, meta.periodo)) return null;
        let rem = remitos.find(x => x.numero === numero);
        if (!rem) {
            rem = { numero, fecha: fecha || null, items: [], hora: null, transporte: 0, placa: null };
            remitos.push(rem);
        } else if (!rem.fecha && fecha) rem.fecha = fecha;
        return rem;
    }

    for (const block of blocks.filter(b => b.type === "mov")) {
        const hr = block.headerRow;
        const dateRow = hr + 1;
        const cols = [];
        for (let c = 1; c < maxC; c++) {
            const ht = cell(rows, hr, c);
            if (!ht) continue;
            const hu = upper(ht);
            if (hu.startsWith("MOVIMIENTO")) break;
            if ((hu === "MATERIAL" || hu.startsWith("MATERIAL ")) && cols.length) break;
            if (isDebtHeader(ht)) break;
            const hn = parseNum(ht);
            let kind = "other";
            let remito = null;
            if (hn && hn >= 10000 && hn <= 19999) { kind = "remito"; remito = String(Math.round(hn)); }
            else if (hu === "SALDO" || hu.includes("SALDO") || hu.includes("MATERIAL EN OBRA")) kind = "saldo";
            else if (hu.includes("RECOGIDA") || hu.includes("RECOGIDO")) kind = "recogida";
            const fecha = parseDate(cell(rows, dateRow, c)) || parseDate(ht);
            const prev = cols[cols.length - 1];
            if (prev && prev.kind === "remito" && prev.remito === remito && prev.fecha === fecha && kind === "remito") {
                prev.cs.push(c);
                continue;
            }
            cols.push({ c, cs: [c], kind, remito, fecha, header: ht });
        }
        const saldoCols = cols.filter(x => x.kind === "saldo");
        const saldoCol = saldoCols.length ? saldoCols[saldoCols.length - 1] : null;
        const remitoCols = cols.filter(x => x.kind === "remito");
        for (const rc of remitoCols) addRemito(rc.remito, rc.fecha);

        const qtyAt = (r, col) => {
            for (const c of col.cs) {
                const n = parseNum(cell(rows, r, c));
                if (n != null && n !== 0) return n;
            }
            return null;
        };

        for (let r = dateRow + 1; r < maxR; r++) {
            const name = cell(rows, r, 0);
            if (!name) {
                if (looksMerged(rows, r, 6) && r > hr + 8) break;
                continue;
            }
            const un = upper(name);
            if (un === "MATERIAL" || un.startsWith("MATERIAL") || un === "DETALLES" || isDebtHeader(un) || /^JIMMY/.test(un)) break;
            if (/^HORA/.test(un)) {
                for (const rc of remitoCols) {
                    const t = parseTime(cell(rows, r, rc.c));
                    const rem = remitos.find(x => x.numero === rc.remito);
                    if (rem && t) rem.hora = t;
                }
                continue;
            }
            if (/TRANSPORTE|TRANSORTE/.test(un)) {
                for (const rc of remitoCols) {
                    const raw = cell(rows, r, rc.c);
                    const rem = remitos.find(x => x.numero === rc.remito);
                    const n = parseNum(raw);
                    if (n != null && n > 100 && n < 5e6) {
                        if (rem) rem.transporte = n;
                    } else if (/[A-Z]{2,3}-?\d|\b[A-Z]{3}\d{3}\b/i.test(raw)) {
                        if (rem) rem.placa = raw;
                    }
                }
                continue;
            }
            if (NOTE_ROW.test(un) && !/MARCOS|PARAL|FORMALETA|TABLERO|CERCHA|CHAPETA|ANDAMIO/.test(un)) {
                notas.push(name);
                const mon = extractMoney(name);
                if (mon && /ABONO|CANCELO|CANCELADO|DEPOSITO/.test(un)) {
                    pagos.push({ detalle: name, monto: mon, fecha: remitoCols[0] && remitoCols[0].fecha, medio: /NEQUI/.test(un) ? "NEQUI" : "" });
                }
                continue;
            }
            if (SKIP_NAMES.test(un) || SKIP_MATERIAL.test(un) || looksMerged(rows, r, Math.min(maxC, 8))) {
                if (looksMerged(rows, r, 8) && r > hr + 8) break;
                continue;
            }

            const qtyByCol = {};
            for (const col of cols) {
                const n = qtyAt(r, col);
                if (n != null) qtyByCol[col.c] = n;
            }
            let saldo = null;
            const saldoInicialCol = saldoCols[0];
            if (saldoCols.length >= 2 && qtyByCol[saldoCol.c] != null) {
                saldo = qtyByCol[saldoCol.c];
            } else if (saldoInicialCol) {
                const ini = qtyByCol[saldoInicialCol.c] || 0;
                let delta = 0;
                for (const rc of remitoCols) {
                    const q = qtyByCol[rc.c] || 0;
                    if (!q) continue;
                    const f = rc.fecha || "";
                    const ym = f.slice(0, 7);
                    if (meta.periodo && f && ym !== meta.periodo && ym.length === 7) continue;
                    delta += q;
                }
                saldo = ini + delta;
            } else if (saldoCol && qtyByCol[saldoCol.c] != null) {
                saldo = qtyByCol[saldoCol.c];
            }

            for (const rc of remitoCols) {
                const q = qtyByCol[rc.c];
                if (q == null || q === 0) continue;
                if (Math.abs(q) >= 20000) {
                    revision.push(`cantidad absurda ${q} en ${name} remito ${rc.remito}`);
                    continue;
                }
                const rem = remitos.find(x => x.numero === rc.remito);
                if (rem) rem.items.push({ material: name, cantidad: q });
            }
            if (saldo != null && Math.abs(saldo) < 20000) {
                saldoByMat.set(upper(name), { material: name, cantidad: saldo });
            }
        }
    }

    for (const block of blocks.filter(b => b.type === "cobro")) {
        const headTxt = [0, 1, 2, 3, 4].map(c => upper(cell(rows, block.headerRow, c))).join(" ");
        if (isDebtHeader(headTxt)) continue;
        const startLen = cobros.length;
        let hr = block.headerRow;
        for (let r = block.headerRow; r <= Math.min(block.headerRow + 3, maxR - 1); r++) {
            const rowTxt = [0, 1, 2, 3, 4, 5].map(c => upper(cell(rows, r, c))).join(" ");
            if (rowTxt.includes("DIAS") && rowTxt.includes("CANTIDAD")) { hr = r; break; }
        }
        for (let r = hr + 1; r < Math.min(hr + 90, maxR); r++) {
            const name = cell(rows, r, 0);
            const un = upper(name);
            const rowTxt = [0, 1, 2, 3, 4, 5].map(c => upper(cell(rows, r, c))).join(" ");
            if (/DEPOSITO|ABONO|CANCELO/.test(rowTxt)) {
                const mon = [1, 2, 3, 4, 5].map(c => parseNum(cell(rows, r, c))).find(n => n && Math.abs(n) >= 1000);
                const det = name || rowTxt;
                if (mon && !pagos.some(p => p.detalle === det && p.monto === mon)) {
                    pagos.push({ detalle: det, monto: mon, fecha: null, medio: /NEQUI/.test(rowTxt) ? "NEQUI" : "" });
                }
                continue;
            }
            if (!name) {
                if (/LLEVADA|TRAIDA|RECOGIDA|TRANSPORTE/.test(rowTxt)) {
                    const mon = [2, 3, 4, 5].map(c => parseNum(cell(rows, r, c))).find(n => n && n > 100 && n < 5e6);
                    if (mon) transporteTotal += mon;
                }
                if (looksMerged(rows, r, 6) && r > hr + 4) break;
                continue;
            }
            if (isDebtHeader(un) || isDebtHeader(rowTxt)) break;
            if (/JIMMY|EQUIORIENTE/.test(un) && r > hr + 2) break;
            if (/TOTAL DIAS|LLEVADA Y|TRAIDA|IVA\s*19|PESO MATERIAL|SUB-?TOTAL|TOTAL DIARIO|VALOR IVA|VALOR DIAS|VALOR\s+TOTAL/.test(rowTxt)) {
                if (/LLEVADA|TRAIDA/.test(rowTxt)) {
                    const mon = [2, 3, 4, 5].map(c => parseNum(cell(rows, r, c))).find(n => n && n > 100 && n < 5e6);
                    if (mon) transporteTotal += mon;
                }
                continue;
            }
            if (/^(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\b/.test(un)
                && !/MARCOS|PARAL|FORMALETA|TABLERO|CERCHA|CHAPETA|ANDAMIO/.test(un)) {
                const fileM = monthNameFromYm(meta.periodo);
                if (fileM && !un.includes(fileM)) cobros.length = startLen;
                break;
            }
            if (looksMerged(rows, r, 6) && r > hr + 2) break;
            if (SKIP_NAMES.test(un) || SKIP_MATERIAL.test(un)) {
                if (/LLEVADA|TRAIDA/.test(un)) {
                    const mon = [2, 3, 4, 5].map(c => parseNum(cell(rows, r, c))).find(n => n && n > 100 && n < 5e6);
                    if (mon) transporteTotal += mon;
                }
                continue;
            }
            const cantRaw = upper(cell(rows, r, 2));
            if (/REPOSICION|FALTANTE|NO ENTREG|ADEUDADO/.test(cantRaw) || /REPOSICION/.test(un)) continue;
            if (/^\d+\s/.test(un) && !parseNum(cell(rows, r, 1))) continue;
            const dias = parseNum(cell(rows, r, 1));
            const cant = parseNum(cell(rows, r, 2));
            const valor = parseNum(cell(rows, r, 3));
            const diario = parseNum(cell(rows, r, 4));
            const precio = parseNum(cell(rows, r, 5));
            const periodoTexto = cell(rows, r, 6) || "";
            if (cant == null && valor == null && precio == null) continue;
            const fileM = monthNameFromYm(meta.periodo);
            const perU = upper(periodoTexto);
            if (fileM && perU && /ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE/.test(perU)
                && !perU.includes(fileM)) continue;
            const total = (precio && precio > 0 && precio < 5e6) ? precio : ((dias || 1) * (cant || 0) * (valor || 0));
            if (Math.abs(cant || 0) >= 20000 || total > 5e6) {
                revision.push(`cobro fuera de rango en ${name}`);
                continue;
            }
            if (!total && !cant) continue;
            cobros.push({
                material: name,
                dias: (dias && dias > 0 && dias < 400) ? dias : 1,
                cantidad: (cant && Math.abs(cant) < 20000) ? cant : 0,
                valor_unitario: (valor && valor < 1e7) ? valor : 0,
                costo_diario: diario || 0,
                total: total && total < 5e6 ? total : 0,
                periodo_texto: periodoTexto
            });
        }
    }

    for (let r = 0; r < maxR; r++) {
        const t = cell(rows, r, 0);
        if (t && /ABONO|CANCELO|CANCELADO/.test(upper(t)) && !pagos.some(p => p.detalle === t)) {
            const mon = extractMoney(t);
            if (mon) pagos.push({ detalle: t, monto: mon, fecha: null, medio: /NEQUI/.test(upper(t)) ? "NEQUI" : "" });
            else notas.push(t);
        }
    }

    if (!transporteTotal) {
        transporteTotal = remitos.reduce((s, r) => s + (Number(r.transporte) || 0), 0);
    }

    const saldoItems = [...saldoByMat.values()].filter(s => Number(s.cantidad) !== 0);

    if (!cliente || cliente.length < 3) revision.push("nombre de cliente corto o vacio");
    if (/^(JIMMY|EQUIORIENTE)\b/.test(upper(cliente))) revision.push("cliente parece ser Equioriente/Jimmy");
    if (!remitos.length && !cobros.length && !saldoItems.length) revision.push("sin remitos, cobros ni saldos");

    return {
        cliente,
        direccion,
        telefono,
        obra: direccion || cliente,
        remitos,
        saldoItems,
        cobros,
        pagos,
        transporteTotal,
        notas: [...new Set(notas)].join(" | "),
        revision
    };
}

function parseInventoryCsv(fp) {
    const rows = parseCsv(fs.readFileSync(fp, "utf8"));
    const out = [];
    let header = -1;
    for (let r = 0; r < Math.min(8, rows.length); r++) {
        if (upper(cell(rows, r, 0)) === "MATERIAL") { header = r; break; }
    }
    let totalCol = 4;
    let valorCol = 5;
    if (header >= 0) {
        for (let c = 0; c < (rows[header] || []).length; c++) {
            const u = upper(cell(rows, header, c));
            if (u === "TOTAL MATERIAL" || (/\bTOTAL\b/.test(u) && !/VALOR|AVALUO/.test(u))) totalCol = c;
            if (u === "VALOR UNITARIO") valorCol = c;
        }
    }
    const start = header >= 0 ? header + 1 : 3;
    for (let r = start; r < rows.length; r++) {
        const nombre = cell(rows, r, 0);
        if (!nombre) continue;
        if (SKIP_INV.test(upper(nombre)) || /CAMION JAC|^AVALUO/.test(upper(nombre))) continue;
        const total = parseNum(cell(rows, r, totalCol));
        if (total == null) continue;
        out.push({
            nombre,
            total,
            valor_unitario: parseNum(cell(rows, r, valorCol)) || 0
        });
    }
    return out;
}

function parsePreciosCsv(fp) {
    const rows = parseCsv(fs.readFileSync(fp, "utf8"));
    const out = [];
    for (let r = 0; r < rows.length; r++) {
        const nombre = cell(rows, r, 0);
        if (!nombre || /LISTA DE PRECIOS|MATERIAL/.test(upper(nombre))) continue;
        const precio = parseNum(cell(rows, r, 1));
        if (precio == null) continue;
        const minTxt = cell(rows, r, 2);
        const min = Number((String(minTxt).match(/\d+/) || [1])[0]);
        out.push({ nombre, precio_dia: precio, dias_minimos: min || 1 });
    }
    return out;
}

function parseFlujoCsv(fp, sheetName) {
    const rows = parseCsv(fs.readFileSync(fp, "utf8"));
    const p = periodFromPath(sheetName + " " + path.basename(fp));
    const out = [];
    let modo = /EGRESO|GASTO/.test(upper(sheetName)) ? "egreso" : "ingreso";
    let lastFecha = null;
    for (let r = 0; r < rows.length; r++) {
        const a = cell(rows, r, 0);
        const b = cell(rows, r, 1);
        const c2 = cell(rows, r, 2);
        const c3 = cell(rows, r, 3);
        const rowTxt = upper([a, b, c2].join(" "));
        if (/EGRESOS|GASTOS/.test(rowTxt) && !/INGRESOS/.test(rowTxt)) { modo = "egreso"; continue; }
        if (/^INGRESOS$/.test(rowTxt.trim()) || rowTxt.startsWith("INGRESOS ")) { modo = "ingreso"; continue; }
        if (/FECHA|DETALLE|SALDO EN CAJA|^VALOR$/.test(upper(a)) && !b) continue;
        const fecha = parseDate(a);
        if (fecha) lastFecha = fecha;
        const detalle = b || (!fecha && a ? a : "");
        if (!detalle || /INGRESOS|EGRESOS|SALDO EN CAJA|FECHA/.test(upper(detalle))) continue;
        if (/^\d{4} 1 AL \d+/.test(upper(detalle))) continue;
        let valor = parseNum(c2);
        let medio = c3 || "";
        if (valor == null && parseNum(c3) != null) {
            valor = parseNum(c3);
            medio = c2;
        }
        if (valor == null || valor === 0) continue;
        if (!b && !fecha && Math.abs(valor) > 1000) continue;
        let tipo = modo;
        if (/RETIRO|SACAD/.test(upper(detalle))) tipo = "traslado";
        if (/NEQUI/i.test(medio)) medio = "NEQUI";
        out.push({
            fecha: lastFecha,
            detalle,
            valor,
            tipo,
            medio: medio || "",
            mes: p.month || null,
            anio: 2026
        });
    }
    return out;
}

function obrasCompatibles(a, b, unico) {
    if (unico) return true;
    const ua = upper(a || ""), ub = upper(b || "");
    if (!ua || !ub) return true;
    if (ua === ub) return true;
    return ua.includes(ub) || ub.includes(ua);
}

function sameCuenta(row, cuenta) {
    return upper(row.cliente) === upper(cuenta.cliente)
        && row.tipo === cuenta.tipo
        && upper(row.obra || "") === upper(cuenta.obra || "");
}

function namesCompatibles(a, b) {
    const ua = upper(a), ub = upper(b);
    if (!ua || !ub) return false;
    if (ua === ub) return true;
    if (ua.includes(ub) || ub.includes(ua)) return true;
    const ta = ua.split(" ").filter(Boolean);
    const tb = ub.split(" ").filter(Boolean);
    if (ta[0] && ta[0] === tb[0] && ta[0].length >= 5 && ta[1] && tb[1]) {
        return ta[1].includes(tb[1]) || tb[1].includes(ta[1]);
    }
    return false;
}

function pickSegForDetail(d, segs) {
    const sameName = segs.filter(s => upper(s.cliente) === upper(d.cliente));
    const unico = sameName.length === 1;
    let mates = sameName.filter(s => obrasCompatibles(s.obra, d.obra, unico));
    if (mates.length > 1) {
        const exact = mates.filter(s => upper(s.obra || "") === upper(d.obra || ""));
        if (exact.length) mates = exact;
    }
    if (mates.length === 1) return mates[0];
    if (unico && mates.length) return mates[0];
    const fuzzy = segs.filter(s =>
        namesCompatibles(s.cliente, d.cliente) && obrasCompatibles(s.obra, d.obra, false)
    );
    if (fuzzy.length === 1) return fuzzy[0];
    return null;
}

/** Desde junio: seguimiento es la cuenta; fiscal/no fiscal solo aportan cobros y huecos. */
function mergeDesdeSeguimiento(ym, b) {
    if (ym < "2026-06") return;
    const segs = b.cuentas.filter(c => c.tipo === "seguimiento");
    const dets = b.cuentas.filter(c => c.tipo !== "seguimiento");
    const bind = [];
    for (const d of dets) {
        const seg = pickSegForDetail(d, segs);
        if (!seg) continue;
        d._bound = true;
        bind.push({ from: d, to: seg });
    }
    const newCuentas = [];
    for (const seg of segs) {
        const mates = bind.filter(x => x.to === seg).map(x => x.from);
        const tipoDoc = mates.some(m => m.tipo === "fiscal") ? "fiscal"
            : mates.some(m => m.tipo === "no_fiscal") ? "no_fiscal"
            : "seguimiento";
        const transSeg = Number(seg.transporte) || 0;
        const transDet = mates.reduce((s, m) => s + (Number(m.transporte) || 0), 0);
        newCuentas.push({
            cliente: seg.cliente,
            obra: seg.obra,
            tipo: "seguimiento",
            tipo_documento: tipoDoc,
            telefono: seg.telefono || (mates.find(m => m.telefono) || {}).telefono || "",
            direccion: seg.direccion || "",
            fuente: seg.fuente,
            hoja: seg.hoja,
            notas: [seg.notas, ...mates.map(m => m.notas)].filter(Boolean).join(" | "),
            transporte: transSeg || transDet,
            fuente_detalle: mates.map(m => m.fuente).join(" | ")
        });
    }
    for (const d of dets.filter(d => !d._bound)) {
        newCuentas.push({ ...d, tipo_documento: d.tipo, fuente_detalle: "" });
    }

    const remitos = [];
    const movimientos = [];
    const saldos = [];
    const cobros = [];
    const pagos = [];

    for (const cuenta of newCuentas) {
        const baseOrig = b.cuentas.find(c =>
            upper(c.cliente) === upper(cuenta.cliente)
            && c.tipo === "seguimiento"
            && upper(c.obra || "") === upper(cuenta.obra || "")
        );
        const details = bind
            .filter(x => upper(x.to.cliente) === upper(cuenta.cliente) && upper(x.to.obra || "") === upper(cuenta.obra || ""))
            .map(x => x.from);
        const orphan = !baseOrig;

        const remMap = new Map();
        const takeRem = (r) => {
            const k = String(r.numero);
            if (remMap.has(k)) {
                const cur = remMap.get(k);
                if (!cur.hora && r.hora) cur.hora = r.hora;
                if (!cur.placa && r.placa) cur.placa = r.placa;
                if (!(Number(cur.transporte) > 0) && Number(r.transporte) > 0) cur.transporte = r.transporte;
                return;
            }
            remMap.set(k, {
                ...r,
                cliente: cuenta.cliente,
                obra: cuenta.obra,
                tipo: orphan ? cuenta.tipo : "seguimiento"
            });
        };
        const sources = orphan ? [{ cliente: cuenta.cliente, tipo: cuenta.tipo, obra: cuenta.obra }] : [baseOrig, ...details];
        for (const src of sources) {
            for (const r of b.remitos.filter(r => sameCuenta(r, src))) takeRem(r);
        }
        remitos.push(...remMap.values());

        const movSeen = new Set();
        for (const src of sources) {
            for (const m of b.movimientos.filter(m => upper(m.cliente) === upper(cuenta.cliente) && m.tipo === src.tipo)) {
                if (!remMap.has(String(m.remito))) continue;
                const key = `${m.remito}|${upper(m.material)}|${m.cantidad}`;
                if (movSeen.has(key)) continue;
                movSeen.add(key);
                movimientos.push({
                    ...m,
                    cliente: cuenta.cliente,
                    tipo: orphan ? cuenta.tipo : "seguimiento"
                });
            }
        }

        const salSrc = orphan ? { cliente: cuenta.cliente, tipo: cuenta.tipo, obra: cuenta.obra } : baseOrig;
        if (salSrc) {
            for (const s of b.saldos.filter(s => sameCuenta(s, salSrc))) {
                saldos.push({
                    ...s,
                    cliente: cuenta.cliente,
                    obra: cuenta.obra,
                    tipo: orphan ? cuenta.tipo : "seguimiento"
                });
            }
        }

        let cobSrc = [];
        if (!orphan) {
            for (const d of details) {
                const rows = b.cobros.filter(c => sameCuenta(c, d));
                if (rows.length) cobSrc = cobSrc.concat(rows);
            }
            if (!cobSrc.length && baseOrig) cobSrc = b.cobros.filter(c => sameCuenta(c, baseOrig));
        } else {
            cobSrc = b.cobros.filter(c => sameCuenta(c, { cliente: cuenta.cliente, tipo: cuenta.tipo, obra: cuenta.obra }));
        }
        for (const c of cobSrc) {
            cobros.push({
                ...c,
                cliente: cuenta.cliente,
                obra: cuenta.obra,
                tipo: orphan ? cuenta.tipo : "seguimiento"
            });
        }

        const pagSeen = new Set();
        for (const src of sources) {
            for (const p of b.pagos.filter(p => sameCuenta(p, src))) {
                const k = `${p.monto}|${upper(p.detalle || "")}`;
                if (pagSeen.has(k)) continue;
                pagSeen.add(k);
                pagos.push({
                    ...p,
                    cliente: cuenta.cliente,
                    obra: cuenta.obra,
                    tipo: orphan ? cuenta.tipo : "seguimiento"
                });
            }
        }
    }

    b.cuentas = newCuentas;
    b.remitos = remitos;
    b.movimientos = movimientos;
    b.saldos = saldos;
    b.cobros = cobros;
    b.pagos = pagos;
}

function classifyDoc(rel) {
    const u = upper(rel);
    let tipo = "documento";
    let dominio = "documento";
    if (/ACTA/.test(u)) { tipo = "acta"; dominio = "documento"; }
    else if (/CONTRATO/.test(u)) { tipo = "contrato"; dominio = "documento"; }
    else if (/P\s*Y\s*G|INFORME|ANALISIS|INDICADOR|CARTERA|VALOR EMPRESA|IVA|REPARTICION|CUADRO IVA/.test(u)) {
        tipo = "informe"; dominio = "informe";
    } else if (/SEGUIMIENTO/.test(u)) {
        tipo = "seguimiento"; dominio = /2026/.test(u) ? "operacion" : "historico";
    } else if (/ALQUILER/.test(u)) {
        tipo = "alquiler"; dominio = /2026/.test(u) ? "operacion" : "historico";
    } else if (/INVENTARIO|VALOR MATERIAL|LISTO DE PRECIOS|LISTA DE PRECIOS/.test(u)) {
        tipo = "inventario"; dominio = "operacion";
    } else if (/FLUJO/.test(u)) {
        tipo = "flujo"; dominio = "informe";
    } else if (/COTIZ/.test(u)) {
        tipo = "cotizacion"; dominio = "historico";
    }
    if ((/20(1\d|2[0-5])/.test(u) && !/2026/.test(u)) || /ABRIL 2025|JULIO 2025/.test(u)) {
        if (dominio === "documento" || dominio === "operacion") dominio = "historico";
        if (tipo === "alquiler" || tipo === "seguimiento") dominio = "historico";
    }
    const p = periodFromPath(rel);
    return { tipo, dominio, anio: p.year || null, mes: p.month || null };
}

function main() {
    console.log("Construyendo data/canon/ desde CSV crudos 2026...\n");
    if (!fs.existsSync(ROOT)) {
        console.error("No existe Equioriente_Data");
        process.exit(1);
    }
    if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(path.join(OUT, "catalogo"), { recursive: true });
    fs.mkdirSync(path.join(OUT, "clientes"), { recursive: true });
    fs.mkdirSync(path.join(OUT, "caja"), { recursive: true });
    fs.mkdirSync(path.join(OUT, "archivo"), { recursive: true });

    const allFiles = walkFiles(ROOT);
    const revision = [];
    const clientesMap = new Map();
    const byPeriod = {};

    function ensurePeriod(ym) {
        if (!byPeriod[ym]) {
            byPeriod[ym] = { cuentas: [], remitos: [], movimientos: [], saldos: [], cobros: [], pagos: [] };
            fs.mkdirSync(path.join(OUT, "operacion", ym), { recursive: true });
        }
        return byPeriod[ym];
    }
    function getCliente(nombre) {
        const key = normClientName(nombre);
        if (!clientesMap.has(key)) {
            clientesMap.set(key, { nombre_normalizado: key, nombre_origen: nombre, telefono: "", direccion: "" });
        }
        return clientesMap.get(key);
    }

    // Inventario + precios
    const invFile = allFiles.find(f => /INVENTARIO MATERIAL EQUIORIENTE FEBRERO 2026__INVENTARIO/i.test(path.relative(ROOT, f)));
    const precioFile = allFiles.find(f => /LISTO DE PRECIOS 2023__2023\.csv$/i.test(path.relative(ROOT, f)));
    const articulos = invFile ? parseInventoryCsv(invFile) : [];
    const precios = precioFile ? parsePreciosCsv(precioFile) : [];
    writeCsv(path.join(OUT, "catalogo", "articulos.csv"),
        ["nombre", "total", "valor_unitario"],
        articulos);
    writeCsv(path.join(OUT, "catalogo", "precios.csv"),
        ["nombre", "precio_dia", "dias_minimos"],
        precios);
    console.log(`Catálogo: ${articulos.length} artículos, ${precios.length} precios`);

    // Operación 2026
    let parsedSheets = 0;
    for (const full of allFiles) {
        const rel = path.relative(ROOT, full);
        const op = isOpCsv(rel);
        if (!op) continue;
        let rows;
        try { rows = parseCsv(fs.readFileSync(full, "utf8")); }
        catch (e) {
            revision.push({ fuente: rel, hoja: path.basename(full), anio_mes: op.period, tipo: op.tipo, cliente: "", motivo: "csv_invalido", detalle: e.message });
            continue;
        }
        const clienteArchivo = clientFromFilename(full);
        if (/^ALQUILER( NO)? FISCAL/i.test(clienteArchivo) || clienteArchivo === "ALQUILER") {
            revision.push({ fuente: rel, hoja: path.basename(full), anio_mes: op.period, tipo: op.tipo, cliente: clienteArchivo, motivo: "hoja_indice", detalle: "no es una cuenta de cliente" });
            continue;
        }
        let parsed;
        try { parsed = parseClientSheet(rows, { clienteArchivo, periodo: op.period }); }
        catch (e) {
            revision.push({ fuente: rel, hoja: path.basename(full), anio_mes: op.period, tipo: op.tipo, cliente: clienteArchivo, motivo: "parse_error", detalle: e.message });
            continue;
        }
        if (!parsed) {
            revision.push({ fuente: rel, hoja: path.basename(full), anio_mes: op.period, tipo: op.tipo, cliente: clienteArchivo, motivo: "vacio", detalle: "" });
            continue;
        }
        if (!parsed.remitos.length && !parsed.cobros.length && !parsed.saldoItems.length) {
            revision.push({
                fuente: rel, hoja: path.basename(full), anio_mes: op.period,
                tipo: op.tipo, cliente: parsed.cliente, motivo: "sin remitos, cobros ni saldos", detalle: ""
            });
            continue;
        }
        parsedSheets++;
        const cli = getCliente(parsed.cliente);
        if (parsed.telefono && !cli.telefono) cli.telefono = parsed.telefono;
        if (parsed.direccion && !cli.direccion) cli.direccion = parsed.direccion;
        const bucket = ensurePeriod(op.period);
        const cuentaKey = `${cli.nombre_normalizado}|${upper(parsed.obra || "")}|${op.tipo}`;
        bucket.cuentas.push({
            cliente: cli.nombre_normalizado,
            obra: parsed.obra || "",
            tipo: op.tipo,
            tipo_documento: op.tipo,
            telefono: parsed.telefono || cli.telefono || "",
            direccion: parsed.direccion || "",
            fuente: rel,
            hoja: path.basename(full, ".csv"),
            notas: parsed.notas,
            transporte: parsed.transporteTotal || 0,
            _key: cuentaKey
        });
        for (const rem of parsed.remitos) {
            bucket.remitos.push({
                cliente: cli.nombre_normalizado,
                obra: parsed.obra || "",
                tipo: op.tipo,
                numero: rem.numero,
                fecha: rem.fecha || "",
                hora: rem.hora || "",
                transporte: rem.transporte || 0,
                placa: rem.placa || "",
                fuente: rel
            });
            for (const it of rem.items) {
                bucket.movimientos.push({
                    cliente: cli.nombre_normalizado,
                    tipo: op.tipo,
                    remito: rem.numero,
                    fecha: rem.fecha || "",
                    material: it.material,
                    cantidad: it.cantidad,
                    signo: it.cantidad < 0 ? -1 : 1
                });
            }
        }
        for (const s of parsed.saldoItems) {
            bucket.saldos.push({
                cliente: cli.nombre_normalizado,
                obra: parsed.obra || "",
                tipo: op.tipo,
                material: s.material,
                cantidad: s.cantidad
            });
        }
        for (const c of parsed.cobros) {
            bucket.cobros.push({
                cliente: cli.nombre_normalizado,
                obra: parsed.obra || "",
                tipo: op.tipo,
                material: c.material,
                dias: c.dias,
                cantidad: c.cantidad,
                valor_unitario: c.valor_unitario,
                costo_diario: c.costo_diario,
                total: c.total,
                periodo_texto: c.periodo_texto || ""
            });
        }
        for (const p of parsed.pagos) {
            bucket.pagos.push({
                cliente: cli.nombre_normalizado,
                obra: parsed.obra || "",
                tipo: op.tipo,
                fecha: p.fecha || "",
                monto: p.monto,
                medio: p.medio || "",
                detalle: p.detalle,
                tipo_pago: /ABONO/.test(upper(p.detalle)) ? "abono" : "pago"
            });
        }
        for (const motivo of parsed.revision) {
            revision.push({
                fuente: rel, hoja: path.basename(full), anio_mes: op.period,
                tipo: op.tipo, cliente: parsed.cliente, motivo, detalle: ""
            });
        }
    }

    const periodos = Object.keys(byPeriod).sort();
    const comparacion = [];
    for (const ym of periodos) {
        const b = byPeriod[ym];
        const segCuentas = b.cuentas.filter(c => c.tipo === "seguimiento");
        const segRemitos = b.remitos.filter(r => r.tipo === "seguimiento");
        const segClientes = new Set(segCuentas.map(c => c.cliente));
        if (ym >= "2026-06") mergeDesdeSeguimiento(ym, b);
        const dir = path.join(OUT, "operacion", ym);
        writeCsv(dir + "/cuentas.csv", ["cliente", "obra", "tipo", "tipo_documento", "telefono", "direccion", "fuente", "hoja", "notas", "transporte", "fuente_detalle"], b.cuentas);
        writeCsv(dir + "/remitos.csv", ["cliente", "obra", "tipo", "numero", "fecha", "hora", "transporte", "placa", "fuente"], b.remitos);
        writeCsv(dir + "/movimientos.csv", ["cliente", "tipo", "remito", "fecha", "material", "cantidad", "signo"], b.movimientos);
        writeCsv(dir + "/saldos.csv", ["cliente", "obra", "tipo", "material", "cantidad"], b.saldos);
        writeCsv(dir + "/cobros.csv", ["cliente", "obra", "tipo", "material", "dias", "cantidad", "valor_unitario", "costo_diario", "total", "periodo_texto"], b.cobros);
        writeCsv(dir + "/pagos.csv", ["cliente", "obra", "tipo", "fecha", "monto", "medio", "detalle", "tipo_pago"], b.pagos);
        const postCli = new Set(b.cuentas.map(c => c.cliente));
        const faltan = [...segClientes].filter(n => !postCli.has(n));
        const extra = b.cuentas.filter(c => !segClientes.has(c.cliente)).map(c => c.cliente);
        const remOk = b.remitos.filter(r => r.tipo === "seguimiento" || ym < "2026-06").length;
        comparacion.push({
            anio_mes: ym,
            seguimiento_cuentas: segCuentas.length,
            seguimiento_remitos: segRemitos.length,
            cuentas_finales: b.cuentas.length,
            remitos_finales: b.remitos.length,
            cobros_finales: b.cobros.length,
            clientes_seguimiento_faltantes: faltan.join(" | "),
            cuentas_sin_seguimiento: extra.join(" | "),
            ok: faltan.length === 0 && (ym < "2026-06" || remOk >= segRemitos.length) ? "si" : "revisar"
        });
        console.log(`${ym}: ${b.cuentas.length} cuentas, ${b.remitos.length} remitos, ${b.saldos.length} saldos, ${b.cobros.length} cobros`);
        if (ym >= "2026-06") {
            console.log(`  vs seguimiento: ${segCuentas.length} cuentas / ${segRemitos.length} remitos → ${b.cuentas.length} / ${b.remitos.length}`
                + (faltan.length ? ` FALTAN: ${faltan.join(", ")}` : "")
                + (extra.length ? ` extra (solo factura): ${extra.join(", ")}` : ""));
        }
    }
    writeCsv(path.join(OUT, "_COMPARACION.csv"),
        ["anio_mes", "seguimiento_cuentas", "seguimiento_remitos", "cuentas_finales", "remitos_finales", "cobros_finales", "clientes_seguimiento_faltantes", "cuentas_sin_seguimiento", "ok"],
        comparacion);

    writeCsv(path.join(OUT, "clientes", "clientes.csv"),
        ["nombre_normalizado", "nombre_origen", "telefono", "direccion"],
        [...clientesMap.values()]);

    // Flujo 2026
    const flujoRows = [];
    for (const full of allFiles) {
        const rel = path.relative(ROOT, full);
        if (!/FLUJO EFECTIVO 2026__.+\.csv$/i.test(rel)) continue;
        const sheet = path.basename(full, ".csv").split("__")[1] || "";
        const rows = parseFlujoCsv(full, sheet);
        for (const r of rows) flujoRows.push({ ...r, fuente: rel });
    }
    writeCsv(path.join(OUT, "caja", "flujo_2026.csv"),
        ["fecha", "detalle", "valor", "tipo", "medio", "mes", "anio", "fuente"],
        flujoRows);
    console.log(`Caja 2026: ${flujoRows.length} movimientos`);

    // Archivo
    const docs = [];
    const DOC_EXT = new Set([".xlsx", ".xls", ".docx", ".doc", ".pdf", ".odt", ".png", ".jpg", ".jpeg"]);
    for (const full of allFiles) {
        const rel = path.relative(ROOT, full);
        const ext = path.extname(full).toLowerCase();
        if (!DOC_EXT.has(ext)) continue;
        if (path.basename(full).startsWith("~$")) continue;
        const st = fs.statSync(full);
        const cls = classifyDoc(rel);
        docs.push({
            archivo: path.basename(full),
            ruta: rel.replace(/\\/g, "/"),
            extension: ext.slice(1),
            tipo: cls.tipo,
            dominio: cls.dominio,
            titulo: path.basename(full, ext),
            anio: cls.anio || "",
            mes: cls.mes || "",
            tamano: st.size
        });
    }
    writeCsv(path.join(OUT, "archivo", "documentos.csv"),
        ["archivo", "ruta", "extension", "tipo", "dominio", "titulo", "anio", "mes", "tamano"],
        docs);

    writeCsv(path.join(OUT, "_REVISION.csv"),
        ["fuente", "hoja", "anio_mes", "tipo", "cliente", "motivo", "detalle"],
        revision);

    console.log(`\nHojas parseadas: ${parsedSheets}`);
    console.log(`Clientes: ${clientesMap.size}`);
    console.log(`Documentos archivo: ${docs.length}`);
    console.log(`Revisión: ${revision.length} avisos → data/canon/_REVISION.csv`);
}

main();
