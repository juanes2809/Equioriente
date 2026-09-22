/**
 * import_equioriente_data.js
 * Lee Equioriente_Data (Excel + documentos) y llena data/store.json
 * para que inventario, clientes, alquileres, remitos, pagos, caja y
 * documentos queden juntos en el sistema.
 *
 *   node import_equioriente_data.js
 */
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const ROOT = path.join(__dirname, "Equioriente_Data");
const STORE = path.join(__dirname, "data", "store.json");

const MESES = {
    ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6,
    JULIO: 7, AGOSTO: 8, SEPTIEMBRE: 9, OCTUBRE: 10, NOVIEMBRE: 11, DICIEMBRE: 12
};

function cellRaw(ws, r, c) {
    const cell = ws.getRow(r).getCell(c);
    if (!cell || cell.value == null || cell.value === "") return null;
    const v = cell.value;
    if (typeof v === "object") {
        if (v instanceof Date) return v;
        if (v.result !== undefined && v.result !== null && v.result !== "undefined") return v.result;
        if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join("");
        if (v.text) return v.text;
        if (v.hyperlink) return v.text || v.hyperlink;
        return null;
    }
    return v;
}
function cellText(ws, r, c) {
    const v = cellRaw(ws, r, c);
    if (v == null) return "";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).replace(/\s+/g, " ").trim();
}
function cellNum(ws, r, c) {
    const v = cellRaw(ws, r, c);
    if (v == null || v === "") return null;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (v instanceof Date) return null;
    const n = Number(String(v).replace(/[$\s]/g, "").replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
}
function isDate(v) {
    return v instanceof Date && !Number.isNaN(v.getTime()) && v.getFullYear() > 1990 && v.getFullYear() < 2100;
}
function isoDate(v) {
    if (!v) return null;
    if (v instanceof Date && isDate(v)) return v.toISOString().slice(0, 10);
    const s = String(v);
    const m = s.match(/(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
function isoTime(v) {
    if (!(v instanceof Date)) return null;
    if (v.getFullYear() < 1950) {
        return v.toISOString().slice(11, 16);
    }
    return null;
}
function stripAccents(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function upper(s) { return stripAccents(s).toUpperCase().replace(/\s+/g, " ").trim(); }

function normMaterial(s) {
    let t = upper(s);
    t = t.replace(/FORMALETAS?/g, "TABLERO METALICO");
    t = t.replace(/TABLEROS? METALICOS?/g, "TABLERO METALICO");
    t = t.replace(/MTROS|METROS|MTRS|MTS\b/g, "M");
    t = t.replace(/CENTIMETROS|CMS\b/g, "CM");
    t = t.replace(/CHAPETAS?( CUADRADAS?)?/g, "CHAPETAS");
    t = t.replace(/CRUCETAS?( DE ANDAMIOS?)?/g, "CRUCETAS");
    t = t.replace(/MARCOS DE ANDAMIOS?/g, "MARCOS ANDAMIO");
    t = t.replace(/MARCOS DE ANDAMIO/g, "MARCOS ANDAMIO");
    t = t.replace(/CERCHAS?/g, "CERCHA");
    t = t.replace(/PARALES/g, "PARAL");
    t = t.replace(/ALINEADORES/g, "ALINEADOR");
    t = t.replace(/ANGULOS/g, "ANGULO");
    t = t.replace(/RINCONERAS/g, "RINCONERA");
    t = t.replace(/TABLONES/g, "TABLON");
    t = t.replace(/BANDAS/g, "BANDA");
    t = t.replace(/TABLEROS DE MADERA|TABLERO DE MADERA|TABREROS DE MADERA/g, "TABLERO MADERA");
    t = t.replace(/RUEDAS( NIVELADORAS| PARA ANDAMIOS| DE ANDAMIO)?/g, "RUEDAS ANDAMIO");
    t = t.replace(/CAJAS METALICAS|CAJA METALICA/g, "CAJA METALICA");
    t = t.replace(/[,]/g, ".");
    t = t.replace(/[xX×]/g, "*");
    t = t.replace(/[^A-Z0-9*. ]/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    return t;
}
function dims(s) {
    const nums = String(s).match(/\d+(?:\.\d+)?/g) || [];
    return nums.map(n => {
        let x = Number(n);
        if (x > 0 && x <= 10) x = Math.round(x * 100); // 1.20 m → 120 cm
        return Math.round(x);
    }).sort((a, b) => a - b);
}
function materialKey(s) {
    const n = normMaterial(s);
    const d = dims(n);
    const words = n.replace(/[0-9*.]/g, " ").split(" ").filter(w => w.length > 1);
    return words.slice(0, 4).join(" ") + (d.length ? " " + d.join("*") : "");
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
function looksMergedTitle(ws, r, maxC) {
    const first = cellText(ws, r, 1);
    if (!first) return false;
    let same = 0, filled = 0;
    for (let c = 1; c <= Math.min(maxC, 8); c++) {
        const t = cellText(ws, r, c);
        if (t) { filled++; if (t === first) same++; }
    }
    return filled >= 3 && same === filled;
}

function classifyFile(rel) {
    const n = upper(path.basename(rel));
    if (n.startsWith("~$") || n === "DESKTOP.INI") return "skip";
    if (n.includes("SEGUIMIENTO")) return "seguimiento";
    if (n.includes("ALQUILER FISCAL") || n.includes("ALQUILER  FISCAL")) return "fiscal";
    if (n.includes("NO FISCAL") || n.includes("NI FISCAL") || n.includes("ALQUIER NO")) return "no_fiscal";
    if (n.includes("INVENTARIO MATERIAL") || n.includes("VALOR MATERIAL")) return "inventario";
    if (n.includes("LISTO DE PRECIOS") || n.includes("LISTA DE PRECIOS")) return "precios";
    if (n.includes("FLUJO")) return "flujo";
    if (n.includes("COTIZACION")) return "cotizacion";
    return "documento";
}

function periodFromPath(rel) {
    const u = upper(rel);
    let year = null, month = null;
    const y = u.match(/\b(20\d{2})\b/);
    if (y) year = Number(y[1]);
    for (const [name, num] of Object.entries(MESES)) {
        if (u.includes(name)) { month = num; break; }
    }
    if (!year) year = 0;
    if (!month) month = 0;
    return { year, month, key: `${year}-${String(month).padStart(2, "0")}` };
}

function walkFiles(dir, acc = []) {
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

function categoriaDe(nombre) {
    const n = upper(nombre);
    if (/ANDAMIO|MARCOS|CRUCETA|TABLON|RUEDA|PASAMANOS/.test(n)) return "Andamios";
    if (/TABLERO METALICO|FORMALETA|RINCONERA|ANGULO|CHAPETA|TENSOR|ALINEADOR|CORBATA/.test(n)) return "Formaleta";
    if (/PARAL/.test(n)) return "Puntales";
    if (/CERCHA/.test(n)) return "Cerchas";
    if (/MADERA|BANDA|TABLERO MADERA/.test(n)) return "Madera";
    if (/ESCALERA|POLEA|MEZCLADORA|ARNES|SLINGA|BALDE/.test(n)) return "Equipos";
    if (/CAMION/.test(n)) return "Activos";
    return "General";
}

function makeRef(nombre, used) {
    const n = upper(nombre);
    const words = n.replace(/[^A-Z0-9 ]/g, " ").split(" ").filter(w => w.length > 1 && !["DE", "DEL", "LA", "EL", "EN"].includes(w));
    const letters = words.filter(w => !/^\d/.test(w)).map(w => w[0]).join("").slice(0, 5);
    const nums = (n.match(/\d+(?:[.,]\d+)?/g) || []).map(x => x.replace(",", ".")).join("X");
    let base = (letters || "ART") + (nums ? "-" + nums : "");
    base = base.slice(0, 28);
    let ref = base, i = 2;
    while (used.has(ref)) { ref = `${base}-${i++}`; }
    used.add(ref);
    return ref;
}

function nextId(seq, table) {
    seq[table] = (seq[table] || 0) + 1;
    return seq[table];
}

const SKIP_NAMES = /^(HORA|HORAS|TRANSPORTE|TRANSORTE|MATERIAL|SALDO|P\.?M\.?|A\.?M\.?|DETALLES|COSTOS|DIAS|CANTIDAD|VALOR|RECOGIDA)$/i;
const SKIP_MATERIAL = /TOTAL MATERIAL|MATERIAL NO ENTREGADO|TOTAL A PAGAR|MATERIAL A DAÑADO|MATERIAL ADAÑADO|A LA FECHA|VALOR DIA|SUB-?TOTAL|LLEVADA Y/;
const NOTE_ROW = /ABONO|CANCELO|CANCELADO|NEQUI|DEPOSITO|VALOR DIA|TOTAL/;

function parseClientSheet(ws, meta) {
    const maxR = Math.min(ws.rowCount || 0, 200);
    const maxC = Math.min(ws.columnCount || 0, 30);
    if (maxR < 3) return null;

    const titles = [];
    for (let r = 1; r <= Math.min(6, maxR); r++) {
        const t = cellText(ws, r, 1);
        if (t) titles.push(t);
    }
    const sheetName = (ws.name || "").trim();
    let cliente = sheetName;
    const owner = /JIMMY|EQUIORIENTE|JAIMES/;
    if (owner.test(upper(cliente)) && titles.length) {
        const alt = titles.find(t => t && !owner.test(upper(t)) && !/CRA|CALLE|MOVIMIENTO|MATERIAL/i.test(t));
        if (alt) cliente = alt.split(":")[0].trim();
    }
    if (!cliente || cliente.length < 2) cliente = titles[0] || "SIN NOMBRE";
    cliente = cliente.replace(/\s+/g, " ").trim();

    let direccion = "";
    let telefono = extractPhone(titles.join(" "));
    for (const t of titles) {
        if (/CRA|CALLE|CARRERA|AV\.|AVENIDA|BARRIO|VEREDA|#\d|CONJUNTO|EDIFICIO|TRANSICION|INDEPENDENCIA|COMUNEROS/i.test(t)
            && !/MOVIMIENTO|MATERIAL/i.test(t)) {
            direccion = t.replace(/TEL:?\s*\d+/i, "").trim();
            const ph = extractPhone(t);
            if (ph) telefono = telefono || ph;
        }
    }
    const periodo = titles.find(t => /MOVIMIENTO/i.test(t)) || meta.periodo || "";

    const blocks = [];
    for (let r = 1; r <= Math.min(40, maxR); r++) {
        const a = upper(cellText(ws, r, 1));
        if (a === "MATERIAL" || a.startsWith("MATERIAL")) {
            const headerVals = [];
            for (let c = 1; c <= maxC; c++) headerVals.push({ c, t: cellText(ws, r, c), n: cellNum(ws, r, c), raw: cellRaw(ws, r, c) });
            const hasRemito = headerVals.some(h => h.n && h.n >= 1000 && h.n < 999999);
            const hasSaldo = headerVals.some(h => upper(h.t) === "SALDO");
            const hasBilling = headerVals.some(h => /DIAS/.test(upper(h.t))) ||
                headerVals.some(h => /CANTIDAD/.test(upper(h.t))) ||
                (upper(cellText(ws, r + 1, 2)) === "DIAS" && upper(cellText(ws, r + 1, 3)) === "CANTIDAD");
            if (hasRemito || hasSaldo) blocks.push({ type: "mov", headerRow: r });
            if (hasBilling) blocks.push({ type: "cobro", headerRow: r });
        }
        // billing header on next line style: R = MATERIAL/DETALLES, R+1 = DIAS CANTIDAD VALOR
        if (upper(cellText(ws, r, 2)) === "DIAS" && /CANTIDAD/.test(upper(cellText(ws, r, 3)))) {
            if (!blocks.some(b => b.type === "cobro" && Math.abs(b.headerRow - r) <= 1))
                blocks.push({ type: "cobro", headerRow: r - 1 > 0 ? r - 1 : r });
        }
    }

    const remitos = [];
    const saldoItems = [];
    const cobros = [];
    const pagos = [];
    let transporteTotal = 0;
    const notas = [];

    for (const block of blocks.filter(b => b.type === "mov")) {
        const hr = block.headerRow;
        const dateRow = hr + 1;
        const cols = [];
        for (let c = 2; c <= maxC; c++) {
            const ht = cellText(ws, hr, c);
            const hn = cellNum(ws, hr, c);
            const dt = cellRaw(ws, dateRow, c);
            const headerU = upper(ht);
            let kind = "other";
            let remito = null;
            if (hn && hn >= 1000 && hn < 999999) { kind = "remito"; remito = String(Math.round(hn)); }
            else if (headerU === "SALDO" || headerU.includes("SALDO") || headerU.includes("MATERIAL EN OBRA")) kind = "saldo";
            else if (headerU.includes("RECOGIDA") || headerU.includes("RECOGIDO")) kind = "recogida";
            const fecha = isDate(dt) ? isoDate(dt) : isoDate(ht);
            cols.push({ c, kind, remito, fecha, header: ht });
        }
        const saldoCol = [...cols].reverse().find(x => x.kind === "saldo") || cols.find(x => x.kind === "saldo");
        const remitoCols = cols.filter(x => x.kind === "remito");

        for (const rc of remitoCols) {
            if (!remitos.some(x => x.numero === rc.remito)) {
                remitos.push({ numero: rc.remito, fecha: rc.fecha, items: [], hora: null, transporte: 0, placa: null });
            }
        }

        for (let r = dateRow + 1; r <= maxR; r++) {
            const name = cellText(ws, r, 1);
            if (!name) continue;
            const un = upper(name);
            if (un === "MATERIAL" || un === "DETALLES") break;
            if (/^HORA/.test(un)) {
                for (const rc of remitoCols) {
                    const t = isoTime(cellRaw(ws, r, rc.c));
                    const rem = remitos.find(x => x.numero === rc.remito);
                    if (rem && t) rem.hora = t;
                }
                continue;
            }
            if (/TRANSPORTE|TRANSORTE/.test(un)) {
                for (const col of cols) {
                    const v = cellRaw(ws, r, col.c);
                    const rem = remitos.find(x => x.numero === col.remito);
                    if (typeof v === "number" && v > 100) {
                        if (rem) rem.transporte = v;
                        transporteTotal += v;
                    } else if (typeof v === "string" && /[A-Z]{2,3}-?\d|\b[A-Z]{3}\d{3}\b/i.test(v)) {
                        if (rem) rem.placa = String(v);
                    }
                }
                const totalCell = cellNum(ws, r, (saldoCol && saldoCol.c) || maxC);
                if (totalCell && totalCell > 100) transporteTotal = Math.max(transporteTotal, totalCell);
                continue;
            }
            if (NOTE_ROW.test(un) && !/MARCOS|PARAL|FORMALETA|TABLERO|CERCHA|CHAPETA/.test(un)) {
                notas.push(name);
                const mon = extractMoney(name);
                if (mon && /ABONO|CANCELO|CANCELADO|DEPOSITO/.test(un)) {
                    pagos.push({ detalle: name, monto: mon, fecha: remitoCols[0] && remitoCols[0].fecha });
                }
                continue;
            }
            if (SKIP_NAMES.test(un) || SKIP_MATERIAL.test(un) || looksMergedTitle(ws, r, maxC)) {
                if (looksMergedTitle(ws, r, maxC) && r > hr + 8) break;
                continue;
            }

            const qtyByCol = {};
            for (const col of cols) {
                const n = cellNum(ws, r, col.c);
                if (n != null && n !== 0) qtyByCol[col.c] = n;
            }
            let saldo = null;
            if (saldoCol && qtyByCol[saldoCol.c] != null) saldo = qtyByCol[saldoCol.c];
            else {
                const nums = remitoCols.map(c => qtyByCol[c.c] || 0);
                const firstSaldo = cols.find(x => x.kind === "saldo");
                const prev = firstSaldo && firstSaldo !== saldoCol ? (qtyByCol[firstSaldo.c] || 0) : 0;
                if (nums.length || prev) saldo = nums.reduce((s, n) => s + n, prev);
            }

            for (const rc of remitoCols) {
                const q = qtyByCol[rc.c];
                if (q == null || q === 0) continue;
                const rem = remitos.find(x => x.numero === rc.remito);
                if (rem) rem.items.push({ material: name, cantidad: q });
            }
            if (saldo != null && saldo !== 0 && Math.abs(saldo) < 20000) {
                saldoItems.push({ material: name, cantidad: saldo });
            }
        }
    }

    for (const block of blocks.filter(b => b.type === "cobro")) {
        let start = block.headerRow;
        // find DIAS/CANTIDAD/VALOR row
        let hr = start;
        for (let r = start; r <= Math.min(start + 3, maxR); r++) {
            const rowTxt = [1, 2, 3, 4, 5, 6].map(c => upper(cellText(ws, r, c))).join(" ");
            if (rowTxt.includes("DIAS") && rowTxt.includes("CANTIDAD")) { hr = r; break; }
        }
        for (let r = hr + 1; r <= Math.min(hr + 80, maxR); r++) {
            const name = cellText(ws, r, 1);
            if (!name) {
                // totals / transport line
                const rowTxt = [1, 2, 3, 4, 5].map(c => upper(cellText(ws, r, c))).join(" ");
                if (/LLEVADA|TRAIDA|RECOGIDA|TRANSPORTE/.test(rowTxt)) {
                    const mon = [3, 4, 5, 6].map(c => cellNum(ws, r, c)).find(n => n && n > 100);
                    if (mon) transporteTotal += mon;
                }
                if (looksMergedTitle(ws, r, 6) && r > hr + 4) break;
                continue;
            }
            const un = upper(name);
            if (looksMergedTitle(ws, r, 6) && r > hr + 2) break;
            if (/JIMMY|EQUIORIENTE/.test(un) && r > hr + 2) break;
            if (SKIP_NAMES.test(un) || SKIP_MATERIAL.test(un) || /SUB-?TOTAL|TOTAL DIAS|TOTAL DIARIO|VALOR DIARIO/.test(un)) {
                if (/LLEVADA|TRAIDA/.test(un)) {
                    const mon = [3, 4, 5].map(c => cellNum(ws, r, c)).find(n => n && n > 100);
                    if (mon) transporteTotal += mon;
                }
                continue;
            }
            const dias = cellNum(ws, r, 2);
            const cant = cellNum(ws, r, 3);
            const valor = cellNum(ws, r, 4);
            const diario = cellNum(ws, r, 5);
            const precio = cellNum(ws, r, 6);
            if (cant == null && valor == null) continue;
            cobros.push({
                material: name,
                dias: (dias && dias > 0 && dias < 400) ? dias : 1,
                cantidad: (cant && Math.abs(cant) < 20000) ? cant : 0,
                valor_unitario: (valor && valor < 1e7) ? valor : 0,
                costo_diario: diario || 0,
                total: (precio && precio < 5e8) ? precio : ((dias || 1) * (cant || 0) * (valor || 0))
            });
        }
    }

    for (let r = 1; r <= maxR; r++) {
        const t = cellText(ws, r, 1);
        if (t && /ABONO|CANCELO|CANCELADO/.test(upper(t)) && !pagos.some(p => p.detalle === t)) {
            const mon = extractMoney(t);
            if (mon) pagos.push({ detalle: t, monto: mon, fecha: null });
            else notas.push(t);
        }
    }

    return {
        cliente,
        direccion,
        telefono,
        obra: direccion || sheetName,
        periodo,
        remitos,
        saldoItems,
        cobros,
        pagos,
        transporteTotal,
        notas: [...new Set(notas)].join(" | ")
    };
}

async function parseInventory(fp) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fp);
    const ws = wb.worksheets[0];
    const rows = [];
    for (let r = 4; r <= (ws.rowCount || 0); r++) {
        const nombre = cellText(ws, r, 1);
        if (!nombre) continue;
        if (/VALOR TOTAL|AVALUO|CAMION JAC/.test(upper(nombre))) {
            if (/CAMION JAC/.test(upper(nombre))) {
                rows.push({
                    nombre: "CAMION JAC",
                    bodega: 1, alquilado: 0, subalquilado: 0,
                    total: 1, valor_unitario: cellNum(ws, r, 2) || cellNum(ws, r, 6) || 30000000
                });
            }
            continue;
        }
        rows.push({
            nombre,
            bodega: cellNum(ws, r, 2) || 0,
            alquilado: cellNum(ws, r, 3) || 0,
            subalquilado: cellNum(ws, r, 4) || 0,
            total: cellNum(ws, r, 5) || ((cellNum(ws, r, 2) || 0) + (cellNum(ws, r, 3) || 0)),
            valor_unitario: cellNum(ws, r, 6) || 0
        });
    }
    return rows;
}

async function parsePrecios(fp) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fp);
    const ws = wb.worksheets[0];
    const rows = [];
    for (let r = 3; r <= (ws.rowCount || 0); r++) {
        const nombre = cellText(ws, r, 1);
        if (!nombre || /LISTA DE PRECIOS|MATERIAL/.test(upper(nombre))) continue;
        const precio = cellNum(ws, r, 2) || 0;
        const minTxt = cellText(ws, r, 3);
        const min = Number((minTxt.match(/\d+/) || [1])[0]);
        rows.push({ nombre, precio_dia: precio, dias_minimos: min });
    }
    return rows;
}

async function parseFlujo(fp, anioHint) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fp);
    const out = [];
    for (const ws of wb.worksheets) {
        const sheet = upper(ws.name);
        if (!ws.rowCount) continue;
        const mesNum = MESES[sheet.split(" ")[0]] || periodFromPath(ws.name).month || null;
        let modo = /EGRESO|GASTO/.test(sheet) ? "egreso" : "ingreso";
        let lastFecha = null;
        const maxR = Math.min(ws.rowCount || 0, 400);
        const maxC = Math.min(ws.columnCount || 0, 8);
        for (let r = 1; r <= maxR; r++) {
            const a = cellText(ws, r, 1);
            const b = cellText(ws, r, 2);
            const rowTxt = [1, 2, 3].map(c => upper(cellText(ws, r, c))).join(" ");
            if (/EGRESOS|GASTOS/.test(rowTxt) && !/INGRESOS/.test(rowTxt)) { modo = "egreso"; continue; }
            if (/^INGRESOS$/.test(rowTxt.trim()) || rowTxt.startsWith("INGRESOS")) { modo = "ingreso"; continue; }
            if (/FECHA|DETALLE|SALDO EN CAJA|VALOR/.test(upper(a)) && !b) continue;
            const rawA = cellRaw(ws, r, 1);
            if (isDate(rawA)) lastFecha = isoDate(rawA);
            const detalle = b || (a && !isDate(rawA) ? a : "");
            if (!detalle || /INGRESOS|SALDO EN CAJA|FECHA/.test(upper(detalle))) continue;
            const valor = cellNum(ws, r, 3);
            if (valor == null || valor === 0) continue;
            const medio = cellText(ws, r, 4) || null;
            let tipo = modo;
            if (/RETIRO|SACAD/.test(upper(detalle))) tipo = "traslado";
            out.push({
                fecha: lastFecha,
                detalle,
                valor,
                tipo,
                medio,
                mes: mesNum,
                anio: anioHint || (lastFecha ? Number(lastFecha.slice(0, 4)) : null)
            });
        }
    }
    return out;
}

async function parseCotizacionBook(fp) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fp);
    const out = [];
    for (const ws of wb.worksheets) {
        const parsed = parseClientSheet(ws, { periodo: "2023" });
        if (!parsed || (!parsed.cobros.length && !parsed.saldoItems.length)) continue;
        const total = parsed.cobros.reduce((s, c) => s + (c.total || 0), 0) + (parsed.transporteTotal || 0);
        out.push({
            cliente: parsed.cliente,
            direccion: parsed.direccion,
            telefono: parsed.telefono,
            notas: parsed.notas,
            transporte: parsed.transporteTotal,
            total,
            items: parsed.cobros,
            fuente: path.relative(ROOT, fp),
            hoja: ws.name
        });
    }
    return out;
}

async function parseRentalBook(fp, tipo, periodo) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fp);
    const sheets = [];
    for (const ws of wb.worksheets) {
        if (!ws.rowCount || ws.name.toUpperCase().includes("ALQUILER NI FISCAL")) continue;
        try {
            const parsed = parseClientSheet(ws, { periodo: periodo.key });
            if (parsed) sheets.push({ ...parsed, hoja: ws.name, tipo, periodo: periodo.key, fuente: path.relative(ROOT, fp) });
        } catch (e) {
            console.warn("  hoja", ws.name, e.message);
        }
    }
    return sheets;
}

function findArticulo(articulos, nombre) {
    const key = materialKey(nombre);
    let hit = articulos.find(a => a._key === key);
    if (hit) return hit;
    const n = normMaterial(nombre);
    hit = articulos.find(a => a._norm === n);
    if (hit) return hit;
    const d = dims(n).join("*");
    const head = n.split(" ").filter(w => !/^\d/.test(w)).slice(0, 2).join(" ");
    if (d && head) {
        hit = articulos.find(a => a._dims === d && a._norm.startsWith(head));
        if (hit) return hit;
    }
    return null;
}

function saneTotal(precio, dias, cant, total) {
    const expected = (Number(precio) || 0) * (Number(dias) || 1) * (Number(cant) || 0);
    if (total == null || total === 0) return expected || null;
    if (total < 0 || total > 5e8) return expected || null;
    if (expected > 0 && total > expected * 30) return expected;
    return total;
}

async function main() {
    console.log("Integrando Equioriente_Data → data/store.json\n");
    if (!fs.existsSync(ROOT)) {
        console.error("No existe Equioriente_Data");
        process.exit(1);
    }

    let existingUsers = [];
    if (fs.existsSync(STORE)) {
        try {
            const old = JSON.parse(fs.readFileSync(STORE, "utf8"));
            existingUsers = old.tables?.equioriente_usuarios || [];
        } catch { /* ignore */ }
    }

    const allFiles = walkFiles(ROOT);
    const byType = {};
    for (const full of allFiles) {
        const rel = path.relative(ROOT, full);
        const t = classifyFile(rel);
        if (t === "skip") continue;
        (byType[t] = byType[t] || []).push({ full, rel, periodo: periodFromPath(rel) });
    }

    const tables = {
        equioriente_usuarios: existingUsers.slice(),
        equioriente_categorias: [],
        equioriente_clientes: [],
        equioriente_articulos: [],
        equioriente_alquileres: [],
        equioriente_alquiler_items: [],
        equioriente_devoluciones_proveedor: [],
        equioriente_movimientos_inventario: [],
        equioriente_registro_danos: [],
        equioriente_remitos: [],
        equioriente_remito_items: [],
        equioriente_pagos: [],
        equioriente_flujo_caja: [],
        equioriente_documentos: [],
        equioriente_cotizaciones: [],
        equioriente_cotizacion_items: []
    };
    const seq = {};
    const usedRef = new Set();
    const catByName = {};
    function catId(nombre) {
        if (!catByName[nombre]) {
            const id = nextId(seq, "equioriente_categorias");
            catByName[nombre] = id;
            tables.equioriente_categorias.push({ id, nombre });
        }
        return catByName[nombre];
    }
    catId("General");

    // Inventario
    const invFile = (byType.inventario || []).find(f => /INVENTARIO MATERIAL/i.test(f.rel)) || (byType.inventario || [])[0];
    let inventario = [];
    if (invFile) {
        console.log("Inventario:", invFile.rel);
        inventario = await parseInventory(invFile.full);
    }
    const precios = [];
    for (const f of byType.precios || []) {
        console.log("Precios:", f.rel);
        precios.push(...await parsePrecios(f.full));
    }

    const articulos = [];
    for (const row of inventario) {
        const id = nextId(seq, "equioriente_articulos");
        const precioHit = precios.find(p => materialKey(p.nombre) === materialKey(row.nombre));
        const art = {
            id,
            referencia: makeRef(row.nombre, usedRef),
            nombre: row.nombre,
            stock_total: row.total || (row.bodega + row.alquilado),
            stock_disponible: row.bodega,
            stock_mantenimiento: 0,
            stock_danado: 0,
            stock_minimo: 0,
            stock_alquilado: row.alquilado,
            stock_subalquilado: row.subalquilado,
            precio_dia: precioHit ? precioHit.precio_dia : 0,
            valor_unitario: row.valor_unitario || 0,
            dias_minimos: precioHit ? precioHit.dias_minimos : 1,
            es_externo: row.subalquilado > 0 ? 1 : 0,
            empresa_externa: row.subalquilado > 0 ? "Subalquilado" : null,
            costo_proveedor_dia: 0,
            categoria_id: catId(categoriaDe(row.nombre)),
            _key: materialKey(row.nombre),
            _norm: normMaterial(row.nombre),
            _dims: dims(normMaterial(row.nombre)).join("*")
        };
        articulos.push(art);
    }
    for (const p of precios) {
        if (findArticulo(articulos, p.nombre)) continue;
        const id = nextId(seq, "equioriente_articulos");
        articulos.push({
            id,
            referencia: makeRef(p.nombre, usedRef),
            nombre: p.nombre,
            stock_total: 0, stock_disponible: 0, stock_mantenimiento: 0, stock_danado: 0,
            stock_minimo: 0, stock_alquilado: 0, stock_subalquilado: 0,
            precio_dia: p.precio_dia, valor_unitario: 0, dias_minimos: p.dias_minimos,
            es_externo: 0, empresa_externa: null, costo_proveedor_dia: 0,
            categoria_id: catId(categoriaDe(p.nombre)),
            _key: materialKey(p.nombre), _norm: normMaterial(p.nombre),
            _dims: dims(normMaterial(p.nombre)).join("*")
        });
    }

    function ensureArticulo(nombre) {
        let a = findArticulo(articulos, nombre);
        if (a) return a;
        const id = nextId(seq, "equioriente_articulos");
        a = {
            id,
            referencia: makeRef(nombre, usedRef),
            nombre,
            stock_total: 0, stock_disponible: 0, stock_mantenimiento: 0, stock_danado: 0,
            stock_minimo: 0, stock_alquilado: 0, stock_subalquilado: 0,
            precio_dia: 0, valor_unitario: 0, dias_minimos: 1,
            es_externo: 0, empresa_externa: null, costo_proveedor_dia: 0,
            categoria_id: catId(categoriaDe(nombre)),
            _key: materialKey(nombre), _norm: normMaterial(nombre),
            _dims: dims(normMaterial(nombre)).join("*")
        };
        articulos.push(a);
        return a;
    }

    const clientesByKey = {};
    function ensureCliente(nombre, extra = {}) {
        const key = upper(nombre).replace(/[^A-Z0-9]+/g, " ").trim();
        if (clientesByKey[key]) {
            const c = clientesByKey[key];
            if (extra.telefono && !c.telefono) c.telefono = extra.telefono;
            if (extra.direccion && !c.direccion) c.direccion = extra.direccion;
            return c;
        }
        const id = nextId(seq, "equioriente_clientes");
        const c = {
            id,
            nombre: nombre.replace(/\s+/g, " ").trim(),
            telefono: extra.telefono || null,
            direccion: extra.direccion || null,
            identificacion: extra.identificacion || null
        };
        clientesByKey[key] = c;
        tables.equioriente_clientes.push(c);
        return c;
    }

    const alquileresByKey = {};
    const remitosByNum = {};

    const rentalFiles = [
        ...(byType.seguimiento || []).map(f => ({ ...f, tipo: "seguimiento" })),
        ...(byType.fiscal || []).map(f => ({ ...f, tipo: "fiscal" })),
        ...(byType.no_fiscal || []).map(f => ({ ...f, tipo: "no_fiscal" }))
    ].sort((a, b) => a.periodo.key.localeCompare(b.periodo.key));

    let sheetCount = 0;
    for (const f of rentalFiles) {
        console.log(`Alquileres [${f.tipo}] ${f.periodo.key}: ${f.rel}`);
        const sheets = await parseRentalBook(f.full, f.tipo, f.periodo);
        sheetCount += sheets.length;
        for (const s of sheets) {
            const cli = ensureCliente(s.cliente, { telefono: s.telefono, direccion: s.direccion });
            const akey = cli.id + "|" + upper(s.obra || s.cliente);
            let alq = alquileresByKey[akey];
            const isCurrent = f.periodo.year >= 2026;
            if (!alq) {
                const id = nextId(seq, "equioriente_alquileres");
                alq = {
                    id,
                    cliente_id: cli.id,
                    usuario_id: 1,
                    fecha_salida: null,
                    fecha_devolucion_esperada: null,
                    fecha_devolucion_real: null,
                    estado: "activo",
                    notas: s.notas || null,
                    tipo_fiscal: s.tipo === "fiscal" ? "fiscal" : s.tipo === "no_fiscal" ? "no_fiscal" : "seguimiento",
                    obra: s.obra || s.direccion || null,
                    periodo: s.periodo,
                    fuente_archivo: s.fuente,
                    fuente_hoja: s.hoja,
                    transporte: s.transporteTotal || 0,
                    total_cobrado: 0,
                    _itemMap: {},
                    _period: s.periodo
                };
                alquileresByKey[akey] = alq;
                tables.equioriente_alquileres.push(alq);
            } else {
                if (s.tipo === "fiscal") alq.tipo_fiscal = "fiscal";
                else if (s.tipo === "no_fiscal" && alq.tipo_fiscal === "seguimiento") alq.tipo_fiscal = "no_fiscal";
                if (s.periodo >= (alq._period || "")) {
                    alq._period = s.periodo;
                    alq.periodo = s.periodo;
                    alq.fuente_archivo = s.fuente;
                    alq.fuente_hoja = s.hoja;
                    if (s.notas) alq.notas = [alq.notas, s.notas].filter(Boolean).join(" | ");
                    alq.transporte = (alq.transporte || 0) + (s.transporteTotal || 0);
                } else {
                    alq.transporte = (alq.transporte || 0) + (s.transporteTotal || 0);
                }
            }

            for (const rem of s.remitos) {
                if (!rem.numero) continue;
                if (!remitosByNum[rem.numero]) {
                    const id = nextId(seq, "equioriente_remitos");
                    remitosByNum[rem.numero] = {
                        id, alquiler_id: alq.id, numero: rem.numero,
                        fecha: rem.fecha, hora: rem.hora,
                        transporte: rem.transporte || 0, placa: rem.placa,
                        fuente: s.fuente
                    };
                    tables.equioriente_remitos.push(remitosByNum[rem.numero]);
                    if (rem.fecha && (!alq.fecha_salida || rem.fecha < alq.fecha_salida)) alq.fecha_salida = rem.fecha + "T08:00:00";
                }
                const remRow = remitosByNum[rem.numero];
                for (const it of rem.items) {
                    const art = ensureArticulo(it.material);
                    const iid = nextId(seq, "equioriente_remito_items");
                    tables.equioriente_remito_items.push({
                        id: iid, remito_id: remRow.id, articulo_id: art.id,
                        cantidad: it.cantidad, material_origen: it.material
                    });
                }
            }

            const cobroByMat = {};
            for (const c of s.cobros) {
                cobroByMat[materialKey(c.material)] = c;
                const art = ensureArticulo(c.material);
                if (!art.precio_dia && c.valor_unitario) art.precio_dia = c.valor_unitario;
                alq.total_cobrado = (alq.total_cobrado || 0) + (c.total || 0);
            }

            if (s.periodo >= (alq._period || "") && (s.tipo === "seguimiento" || !alq._gotSeg)) {
                if (s.tipo === "seguimiento") alq._gotSeg = true;
                if (s.saldoItems.length) {
                    alq._itemMap = {};
                    for (const it of s.saldoItems) {
                        const art = ensureArticulo(it.material);
                        const cob = cobroByMat[materialKey(it.material)];
                        alq._itemMap[art.id] = {
                            articulo_id: art.id,
                            cantidad: Math.abs(it.cantidad),
                            cantidad_devuelta: it.cantidad < 0 ? Math.abs(it.cantidad) : 0,
                            precio_dia_aplicado: cob ? cob.valor_unitario : (art.precio_dia || 0),
                            dias_acordados: cob ? cob.dias : (art.dias_minimos || 1),
                            dias_reales: cob ? cob.dias : null,
                            total_calculado: saneTotal(
                                cob ? cob.valor_unitario : (art.precio_dia || 0),
                                cob ? cob.dias : 1,
                                Math.abs(it.cantidad),
                                cob ? cob.total : null
                            )
                        };
                    }
                } else if (s.cobros.length && !Object.keys(alq._itemMap).length) {
                    for (const c of s.cobros) {
                        const art = ensureArticulo(c.material);
                        alq._itemMap[art.id] = {
                            articulo_id: art.id,
                            cantidad: c.cantidad || 1,
                            cantidad_devuelta: 0,
                            precio_dia_aplicado: c.valor_unitario || art.precio_dia || 0,
                            dias_acordados: c.dias || 1,
                            dias_reales: c.dias || null,
                            total_calculado: saneTotal(c.valor_unitario || art.precio_dia, c.dias, c.cantidad, c.total)
                        };
                    }
                }
            } else if (s.cobros.length) {
                for (const c of s.cobros) {
                    const art = ensureArticulo(c.material);
                    if (!alq._itemMap[art.id]) {
                        alq._itemMap[art.id] = {
                            articulo_id: art.id,
                            cantidad: c.cantidad || 1,
                            cantidad_devuelta: isCurrent ? 0 : (c.cantidad || 1),
                            precio_dia_aplicado: c.valor_unitario || art.precio_dia || 0,
                            dias_acordados: c.dias || 1,
                            dias_reales: c.dias || null,
                            total_calculado: saneTotal(c.valor_unitario || art.precio_dia, c.dias, c.cantidad, c.total)
                        };
                    } else if (!alq._itemMap[art.id].total_calculado) {
                        alq._itemMap[art.id].precio_dia_aplicado = c.valor_unitario || alq._itemMap[art.id].precio_dia_aplicado;
                        alq._itemMap[art.id].dias_acordados = c.dias || alq._itemMap[art.id].dias_acordados;
                        alq._itemMap[art.id].total_calculado = saneTotal(
                            alq._itemMap[art.id].precio_dia_aplicado,
                            alq._itemMap[art.id].dias_acordados,
                            alq._itemMap[art.id].cantidad,
                            c.total
                        );
                    }
                }
            }

            for (const p of s.pagos) {
                const id = nextId(seq, "equioriente_pagos");
                tables.equioriente_pagos.push({
                    id, cliente_id: cli.id, alquiler_id: alq.id,
                    fecha: p.fecha, monto: p.monto, medio: /NEQUI/i.test(p.detalle || "") ? "Nequi" : null,
                    detalle: p.detalle, tipo: /ABONO/i.test(p.detalle || "") ? "abono" : "pago",
                    fuente: s.fuente
                });
            }
        }
    }

    // Finalize alquiler items + estado
    for (const alq of tables.equioriente_alquileres) {
        const items = Object.values(alq._itemMap || {});
        const year = Number((alq.periodo || "0").slice(0, 4));
        let pending = 0;
        for (const it of items) {
            const id = nextId(seq, "equioriente_alquiler_items");
            tables.equioriente_alquiler_items.push({
                id, alquiler_id: alq.id, articulo_id: it.articulo_id,
                cantidad: it.cantidad, cantidad_devuelta: it.cantidad_devuelta || 0,
                precio_dia_aplicado: it.precio_dia_aplicado || 0,
                dias_acordados: it.dias_acordados || 1,
                dias_reales: it.dias_reales,
                total_calculado: saneTotal(it.precio_dia_aplicado, it.dias_acordados, it.cantidad, it.total_calculado)
            });
            pending += Math.max(0, (it.cantidad || 0) - (it.cantidad_devuelta || 0));
        }
        if (pending <= 0) {
            alq.estado = "devuelto";
            if (!alq.fecha_devolucion_real && alq.periodo) alq.fecha_devolucion_real = alq.periodo + "-28T12:00:00";
        } else if (items.some(i => (i.cantidad_devuelta || 0) > 0 && i.cantidad_devuelta < i.cantidad)) {
            alq.estado = "parcial";
        } else {
            alq.estado = year >= 2026 ? "activo" : "devuelto";
            if (alq.estado === "devuelto" && !alq.fecha_devolucion_real) alq.fecha_devolucion_real = (alq.periodo || "2025-12") + "-28T12:00:00";
        }
        if (!alq.fecha_salida) alq.fecha_salida = (alq.periodo || "2026-01") + "-01T08:00:00";
        delete alq._itemMap;
        delete alq._period;
        delete alq._gotSeg;
    }

    // Overlay stock_alquilado from active items
    const alqByArt = {};
    for (const it of tables.equioriente_alquiler_items) {
        const alq = tables.equioriente_alquileres.find(a => a.id === it.alquiler_id);
        if (!alq || alq.estado === "devuelto") continue;
        const pend = (it.cantidad || 0) - (it.cantidad_devuelta || 0);
        alqByArt[it.articulo_id] = (alqByArt[it.articulo_id] || 0) + pend;
    }
    for (const a of articulos) {
        if (alqByArt[a.id] != null) a.stock_alquilado = alqByArt[a.id];
    }

    tables.equioriente_articulos = articulos.map(a => {
        const { _key, _norm, _dims, ...rest } = a;
        return rest;
    });

    // Flujo
    for (const f of byType.flujo || []) {
        console.log("Flujo:", f.rel);
        const rows = await parseFlujo(f.full, f.periodo.year || 2026);
        for (const row of rows) {
            const id = nextId(seq, "equioriente_flujo_caja");
            tables.equioriente_flujo_caja.push({ id, ...row, fuente: f.rel });
        }
    }

    // Cotizaciones
    for (const f of byType.cotizacion || []) {
        console.log("Cotizaciones:", f.rel);
        const cots = await parseCotizacionBook(f.full);
        for (const cot of cots) {
            const cli = ensureCliente(cot.cliente, { telefono: cot.telefono, direccion: cot.direccion });
            const id = nextId(seq, "equioriente_cotizaciones");
            tables.equioriente_cotizaciones.push({
                id, cliente_id: cli.id, fecha: "2023-01-01",
                estado: "historica", total: cot.total, transporte: cot.transporte,
                notas: cot.notas, fuente_archivo: cot.fuente, fuente_hoja: cot.hoja
            });
            for (const it of cot.items) {
                const art = ensureArticulo(it.material);
                const iid = nextId(seq, "equioriente_cotizacion_items");
                tables.equioriente_cotizacion_items.push({
                    id: iid, cotizacion_id: id, articulo_id: art.id,
                    cantidad: it.cantidad, dias: it.dias, valor_unitario: it.valor_unitario, total: it.total
                });
            }
        }
    }

    // Documentos: todos los archivos útiles
    const skipExt = new Set(["ini", "dat", "lnk"]);
    for (const full of allFiles) {
        const rel = path.relative(ROOT, full);
        const base = path.basename(rel);
        if (base.startsWith("~$") || rel.includes("System Volume Information")) continue;
        const ext = path.extname(base).slice(1).toLowerCase();
        if (skipExt.has(ext) || !ext) continue;
        const u = upper(base + " " + rel);
        let tipo = "otro";
        if (/^ACTA|\bACTA\b/.test(u)) tipo = "acta";
        else if (/CONTRATO/.test(u)) tipo = "contrato";
        else if (/INFORME|PYG|P Y G|BALANCE|ESTADOS FINANCIEROS/.test(u)) tipo = "informe";
        else if (/FLUJO/.test(u)) tipo = "flujo";
        else if (/INVENTARIO|VALOR MATERIAL/.test(u)) tipo = "inventario";
        else if (/COTIZACION/.test(u)) tipo = "cotizacion";
        else if (/SEGUIMIENTO/.test(u)) tipo = "seguimiento";
        else if (/ALQUILER/.test(u)) tipo = "alquiler";
        else if (/PRECIO/.test(u)) tipo = "precios";
        else if (ext === "docx" || ext === "odt" || ext === "pdf") tipo = "documento";
        const per = periodFromPath(rel);
        const id = nextId(seq, "equioriente_documentos");
        tables.equioriente_documentos.push({
            id, tipo, titulo: base.replace(path.extname(base), ""),
            archivo: base, ruta: rel, extension: ext,
            anio: per.year || null, mes: per.month || null,
            tamano: fs.statSync(full).size
        });
    }

    const meta = {
        imported_at: new Date().toISOString(),
        source: "Equioriente_Data",
        stats: {
            categorias: tables.equioriente_categorias.length,
            articulos: tables.equioriente_articulos.length,
            clientes: tables.equioriente_clientes.length,
            alquileres: tables.equioriente_alquileres.length,
            alquiler_items: tables.equioriente_alquiler_items.length,
            remitos: tables.equioriente_remitos.length,
            remito_items: tables.equioriente_remito_items.length,
            pagos: tables.equioriente_pagos.length,
            flujo: tables.equioriente_flujo_caja.length,
            documentos: tables.equioriente_documentos.length,
            cotizaciones: tables.equioriente_cotizaciones.length,
            hojas_alquiler: sheetCount
        }
    };

    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify({ meta, tables, seq }));
    console.log("\n✓ Guardado", STORE);
    console.log(JSON.stringify(meta.stats, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
