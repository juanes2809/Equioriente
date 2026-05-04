/**
 * migrate_to_supabase.js
 * ──────────────────────
 * Copia todos los datos del SQLite local (rental.db) a Supabase.
 * Las tablas SQLite ya tienen el prefijo equioriente_ (aplicado
 * automáticamente al reiniciar el servidor con la nueva versión).
 *
 * Uso:
 *   1. Ejecuta supabase_schema.sql en Supabase (SQL Editor → Run).
 *   2. Define DATABASE_URL en .env con la connection string de Supabase.
 *   3. Inicia el servidor al menos una vez para que SQLite migre los nombres.
 *   4. node migrate_to_supabase.js
 *
 * Seguro de re-ejecutar: usa INSERT ... ON CONFLICT DO NOTHING.
 */

require("dotenv").config();

const sqlite3 = require("sqlite3").verbose();
const { Pool }  = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error("ERROR: DATABASE_URL no está definido en .env");
    process.exit(1);
}

const sqlite = new sqlite3.Database("rental.db");
const pg     = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const sqliteAll = (sql) => new Promise((resolve, reject) =>
    sqlite.all(sql, [], (err, rows) => err ? reject(err) : resolve(rows || [])));

let totalInserted = 0;

async function insertRows(table, rows) {
    if (!rows.length) { console.log(`  ${table}: sin datos`); return; }
    let inserted = 0;
    for (const row of rows) {
        const cols = Object.keys(row);
        const vals = Object.values(row);
        const nums = cols.map((_, i) => `$${i + 1}`);
        const sql  = `INSERT INTO ${table} (${cols.join(",")}) VALUES (${nums.join(",")}) ON CONFLICT (id) DO NOTHING`;
        try {
            const r = await pg.query(sql, vals);
            inserted += r.rowCount;
        } catch (e) {
            console.warn(`    ↳ Fila omitida (conflicto): ${e.message.split("\n")[0]}`);
        }
    }
    console.log(`  ${table}: ${inserted}/${rows.length} filas insertadas`);
    totalInserted += inserted;
}

async function resetSequence(table) {
    await pg.query(
        `SELECT setval('${table}_id_seq', COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`
    );
}

function normalizeDates(rows, cols) {
    rows.forEach(r => {
        cols.forEach(col => {
            if (typeof r[col] === "string" && r[col].trim()) {
                r[col] = r[col].replace(" ", "T"); // SQLite stores dates without T
            } else if (!r[col]) {
                r[col] = null;
            }
        });
    });
}

async function migrate() {
    console.log("═══════════════════════════════════════════════════════");
    console.log(" Migración SQLite → Supabase  (tablas equioriente_*)");
    console.log("═══════════════════════════════════════════════════════\n");

    // Tablas en orden de dependencia (FK)
    const migrations = [
        { table: "equioriente_usuarios",              dateCols: [] },
        { table: "equioriente_categorias",            dateCols: [] },
        { table: "equioriente_clientes",              dateCols: [] },
        { table: "equioriente_articulos",             dateCols: [] },
        { table: "equioriente_alquileres",            dateCols: ["fecha_salida", "fecha_devolucion_real"] },
        { table: "equioriente_alquiler_items",        dateCols: [] },
        { table: "equioriente_devoluciones_proveedor",dateCols: ["fecha_devolucion"] },
        { table: "equioriente_movimientos_inventario",dateCols: ["fecha"] },
        { table: "equioriente_registro_danos",        dateCols: ["fecha"] },
    ];

    for (const { table, dateCols } of migrations) {
        process.stdout.write(`Migrando ${table}... `);
        let rows;
        try {
            rows = await sqliteAll(`SELECT * FROM ${table}`);
        } catch (e) {
            // Table might still have old name (not yet migrated by server restart)
            const oldName = table.replace("equioriente_", "");
            try {
                rows = await sqliteAll(`SELECT * FROM ${oldName}`);
                console.log(`(usando nombre antiguo '${oldName}') `, "");
            } catch (_) {
                console.log(`OMITIDA (tabla no encontrada)`);
                continue;
            }
        }
        console.log(`${rows.length} filas → `);
        if (dateCols.length) normalizeDates(rows, dateCols);
        await insertRows(table, rows);
    }

    // Reset sequences so new inserts get correct IDs
    console.log("\nReseteando secuencias de IDs...");
    for (const { table } of migrations) {
        try { await resetSequence(table); process.stdout.write(`.`); }
        catch (_) {}
    }
    console.log(" OK\n");

    console.log("═══════════════════════════════════════════════════════");
    console.log(` Total filas migradas: ${totalInserted}`);
    console.log("═══════════════════════════════════════════════════════");
    console.log("\n✓ Migración completada.");
    console.log("  Descomenta DATABASE_URL en .env y reinicia el servidor.\n");
}

migrate()
    .catch(e => { console.error("\nERROR:", e.message); process.exit(1); })
    .finally(() => { sqlite.close(); pg.end(); });
