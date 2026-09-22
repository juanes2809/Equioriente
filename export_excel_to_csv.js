/**
 * Exporta cada hoja de cada .xlsx de Equioriente_Data a CSV
 * junto al libro original, para revisión y limpieza.
 *
 *   node export_excel_to_csv.js
 */
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const ROOT = path.join(__dirname, "Equioriente_Data");

function walkXlsx(dir, acc = []) {
    for (const name of fs.readdirSync(dir)) {
        if (name.startsWith("~$") || name === "System Volume Information") continue;
        const full = path.join(dir, name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.isDirectory()) walkXlsx(full, acc);
        else if (/\.xlsx$/i.test(name)) acc.push(full);
    }
    return acc;
}

function cellOut(cell) {
    if (!cell || cell.value == null || cell.value === "") return "";
    const v = cell.value;
    if (typeof v === "object") {
        if (v instanceof Date && !Number.isNaN(v.getTime())) {
            if (v.getFullYear() < 1950) {
                return v.toISOString().slice(11, 16);
            }
            return v.toISOString().slice(0, 10);
        }
        if (v.result !== undefined && v.result !== null && v.result !== "undefined") {
            if (v.result instanceof Date) return v.result.toISOString().slice(0, 10);
            return String(v.result);
        }
        if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join("");
        if (v.text) return v.text;
        if (v.hyperlink) return v.text || v.hyperlink;
        return "";
    }
    return String(v);
}

function csvEscape(s) {
    const t = String(s ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
}

function safeSheet(name) {
    return String(name || "Hoja")
        .replace(/[<>:"/\\|?*]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80) || "Hoja";
}

async function exportBook(fp) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fp);
    const dir = path.dirname(fp);
    const base = path.basename(fp, path.extname(fp));
    const out = [];
    const used = new Set();

    for (const ws of wb.worksheets) {
        const maxR = ws.rowCount || 0;
        const maxC = ws.columnCount || 0;
        if (!maxR || !maxC) continue;

        let lastR = 0, lastC = 0;
        const grid = [];
        for (let r = 1; r <= maxR; r++) {
            const row = ws.getRow(r);
            const cells = [];
            let rowHas = false;
            for (let c = 1; c <= maxC; c++) {
                const val = cellOut(row.getCell(c));
                cells.push(val);
                if (val !== "") { rowHas = true; lastC = Math.max(lastC, c); }
            }
            if (rowHas) lastR = r;
            grid.push(cells);
        }
        if (!lastR) continue;

        const lines = [];
        for (let r = 0; r < lastR; r++) {
            const slice = grid[r].slice(0, lastC);
            lines.push(slice.map(csvEscape).join(","));
        }

        let sheet = safeSheet(ws.name);
        let fname = `${base}__${sheet}.csv`;
        let n = 2;
        while (used.has(fname.toLowerCase())) {
            fname = `${base}__${sheet}-${n++}.csv`;
        }
        used.add(fname.toLowerCase());

        const dest = path.join(dir, fname);
        fs.writeFileSync(dest, "\uFEFF" + lines.join("\n") + "\n", "utf8");
        out.push({
            csv: path.relative(ROOT, dest),
            libro: path.relative(ROOT, fp),
            hoja: ws.name,
            filas: lastR,
            columnas: lastC
        });
    }
    return out;
}

async function main() {
    const files = walkXlsx(ROOT);
    const all = [];
    console.log(`Exportando ${files.length} libros Excel → CSV (una hoja = un csv)\n`);
    for (const fp of files) {
        process.stdout.write(path.relative(ROOT, fp) + " ... ");
        try {
            const rows = await exportBook(fp);
            console.log(`${rows.length} hojas`);
            all.push(...rows);
        } catch (e) {
            console.log("ERROR:", e.message);
        }
    }
    const indexPath = path.join(ROOT, "_INDICE_CSV.csv");
    const header = "csv,libro,hoja,filas,columnas";
    const body = all.map(r => [r.csv, r.libro, r.hoja, r.filas, r.columnas].map(csvEscape).join(","));
    fs.writeFileSync(indexPath, "\uFEFF" + [header, ...body].join("\n") + "\n", "utf8");
    console.log(`\n${all.length} CSV creados. Índice: Equioriente_Data/_INDICE_CSV.csv`);
}

main().catch(e => { console.error(e); process.exit(1); });
