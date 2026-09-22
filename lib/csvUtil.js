"use strict";

function parseCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += ch;
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ",") {
            row.push(field);
            field = "";
        } else if (ch === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else if (ch !== "\r") {
            field += ch;
        }
    }
    if (field.length || row.length) {
        row.push(field);
        rows.push(row);
    }
    while (rows.length && rows[rows.length - 1].every(c => String(c || "").trim() === "")) rows.pop();
    return rows;
}

function csvEscape(v) {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function writeCsv(filePath, headers, rows) {
    const fs = require("fs");
    const path = require("path");
    const lines = [headers.map(csvEscape).join(",")];
    for (const r of rows) {
        lines.push(headers.map(h => csvEscape(r[h])).join(","));
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

function readCsvFile(filePath) {
    const fs = require("fs");
    const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
    if (!rows.length) return [];
    const headers = rows[0].map(h => String(h || "").trim());
    return rows.slice(1).filter(r => r.some(c => String(c || "").trim() !== "")).map(r => {
        const o = {};
        headers.forEach((h, i) => { o[h] = r[i] == null ? "" : r[i]; });
        return o;
    });
}

module.exports = { parseCsv, csvEscape, writeCsv, readCsvFile };
