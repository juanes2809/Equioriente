require("dotenv").config();
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "equioriente_secret_key_change_in_production";
const SALT_ROUNDS = 10;
const BACKUP_DIR = path.join(__dirname, "backups");

const app = express();
app.use(express.json());
app.use(express.static("."));

// ── Ensure backup directory exists ───────────────────
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

// ── Database: SQLite (local) or PostgreSQL (Supabase) ─
let pgPool = null;
let db = null;

if (process.env.DATABASE_URL) {
    const { Pool, types } = require("pg");
    // Return timestamp columns as strings to match SQLite behavior
    types.setTypeParser(1114, v => v); // TIMESTAMP
    types.setTypeParser(1184, v => v); // TIMESTAMPTZ
    types.setTypeParser(1082, v => v); // DATE
    pgPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    console.log("Usando PostgreSQL (Supabase)");
} else {
    db = new sqlite3.Database("rental.db");
    console.log("Usando SQLite local");
}

// ── SQL translator: SQLite dialect → PostgreSQL ───────
function pgSQL(sql) {
    let i = 0;
    const isIgnoreInsert = /INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql);
    let s = sql
        // strftime + nested date(): strftime('%Y-%m', date('now', '-N months'))
        .replace(/strftime\s*\(\s*'%Y-%m'\s*,\s*date\s*\(\s*'now'\s*,\s*'([^']+)'\s*\)\s*\)/gi,
            (_, iv) => `TO_CHAR(NOW() + INTERVAL '${iv}', 'YYYY-MM')`)
        // strftime('%Y-%m', 'now')
        .replace(/strftime\s*\(\s*'%Y-%m'\s*,\s*'now'\s*\)/gi, "TO_CHAR(NOW(), 'YYYY-MM')")
        // strftime('%Y-%m', col)
        .replace(/strftime\s*\(\s*'%Y-%m'\s*,\s*([a-zA-Z_.]+)\s*\)/gi,
            (_, col) => `TO_CHAR((${col})::timestamptz, 'YYYY-MM')`)
        // date('now', '-N months/month')
        .replace(/\bdate\s*\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi,
            (_, iv) => `(NOW() + INTERVAL '${iv}')::date`)
        // DATE('now')
        .replace(/\bDATE\s*\(\s*'now'\s*\)/gi, "CURRENT_DATE")
        // DATE(col) → (col)::date
        .replace(/\bDATE\s*\(\s*([a-zA-Z_.]+)\s*\)/g,
            (_, col) => `(${col})::date`)
        // CAST(julianday('now') - julianday(col) AS INTEGER)
        .replace(/CAST\s*\(\s*julianday\s*\(\s*'now'\s*\)\s*-\s*julianday\s*\(([^)]+)\)\s+AS\s+INTEGER\s*\)/gi,
            (_, col) => `EXTRACT(DAY FROM (CURRENT_DATE - (${col.trim()})::date))::int`)
        // MAX(0, expr) → GREATEST(0, expr)
        .replace(/\bMAX\s*\(\s*0\s*,/g, "GREATEST(0,")
        // CAST(col AS TEXT) → col::text  (for LIKE queries)
        .replace(/CAST\s*\(\s*([a-zA-Z_.]+)\s+AS\s+TEXT\s*\)/gi, "($1)::text")
        // INSERT OR IGNORE
        .replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO")
        // ? → $N param placeholders
        .replace(/\?/g, () => `$${++i}`);

    if (isIgnoreInsert) s = s.trimEnd().replace(/;?\s*$/, "") + " ON CONFLICT DO NOTHING";
    return s;
}

// ── Unified db helpers ────────────────────────────────
const dbGet = async (sql, params = []) => {
    if (pgPool) {
        const r = await pgPool.query(pgSQL(sql), params);
        return r.rows[0] || null;
    }
    return new Promise((resolve, reject) =>
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
};

const dbAll = async (sql, params = []) => {
    if (pgPool) {
        const r = await pgPool.query(pgSQL(sql), params);
        return r.rows;
    }
    return new Promise((resolve, reject) =>
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));
};

const dbRun = async (sql, params = []) => {
    if (pgPool) {
        let pgSql = pgSQL(sql);
        if (/^\s*INSERT\s+INTO/i.test(pgSql) && !/RETURNING/i.test(pgSql))
            pgSql = pgSql.trimEnd() + " RETURNING id";
        const r = await pgPool.query(pgSql, params);
        return { lastID: r.rows[0]?.id || null, changes: r.rowCount };
    }
    return new Promise((resolve, reject) =>
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        }));
};

// ── Schema init ───────────────────────────────────────
async function initDB() {
    if (pgPool) {
        // PostgreSQL / Supabase schema
        const stmts = [
            `CREATE TABLE IF NOT EXISTS equioriente_usuarios (
                id BIGSERIAL PRIMARY KEY, usuario TEXT UNIQUE, password TEXT, rol TEXT)`,
            `CREATE TABLE IF NOT EXISTS equioriente_clientes (
                id BIGSERIAL PRIMARY KEY, nombre TEXT NOT NULL, telefono TEXT,
                direccion TEXT, identificacion TEXT UNIQUE)`,
            `CREATE TABLE IF NOT EXISTS equioriente_categorias (
                id BIGSERIAL PRIMARY KEY, nombre TEXT UNIQUE)`,
            `CREATE TABLE IF NOT EXISTS equioriente_articulos (
                id BIGSERIAL PRIMARY KEY, referencia TEXT UNIQUE NOT NULL, nombre TEXT NOT NULL,
                stock_total INTEGER NOT NULL DEFAULT 0, stock_disponible INTEGER NOT NULL DEFAULT 0,
                stock_mantenimiento INTEGER NOT NULL DEFAULT 0, stock_danado INTEGER NOT NULL DEFAULT 0,
                stock_minimo INTEGER NOT NULL DEFAULT 0, precio_dia FLOAT NOT NULL DEFAULT 0,
                es_externo SMALLINT NOT NULL DEFAULT 0, empresa_externa TEXT,
                costo_proveedor_dia FLOAT DEFAULT 0, categoria_id BIGINT REFERENCES equioriente_categorias(id))`,
            `CREATE TABLE IF NOT EXISTS equioriente_alquileres (
                id BIGSERIAL PRIMARY KEY, cliente_id BIGINT NOT NULL REFERENCES equioriente_clientes(id),
                usuario_id BIGINT NOT NULL REFERENCES equioriente_usuarios(id),
                fecha_salida TIMESTAMPTZ DEFAULT NOW(),
                fecha_devolucion_esperada TEXT, fecha_devolucion_real TIMESTAMPTZ,
                estado TEXT DEFAULT 'activo', notas TEXT)`,
            `CREATE TABLE IF NOT EXISTS equioriente_alquiler_items (
                id BIGSERIAL PRIMARY KEY, alquiler_id BIGINT NOT NULL REFERENCES equioriente_alquileres(id),
                articulo_id BIGINT NOT NULL REFERENCES equioriente_articulos(id),
                cantidad INTEGER NOT NULL, cantidad_devuelta INTEGER NOT NULL DEFAULT 0,
                precio_dia_aplicado FLOAT NOT NULL, dias_acordados INTEGER NOT NULL DEFAULT 1,
                dias_reales INTEGER, total_calculado FLOAT)`,
            `CREATE TABLE IF NOT EXISTS equioriente_devoluciones_proveedor (
                id BIGSERIAL PRIMARY KEY, articulo_id BIGINT NOT NULL REFERENCES equioriente_articulos(id),
                cantidad INTEGER NOT NULL, fecha_retiro TEXT, fecha_devolucion TIMESTAMPTZ DEFAULT NOW(),
                dias_reales INTEGER, costo_proveedor_dia FLOAT, total_costo FLOAT, notas TEXT,
                usuario_id BIGINT REFERENCES equioriente_usuarios(id))`,
            `CREATE TABLE IF NOT EXISTS equioriente_movimientos_inventario (
                id BIGSERIAL PRIMARY KEY, articulo_id BIGINT NOT NULL REFERENCES equioriente_articulos(id),
                tipo TEXT NOT NULL, cantidad INTEGER NOT NULL, motivo TEXT, referencia_id BIGINT,
                usuario_id BIGINT REFERENCES equioriente_usuarios(id), fecha TIMESTAMPTZ DEFAULT NOW())`,
            `CREATE TABLE IF NOT EXISTS equioriente_registro_danos (
                id BIGSERIAL PRIMARY KEY, articulo_id BIGINT NOT NULL REFERENCES equioriente_articulos(id),
                alquiler_id BIGINT REFERENCES equioriente_alquileres(id), cliente_id BIGINT REFERENCES equioriente_clientes(id),
                cantidad INTEGER NOT NULL DEFAULT 1, tipo TEXT NOT NULL DEFAULT 'dano',
                descripcion TEXT, costo_reparacion FLOAT DEFAULT 0, cobrado_cliente SMALLINT DEFAULT 0,
                monto_cobrado FLOAT DEFAULT 0, estado TEXT DEFAULT 'pendiente',
                usuario_id BIGINT REFERENCES equioriente_usuarios(id), fecha TIMESTAMPTZ DEFAULT NOW())`,
        ];
        for (const sql of stmts) await pgPool.query(sql);

        // Default seed rows
        await pgPool.query(`INSERT INTO equioriente_categorias (nombre) VALUES ('General') ON CONFLICT DO NOTHING`);
        const adminHash = bcrypt.hashSync("1234", SALT_ROUNDS);
        await pgPool.query(`INSERT INTO equioriente_usuarios (usuario, password, rol) VALUES ('admin', $1, 'admin') ON CONFLICT DO NOTHING`, [adminHash]);
        await pgPool.query(`INSERT INTO equioriente_usuarios (usuario, password, rol) VALUES ('operario', $1, 'operario') ON CONFLICT DO NOTHING`, [adminHash]);
        console.log("Schema PostgreSQL OK");
    } else {
        // SQLite schema (run synchronously via serialize)
        await new Promise(resolve => db.serialize(() => {
            const run = sql => db.run(sql, () => {});
            // ── One-time migration: rename old tables (no prefix) to new names ──
            const oldTables = [
                'registro_danos', 'movimientos_inventario', 'devoluciones_proveedor',
                'alquiler_items', 'alquileres', 'articulos', 'clientes', 'categorias', 'usuarios'
            ];
            for (const t of oldTables)
                db.run(`ALTER TABLE ${t} RENAME TO equioriente_${t}`, () => {});
            run(`CREATE TABLE IF NOT EXISTS equioriente_usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT UNIQUE, password TEXT, rol TEXT)`);
            run(`CREATE TABLE IF NOT EXISTS equioriente_clientes (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, telefono TEXT, direccion TEXT, identificacion TEXT UNIQUE)`);
            run(`CREATE TABLE IF NOT EXISTS equioriente_categorias (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT UNIQUE)`);
            run(`CREATE TABLE IF NOT EXISTS equioriente_articulos (id INTEGER PRIMARY KEY AUTOINCREMENT, referencia TEXT UNIQUE NOT NULL, nombre TEXT NOT NULL, stock_total INTEGER NOT NULL DEFAULT 0, stock_disponible INTEGER NOT NULL DEFAULT 0, stock_mantenimiento INTEGER NOT NULL DEFAULT 0, stock_danado INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, precio_dia REAL NOT NULL DEFAULT 0, es_externo INTEGER NOT NULL DEFAULT 0, empresa_externa TEXT, costo_proveedor_dia REAL DEFAULT 0, categoria_id INTEGER, FOREIGN KEY(categoria_id) REFERENCES equioriente_categorias(id))`);
            run(`CREATE TABLE IF NOT EXISTS equioriente_alquileres (id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_id INTEGER NOT NULL, usuario_id INTEGER NOT NULL, fecha_salida TEXT DEFAULT CURRENT_TIMESTAMP, fecha_devolucion_esperada TEXT, fecha_devolucion_real TEXT, estado TEXT DEFAULT 'activo', notas TEXT, FOREIGN KEY(cliente_id) REFERENCES equioriente_clientes(id), FOREIGN KEY(usuario_id) REFERENCES equioriente_usuarios(id))`);
            run(`CREATE TABLE IF NOT EXISTS equioriente_alquiler_items (id INTEGER PRIMARY KEY AUTOINCREMENT, alquiler_id INTEGER NOT NULL, articulo_id INTEGER NOT NULL, cantidad INTEGER NOT NULL, cantidad_devuelta INTEGER NOT NULL DEFAULT 0, precio_dia_aplicado REAL NOT NULL, dias_acordados INTEGER NOT NULL DEFAULT 1, dias_reales INTEGER, total_calculado REAL, FOREIGN KEY(alquiler_id) REFERENCES equioriente_alquileres(id), FOREIGN KEY(articulo_id) REFERENCES equioriente_articulos(id))`);
            run(`CREATE TABLE IF NOT EXISTS equioriente_devoluciones_proveedor (id INTEGER PRIMARY KEY AUTOINCREMENT, articulo_id INTEGER NOT NULL, cantidad INTEGER NOT NULL, fecha_retiro TEXT, fecha_devolucion TEXT DEFAULT CURRENT_TIMESTAMP, dias_reales INTEGER, costo_proveedor_dia REAL, total_costo REAL, notas TEXT, usuario_id INTEGER, FOREIGN KEY(articulo_id) REFERENCES equioriente_articulos(id), FOREIGN KEY(usuario_id) REFERENCES equioriente_usuarios(id))`);
            run(`CREATE TABLE IF NOT EXISTS equioriente_movimientos_inventario (id INTEGER PRIMARY KEY AUTOINCREMENT, articulo_id INTEGER NOT NULL, tipo TEXT NOT NULL, cantidad INTEGER NOT NULL, motivo TEXT, referencia_id INTEGER, usuario_id INTEGER, fecha TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(articulo_id) REFERENCES equioriente_articulos(id), FOREIGN KEY(usuario_id) REFERENCES equioriente_usuarios(id))`);
            run(`CREATE TABLE IF NOT EXISTS equioriente_registro_danos (id INTEGER PRIMARY KEY AUTOINCREMENT, articulo_id INTEGER NOT NULL, alquiler_id INTEGER, cliente_id INTEGER, cantidad INTEGER NOT NULL DEFAULT 1, tipo TEXT NOT NULL DEFAULT 'dano', descripcion TEXT, costo_reparacion REAL DEFAULT 0, cobrado_cliente INTEGER DEFAULT 0, monto_cobrado REAL DEFAULT 0, estado TEXT DEFAULT 'pendiente', usuario_id INTEGER, fecha TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(articulo_id) REFERENCES equioriente_articulos(id), FOREIGN KEY(alquiler_id) REFERENCES equioriente_alquileres(id), FOREIGN KEY(cliente_id) REFERENCES equioriente_clientes(id), FOREIGN KEY(usuario_id) REFERENCES equioriente_usuarios(id))`);
            // Migrations for older DBs
            db.run(`ALTER TABLE equioriente_articulos ADD COLUMN stock_mantenimiento INTEGER NOT NULL DEFAULT 0`, () => {});
            db.run(`ALTER TABLE equioriente_articulos ADD COLUMN stock_danado INTEGER NOT NULL DEFAULT 0`, () => {});
            db.run(`ALTER TABLE equioriente_articulos ADD COLUMN stock_minimo INTEGER NOT NULL DEFAULT 0`, () => {});
            db.run(`ALTER TABLE equioriente_alquiler_items ADD COLUMN cantidad_devuelta INTEGER NOT NULL DEFAULT 0`, () => {});
            // Default seed
            db.run(`INSERT OR IGNORE INTO equioriente_usuarios (usuario, password, rol) VALUES ('admin', '1234', 'admin')`);
            db.run(`INSERT OR IGNORE INTO equioriente_usuarios (usuario, password, rol) VALUES ('operario', '1234', 'operario')`);
            db.run(`INSERT OR IGNORE INTO equioriente_categorias (nombre) VALUES ('General')`, () => resolve());
        }));
        // Migrate plaintext passwords to bcrypt
        const users = await dbAll("SELECT id, password FROM equioriente_usuarios");
        for (const u of users) {
            if (!u.password.startsWith("$2b$") && !u.password.startsWith("$2a$")) {
                const hash = bcrypt.hashSync(u.password, SALT_ROUNDS);
                await dbRun("UPDATE equioriente_usuarios SET password=? WHERE id=?", [hash, u.id]);
            }
        }
    }
}

initDB().catch(e => console.error("Error initDB:", e.message));

// ── Helper: log inventory movement ──────────────────
async function logMovimiento(articulo_id, tipo, cantidad, motivo, referencia_id, usuario_id) {
    await dbRun(
        `INSERT INTO equioriente_movimientos_inventario (articulo_id, tipo, cantidad, motivo, referencia_id, usuario_id) VALUES (?,?,?,?,?,?)`,
        [articulo_id, tipo, cantidad, motivo, referencia_id || null, usuario_id || null]
    );
}

// ── JWT Auth Middleware ──────────────────────────────
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Token requerido" });
    }
    try {
        const decoded = jwt.verify(authHeader.split(" ")[1], JWT_SECRET);
        req.user = decoded;
        next();
    } catch (e) {
        return res.status(401).json({ error: "Token invalido o expirado" });
    }
}

function adminOnly(req, res, next) {
    if (req.user.rol !== "admin") return res.status(403).json({ error: "Solo administradores" });
    next();
}

// ── AUTH ──────────────────────────────────────────────
app.post("/login", async (req, res) => {
    try {
        const { usuario, password } = req.body;
        const user = await dbGet("SELECT id, rol, usuario, password as hash FROM equioriente_usuarios WHERE usuario = ?", [usuario]);
        if (!user) return res.status(401).json({ error: "Credenciales incorrectas" });

        const valid = await bcrypt.compare(password, user.hash);
        if (!valid) return res.status(401).json({ error: "Credenciales incorrectas" });

        const token = jwt.sign({ id: user.id, usuario: user.usuario, rol: user.rol }, JWT_SECRET, { expiresIn: "12h" });
        res.json({ id: user.id, usuario: user.usuario, rol: user.rol, token });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Change password
app.put("/usuarios/password", authMiddleware, async (req, res) => {
    try {
        const { password_actual, password_nuevo } = req.body;
        const user = await dbGet("SELECT password FROM equioriente_usuarios WHERE id=?", [req.user.id]);
        const valid = await bcrypt.compare(password_actual, user.password);
        if (!valid) return res.status(400).json({ error: "Contraseña actual incorrecta" });
        const hash = await bcrypt.hash(password_nuevo, SALT_ROUNDS);
        await dbRun("UPDATE equioriente_usuarios SET password=? WHERE id=?", [hash, req.user.id]);
        res.json({ msg: "Contraseña actualizada" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── CATEGORIAS ────────────────────────────────────────
app.get("/categorias", authMiddleware, async (req, res) => {
    try { res.json(await dbAll("SELECT * FROM equioriente_categorias ORDER BY nombre")); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/categorias", authMiddleware, async (req, res) => {
    try {
        const r = await dbRun("INSERT INTO equioriente_categorias (nombre) VALUES (?)", [req.body.nombre]);
        res.json({ id: r.lastID, nombre: req.body.nombre });
    } catch (e) { res.status(500).send(e.message); }
});

// ── CLIENTES ──────────────────────────────────────────
app.get("/clientes", authMiddleware, async (req, res) => {
    try {
        const { buscar } = req.query;
        let sql = "SELECT * FROM equioriente_clientes";
        const params = [];
        if (buscar) {
            sql += " WHERE nombre LIKE ? OR identificacion LIKE ? OR telefono LIKE ?";
            const term = `%${buscar}%`;
            params.push(term, term, term);
        }
        res.json(await dbAll(sql + " ORDER BY nombre", params));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/clientes", authMiddleware, async (req, res) => {
    try {
        const { nombre, telefono, direccion, identificacion } = req.body;
        const r = await dbRun(
            "INSERT INTO equioriente_clientes (nombre, telefono, direccion, identificacion) VALUES (?,?,?,?)",
            [nombre, telefono, direccion, identificacion]);
        res.json({ id: r.lastID, nombre });
    } catch (e) { res.status(500).send("Error: identificacion duplicada o datos invalidos."); }
});
app.put("/clientes/:id", authMiddleware, async (req, res) => {
    try {
        const { nombre, telefono, direccion, identificacion } = req.body;
        await dbRun("UPDATE equioriente_clientes SET nombre=?, telefono=?, direccion=?, identificacion=? WHERE id=?",
            [nombre, telefono, direccion, identificacion, req.params.id]);
        res.json({ msg: "Actualizado" });
    } catch (e) { res.status(500).send(e.message); }
});
app.delete("/clientes/:id", authMiddleware, async (req, res) => {
    try {
        await dbRun("DELETE FROM equioriente_clientes WHERE id=?", [req.params.id]);
        res.json({ msg: "Eliminado" });
    } catch (e) { res.status(500).send(e.message); }
});

// ── ARTICULOS ─────────────────────────────────────────
app.get("/articulos", authMiddleware, async (req, res) => {
    try {
        const { buscar, categoria_id } = req.query;
        let sql = `SELECT a.*, c.nombre as categoria_nombre
                   FROM equioriente_articulos a LEFT JOIN equioriente_categorias c ON a.categoria_id = c.id WHERE 1=1`;
        const params = [];
        if (buscar) {
            sql += " AND (a.nombre LIKE ? OR a.referencia LIKE ?)";
            params.push(`%${buscar}%`, `%${buscar}%`);
        }
        if (categoria_id) { sql += " AND a.categoria_id = ?"; params.push(categoria_id); }
        res.json(await dbAll(sql + " ORDER BY a.nombre", params));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/articulos/alertas", authMiddleware, async (req, res) => {
    try {
        res.json(await dbAll(`SELECT a.*, c.nombre as categoria_nombre
            FROM equioriente_articulos a LEFT JOIN equioriente_categorias c ON a.categoria_id = c.id
            WHERE a.stock_disponible <= a.stock_minimo AND a.stock_minimo > 0
            ORDER BY a.stock_disponible ASC`));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/articulos", authMiddleware, async (req, res) => {
    try {
        const { referencia, nombre, stock_total, precio_dia, es_externo, empresa_externa, costo_proveedor_dia, categoria_id, stock_minimo } = req.body;
        const stockInt = parseInt(stock_total) || 0;
        const result = await dbRun(
            `INSERT INTO equioriente_articulos (referencia, nombre, stock_total, stock_disponible, precio_dia, es_externo, empresa_externa, costo_proveedor_dia, categoria_id, stock_minimo)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [referencia.toUpperCase(), nombre, stockInt, stockInt,
             precio_dia, parseInt(es_externo) === 1 ? 1 : 0, empresa_externa || null,
             costo_proveedor_dia || 0, categoria_id, stock_minimo || 0]);
        await logMovimiento(result.lastID, "entrada", stockInt, "Creacion de articulo", null, req.user.id);
        res.json({ id: result.lastID });
    } catch (e) {
        res.status(500).send("Error: referencia duplicada o datos invalidos.");
    }
});

app.put("/articulos/:id", authMiddleware, async (req, res) => {
    try {
        const { nombre, stock_total, precio_dia, empresa_externa, costo_proveedor_dia, stock_minimo } = req.body;
        const old = await dbGet("SELECT stock_total FROM equioriente_articulos WHERE id=?", [req.params.id]);
        await dbRun("UPDATE equioriente_articulos SET nombre=?, stock_total=?, precio_dia=?, empresa_externa=?, costo_proveedor_dia=?, stock_minimo=? WHERE id=?",
            [nombre, stock_total, precio_dia, empresa_externa || null, costo_proveedor_dia || 0, stock_minimo || 0, req.params.id]);

        if (old && stock_total !== old.stock_total) {
            const diff = stock_total - old.stock_total;
            if (diff > 0) {
                await dbRun("UPDATE equioriente_articulos SET stock_disponible = stock_disponible + ? WHERE id=?", [diff, req.params.id]);
                await logMovimiento(req.params.id, "entrada", diff, "Ajuste manual de stock", null, req.user.id);
            } else if (diff < 0) {
                await dbRun("UPDATE equioriente_articulos SET stock_disponible = MAX(0, stock_disponible + ?) WHERE id=?", [diff, req.params.id]);
                await logMovimiento(req.params.id, "salida", Math.abs(diff), "Ajuste manual de stock", null, req.user.id);
            }
        }
        res.json({ msg: "Actualizado" });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.delete("/articulos/:id", authMiddleware, async (req, res) => {
    try {
        await dbRun("DELETE FROM equioriente_articulos WHERE id=?", [req.params.id]);
        res.json({ msg: "Eliminado" });
    } catch (e) { res.status(500).send(e.message); }
});

// ── MOVIMIENTOS DE INVENTARIO ────────────────────────
app.get("/movimientos", authMiddleware, async (req, res) => {
    try {
        const { articulo_id, limit } = req.query;
        let sql = `SELECT m.*, a.nombre as articulo_nombre, a.referencia, u.usuario as operario
                   FROM equioriente_movimientos_inventario m
                   JOIN equioriente_articulos a ON m.articulo_id = a.id
                   LEFT JOIN equioriente_usuarios u ON m.usuario_id = u.id`;
        const params = [];
        if (articulo_id) { sql += " WHERE m.articulo_id = ?"; params.push(articulo_id); }
        sql += " ORDER BY m.id DESC";
        if (limit) { sql += " LIMIT ?"; params.push(parseInt(limit)); }
        res.json(await dbAll(sql, params));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ALQUILERES (a equioriente_clientes) ───────────────────────────
app.post("/alquileres", authMiddleware, async (req, res) => {
    try {
        const { cliente_id, usuario_id, fecha_devolucion_esperada, notas, items } = req.body;
        if (!items || items.length === 0) return res.status(400).send("Sin articulos");

        // Verify stock for all items first
        for (const item of items) {
            const art = await dbGet("SELECT stock_disponible, nombre FROM equioriente_articulos WHERE id=?", [item.articulo_id]);
            if (!art || art.stock_disponible < item.cantidad) {
                return res.status(400).send(`Stock insuficiente para ${art ? art.nombre : 'articulo ID ' + item.articulo_id}`);
            }
        }

        const result = await dbRun(
            `INSERT INTO equioriente_alquileres (cliente_id, usuario_id, fecha_devolucion_esperada, notas) VALUES (?,?,?,?)`,
            [cliente_id, usuario_id || req.user.id, fecha_devolucion_esperada, notas || null]);
        const alqId = result.lastID;

        for (const item of items) {
            await dbRun(
                `INSERT INTO equioriente_alquiler_items (alquiler_id, articulo_id, cantidad, precio_dia_aplicado, dias_acordados) VALUES (?,?,?,?,?)`,
                [alqId, item.articulo_id, item.cantidad, item.precio_dia_aplicado, item.dias_acordados]);
            await dbRun("UPDATE equioriente_articulos SET stock_disponible = stock_disponible - ? WHERE id=?",
                [item.cantidad, item.articulo_id]);
            await logMovimiento(item.articulo_id, "salida", item.cantidad, "Alquiler #" + alqId, alqId, req.user.id);
        }

        res.json({ id: alqId });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.get("/alquileres", authMiddleware, async (req, res) => {
    try {
        const { estado, buscar } = req.query;
        let sql = `SELECT al.*, c.nombre as cliente_nombre, c.identificacion as cliente_id_doc,
                          c.telefono as cliente_tel, u.usuario as operario
                   FROM equioriente_alquileres al
                   JOIN equioriente_clientes c ON al.cliente_id = c.id
                   JOIN equioriente_usuarios u ON al.usuario_id = u.id WHERE 1=1`;
        const params = [];
        if (estado) { sql += " AND al.estado = ?"; params.push(estado); }
        if (buscar) {
            sql += " AND (c.nombre LIKE ? OR c.identificacion LIKE ? OR CAST(al.id AS TEXT) LIKE ?)";
            params.push(`%${buscar}%`, `%${buscar}%`, `%${buscar}%`);
        }
        res.json(await dbAll(sql + " ORDER BY al.id DESC", params));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/alquileres/:id/items", authMiddleware, async (req, res) => {
    try {
        res.json(await dbAll(
            `SELECT ai.*, a.nombre, a.referencia, a.es_externo, a.empresa_externa
             FROM equioriente_alquiler_items ai JOIN equioriente_articulos a ON ai.articulo_id = a.id
             WHERE ai.alquiler_id = ?`, [req.params.id]));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DEVOLUCION PARCIAL ───────────────────────────────
app.put("/alquileres/:id/devolver", authMiddleware, async (req, res) => {
    try {
        const alqId = req.params.id;
        const { items_devueltos } = req.body;
        // items_devueltos: [{ item_id, cantidad_devolver }] — optional, if not provided returns ALL

        const alq = await dbGet("SELECT fecha_salida, estado FROM equioriente_alquileres WHERE id=?", [alqId]);
        if (!alq) return res.status(404).send("Alquiler no encontrado");
        if (alq.estado === "devuelto") return res.status(400).send("Este alquiler ya fue devuelto completamente");

        const ahora = new Date();
        const salida = new Date(alq.fecha_salida);
        const diasReales = Math.max(1, Math.ceil((ahora - salida) / (1000 * 60 * 60 * 24)));

        const allItems = await dbAll("SELECT * FROM equioriente_alquiler_items WHERE alquiler_id=?", [alqId]);

        if (items_devueltos && items_devueltos.length > 0) {
            // Partial return
            for (const dev of items_devueltos) {
                const item = allItems.find(i => i.id === dev.item_id);
                if (!item) continue;
                const pendiente = item.cantidad - item.cantidad_devuelta;
                const cantDev = Math.min(dev.cantidad_devolver, pendiente);
                if (cantDev <= 0) continue;

                const newDevuelta = item.cantidad_devuelta + cantDev;
                const total = item.precio_dia_aplicado * diasReales * newDevuelta;

                await dbRun("UPDATE equioriente_alquiler_items SET cantidad_devuelta=?, dias_reales=?, total_calculado=? WHERE id=?",
                    [newDevuelta, diasReales, total, item.id]);
                await dbRun("UPDATE equioriente_articulos SET stock_disponible = stock_disponible + ? WHERE id=?",
                    [cantDev, item.articulo_id]);
                await logMovimiento(item.articulo_id, "entrada", cantDev, "Devolucion parcial alquiler #" + alqId, alqId, req.user.id);
            }
        } else {
            // Full return of all remaining items
            for (const item of allItems) {
                const pendiente = item.cantidad - item.cantidad_devuelta;
                if (pendiente <= 0) continue;
                const total = item.precio_dia_aplicado * diasReales * item.cantidad;
                await dbRun("UPDATE equioriente_alquiler_items SET cantidad_devuelta=?, dias_reales=?, total_calculado=? WHERE id=?",
                    [item.cantidad, diasReales, total, item.id]);
                await dbRun("UPDATE equioriente_articulos SET stock_disponible = stock_disponible + ? WHERE id=?",
                    [pendiente, item.articulo_id]);
                await logMovimiento(item.articulo_id, "entrada", pendiente, "Devolucion alquiler #" + alqId, alqId, req.user.id);
            }
        }

        // Check if all items fully returned
        const updated = await dbAll("SELECT cantidad, cantidad_devuelta FROM equioriente_alquiler_items WHERE alquiler_id=?", [alqId]);
        const allReturned = updated.every(i => i.cantidad_devuelta >= i.cantidad);
        if (allReturned) {
            await dbRun("UPDATE equioriente_alquileres SET estado='devuelto', fecha_devolucion_real=CURRENT_TIMESTAMP WHERE id=?", [alqId]);
        } else {
            await dbRun("UPDATE equioriente_alquileres SET estado='parcial' WHERE id=?", [alqId]);
        }

        res.json({ msg: allReturned ? "Devuelto completamente" : "Devolucion parcial registrada", diasReales });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// ── REGISTRO DE DAÑOS / PÉRDIDAS ─────────────────────
app.post("/danos", authMiddleware, async (req, res) => {
    try {
        const { articulo_id, alquiler_id, cliente_id, cantidad, tipo, descripcion, costo_reparacion, cobrado_cliente, monto_cobrado } = req.body;
        if (!articulo_id || !cantidad) return res.status(400).send("Datos incompletos");

        const result = await dbRun(
            `INSERT INTO equioriente_registro_danos (articulo_id, alquiler_id, cliente_id, cantidad, tipo, descripcion, costo_reparacion, cobrado_cliente, monto_cobrado, usuario_id)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [articulo_id, alquiler_id || null, cliente_id || null, cantidad,
             tipo || "dano", descripcion || null, costo_reparacion || 0,
             cobrado_cliente ? 1 : 0, monto_cobrado || 0, req.user.id]);

        if (tipo === "perdida") {
            await dbRun("UPDATE equioriente_articulos SET stock_total = stock_total - ?, stock_disponible = MAX(0, stock_disponible - ?) WHERE id=?",
                [cantidad, cantidad, articulo_id]);
            await logMovimiento(articulo_id, "perdida", cantidad, descripcion || "Perdida registrada", alquiler_id, req.user.id);
        } else {
            // Damage: move from available to damaged
            await dbRun("UPDATE equioriente_articulos SET stock_disponible = MAX(0, stock_disponible - ?), stock_danado = stock_danado + ? WHERE id=?",
                [cantidad, cantidad, articulo_id]);
            await logMovimiento(articulo_id, "dano", cantidad, descripcion || "Dano registrado", alquiler_id, req.user.id);
        }

        res.json({ id: result.lastID });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// Repair: move from damaged back to available
app.put("/danos/:id/reparar", authMiddleware, async (req, res) => {
    try {
        const dano = await dbGet("SELECT * FROM equioriente_registro_danos WHERE id=?", [req.params.id]);
        if (!dano) return res.status(404).send("Registro no encontrado");

        await dbRun("UPDATE equioriente_registro_danos SET estado='reparado' WHERE id=?", [req.params.id]);
        await dbRun("UPDATE equioriente_articulos SET stock_danado = MAX(0, stock_danado - ?), stock_disponible = stock_disponible + ? WHERE id=?",
            [dano.cantidad, dano.cantidad, dano.articulo_id]);
        await logMovimiento(dano.articulo_id, "reparacion", dano.cantidad, "Reparacion completada", null, req.user.id);
        res.json({ msg: "Articulo reparado y devuelto al inventario" });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.get("/danos", authMiddleware, async (req, res) => {
    try {
        const { estado } = req.query;
        let sql = `SELECT d.*, a.nombre as articulo_nombre, a.referencia,
                          c.nombre as cliente_nombre, u.usuario as operario
                   FROM equioriente_registro_danos d
                   JOIN equioriente_articulos a ON d.articulo_id = a.id
                   LEFT JOIN equioriente_clientes c ON d.cliente_id = c.id
                   LEFT JOIN equioriente_usuarios u ON d.usuario_id = u.id`;
        const params = [];
        if (estado) { sql += " WHERE d.estado = ?"; params.push(estado); }
        res.json(await dbAll(sql + " ORDER BY d.id DESC", params));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DEVOLUCIONES A PROVEEDOR ──────────────────────────
app.post("/devoluciones_proveedor", authMiddleware, async (req, res) => {
    try {
        const { articulo_id, cantidad, fecha_retiro, costo_proveedor_dia, notas } = req.body;
        if (!articulo_id || !cantidad) return res.status(400).send("Datos incompletos");

        const art = await dbGet("SELECT * FROM equioriente_articulos WHERE id=?", [articulo_id]);
        if (!art) return res.status(404).send("Articulo no encontrado");
        if (art.stock_disponible < cantidad)
            return res.status(400).send(`Solo hay ${art.stock_disponible} unidades disponibles para devolver`);

        const fechaRetiroDate = fecha_retiro ? new Date(fecha_retiro) : new Date();
        const ahora = new Date();
        const diasReales = Math.max(1, Math.ceil((ahora - fechaRetiroDate) / (1000 * 60 * 60 * 24)));
        const costoDia = parseFloat(costo_proveedor_dia) || art.costo_proveedor_dia || 0;
        const totalCosto = costoDia * diasReales * cantidad;

        const result = await dbRun(
            `INSERT INTO equioriente_devoluciones_proveedor (articulo_id, cantidad, fecha_retiro, dias_reales, costo_proveedor_dia, total_costo, notas, usuario_id)
             VALUES (?,?,?,?,?,?,?,?)`,
            [articulo_id, cantidad, fecha_retiro || null, diasReales, costoDia, totalCosto, notas || null, req.user.id]);

        const newTotal = art.stock_total - cantidad;
        if (newTotal <= 0) {
            await dbRun("DELETE FROM equioriente_articulos WHERE id=?", [articulo_id]);
        } else {
            await dbRun("UPDATE equioriente_articulos SET stock_disponible = stock_disponible - ?, stock_total = stock_total - ? WHERE id=?",
                [cantidad, cantidad, articulo_id]);
        }
        await logMovimiento(articulo_id, "devolucion_proveedor", cantidad, "Devolucion a proveedor", result.lastID, req.user.id);

        res.json({ id: result.lastID, diasReales, totalCosto });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.get("/devoluciones_proveedor", authMiddleware, async (req, res) => {
    try {
        res.json(await dbAll(
            `SELECT dp.*, a.nombre, a.referencia, a.empresa_externa, u.usuario as operario
             FROM equioriente_devoluciones_proveedor dp
             JOIN equioriente_articulos a ON dp.articulo_id = a.id
             LEFT JOIN equioriente_usuarios u ON dp.usuario_id = u.id
             ORDER BY dp.id DESC`));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REPORTES ─────────────────────────────────────────
app.get("/reportes/articulos-top", authMiddleware, async (req, res) => {
    try {
        const rows = await dbAll(`
            SELECT a.nombre, a.referencia, SUM(ai.cantidad) as total_alquilado, COUNT(DISTINCT ai.alquiler_id) as veces_alquilado
            FROM equioriente_alquiler_items ai
            JOIN equioriente_articulos a ON ai.articulo_id = a.id
            GROUP BY ai.articulo_id
            ORDER BY total_alquilado DESC
            LIMIT 20`);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/reportes/ingresos", authMiddleware, async (req, res) => {
    try {
        const { desde, hasta } = req.query;
        let sql = `
            SELECT DATE(al.fecha_salida) as fecha,
                   SUM(ai.total_calculado) as ingreso_total,
                   COUNT(DISTINCT al.id) as total_alquileres
            FROM equioriente_alquileres al
            JOIN equioriente_alquiler_items ai ON al.id = ai.alquiler_id
            WHERE al.estado = 'devuelto' AND ai.total_calculado IS NOT NULL`;
        const params = [];
        if (desde) { sql += " AND DATE(al.fecha_salida) >= ?"; params.push(desde); }
        if (hasta) { sql += " AND DATE(al.fecha_salida) <= ?"; params.push(hasta); }
        sql += " GROUP BY DATE(al.fecha_salida) ORDER BY fecha DESC";
        const rows = await dbAll(sql, params);

        const totales = await dbGet(`
            SELECT COALESCE(SUM(ai.total_calculado), 0) as ingreso_total,
                   COUNT(DISTINCT al.id) as total_alquileres
            FROM equioriente_alquileres al
            JOIN equioriente_alquiler_items ai ON al.id = ai.alquiler_id
            WHERE al.estado = 'devuelto' AND ai.total_calculado IS NOT NULL
            ${desde ? "AND DATE(al.fecha_salida) >= ?" : ""}
            ${hasta ? "AND DATE(al.fecha_salida) <= ?" : ""}`,
            params);

        res.json({ detalle: rows, totales });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/reportes/clientes-top", authMiddleware, async (req, res) => {
    try {
        const rows = await dbAll(`
            SELECT c.nombre, c.identificacion, c.telefono,
                   COUNT(al.id) as total_alquileres,
                   COALESCE(SUM(ai.total_calculado), 0) as total_gastado
            FROM equioriente_clientes c
            JOIN equioriente_alquileres al ON c.id = al.cliente_id
            LEFT JOIN equioriente_alquiler_items ai ON al.id = ai.alquiler_id
            GROUP BY c.id
            ORDER BY total_alquileres DESC
            LIMIT 20`);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/reportes/costos-externos", authMiddleware, async (req, res) => {
    try {
        const rows = await dbAll(`
            SELECT a.nombre, a.referencia, a.empresa_externa,
                   COALESCE(SUM(dp.total_costo), 0) as costo_total_proveedor,
                   COALESCE((SELECT SUM(ai2.total_calculado) FROM equioriente_alquiler_items ai2 WHERE ai2.articulo_id = a.id), 0) as ingreso_generado
            FROM equioriente_articulos a
            LEFT JOIN equioriente_devoluciones_proveedor dp ON a.id = dp.articulo_id
            WHERE a.es_externo = 1
            GROUP BY a.id
            ORDER BY costo_total_proveedor DESC`);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/reportes/morosos", authMiddleware, async (req, res) => {
    try {
        const rows = await dbAll(`
            SELECT al.id as alquiler_id, c.nombre, c.telefono, c.identificacion,
                   al.fecha_salida, al.fecha_devolucion_esperada,
                   CAST(julianday('now') - julianday(al.fecha_devolucion_esperada) AS INTEGER) as dias_retraso
            FROM equioriente_alquileres al
            JOIN equioriente_clientes c ON al.cliente_id = c.id
            WHERE al.estado IN ('activo', 'parcial')
              AND al.fecha_devolucion_esperada IS NOT NULL
              AND DATE('now') > DATE(al.fecha_devolucion_esperada)
            ORDER BY dias_retraso DESC`);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BACKUP ───────────────────────────────────────────
app.post("/backup", authMiddleware, adminOnly, (req, res) => {
    if (pgPool) return res.json({ msg: "Supabase gestiona sus propios backups automaticos en la nube." });
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupFile = path.join(BACKUP_DIR, `rental_backup_${timestamp}.db`);
        fs.copyFileSync("rental.db", backupFile);
        const backups = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith("rental_backup_") && f.endsWith(".db"))
            .sort().reverse();
        backups.slice(10).forEach(f => { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch(_) {} });
        res.json({ msg: "Backup creado", archivo: backupFile });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/backup/list", authMiddleware, adminOnly, (req, res) => {
    try {
        const backups = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith("rental_backup_") && f.endsWith(".db"))
            .sort().reverse()
            .map(f => ({
                nombre: f,
                tamano: (fs.statSync(path.join(BACKUP_DIR, f)).size / 1024).toFixed(1) + " KB",
                fecha: f.replace("rental_backup_", "").replace(".db", "").replace(/-/g, (m, i) => i < 10 ? "-" : i === 10 ? "T" : i < 16 ? ":" : ".")
            }));
        res.json(backups);
    } catch (e) {
        res.json([]);
    }
});

// Auto-backup every 6 hours (SQLite only)
if (!pgPool) setInterval(() => {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupFile = path.join(BACKUP_DIR, `rental_backup_${timestamp}.db`);
        fs.copyFileSync("rental.db", backupFile);
        const backups = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith("rental_backup_") && f.endsWith(".db"))
            .sort().reverse();
        backups.slice(10).forEach(f => { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch(_) {} });
        console.log("Auto-backup creado:", backupFile);
    } catch (e) { console.error("Error en auto-backup:", e.message); }
}, 6 * 60 * 60 * 1000);

// ── ESTADÍSTICAS MENSUALES ────────────────────────────
app.get("/reportes/estadisticas", authMiddleware, async (req, res) => {
    try {
        // Revenue per month for the last 12 months
        const meses = await dbAll(`
            SELECT strftime('%Y-%m', al.fecha_salida) as mes,
                   COALESCE(SUM(ai.total_calculado), 0) as ingreso,
                   COUNT(DISTINCT al.id) as equioriente_alquileres
            FROM equioriente_alquileres al
            JOIN equioriente_alquiler_items ai ON al.id = ai.alquiler_id
            WHERE al.estado = 'devuelto' AND ai.total_calculado IS NOT NULL
              AND al.fecha_salida >= date('now', '-12 months')
            GROUP BY mes
            ORDER BY mes ASC`);

        // Current month totals
        const mesActual = await dbGet(`
            SELECT COALESCE(SUM(ai.total_calculado), 0) as ingreso,
                   COUNT(DISTINCT al.id) as equioriente_alquileres,
                   COALESCE(AVG(ai.total_calculado), 0) as promedio_item
            FROM equioriente_alquileres al
            JOIN equioriente_alquiler_items ai ON al.id = ai.alquiler_id
            WHERE al.estado = 'devuelto' AND ai.total_calculado IS NOT NULL
              AND strftime('%Y-%m', al.fecha_salida) = strftime('%Y-%m', 'now')`);

        // Previous month totals
        const mesPasado = await dbGet(`
            SELECT COALESCE(SUM(ai.total_calculado), 0) as ingreso,
                   COUNT(DISTINCT al.id) as equioriente_alquileres
            FROM equioriente_alquileres al
            JOIN equioriente_alquiler_items ai ON al.id = ai.alquiler_id
            WHERE al.estado = 'devuelto' AND ai.total_calculado IS NOT NULL
              AND strftime('%Y-%m', al.fecha_salida) = strftime('%Y-%m', date('now', '-1 month'))`);

        // Top client this month
        const topCliente = await dbGet(`
            SELECT c.nombre, COUNT(al.id) as equioriente_alquileres,
                   COALESCE(SUM(ai.total_calculado), 0) as total
            FROM equioriente_alquileres al
            JOIN equioriente_clientes c ON al.cliente_id = c.id
            JOIN equioriente_alquiler_items ai ON al.id = ai.alquiler_id
            WHERE al.estado = 'devuelto' AND ai.total_calculado IS NOT NULL
              AND strftime('%Y-%m', al.fecha_salida) = strftime('%Y-%m', 'now')
            GROUP BY c.id ORDER BY total DESC LIMIT 1`);

        // Top article this month
        const topArticulo = await dbGet(`
            SELECT a.nombre, SUM(ai.cantidad) as total_cant
            FROM equioriente_alquiler_items ai
            JOIN equioriente_articulos a ON ai.articulo_id = a.id
            JOIN equioriente_alquileres al ON ai.alquiler_id = al.id
            WHERE strftime('%Y-%m', al.fecha_salida) = strftime('%Y-%m', 'now')
            GROUP BY ai.articulo_id ORDER BY total_cant DESC LIMIT 1`);

        res.json({ meses, mesActual, mesPasado, topCliente: topCliente || null, topArticulo: topArticulo || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EXPORTAR XLSX ─────────────────────────────────────

function xlsxStyleHeader(ws, row, bgColor = "1e3a5f") {
    row.eachCell(cell => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + bgColor } };
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: false };
        cell.border = {
            top: { style: "thin", color: { argb: "FFB0BEC5" } },
            left: { style: "thin", color: { argb: "FFB0BEC5" } },
            bottom: { style: "thin", color: { argb: "FFB0BEC5" } },
            right: { style: "thin", color: { argb: "FFB0BEC5" } }
        };
    });
    row.height = 22;
}

function xlsxStyleDataRow(ws, row, isAlt) {
    row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = {
            type: "pattern", pattern: "solid",
            fgColor: { argb: isAlt ? "FFf0f9ff" : "FFFFFFFF" }
        };
        cell.alignment = { vertical: "middle" };
        cell.border = {
            top: { style: "hair", color: { argb: "FFe5e7eb" } },
            left: { style: "hair", color: { argb: "FFe5e7eb" } },
            bottom: { style: "hair", color: { argb: "FFe5e7eb" } },
            right: { style: "hair", color: { argb: "FFe5e7eb" } }
        };
    });
    row.height = 18;
}

function xlsxStyleSheet(ws) {
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

function xlsxFormatCurrency(ws, colLetter, startRow, endRow) {
    for (let r = startRow; r <= endRow; r++) {
        const cell = ws.getCell(`${colLetter}${r}`);
        cell.numFmt = '"$"#,##0';
        cell.alignment = { horizontal: "right", vertical: "middle" };
    }
}

function tipoLabel(isExterno, empresa) {
    return isExterno ? (empresa || "Externo") : "Propio";
}

// Export all rentals for a client
app.get("/exportar/cliente/:id", authMiddleware, async (req, res) => {
    try {
        const cliente = await dbGet("SELECT * FROM equioriente_clientes WHERE id=?", [req.params.id]);
        if (!cliente) return res.status(404).send("Cliente no encontrado");

        const alqs = await dbAll(`
            SELECT al.id, al.fecha_salida, al.fecha_devolucion_esperada, al.fecha_devolucion_real,
                   al.estado, al.notas, u.usuario as operario
            FROM equioriente_alquileres al
            JOIN equioriente_usuarios u ON al.usuario_id = u.id
            WHERE al.cliente_id = ?
            ORDER BY al.id DESC`, [req.params.id]);

        const items = await dbAll(`
            SELECT ai.alquiler_id, a.referencia, a.es_externo, a.empresa_externa,
                   a.nombre, ai.cantidad, ai.cantidad_devuelta,
                   ai.precio_dia_aplicado, ai.dias_acordados, ai.dias_reales,
                   COALESCE(ai.total_calculado, ai.precio_dia_aplicado * COALESCE(ai.dias_reales, ai.dias_acordados) * ai.cantidad) as subtotal
            FROM equioriente_alquiler_items ai
            JOIN equioriente_articulos a ON ai.articulo_id = a.id
            JOIN equioriente_alquileres al ON ai.alquiler_id = al.id
            WHERE al.cliente_id = ?
            ORDER BY ai.alquiler_id DESC, a.nombre`, [req.params.id]);

        const workbook = new ExcelJS.Workbook();
        workbook.creator = "Equioriente";
        workbook.created = new Date();

        // Sheet 1: Rentals summary
        const ws1 = workbook.addWorksheet("Alquileres");
        ws1.columns = [
            { header: "#",            key: "id",       width: 8  },
            { header: "Fecha Salida", key: "fsal",     width: 20 },
            { header: "Dev. Esperada",key: "fesp",     width: 14 },
            { header: "Dev. Real",    key: "freal",    width: 20 },
            { header: "Estado",       key: "estado",   width: 12 },
            { header: "Operario",     key: "operario", width: 14 },
            { header: "Notas",        key: "notas",    width: 35 },
        ];
        xlsxStyleHeader(ws1, ws1.getRow(1));
        alqs.forEach((a, ri) => {
            const row = ws1.addRow([
                a.id,
                (a.fecha_salida || "").substring(0, 16).replace("T", " "),
                a.fecha_devolucion_esperada || "",
                (a.fecha_devolucion_real || "").substring(0, 16).replace("T", " "),
                a.estado,
                a.operario,
                a.notas || ""
            ]);
            xlsxStyleDataRow(ws1, row, ri % 2 !== 0);
        });
        xlsxStyleSheet(ws1);

        // Sheet 2: Items detail
        const ws2 = workbook.addWorksheet("Items");
        ws2.columns = [
            { header: "Alquiler #",  key: "alq_id",   width: 10 },
            { header: "Referencia",  key: "ref",       width: 14 },
            { header: "Tipo",        key: "tipo",      width: 14 },
            { header: "Articulo",    key: "nombre",    width: 30 },
            { header: "Cantidad",    key: "cant",      width: 9  },
            { header: "Devuelto",    key: "dev",       width: 9  },
            { header: "Precio/dia",  key: "precio",    width: 13 },
            { header: "Dias",        key: "dias",      width: 6  },
            { header: "Subtotal",    key: "subtotal",  width: 16 },
        ];
        xlsxStyleHeader(ws2, ws2.getRow(1));
        items.forEach((i, ri) => {
            const row = ws2.addRow([
                i.alquiler_id, i.referencia, tipoLabel(i.es_externo, i.empresa_externa),
                i.nombre, i.cantidad, i.cantidad_devuelta,
                i.precio_dia_aplicado, i.dias_reales || i.dias_acordados, i.subtotal
            ]);
            xlsxStyleDataRow(ws2, row, ri % 2 !== 0);
            row.getCell(7).numFmt = '"$"#,##0';
            row.getCell(7).alignment = { horizontal: "right", vertical: "middle" };
            row.getCell(9).numFmt = '"$"#,##0';
            row.getCell(9).alignment = { horizontal: "right", vertical: "middle" };
        });
        xlsxStyleSheet(ws2);

        const safeName = cliente.nombre.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 30);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="equioriente_cliente_${safeName}.xlsx"`);
        const buffer = await workbook.xlsx.writeBuffer();
        res.send(buffer);
    } catch (e) { res.status(500).send(e.message); }
});

// Export all rentals for a specific day
app.get("/exportar/dia/:fecha", authMiddleware, async (req, res) => {
    try {
        const fecha = req.params.fecha;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).send("Fecha invalida (YYYY-MM-DD)");

        const alqs = await dbAll(`
            SELECT al.id, c.nombre as cliente, c.telefono, c.identificacion,
                   al.fecha_salida, al.fecha_devolucion_esperada, al.fecha_devolucion_real,
                   al.estado, al.notas, u.usuario as operario
            FROM equioriente_alquileres al
            JOIN equioriente_clientes c ON al.cliente_id = c.id
            JOIN equioriente_usuarios u ON al.usuario_id = u.id
            WHERE DATE(al.fecha_salida) = ?
            ORDER BY al.id`, [fecha]);

        const alqIds = alqs.map(a => a.id);
        const items = alqIds.length ? await dbAll(`
            SELECT ai.alquiler_id, a.referencia, a.es_externo, a.empresa_externa,
                   a.nombre, ai.cantidad, ai.cantidad_devuelta,
                   ai.precio_dia_aplicado, ai.dias_acordados, ai.dias_reales,
                   COALESCE(ai.total_calculado, ai.precio_dia_aplicado * COALESCE(ai.dias_reales, ai.dias_acordados) * ai.cantidad) as subtotal
            FROM equioriente_alquiler_items ai
            JOIN equioriente_articulos a ON ai.articulo_id = a.id
            WHERE ai.alquiler_id IN (${alqIds.map(() => "?").join(",")})
            ORDER BY ai.alquiler_id, a.nombre`, alqIds) : [];

        const workbook = new ExcelJS.Workbook();
        workbook.creator = "Equioriente";
        workbook.created = new Date();

        // Sheet 1: Rentals summary
        const ws1 = workbook.addWorksheet(`Alquileres ${fecha}`);
        ws1.columns = [
            { header: "#",            key: "id",       width: 8  },
            { header: "Cliente",      key: "cliente",  width: 26 },
            { header: "Telefono",     key: "tel",      width: 14 },
            { header: "ID/NIT",       key: "idnit",    width: 14 },
            { header: "Fecha Salida", key: "fsal",     width: 20 },
            { header: "Dev. Esperada",key: "fesp",     width: 14 },
            { header: "Dev. Real",    key: "freal",    width: 20 },
            { header: "Estado",       key: "estado",   width: 12 },
            { header: "Operario",     key: "operario", width: 14 },
            { header: "Notas",        key: "notas",    width: 35 },
        ];
        xlsxStyleHeader(ws1, ws1.getRow(1));
        alqs.forEach((a, ri) => {
            const row = ws1.addRow([
                a.id, a.cliente, a.telefono || "", a.identificacion || "",
                (a.fecha_salida || "").substring(0, 16).replace("T", " "),
                a.fecha_devolucion_esperada || "",
                (a.fecha_devolucion_real || "").substring(0, 16).replace("T", " "),
                a.estado, a.operario, a.notas || ""
            ]);
            xlsxStyleDataRow(ws1, row, ri % 2 !== 0);
        });
        xlsxStyleSheet(ws1);

        // Sheet 2: Items detail
        const ws2 = workbook.addWorksheet("Items");
        ws2.columns = [
            { header: "Alquiler #",  key: "alq_id",   width: 10 },
            { header: "Referencia",  key: "ref",       width: 14 },
            { header: "Tipo",        key: "tipo",      width: 14 },
            { header: "Articulo",    key: "nombre",    width: 30 },
            { header: "Cantidad",    key: "cant",      width: 9  },
            { header: "Devuelto",    key: "dev",       width: 9  },
            { header: "Precio/dia",  key: "precio",    width: 13 },
            { header: "Dias",        key: "dias",      width: 6  },
            { header: "Subtotal",    key: "subtotal",  width: 16 },
        ];
        xlsxStyleHeader(ws2, ws2.getRow(1));
        items.forEach((i, ri) => {
            const row = ws2.addRow([
                i.alquiler_id, i.referencia, tipoLabel(i.es_externo, i.empresa_externa),
                i.nombre, i.cantidad, i.cantidad_devuelta,
                i.precio_dia_aplicado, i.dias_reales || i.dias_acordados, i.subtotal
            ]);
            xlsxStyleDataRow(ws2, row, ri % 2 !== 0);
            row.getCell(7).numFmt = '"$"#,##0';
            row.getCell(7).alignment = { horizontal: "right", vertical: "middle" };
            row.getCell(9).numFmt = '"$"#,##0';
            row.getCell(9).alignment = { horizontal: "right", vertical: "middle" };
        });
        xlsxStyleSheet(ws2);

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="equioriente_dia_${fecha}.xlsx"`);
        const buffer = await workbook.xlsx.writeBuffer();
        res.send(buffer);
    } catch (e) { res.status(500).send(e.message); }
});

// ── PDF RECIBO ────────────────────────────────────────
app.get("/alquileres/:id/pdf", authMiddleware, async (req, res) => {
    const alqId = req.params.id;
    try {
        const alq = await dbGet(
            `SELECT al.*, c.nombre as cliente_nombre, c.identificacion as cliente_id_doc,
                    c.telefono as cliente_tel, c.direccion as cliente_dir, u.usuario as operario
             FROM equioriente_alquileres al
             JOIN equioriente_clientes c ON al.cliente_id = c.id
             JOIN equioriente_usuarios u ON al.usuario_id = u.id
             WHERE al.id=?`, [alqId]);
        if (!alq) return res.status(404).send("No encontrado");

        const items = await dbAll(
            `SELECT ai.*, a.nombre, a.referencia, a.es_externo, a.empresa_externa
             FROM equioriente_alquiler_items ai
             JOIN equioriente_articulos a ON ai.articulo_id = a.id
             WHERE ai.alquiler_id=?`, [alqId]);

        res.setHeader("Content-Type", "application/pdf");
                res.setHeader("Content-Disposition", `inline; filename="recibo_${alqId}.pdf"`);

                const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true });
                doc.pipe(res);

                const L = 40, R = 40, PW = 595 - L - R; // page width usable = 515

                const fmtMoney = n => "$" + Number(n || 0).toLocaleString("es-CO", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
                const hline = (y, color = "#e5e7eb", w = 0.5) =>
                    doc.moveTo(L, y).lineTo(L + PW, y).strokeColor(color).lineWidth(w).stroke();

                // ── Title ──────────────────────────────────────────────
                doc.font("Helvetica-Bold").fontSize(22).fillColor("#1e3a5f")
                   .text("RECIBO DE ALQUILER", L, 40, { align: "center", width: PW });
                doc.font("Helvetica").fontSize(10).fillColor("#6b7280")
                   .text("Gestion de Equipos y Materiales", L, 68, { align: "center", width: PW });
                hline(84, "#1e3a5f", 2);

                // ── Info table ─────────────────────────────────────────
                const estado = alq.estado;
                const estadoColor = estado === "devuelto" ? "#059669" : estado === "parcial" ? "#d97706" : "#dc2626";
                const estadoText  = estado === "devuelto" ? "DEVUELTO" : estado === "parcial" ? "PARCIAL" : "EN CURSO";
                const fechaSal  = (alq.fecha_salida || "").substring(0, 16).replace("T", " ");
                const fechaEsp  = alq.fecha_devolucion_esperada || "No especificada";
                const fechaReal = (alq.fecha_devolucion_real || "").substring(0, 16).replace("T", " ") || "-";

                const infoRows = [
                    ["N° Alquiler:", "#" + String(alq.id).padStart(4, "0"), "Estado:", estadoText],
                    ["Cliente:",          alq.cliente_nombre || "",               "ID/NIT:", alq.cliente_id_doc || ""],
                    ["Telefono:",         alq.cliente_tel || "",                  "Direccion:", alq.cliente_dir || ""],
                    ["Fecha salida:",     fechaSal,                               "Dev. esperada:", fechaEsp],
                    ["Operario:",         alq.operario || "",                     "Dev. real:",     fechaReal],
                ];

                const IH = 18;
                const COL = [80, PW / 2 - 80, 80, PW / 2 - 80];
                let iy = 94;
                infoRows.forEach((row, ri) => {
                    doc.fillColor(ri % 2 === 0 ? "#ffffff" : "#f8fafc")
                       .rect(L, iy, PW, IH).fill();
                    let cx = L;
                    row.forEach((cell, ci) => {
                        const isLbl = ci % 2 === 0;
                        const isStatus = ri === 0 && ci === 3;
                        doc.font(isLbl || isStatus ? "Helvetica-Bold" : "Helvetica")
                           .fontSize(9)
                           .fillColor(isStatus ? estadoColor : "#111827")
                           .text(String(cell), cx + 4, iy + 4, { width: COL[ci] - 8, lineBreak: false, ellipsis: true });
                        cx += COL[ci];
                    });
                    iy += IH;
                });
                doc.rect(L, 94, PW, IH * infoRows.length)
                   .strokeColor("#e5e7eb").lineWidth(0.4).stroke();

                // ── Items table ────────────────────────────────────────
                iy += 14;
                doc.font("Helvetica-Bold").fontSize(11).fillColor("#1e3a5f")
                   .text("Detalle de Articulos", L, iy);
                iy += 18;

                const CW  = [50, 46, 118, 30, 34, 52, 28, 65]; // Ref, Tipo, Articulo, Cant, Dev, Precio, Dias, Subtotal
                const HDR = ["Ref.", "Tipo", "Articulo", "Cant.", "Dev.", "Precio/dia", "Dias", "Subtotal"];
                const RH  = 20;

                const drawRow = (cells, y, isHeader, isAlt) => {
                    const totalW = CW.reduce((a, b) => a + b, 0);
                    if (isHeader) doc.fillColor("#1e3a5f").rect(L, y, totalW, RH).fill();
                    else doc.fillColor(isAlt ? "#f0f9ff" : "#ffffff").rect(L, y, totalW, RH).fill();
                    let cx = L;
                    cells.forEach((cell, i) => {
                        const right = i >= 3;
                        doc.font(isHeader ? "Helvetica-Bold" : "Helvetica")
                           .fontSize(8.5)
                           .fillColor(isHeader ? "white" : "#111827")
                           .text(String(cell ?? ""), cx + 3, y + (RH - 8.5) / 2,
                                 { width: CW[i] - 6, lineBreak: false, ellipsis: true, align: right ? "center" : "left" });
                        cx += CW[i];
                    });
                    doc.rect(L, y, totalW, RH).strokeColor("#e5e7eb").lineWidth(0.3).stroke();
                };

                drawRow(HDR, iy, true, false);
                iy += RH;

                let grandTotal = 0;
                (items || []).forEach((item, ri) => {
                    const dias     = item.dias_reales || item.dias_acordados || 1;
                    const subtotal = item.total_calculado || (item.precio_dia_aplicado * dias * item.cantidad);
                    grandTotal += subtotal;
                    const tipo = item.es_externo ? (item.empresa_externa || "Externo") : "Propio";
                    drawRow([
                        item.referencia || "", tipo, item.nombre || "",
                        item.cantidad, item.cantidad_devuelta || 0,
                        fmtMoney(item.precio_dia_aplicado), dias, fmtMoney(subtotal)
                    ], iy, false, ri % 2 !== 0);
                    iy += RH;
                    if (iy > 760) {
                        doc.addPage();
                        iy = 40;
                        drawRow(HDR, iy, true, false);
                        iy += RH;
                    }
                });

                // ── Total ──────────────────────────────────────────────
                iy += 6;
                const TW = 135;
                doc.fillColor("#1e3a5f").rect(L + PW - TW, iy, TW, 26).fill();
                doc.font("Helvetica-Bold").fontSize(12).fillColor("white")
                   .text("TOTAL: " + fmtMoney(grandTotal), L + PW - TW + 4, iy + 7,
                         { width: TW - 8, align: "center", lineBreak: false });
                iy += 34;

                // ── Notes ──────────────────────────────────────────────
                if (alq.notas) {
                    doc.fillColor("#fef9c3").rect(L, iy, PW, 28).fill();
                    doc.rect(L, iy, PW, 28).strokeColor("#d97706").lineWidth(0.5).stroke();
                    doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151")
                       .text("Notas: ", L + 6, iy + 9, { continued: true, lineBreak: false });
                    doc.font("Helvetica").fillColor("#374151").text(alq.notas, { lineBreak: false });
                    iy += 36;
                }

                // ── Footer ─────────────────────────────────────────────
                iy += 14;
                hline(iy, "#e5e7eb", 0.5);
                iy += 8;
                const nowStr = new Date().toLocaleString("es-CO", {
                    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
                });
                doc.font("Helvetica").fontSize(8).fillColor("#9ca3af")
                   .text(`Documento generado el ${nowStr}  |  Firma cliente: _________________________`,
                         L, iy, { align: "center", width: PW });

        doc.end();
    } catch (e) {
        console.error("PDF Error:", e.message);
        if (!res.headersSent) res.status(500).send("Error generando PDF: " + e.message);
    }
});

app.listen(3000, () => console.log("Servidor corriendo en http://localhost:3000"));
