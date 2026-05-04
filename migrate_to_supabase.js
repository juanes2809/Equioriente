/**
 * migrate_to_supabase.js
 * ──────────────────────
 * Copia todos los datos del SQLite local (rental.db) a Supabase.
 * Script de uso único para la migración inicial.
 *
 * Pasos:
 *   1. Ejecuta supabase_schema.sql en Supabase (SQL Editor → Run).
 *   2. Completa SUPABASE_URL y SUPABASE_KEY en .env.
 *   3. Instala sqlite3 temporalmente: npm install sqlite3
 *   4. node migrate_to_supabase.js
 *   5. Después de migrar puedes desinstalar: npm uninstall sqlite3
 *
 * Seguro de re-ejecutar: usa upsert con ignoreDuplicates.
 */

const path = require("path");

// Carga .env manualmente sin depender de dotenv
const fs = require("fs");
const envLines = fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n");
envLines.forEach(line => {
    const [key, ...rest] = line.split("=");
    if (key && !key.trim().startsWith("#") && rest.length) {
        process.env[key.trim()] = rest.join("=").trim();
    }
});

const { createClient } = require("@supabase/supabase-js");
let sqlite3;
try {
    sqlite3 = require("sqlite3").verbose();
} catch {
    console.error("ERROR: sqlite3 no está instalado. Ejecuta: npm install sqlite3");
    process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY || SUPABASE_URL.includes("tu-proyecto")) {
    console.error("ERROR: Configura SUPABASE_URL y SUPABASE_KEY reales en .env");
    process.exit(1);
}

const sb     = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const sqlite = new sqlite3.Database("rental.db");

const sqliteAll = (sql) => new Promise((resolve, reject) =>
    sqlite.all(sql, [], (err, rows) => err ? reject(err) : resolve(rows || [])));

let totalInserted = 0;

async function insertRows(table, rows) {
    if (!rows.length) { console.log(`  ${table}: sin datos`); return; }

    // Supabase upsert en lotes de 100 para no superar el límite de request
    const BATCH = 100;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const { error, count } = await sb.from(table)
            .upsert(batch, { onConflict: "id", ignoreDuplicates: true })
            .select("id");
        if (error) {
            console.warn(`    ↳ Error en lote: ${error.message.split("\n")[0]}`);
        } else {
            inserted += count ?? batch.length;
        }
    }
    console.log(`  ${table}: ${inserted}/${rows.length} filas insertadas`);
    totalInserted += inserted;
}

function normalizeDates(rows, cols) {
    rows.forEach(r => {
        cols.forEach(col => {
            if (typeof r[col] === "string" && r[col].trim()) {
                r[col] = r[col].replace(" ", "T");
            } else if (!r[col]) {
                r[col] = null;
            }
        });
    });
}

async function resetSequences(tables) {
    console.log("\nReseteando secuencias de IDs...");
    for (const table of tables) {
        const { error } = await sb.rpc("equioriente_reset_sequence", { p_table: table });
        if (error) process.stdout.write("!");
        else process.stdout.write(".");
    }
    console.log(" OK\n");
}

async function migrate() {
    console.log("═══════════════════════════════════════════════════════");
    console.log(" Migración SQLite → Supabase  (tablas equioriente_*)");
    console.log("═══════════════════════════════════════════════════════\n");

    const migrations = [
        { table: "equioriente_usuarios",               dateCols: [] },
        { table: "equioriente_categorias",             dateCols: [] },
        { table: "equioriente_clientes",               dateCols: [] },
        { table: "equioriente_articulos",              dateCols: [] },
        { table: "equioriente_alquileres",             dateCols: ["fecha_salida", "fecha_devolucion_real"] },
        { table: "equioriente_alquiler_items",         dateCols: [] },
        { table: "equioriente_devoluciones_proveedor", dateCols: ["fecha_devolucion"] },
        { table: "equioriente_movimientos_inventario", dateCols: ["fecha"] },
        { table: "equioriente_registro_danos",         dateCols: ["fecha"] },
    ];

    for (const { table, dateCols } of migrations) {
        process.stdout.write(`Migrando ${table}... `);
        let rows;
        try {
            rows = await sqliteAll(`SELECT * FROM ${table}`);
        } catch {
            // Intenta con nombre sin prefijo (base de datos antigua)
            const oldName = table.replace("equioriente_", "");
            try {
                rows = await sqliteAll(`SELECT * FROM ${oldName}`);
                process.stdout.write(`(nombre antiguo '${oldName}') `);
            } catch {
                console.log(`OMITIDA (tabla no encontrada)`);
                continue;
            }
        }
        console.log(`${rows.length} filas`);
        if (dateCols.length) normalizeDates(rows, dateCols);
        await insertRows(table, rows);
    }

    // Nota: para resetear las secuencias de IDs necesitas crear esta función en Supabase:
    //   CREATE OR REPLACE FUNCTION equioriente_reset_sequence(p_table TEXT)
    //   RETURNS void LANGUAGE plpgsql AS $$
    //   BEGIN
    //     EXECUTE format('SELECT setval(''%I_id_seq'', COALESCE((SELECT MAX(id) FROM %I), 0) + 1, false)', p_table, p_table);
    //   END; $$;
    // O ejecuta manualmente en SQL Editor para cada tabla:
    //   SELECT setval('equioriente_usuarios_id_seq', (SELECT MAX(id) FROM equioriente_usuarios) + 1);

    console.log("═══════════════════════════════════════════════════════");
    console.log(` Total filas procesadas: ${totalInserted}`);
    console.log("═══════════════════════════════════════════════════════");
    console.log("\n✓ Migración completada.");
    console.log("  Recuerda resetear las secuencias de ID en Supabase SQL Editor.\n");
}

migrate()
    .catch(e => { console.error("\nERROR:", e.message); process.exit(1); })
    .finally(() => sqlite.close());
