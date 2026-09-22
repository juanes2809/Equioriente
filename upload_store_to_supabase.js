/**
 * Sube data/store.json a Supabase.
 *
 *   1. Ejecuta supabase_schema.sql en el SQL Editor.
 *   2. Pon SUPABASE_URL y SUPABASE_KEY (service_role) en .env
 *   3. node upload_store_to_supabase.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
if (typeof global.WebSocket === "undefined") {
    try { global.WebSocket = require("ws"); }
    catch { global.WebSocket = class { constructor() {} close() {} addEventListener() {} removeEventListener() {} send() {} }; }
}
const { createClient } = require("@supabase/supabase-js");

function loadEnv() {
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const i = t.indexOf("=");
        if (i < 0) continue;
        const k = t.slice(0, i).trim();
        const v = t.slice(i + 1).trim();
        if (k && process.env[k] == null) process.env[k] = v;
    }
}
loadEnv();

const URL = process.env.SUPABASE_URL || "";
const KEY = process.env.SUPABASE_KEY || "";
if (!URL || !KEY || /tu-proyecto|tu_service/i.test(URL + KEY)) {
    console.error("Falta SUPABASE_URL y SUPABASE_KEY reales en .env");
    console.error("Supabase → Settings → API → Project URL y service_role");
    process.exit(1);
}

const STORE = path.join(__dirname, "data", "store.json");
if (!fs.existsSync(STORE)) {
    console.error("No existe data/store.json. Corre: node import_canon.js");
    process.exit(1);
}

const ORDER = [
    "equioriente_usuarios",
    "equioriente_categorias",
    "equioriente_clientes",
    "equioriente_articulos",
    "equioriente_obras",
    "equioriente_cuentas",
    "equioriente_alquileres",
    "equioriente_periodos_cuenta",
    "equioriente_alquiler_items",
    "equioriente_remitos",
    "equioriente_pagos",
    "equioriente_flujo_caja",
    "equioriente_documentos",
    "equioriente_cotizaciones",
    "equioriente_remito_items",
    "equioriente_movimientos",
    "equioriente_saldos_periodo",
    "equioriente_cobros",
    "equioriente_viajes",
    "equioriente_devoluciones_proveedor",
    "equioriente_movimientos_inventario",
    "equioriente_registro_danos",
    "equioriente_cotizacion_items"
];

const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const BATCH = 100;

async function upsert(table, rows) {
    if (!rows.length) {
        console.log(`  ${table}: 0`);
        return 0;
    }
    let n = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH).map(r => {
            const copy = { ...r };
            delete copy._key;
            delete copy._norm;
            delete copy._dims;
            return copy;
        });
        const { error } = await sb.from(table).upsert(batch, { onConflict: "id" });
        if (error) throw new Error(table + ": " + error.message);
        n += batch.length;
    }
    console.log(`  ${table}: ${n}`);
    return n;
}

async function main() {
    const store = JSON.parse(fs.readFileSync(STORE, "utf8"));
    const tables = store.tables || {};
    console.log("Subiendo", STORE, "→", URL.replace(/https?:\/\//, "").split(".")[0], "…\n");
    const { error: ping } = await sb.from("equioriente_articulos").select("id").limit(1);
    if (ping) {
        console.error("No se pudo conectar o faltan tablas:", ping.message);
        console.error("Ejecuta supabase_schema.sql en el SQL Editor y vuelve a intentar.");
        process.exit(1);
    }
    let total = 0;
    for (const name of ORDER) {
        total += await upsert(name, tables[name] || []);
    }
    console.log("\nListo:", total, "filas en Supabase.");
}

main().catch(e => {
    console.error(e.message || e);
    process.exit(1);
});
