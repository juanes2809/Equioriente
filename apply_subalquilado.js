/**
 * Carga FORMALETA SUBALQUILADA 2026.xlsx al proyecto Equioriente (Supabase).
 * No toca el total propio. Solo saldos/movimientos de proveedores.
 *
 *   node apply_subalquilado.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
if (typeof global.WebSocket === "undefined") {
    try { global.WebSocket = require("ws"); }
    catch { global.WebSocket = class { constructor() {} close() {} addEventListener() {} removeEventListener() {} send() {} }; }
}
const { createClient } = require("@supabase/supabase-js");
const { parseSubalquiladaXlsx } = require("./lib/parseSubalquilada");
const { materialKey, findArticulo, attachKeys, upper } = require("./lib/materialMatch");

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

function categoriaDe(nombre) {
    const n = upper(nombre);
    if (/ANDAMIO|MARCOS|CRUCETA|TABLON|RUEDA|PASAMANOS/.test(n)) return "Andamios";
    if (/TABLERO METALICO|FORMALETA|RINCONERA|ANGULO|CHAPETA|TENSOR|ALINEADOR|CORBATA|PINES/.test(n)) return "Formaleta";
    if (/PARAL/.test(n)) return "Puntales";
    if (/CERCHA/.test(n)) return "Cerchas";
    if (/MADERA|BANDA|TABLERO MADERA/.test(n)) return "Madera";
    if (/ESCALERA|POLEA|MEZCLADORA/.test(n)) return "Equipos";
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

async function main() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    const appKey = process.env.EQUIORIENTE_APP_KEY || "";
    if (!url || !key) throw new Error("Falta SUPABASE_URL / SUPABASE_KEY");
    const xlsx = path.join(__dirname, "Equioriente_Data", "FORMALETA SUBALQUILADA 2026.xlsx");
    if (!fs.existsSync(xlsx)) throw new Error("No está " + xlsx);

    const sb = createClient(url, key, {
        auth: { persistSession: false },
        global: appKey ? { headers: { "x-equioriente-key": appKey } } : undefined
    });
    const { data: arts, error: e1 } = await sb.from("equioriente_articulos").select("*");
    if (e1) throw e1;
    const { data: cats, error: e2 } = await sb.from("equioriente_categorias").select("*");
    if (e2) throw e2;
    const articulos = (arts || []).map(a => attachKeys({ ...a }));
    const usedRef = new Set(articulos.map(a => a.referencia));
    const catByName = {};
    for (const c of cats || []) catByName[c.nombre] = c.id;

    const sub = await parseSubalquiladaXlsx(xlsx);
    const created = [];
    const saldosRows = [];
    const byArtSub = new Map();

    for (const s of sub.saldos) {
        let art = findArticulo(articulos, s.material);
        if (!art && Number(s.saldo) > 0) {
            const catName = categoriaDe(s.material);
            let categoria_id = catByName[catName];
            if (!categoria_id) {
                const { data: cat, error } = await sb.from("equioriente_categorias")
                    .insert({ nombre: catName }).select("id").single();
                if (error) throw error;
                categoria_id = cat.id;
                catByName[catName] = categoria_id;
            }
            const row = {
                referencia: makeRef(s.material, usedRef),
                nombre: s.material,
                stock_total: 0,
                stock_disponible: 0,
                stock_alquilado: 0,
                stock_subalquilado: 0,
                stock_danado: 0,
                stock_minimo: 0,
                precio_dia: 0,
                es_externo: 1,
                empresa_externa: s.proveedor,
                categoria_id
            };
            const { data: ins, error } = await sb.from("equioriente_articulos").insert(row).select("*").single();
            if (error) throw error;
            art = attachKeys(ins);
            articulos.push(art);
            created.push(art.nombre + " (" + s.proveedor + ")");
        }
        if (!art) continue;
        const q = Number(s.saldo) || 0;
        if (q > 0) byArtSub.set(art.id, (byArtSub.get(art.id) || 0) + q);
        saldosRows.push({
            proveedor: s.proveedor,
            articulo_id: art.id,
            material: s.material,
            saldo: q
        });
    }

    const movRows = sub.movimientos.map(m => {
        const art = findArticulo(articulos, m.material);
        return {
            proveedor: m.proveedor,
            articulo_id: art ? art.id : null,
            material: m.material,
            fecha: m.fecha || null,
            hora: m.hora || null,
            remito: m.remito || null,
            cantidad: m.cantidad,
            cliente_ref: m.cliente_ref || null,
            notas: m.notas || null
        };
    });

    const { error: d1 } = await sb.from("equioriente_subalquiler_mov").delete().neq("id", 0);
    if (d1) throw d1;
    const { error: d2 } = await sb.from("equioriente_subalquiler_saldo").delete().neq("id", 0);
    if (d2) throw d2;

    for (let i = 0; i < movRows.length; i += 100) {
        const { error } = await sb.from("equioriente_subalquiler_mov").insert(movRows.slice(i, i + 100));
        if (error) throw error;
    }
    for (let i = 0; i < saldosRows.length; i += 100) {
        const { error } = await sb.from("equioriente_subalquiler_saldo").insert(saldosRows.slice(i, i + 100));
        if (error) throw error;
    }

    const { data: allArts, error: e3 } = await sb.from("equioriente_articulos").select("id, stock_subalquilado");
    if (e3) throw e3;
    for (const a of allArts || []) {
        const q = byArtSub.get(a.id) || byArtSub.get(Number(a.id)) || 0;
        if ((a.stock_subalquilado || 0) !== q) {
            const { error } = await sb.from("equioriente_articulos").update({ stock_subalquilado: q }).eq("id", a.id);
            if (error) throw error;
        }
    }

    console.log("Movimientos", movRows.length);
    console.log("Saldos", saldosRows.filter(s => s.saldo > 0));
    console.log("Artículos nuevos", created);
    console.log("Stock subalquilado por artículo", [...byArtSub.entries()]);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
