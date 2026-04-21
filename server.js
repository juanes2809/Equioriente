const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const { execSync } = require("child_process");
const fs = require("fs");
const ExcelJS = require("exceljs");
const os = require("os");
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

const db = new sqlite3.Database("rental.db");

// Helper: promisified db methods
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
        if (err) reject(err); else resolve(this);
    });
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows || []); });
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario TEXT UNIQUE,
        password TEXT,
        rol TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        telefono TEXT,
        direccion TEXT,
        identificacion TEXT UNIQUE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS categorias (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT UNIQUE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS articulos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referencia TEXT UNIQUE NOT NULL,
        nombre TEXT NOT NULL,
        stock_total INTEGER NOT NULL DEFAULT 0,
        stock_disponible INTEGER NOT NULL DEFAULT 0,
        stock_mantenimiento INTEGER NOT NULL DEFAULT 0,
        stock_danado INTEGER NOT NULL DEFAULT 0,
        stock_minimo INTEGER NOT NULL DEFAULT 0,
        precio_dia REAL NOT NULL DEFAULT 0,
        es_externo INTEGER NOT NULL DEFAULT 0,
        empresa_externa TEXT,
        costo_proveedor_dia REAL DEFAULT 0,
        categoria_id INTEGER,
        FOREIGN KEY(categoria_id) REFERENCES categorias(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS alquileres (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_id INTEGER NOT NULL,
        usuario_id INTEGER NOT NULL,
        fecha_salida TEXT DEFAULT CURRENT_TIMESTAMP,
        fecha_devolucion_esperada TEXT,
        fecha_devolucion_real TEXT,
        estado TEXT DEFAULT 'activo',
        notas TEXT,
        FOREIGN KEY(cliente_id) REFERENCES clientes(id),
        FOREIGN KEY(usuario_id) REFERENCES usuarios(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS alquiler_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alquiler_id INTEGER NOT NULL,
        articulo_id INTEGER NOT NULL,
        cantidad INTEGER NOT NULL,
        cantidad_devuelta INTEGER NOT NULL DEFAULT 0,
        precio_dia_aplicado REAL NOT NULL,
        dias_acordados INTEGER NOT NULL DEFAULT 1,
        dias_reales INTEGER,
        total_calculado REAL,
        FOREIGN KEY(alquiler_id) REFERENCES alquileres(id),
        FOREIGN KEY(articulo_id) REFERENCES articulos(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS devoluciones_proveedor (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        articulo_id INTEGER NOT NULL,
        cantidad INTEGER NOT NULL,
        fecha_retiro TEXT,
        fecha_devolucion TEXT DEFAULT CURRENT_TIMESTAMP,
        dias_reales INTEGER,
        costo_proveedor_dia REAL,
        total_costo REAL,
        notas TEXT,
        usuario_id INTEGER,
        FOREIGN KEY(articulo_id) REFERENCES articulos(id),
        FOREIGN KEY(usuario_id) REFERENCES usuarios(id)
    )`);

    // Historial de movimientos de inventario
    db.run(`CREATE TABLE IF NOT EXISTS movimientos_inventario (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        articulo_id INTEGER NOT NULL,
        tipo TEXT NOT NULL,
        cantidad INTEGER NOT NULL,
        motivo TEXT,
        referencia_id INTEGER,
        usuario_id INTEGER,
        fecha TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(articulo_id) REFERENCES articulos(id),
        FOREIGN KEY(usuario_id) REFERENCES usuarios(id)
    )`);

    // Registro de daños y pérdidas
    db.run(`CREATE TABLE IF NOT EXISTS registro_danos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        articulo_id INTEGER NOT NULL,
        alquiler_id INTEGER,
        cliente_id INTEGER,
        cantidad INTEGER NOT NULL DEFAULT 1,
        tipo TEXT NOT NULL DEFAULT 'dano',
        descripcion TEXT,
        costo_reparacion REAL DEFAULT 0,
        cobrado_cliente INTEGER DEFAULT 0,
        monto_cobrado REAL DEFAULT 0,
        estado TEXT DEFAULT 'pendiente',
        usuario_id INTEGER,
        fecha TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(articulo_id) REFERENCES articulos(id),
        FOREIGN KEY(alquiler_id) REFERENCES alquileres(id),
        FOREIGN KEY(cliente_id) REFERENCES clientes(id),
        FOREIGN KEY(usuario_id) REFERENCES usuarios(id)
    )`);

    // Add new columns to existing tables if they don't exist (migration)
    db.run(`ALTER TABLE articulos ADD COLUMN stock_mantenimiento INTEGER NOT NULL DEFAULT 0`, () => {});
    db.run(`ALTER TABLE articulos ADD COLUMN stock_danado INTEGER NOT NULL DEFAULT 0`, () => {});
    db.run(`ALTER TABLE articulos ADD COLUMN stock_minimo INTEGER NOT NULL DEFAULT 0`, () => {});
    db.run(`ALTER TABLE alquiler_items ADD COLUMN cantidad_devuelta INTEGER NOT NULL DEFAULT 0`, () => {});

    // Migrate plaintext passwords to bcrypt
    db.all("SELECT id, password FROM usuarios", [], (err, users) => {
        if (users) {
            users.forEach(u => {
                if (!u.password.startsWith("$2b$") && !u.password.startsWith("$2a$")) {
                    const hash = bcrypt.hashSync(u.password, SALT_ROUNDS);
                    db.run("UPDATE usuarios SET password=? WHERE id=?", [hash, u.id]);
                }
            });
        }
    });

    // Insert default users if they don't exist (will be hashed by migration above)
    db.run(`INSERT OR IGNORE INTO usuarios (usuario, password, rol) VALUES ('admin', '1234', 'admin')`);
    db.run(`INSERT OR IGNORE INTO usuarios (usuario, password, rol) VALUES ('operario', '1234', 'operario')`);
    db.run(`INSERT OR IGNORE INTO categorias (nombre) VALUES ('General')`);
});

// ── Helper: log inventory movement ──────────────────
async function logMovimiento(articulo_id, tipo, cantidad, motivo, referencia_id, usuario_id) {
    await dbRun(
        `INSERT INTO movimientos_inventario (articulo_id, tipo, cantidad, motivo, referencia_id, usuario_id) VALUES (?,?,?,?,?,?)`,
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
        const user = await dbGet("SELECT id, rol, usuario, password as hash FROM usuarios WHERE usuario = ?", [usuario]);
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
        const user = await dbGet("SELECT password FROM usuarios WHERE id=?", [req.user.id]);
        const valid = await bcrypt.compare(password_actual, user.password);
        if (!valid) return res.status(400).json({ error: "Contraseña actual incorrecta" });
        const hash = await bcrypt.hash(password_nuevo, SALT_ROUNDS);
        await dbRun("UPDATE usuarios SET password=? WHERE id=?", [hash, req.user.id]);
        res.json({ msg: "Contraseña actualizada" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── CATEGORIAS ────────────────────────────────────────
app.get("/categorias", authMiddleware, (req, res) => {
    db.all("SELECT * FROM categorias ORDER BY nombre", [], (err, rows) => res.json(rows || []));
});
app.post("/categorias", authMiddleware, (req, res) => {
    db.run("INSERT INTO categorias (nombre) VALUES (?)", [req.body.nombre], function(err) {
        if (err) return res.status(500).send(err.message);
        res.json({ id: this.lastID, nombre: req.body.nombre });
    });
});

// ── CLIENTES ──────────────────────────────────────────
app.get("/clientes", authMiddleware, (req, res) => {
    const { buscar } = req.query;
    let sql = "SELECT * FROM clientes";
    const params = [];
    if (buscar) {
        sql += " WHERE nombre LIKE ? OR identificacion LIKE ? OR telefono LIKE ?";
        const term = `%${buscar}%`;
        params.push(term, term, term);
    }
    sql += " ORDER BY nombre";
    db.all(sql, params, (err, rows) => res.json(rows || []));
});
app.post("/clientes", authMiddleware, (req, res) => {
    const { nombre, telefono, direccion, identificacion } = req.body;
    db.run("INSERT INTO clientes (nombre, telefono, direccion, identificacion) VALUES (?,?,?,?)",
        [nombre, telefono, direccion, identificacion], function(err) {
            if (err) return res.status(500).send("Error: identificacion duplicada o datos invalidos.");
            res.json({ id: this.lastID, nombre });
        });
});
app.put("/clientes/:id", authMiddleware, (req, res) => {
    const { nombre, telefono, direccion, identificacion } = req.body;
    db.run("UPDATE clientes SET nombre=?, telefono=?, direccion=?, identificacion=? WHERE id=?",
        [nombre, telefono, direccion, identificacion, req.params.id], (err) => {
            if (err) return res.status(500).send(err.message);
            res.json({ msg: "Actualizado" });
        });
});
app.delete("/clientes/:id", authMiddleware, (req, res) => {
    db.run("DELETE FROM clientes WHERE id=?", [req.params.id], (err) => {
        if (err) return res.status(500).send(err.message);
        res.json({ msg: "Eliminado" });
    });
});

// ── ARTICULOS ─────────────────────────────────────────
app.get("/articulos", authMiddleware, (req, res) => {
    const { buscar, categoria_id } = req.query;
    let sql = `SELECT a.*, c.nombre as categoria_nombre
               FROM articulos a LEFT JOIN categorias c ON a.categoria_id = c.id WHERE 1=1`;
    const params = [];
    if (buscar) {
        sql += " AND (a.nombre LIKE ? OR a.referencia LIKE ?)";
        const term = `%${buscar}%`;
        params.push(term, term);
    }
    if (categoria_id) {
        sql += " AND a.categoria_id = ?";
        params.push(categoria_id);
    }
    sql += " ORDER BY a.nombre";
    db.all(sql, params, (err, rows) => res.json(rows || []));
});

// Stock alerts
app.get("/articulos/alertas", authMiddleware, (req, res) => {
    db.all(`SELECT a.*, c.nombre as categoria_nombre
            FROM articulos a LEFT JOIN categorias c ON a.categoria_id = c.id
            WHERE a.stock_disponible <= a.stock_minimo AND a.stock_minimo > 0
            ORDER BY a.stock_disponible ASC`, [], (err, rows) => res.json(rows || []));
});

app.post("/articulos", authMiddleware, async (req, res) => {
    try {
        const { referencia, nombre, stock_total, precio_dia, es_externo, empresa_externa, costo_proveedor_dia, categoria_id, stock_minimo } = req.body;
        const stockInt = parseInt(stock_total) || 0;
        const result = await dbRun(
            `INSERT INTO articulos (referencia, nombre, stock_total, stock_disponible, precio_dia, es_externo, empresa_externa, costo_proveedor_dia, categoria_id, stock_minimo)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [referencia.toUpperCase(), nombre, stockInt, stockInt,
             precio_dia, es_externo ? 1 : 0, empresa_externa || null,
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
        const old = await dbGet("SELECT stock_total FROM articulos WHERE id=?", [req.params.id]);
        await dbRun("UPDATE articulos SET nombre=?, stock_total=?, precio_dia=?, empresa_externa=?, costo_proveedor_dia=?, stock_minimo=? WHERE id=?",
            [nombre, stock_total, precio_dia, empresa_externa || null, costo_proveedor_dia || 0, stock_minimo || 0, req.params.id]);

        if (old && stock_total !== old.stock_total) {
            const diff = stock_total - old.stock_total;
            if (diff > 0) {
                await dbRun("UPDATE articulos SET stock_disponible = stock_disponible + ? WHERE id=?", [diff, req.params.id]);
                await logMovimiento(req.params.id, "entrada", diff, "Ajuste manual de stock", null, req.user.id);
            } else if (diff < 0) {
                await dbRun("UPDATE articulos SET stock_disponible = MAX(0, stock_disponible + ?) WHERE id=?", [diff, req.params.id]);
                await logMovimiento(req.params.id, "salida", Math.abs(diff), "Ajuste manual de stock", null, req.user.id);
            }
        }
        res.json({ msg: "Actualizado" });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.delete("/articulos/:id", authMiddleware, (req, res) => {
    db.run("DELETE FROM articulos WHERE id=?", [req.params.id], (err) => {
        if (err) return res.status(500).send(err.message);
        res.json({ msg: "Eliminado" });
    });
});

// ── MOVIMIENTOS DE INVENTARIO ────────────────────────
app.get("/movimientos", authMiddleware, (req, res) => {
    const { articulo_id, limit } = req.query;
    let sql = `SELECT m.*, a.nombre as articulo_nombre, a.referencia, u.usuario as operario
               FROM movimientos_inventario m
               JOIN articulos a ON m.articulo_id = a.id
               LEFT JOIN usuarios u ON m.usuario_id = u.id`;
    const params = [];
    if (articulo_id) {
        sql += " WHERE m.articulo_id = ?";
        params.push(articulo_id);
    }
    sql += " ORDER BY m.id DESC";
    if (limit) { sql += " LIMIT ?"; params.push(parseInt(limit)); }
    db.all(sql, params, (err, rows) => res.json(rows || []));
});

// ── ALQUILERES (a clientes) ───────────────────────────
app.post("/alquileres", authMiddleware, async (req, res) => {
    try {
        const { cliente_id, usuario_id, fecha_devolucion_esperada, notas, items } = req.body;
        if (!items || items.length === 0) return res.status(400).send("Sin articulos");

        // Verify stock for all items first
        for (const item of items) {
            const art = await dbGet("SELECT stock_disponible, nombre FROM articulos WHERE id=?", [item.articulo_id]);
            if (!art || art.stock_disponible < item.cantidad) {
                return res.status(400).send(`Stock insuficiente para ${art ? art.nombre : 'articulo ID ' + item.articulo_id}`);
            }
        }

        const result = await dbRun(
            `INSERT INTO alquileres (cliente_id, usuario_id, fecha_devolucion_esperada, notas) VALUES (?,?,?,?)`,
            [cliente_id, usuario_id || req.user.id, fecha_devolucion_esperada, notas || null]);
        const alqId = result.lastID;

        for (const item of items) {
            await dbRun(
                `INSERT INTO alquiler_items (alquiler_id, articulo_id, cantidad, precio_dia_aplicado, dias_acordados) VALUES (?,?,?,?,?)`,
                [alqId, item.articulo_id, item.cantidad, item.precio_dia_aplicado, item.dias_acordados]);
            await dbRun("UPDATE articulos SET stock_disponible = stock_disponible - ? WHERE id=?",
                [item.cantidad, item.articulo_id]);
            await logMovimiento(item.articulo_id, "salida", item.cantidad, "Alquiler #" + alqId, alqId, req.user.id);
        }

        res.json({ id: alqId });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.get("/alquileres", authMiddleware, (req, res) => {
    const { estado, buscar } = req.query;
    let sql = `
        SELECT al.*, c.nombre as cliente_nombre, c.identificacion as cliente_id_doc,
               c.telefono as cliente_tel, u.usuario as operario
        FROM alquileres al
        JOIN clientes c ON al.cliente_id = c.id
        JOIN usuarios u ON al.usuario_id = u.id
        WHERE 1=1
    `;
    const params = [];
    if (estado) { sql += " AND al.estado = ?"; params.push(estado); }
    if (buscar) {
        sql += " AND (c.nombre LIKE ? OR c.identificacion LIKE ? OR CAST(al.id AS TEXT) LIKE ?)";
        const term = `%${buscar}%`;
        params.push(term, term, term);
    }
    sql += " ORDER BY al.id DESC";
    db.all(sql, params, (err, rows) => res.json(rows || []));
});

app.get("/alquileres/:id/items", authMiddleware, (req, res) => {
    db.all(`SELECT ai.*, a.nombre, a.referencia, a.es_externo, a.empresa_externa
            FROM alquiler_items ai
            JOIN articulos a ON ai.articulo_id = a.id
            WHERE ai.alquiler_id = ?`, [req.params.id], (err, rows) => res.json(rows || []));
});

// ── DEVOLUCION PARCIAL ───────────────────────────────
app.put("/alquileres/:id/devolver", authMiddleware, async (req, res) => {
    try {
        const alqId = req.params.id;
        const { items_devueltos } = req.body;
        // items_devueltos: [{ item_id, cantidad_devolver }] — optional, if not provided returns ALL

        const alq = await dbGet("SELECT fecha_salida, estado FROM alquileres WHERE id=?", [alqId]);
        if (!alq) return res.status(404).send("Alquiler no encontrado");
        if (alq.estado === "devuelto") return res.status(400).send("Este alquiler ya fue devuelto completamente");

        const ahora = new Date();
        const salida = new Date(alq.fecha_salida);
        const diasReales = Math.max(1, Math.ceil((ahora - salida) / (1000 * 60 * 60 * 24)));

        const allItems = await dbAll("SELECT * FROM alquiler_items WHERE alquiler_id=?", [alqId]);

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

                await dbRun("UPDATE alquiler_items SET cantidad_devuelta=?, dias_reales=?, total_calculado=? WHERE id=?",
                    [newDevuelta, diasReales, total, item.id]);
                await dbRun("UPDATE articulos SET stock_disponible = stock_disponible + ? WHERE id=?",
                    [cantDev, item.articulo_id]);
                await logMovimiento(item.articulo_id, "entrada", cantDev, "Devolucion parcial alquiler #" + alqId, alqId, req.user.id);
            }
        } else {
            // Full return of all remaining items
            for (const item of allItems) {
                const pendiente = item.cantidad - item.cantidad_devuelta;
                if (pendiente <= 0) continue;
                const total = item.precio_dia_aplicado * diasReales * item.cantidad;
                await dbRun("UPDATE alquiler_items SET cantidad_devuelta=?, dias_reales=?, total_calculado=? WHERE id=?",
                    [item.cantidad, diasReales, total, item.id]);
                await dbRun("UPDATE articulos SET stock_disponible = stock_disponible + ? WHERE id=?",
                    [pendiente, item.articulo_id]);
                await logMovimiento(item.articulo_id, "entrada", pendiente, "Devolucion alquiler #" + alqId, alqId, req.user.id);
            }
        }

        // Check if all items fully returned
        const updated = await dbAll("SELECT cantidad, cantidad_devuelta FROM alquiler_items WHERE alquiler_id=?", [alqId]);
        const allReturned = updated.every(i => i.cantidad_devuelta >= i.cantidad);
        if (allReturned) {
            await dbRun("UPDATE alquileres SET estado='devuelto', fecha_devolucion_real=CURRENT_TIMESTAMP WHERE id=?", [alqId]);
        } else {
            await dbRun("UPDATE alquileres SET estado='parcial' WHERE id=?", [alqId]);
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
            `INSERT INTO registro_danos (articulo_id, alquiler_id, cliente_id, cantidad, tipo, descripcion, costo_reparacion, cobrado_cliente, monto_cobrado, usuario_id)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [articulo_id, alquiler_id || null, cliente_id || null, cantidad,
             tipo || "dano", descripcion || null, costo_reparacion || 0,
             cobrado_cliente ? 1 : 0, monto_cobrado || 0, req.user.id]);

        if (tipo === "perdida") {
            await dbRun("UPDATE articulos SET stock_total = stock_total - ?, stock_disponible = MAX(0, stock_disponible - ?) WHERE id=?",
                [cantidad, cantidad, articulo_id]);
            await logMovimiento(articulo_id, "perdida", cantidad, descripcion || "Perdida registrada", alquiler_id, req.user.id);
        } else {
            // Damage: move from available to damaged
            await dbRun("UPDATE articulos SET stock_disponible = MAX(0, stock_disponible - ?), stock_danado = stock_danado + ? WHERE id=?",
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
        const dano = await dbGet("SELECT * FROM registro_danos WHERE id=?", [req.params.id]);
        if (!dano) return res.status(404).send("Registro no encontrado");

        await dbRun("UPDATE registro_danos SET estado='reparado' WHERE id=?", [req.params.id]);
        await dbRun("UPDATE articulos SET stock_danado = MAX(0, stock_danado - ?), stock_disponible = stock_disponible + ? WHERE id=?",
            [dano.cantidad, dano.cantidad, dano.articulo_id]);
        await logMovimiento(dano.articulo_id, "reparacion", dano.cantidad, "Reparacion completada", null, req.user.id);
        res.json({ msg: "Articulo reparado y devuelto al inventario" });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.get("/danos", authMiddleware, (req, res) => {
    const { estado } = req.query;
    let sql = `SELECT d.*, a.nombre as articulo_nombre, a.referencia,
                      c.nombre as cliente_nombre, u.usuario as operario
               FROM registro_danos d
               JOIN articulos a ON d.articulo_id = a.id
               LEFT JOIN clientes c ON d.cliente_id = c.id
               LEFT JOIN usuarios u ON d.usuario_id = u.id`;
    const params = [];
    if (estado) { sql += " WHERE d.estado = ?"; params.push(estado); }
    sql += " ORDER BY d.id DESC";
    db.all(sql, params, (err, rows) => res.json(rows || []));
});

// ── DEVOLUCIONES A PROVEEDOR ──────────────────────────
app.post("/devoluciones_proveedor", authMiddleware, async (req, res) => {
    try {
        const { articulo_id, cantidad, fecha_retiro, costo_proveedor_dia, notas } = req.body;
        if (!articulo_id || !cantidad) return res.status(400).send("Datos incompletos");

        const art = await dbGet("SELECT * FROM articulos WHERE id=?", [articulo_id]);
        if (!art) return res.status(404).send("Articulo no encontrado");
        if (art.stock_disponible < cantidad)
            return res.status(400).send(`Solo hay ${art.stock_disponible} unidades disponibles para devolver`);

        const fechaRetiroDate = fecha_retiro ? new Date(fecha_retiro) : new Date();
        const ahora = new Date();
        const diasReales = Math.max(1, Math.ceil((ahora - fechaRetiroDate) / (1000 * 60 * 60 * 24)));
        const costoDia = parseFloat(costo_proveedor_dia) || art.costo_proveedor_dia || 0;
        const totalCosto = costoDia * diasReales * cantidad;

        const result = await dbRun(
            `INSERT INTO devoluciones_proveedor (articulo_id, cantidad, fecha_retiro, dias_reales, costo_proveedor_dia, total_costo, notas, usuario_id)
             VALUES (?,?,?,?,?,?,?,?)`,
            [articulo_id, cantidad, fecha_retiro || null, diasReales, costoDia, totalCosto, notas || null, req.user.id]);

        const newTotal = art.stock_total - cantidad;
        if (newTotal <= 0) {
            await dbRun("DELETE FROM articulos WHERE id=?", [articulo_id]);
        } else {
            await dbRun("UPDATE articulos SET stock_disponible = stock_disponible - ?, stock_total = stock_total - ? WHERE id=?",
                [cantidad, cantidad, articulo_id]);
        }
        await logMovimiento(articulo_id, "devolucion_proveedor", cantidad, "Devolucion a proveedor", result.lastID, req.user.id);

        res.json({ id: result.lastID, diasReales, totalCosto });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.get("/devoluciones_proveedor", authMiddleware, (req, res) => {
    db.all(`SELECT dp.*, a.nombre, a.referencia, a.empresa_externa, u.usuario as operario
            FROM devoluciones_proveedor dp
            JOIN articulos a ON dp.articulo_id = a.id
            LEFT JOIN usuarios u ON dp.usuario_id = u.id
            ORDER BY dp.id DESC`, [], (err, rows) => res.json(rows || []));
});

// ── REPORTES ─────────────────────────────────────────
app.get("/reportes/articulos-top", authMiddleware, async (req, res) => {
    try {
        const rows = await dbAll(`
            SELECT a.nombre, a.referencia, SUM(ai.cantidad) as total_alquilado, COUNT(DISTINCT ai.alquiler_id) as veces_alquilado
            FROM alquiler_items ai
            JOIN articulos a ON ai.articulo_id = a.id
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
            FROM alquileres al
            JOIN alquiler_items ai ON al.id = ai.alquiler_id
            WHERE al.estado = 'devuelto' AND ai.total_calculado IS NOT NULL`;
        const params = [];
        if (desde) { sql += " AND DATE(al.fecha_salida) >= ?"; params.push(desde); }
        if (hasta) { sql += " AND DATE(al.fecha_salida) <= ?"; params.push(hasta); }
        sql += " GROUP BY DATE(al.fecha_salida) ORDER BY fecha DESC";
        const rows = await dbAll(sql, params);

        const totales = await dbGet(`
            SELECT COALESCE(SUM(ai.total_calculado), 0) as ingreso_total,
                   COUNT(DISTINCT al.id) as total_alquileres
            FROM alquileres al
            JOIN alquiler_items ai ON al.id = ai.alquiler_id
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
            FROM clientes c
            JOIN alquileres al ON c.id = al.cliente_id
            LEFT JOIN alquiler_items ai ON al.id = ai.alquiler_id
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
                   COALESCE((SELECT SUM(ai2.total_calculado) FROM alquiler_items ai2 WHERE ai2.articulo_id = a.id), 0) as ingreso_generado
            FROM articulos a
            LEFT JOIN devoluciones_proveedor dp ON a.id = dp.articulo_id
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
            FROM alquileres al
            JOIN clientes c ON al.cliente_id = c.id
            WHERE al.estado IN ('activo', 'parcial')
              AND al.fecha_devolucion_esperada IS NOT NULL
              AND DATE('now') > DATE(al.fecha_devolucion_esperada)
            ORDER BY dias_retraso DESC`);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BACKUP ───────────────────────────────────────────
app.post("/backup", authMiddleware, adminOnly, (req, res) => {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupFile = path.join(BACKUP_DIR, `rental_backup_${timestamp}.db`);
        fs.copyFileSync("rental.db", backupFile);

        // Keep only the last 10 backups
        const backups = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith("rental_backup_") && f.endsWith(".db"))
            .sort()
            .reverse();
        backups.slice(10).forEach(f => {
            try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch(_) {}
        });

        res.json({ msg: "Backup creado", archivo: backupFile });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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

// Auto-backup every 6 hours
setInterval(() => {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupFile = path.join(BACKUP_DIR, `rental_backup_${timestamp}.db`);
        fs.copyFileSync("rental.db", backupFile);
        const backups = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith("rental_backup_") && f.endsWith(".db"))
            .sort().reverse();
        backups.slice(10).forEach(f => {
            try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch(_) {}
        });
        console.log("Auto-backup creado:", backupFile);
    } catch (e) {
        console.error("Error en auto-backup:", e.message);
    }
}, 6 * 60 * 60 * 1000);

// ── ESTADÍSTICAS MENSUALES ────────────────────────────
app.get("/reportes/estadisticas", authMiddleware, async (req, res) => {
    try {
        // Revenue per month for the last 12 months
        const meses = await dbAll(`
            SELECT strftime('%Y-%m', al.fecha_salida) as mes,
                   COALESCE(SUM(ai.total_calculado), 0) as ingreso,
                   COUNT(DISTINCT al.id) as alquileres
            FROM alquileres al
            JOIN alquiler_items ai ON al.id = ai.alquiler_id
            WHERE al.estado = 'devuelto' AND ai.total_calculado IS NOT NULL
              AND al.fecha_salida >= date('now', '-12 months')
            GROUP BY mes
            ORDER BY mes ASC`);

        // Current month totals
        const mesActual = await dbGet(`
            SELECT COALESCE(SUM(ai.total_calculado), 0) as ingreso,
                   COUNT(DISTINCT al.id) as alquileres,
                   COALESCE(AVG(ai.total_calculado), 0) as promedio_item
            FROM alquileres al
            JOIN alquiler_items ai ON al.id = ai.alquiler_id
            WHERE al.estado = 'devuelto' AND ai.total_calculado IS NOT NULL
              AND strftime('%Y-%m', al.fecha_salida) = strftime('%Y-%m', 'now')`);

        // Previous month totals
        const mesPasado = await dbGet(`
            SELECT COALESCE(SUM(ai.total_calculado), 0) as ingreso,
                   COUNT(DISTINCT al.id) as alquileres
            FROM alquileres al
            JOIN alquiler_items ai ON al.id = ai.alquiler_id
            WHERE al.estado = 'devuelto' AND ai.total_calculado IS NOT NULL
              AND strftime('%Y-%m', al.fecha_salida) = strftime('%Y-%m', date('now', '-1 month'))`);

        // Top client this month
        const topCliente = await dbGet(`
            SELECT c.nombre, COUNT(al.id) as alquileres,
                   COALESCE(SUM(ai.total_calculado), 0) as total
            FROM alquileres al
            JOIN clientes c ON al.cliente_id = c.id
            JOIN alquiler_items ai ON al.id = ai.alquiler_id
            WHERE al.estado = 'devuelto' AND ai.total_calculado IS NOT NULL
              AND strftime('%Y-%m', al.fecha_salida) = strftime('%Y-%m', 'now')
            GROUP BY c.id ORDER BY total DESC LIMIT 1`);

        // Top article this month
        const topArticulo = await dbGet(`
            SELECT a.nombre, SUM(ai.cantidad) as total_cant
            FROM alquiler_items ai
            JOIN articulos a ON ai.articulo_id = a.id
            JOIN alquileres al ON ai.alquiler_id = al.id
            WHERE strftime('%Y-%m', al.fecha_salida) = strftime('%Y-%m', 'now')
            GROUP BY ai.articulo_id ORDER BY total_cant DESC LIMIT 1`);

        res.json({ meses, mesActual, mesPasado, topCliente: topCliente || null, topArticulo: topArticulo || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EXPORTAR XLSX ─────────────────────────────────────

// Export all rentals for a client
app.get("/exportar/cliente/:id", authMiddleware, async (req, res) => {
    try {
        const cliente = await dbGet("SELECT * FROM clientes WHERE id=?", [req.params.id]);
        if (!cliente) return res.status(404).send("Cliente no encontrado");

        const alqs = await dbAll(`
            SELECT al.id, al.fecha_salida, al.fecha_devolucion_esperada, al.fecha_devolucion_real,
                   al.estado, al.notas, u.usuario as operario
            FROM alquileres al
            JOIN usuarios u ON al.usuario_id = u.id
            WHERE al.cliente_id = ?
            ORDER BY al.id DESC`, [req.params.id]);

        const items = await dbAll(`
            SELECT ai.alquiler_id, a.referencia, a.nombre, ai.cantidad, ai.cantidad_devuelta,
                   ai.precio_dia_aplicado, ai.dias_acordados, ai.dias_reales,
                   COALESCE(ai.total_calculado, ai.precio_dia_aplicado * COALESCE(ai.dias_reales, ai.dias_acordados) * ai.cantidad) as subtotal
            FROM alquiler_items ai
            JOIN articulos a ON ai.articulo_id = a.id
            JOIN alquileres al ON ai.alquiler_id = al.id
            WHERE al.cliente_id = ?
            ORDER BY ai.alquiler_id DESC, a.nombre`, [req.params.id]);

        const workbook = new ExcelJS.Workbook();
        const ws1 = workbook.addWorksheet("Alquileres");

        // Sheet 1: Rentals summary
        const alqData = [
            ["#", "Fecha Salida", "Dev. Esperada", "Dev. Real", "Estado", "Operario", "Notas"],
            ...alqs.map(a => [
                a.id,
                (a.fecha_salida || "").substring(0, 16).replace("T", " "),
                a.fecha_devolucion_esperada || "",
                (a.fecha_devolucion_real || "").substring(0, 16).replace("T", " "),
                a.estado,
                a.operario,
                a.notas || ""
            ])
        ];
        ws1.addRows(alqData);
        const ws1Cols = [8, 18, 14, 14, 10, 12, 30];
        ws1.columns.forEach((col, i) => { if(ws1Cols[i]) col.width = ws1Cols[i]; });

        // Sheet 2: Items detail
        const ws2 = workbook.addWorksheet("Items");
        const itemData = [
            ["Alquiler #", "Referencia", "Articulo", "Cantidad", "Devuelto", "Precio/dia", "Dias", "Subtotal"],
            ...items.map(i => [i.alquiler_id, i.referencia, i.nombre, i.cantidad, i.cantidad_devuelta,
                i.precio_dia_aplicado, i.dias_reales || i.dias_acordados, i.subtotal])
        ];
        ws2.addRows(itemData);
        const ws2Cols = [10, 12, 28, 8, 8, 12, 6, 14];
        ws2.columns.forEach((col, i) => { if(ws2Cols[i]) col.width = ws2Cols[i]; });

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
            FROM alquileres al
            JOIN clientes c ON al.cliente_id = c.id
            JOIN usuarios u ON al.usuario_id = u.id
            WHERE DATE(al.fecha_salida) = ?
            ORDER BY al.id`, [fecha]);

        const alqIds = alqs.map(a => a.id);
        const items = alqIds.length ? await dbAll(`
            SELECT ai.alquiler_id, a.referencia, a.nombre, ai.cantidad, ai.cantidad_devuelta,
                   ai.precio_dia_aplicado, ai.dias_acordados, ai.dias_reales,
                   COALESCE(ai.total_calculado, ai.precio_dia_aplicado * COALESCE(ai.dias_reales, ai.dias_acordados) * ai.cantidad) as subtotal
            FROM alquiler_items ai
            JOIN articulos a ON ai.articulo_id = a.id
            WHERE ai.alquiler_id IN (${alqIds.map(() => "?").join(",")})
            ORDER BY ai.alquiler_id, a.nombre`, alqIds) : [];

        const workbook = new ExcelJS.Workbook();
        const ws1 = workbook.addWorksheet(`Alquileres ${fecha}`);

        const alqData = [
            ["#", "Cliente", "Telefono", "ID/NIT", "Fecha Salida", "Dev. Esperada", "Dev. Real", "Estado", "Operario", "Notas"],
            ...alqs.map(a => [
                a.id, a.cliente, a.telefono || "", a.identificacion || "",
                (a.fecha_salida || "").substring(0, 16).replace("T", " "),
                a.fecha_devolucion_esperada || "",
                (a.fecha_devolucion_real || "").substring(0, 16).replace("T", " "),
                a.estado, a.operario, a.notas || ""
            ])
        ];
        ws1.addRows(alqData);
        const ws1Cols = [8, 24, 14, 14, 18, 14, 14, 10, 12, 30];
        ws1.columns.forEach((col, i) => { if(ws1Cols[i]) col.width = ws1Cols[i]; });

        const ws2 = workbook.addWorksheet("Items");
        const itemData = [
            ["Alquiler #", "Referencia", "Articulo", "Cantidad", "Devuelto", "Precio/dia", "Dias", "Subtotal"],
            ...items.map(i => [i.alquiler_id, i.referencia, i.nombre, i.cantidad, i.cantidad_devuelta,
                i.precio_dia_aplicado, i.dias_reales || i.dias_acordados, i.subtotal])
        ];
        ws2.addRows(itemData);
        const ws2Cols = [10, 12, 28, 8, 8, 12, 6, 14];
        ws2.columns.forEach((col, i) => { if(ws2Cols[i]) col.width = ws2Cols[i]; });

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="equioriente_dia_${fecha}.xlsx"`);
        const buffer = await workbook.xlsx.writeBuffer();
        res.send(buffer);
    } catch (e) { res.status(500).send(e.message); }
});

// ── PDF RECIBO ────────────────────────────────────────
app.get("/alquileres/:id/pdf", authMiddleware, (req, res) => {
    const alqId = req.params.id;

    db.get(`SELECT al.*, c.nombre as cliente_nombre, c.identificacion as cliente_id_doc,
                   c.telefono as cliente_tel, c.direccion as cliente_dir,
                   u.usuario as operario
            FROM alquileres al
            JOIN clientes c ON al.cliente_id = c.id
            JOIN usuarios u ON al.usuario_id = u.id
            WHERE al.id=?`, [alqId], (err, alq) => {
        if (!alq) return res.status(404).send("No encontrado");

        db.all(`SELECT ai.*, a.nombre, a.referencia, a.es_externo, a.empresa_externa
                FROM alquiler_items ai
                JOIN articulos a ON ai.articulo_id = a.id
                WHERE ai.alquiler_id=?`, [alqId], (err2, items) => {

            const tmpDir = os.tmpdir();
            const pdfPath = path.join(tmpDir, `recibo_${alqId}.pdf`);
            const scriptPath = path.join(tmpDir, `gen_pdf_${alqId}.py`);

            const safeData = JSON.stringify({ alq, items }).replace(/\\/g, "\\\\");

            const pyScript = `# -*- coding: utf-8 -*-
import json, sys, datetime
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER

data  = json.loads(${JSON.stringify(safeData)})
alq   = data['alq']
items = data['items']

out_path = ${JSON.stringify(pdfPath)}

doc = SimpleDocTemplate(out_path, pagesize=A4,
    leftMargin=20*mm, rightMargin=20*mm, topMargin=15*mm, bottomMargin=15*mm)
story = []

def sty(fname='Helvetica', fsize=9, color='#111827', align=0, sa=0, bg=None, bp=0):
    kw = dict(fontName=fname, fontSize=fsize,
              textColor=colors.HexColor(color), alignment=align, spaceAfter=sa)
    if bg:  kw['backColor'] = colors.HexColor(bg)
    if bp:  kw['borderPadding'] = bp
    return ParagraphStyle('_s', **kw)

story.append(Paragraph("RECIBO DE ALQUILER",
    sty('Helvetica-Bold', 20, '#1e3a5f', TA_CENTER, 2)))
story.append(Paragraph("Gestion de Equipos y Materiales",
    sty(fsize=10, color='#6b7280', align=TA_CENTER, sa=8)))
story.append(HRFlowable(width="100%", thickness=2, color=colors.HexColor('#1e3a5f')))
story.append(Spacer(1, 8))

estado_color = '#059669' if alq.get('estado') == 'devuelto' else '#d97706' if alq.get('estado') == 'parcial' else '#dc2626'
estado_text  = 'DEVUELTO' if alq.get('estado') == 'devuelto' else 'PARCIAL' if alq.get('estado') == 'parcial' else 'EN CURSO'
fecha_sal    = str(alq.get('fecha_salida') or '')[:16].replace('T', ' ')
fecha_esp    = str(alq.get('fecha_devolucion_esperada') or 'No especificada')[:10]
fecha_real   = str(alq.get('fecha_devolucion_real') or '')[:16].replace('T', ' ') or '-'

info_data = [
    ['N Alquiler:', '#' + str(alq['id']).zfill(4), 'Estado:', estado_text],
    ['Cliente:',   str(alq.get('cliente_nombre','')),   'ID/NIT:', str(alq.get('cliente_id_doc',''))],
    ['Telefono:',  str(alq.get('cliente_tel','')),       'Direccion:', str(alq.get('cliente_dir',''))],
    ['Fecha salida:', fecha_sal,                          'Dev. esperada:', fecha_esp],
    ['Operario:',  str(alq.get('operario','')),           'Dev. real:', fecha_real],
]
it = Table(info_data, colWidths=[38*mm, 55*mm, 45*mm, 45*mm])
it.setStyle(TableStyle([
    ('FONTNAME',  (0,0),(-1,-1), 'Helvetica'),
    ('FONTNAME',  (0,0),(0,-1),  'Helvetica-Bold'),
    ('FONTNAME',  (2,0),(2,-1),  'Helvetica-Bold'),
    ('FONTSIZE',  (0,0),(-1,-1), 9),
    ('TEXTCOLOR', (3,0),(3,0),   colors.HexColor(estado_color)),
    ('FONTNAME',  (3,0),(3,0),   'Helvetica-Bold'),
    ('ROWBACKGROUNDS',(0,0),(-1,-1),[colors.white, colors.HexColor('#f8fafc')]),
    ('TOPPADDING',(0,0),(-1,-1), 4), ('BOTTOMPADDING',(0,0),(-1,-1), 4),
    ('LEFTPADDING',(0,0),(-1,-1),4),
    ('BOX',       (0,0),(-1,-1), 0.5, colors.HexColor('#e5e7eb')),
    ('INNERGRID', (0,0),(-1,-1), 0.25, colors.HexColor('#e5e7eb')),
]))
story.append(it)
story.append(Spacer(1, 12))

story.append(Paragraph("Detalle de Articulos",
    sty('Helvetica-Bold', 11, '#1e3a5f', sa=6)))

rows = [['Ref.', 'Articulo', 'Cant.', 'Devuelto', 'Precio/dia', 'Dias', 'Subtotal']]
grand_total = 0
for i in items:
    dias     = i.get('dias_reales') or i.get('dias_acordados') or 1
    subtotal = i.get('total_calculado') or (i['precio_dia_aplicado'] * dias * i['cantidad'])
    grand_total += subtotal
    rows.append([
        str(i.get('referencia','')),
        str(i.get('nombre','')),
        str(i['cantidad']),
        str(i.get('cantidad_devuelta', 0)),
        '$' + '{:,.0f}'.format(i['precio_dia_aplicado']),
        str(dias),
        '$' + '{:,.0f}'.format(subtotal),
    ])

tbl = Table(rows, colWidths=[22*mm, 55*mm, 16*mm, 20*mm, 24*mm, 14*mm, 32*mm], repeatRows=1)
tbl.setStyle(TableStyle([
    ('BACKGROUND', (0,0),(-1,0),  colors.HexColor('#1e3a5f')),
    ('TEXTCOLOR',  (0,0),(-1,0),  colors.white),
    ('FONTNAME',   (0,0),(-1,0),  'Helvetica-Bold'),
    ('FONTNAME',   (0,1),(-1,-1), 'Helvetica'),
    ('FONTSIZE',   (0,0),(-1,-1), 9),
    ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, colors.HexColor('#f0f9ff')]),
    ('ALIGN',      (2,0),(-1,-1), 'CENTER'),
    ('TOPPADDING', (0,0),(-1,-1), 5), ('BOTTOMPADDING',(0,0),(-1,-1), 5),
    ('LEFTPADDING',(0,0),(-1,-1), 4),
    ('BOX',        (0,0),(-1,-1), 0.5, colors.HexColor('#e5e7eb')),
    ('INNERGRID',  (0,0),(-1,-1), 0.25, colors.HexColor('#e5e7eb')),
]))
story.append(tbl)
story.append(Spacer(1, 10))

tot = Table([['', 'TOTAL: $' + '{:,.0f}'.format(grand_total)]],
            colWidths=[130*mm, 53*mm])
tot.setStyle(TableStyle([
    ('BACKGROUND',(1,0),(1,0), colors.HexColor('#1e3a5f')),
    ('TEXTCOLOR', (1,0),(1,0), colors.white),
    ('FONTNAME',  (1,0),(1,0), 'Helvetica-Bold'),
    ('FONTSIZE',  (1,0),(1,0), 13),
    ('ALIGN',     (1,0),(1,0), 'CENTER'),
    ('TOPPADDING',(0,0),(-1,-1),8), ('BOTTOMPADDING',(0,0),(-1,-1),8),
]))
story.append(tot)

if alq.get('notas'):
    story.append(Spacer(1, 10))
    story.append(Paragraph('<b>Notas:</b> ' + str(alq['notas']),
        sty(color='#374151', bg='#fef9c3', bp=6)))

story.append(Spacer(1, 20))
story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#e5e7eb')))
story.append(Spacer(1, 6))
now_str = datetime.datetime.now().strftime('%d/%m/%Y %H:%M')
story.append(Paragraph(
    'Documento generado el ' + now_str + '  |  Firma cliente: _________________________',
    sty(fsize=8, color='#9ca3af', align=TA_CENTER)))

doc.build(story)
`;

            try {
                fs.writeFileSync(scriptPath, pyScript, { encoding: 'utf8' });
                const cmd = process.platform === 'win32'
                    ? `python "${scriptPath}"`
                    : `python3 "${scriptPath}"`;
                execSync(cmd, { timeout: 20000 });
                const pdf = fs.readFileSync(pdfPath);
                res.setHeader("Content-Type", "application/pdf");
                res.setHeader("Content-Disposition", `inline; filename="recibo_${alqId}.pdf"`);
                res.send(pdf);
            } catch (e) {
                console.error("PDF Error:", e.stderr ? e.stderr.toString() : e.message);
                res.status(500).send(
                    "Error generando PDF. Asegurese de tener Python y reportlab instalados " +
                    "(pip install reportlab). Detalle: " + (e.stderr ? e.stderr.toString() : e.message)
                );
            } finally {
                try { fs.unlinkSync(scriptPath); } catch(_) {}
                try { fs.unlinkSync(pdfPath); } catch(_) {}
            }
        });
    });
});

app.listen(3000, () => console.log("Servidor corriendo en http://localhost:3000"));
