const express = require("express");
const path    = require("path");
const fs      = require("fs");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const bcrypt  = require("bcrypt");
const jwt     = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");

// ── Config ────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // service_role key
const JWT_SECRET   = process.env.JWT_SECRET || "equioriente_secret_change_me";
const SALT_ROUNDS  = 10;
const PORT = parseInt(process.env.PORT) || 3000;
const BACKUP_DIR = path.join(__dirname, "backups");

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("ERROR: SUPABASE_URL y SUPABASE_KEY son requeridos en .env");
    process.exit(1);
}

// ── Supabase client ───────────────────────────────────
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
});

// ── Nombres de tabla ──────────────────────────────────
const T = {
    u:  "equioriente_usuarios",
    ca: "equioriente_categorias",
    cl: "equioriente_clientes",
    ar: "equioriente_articulos",
    al: "equioriente_alquileres",
    it: "equioriente_alquiler_items",
    dp: "equioriente_devoluciones_proveedor",
    mv: "equioriente_movimientos_inventario",
    dn: "equioriente_registro_danos",
};

// ── Helpers Supabase ──────────────────────────────────
const sq = async (builder) => {
    const { data, error } = await builder;
    if (error) throw new Error(error.message);
    return data ?? [];
};
const sqOne = async (builder) => {
    const { data, error } = await builder.maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? null;
};
const sqInsert = async (table, data) => {
    const { data: row, error } = await sb.from(table).insert(data).select("id").single();
    if (error) throw new Error(error.message);
    return { lastID: row.id };
};
const sqUpdate = async (table, data, id) => {
    const { error } = await sb.from(table).update(data).eq("id", id);
    if (error) throw new Error(error.message);
};
const sqDelete = async (table, id) => {
    const { error } = await sb.from(table).delete().eq("id", id);
    if (error) throw new Error(error.message);
};
const sqRpc = async (fn, params = {}) => {
    const { data, error } = await sb.rpc(fn, params);
    if (error) throw new Error(error.message);
    return data;
};

// Ajuste de stock usando RPC (evita race conditions en aritmética)
const ajustarStock = (id, { total = 0, disponible = 0, danado = 0 } = {}) =>
    sqRpc("equioriente_ajustar_stock", { p_id: id, p_total: total, p_disp: disponible, p_dano: danado });

// Log de movimiento de inventario
const logMov = (articulo_id, tipo, cantidad, motivo, referencia_id, usuario_id) =>
    sqInsert(T.mv, { articulo_id, tipo, cantidad, motivo,
        referencia_id: referencia_id ?? null, usuario_id: usuario_id ?? null });

// Flatten un campo de join anidado a campos planos
const flat = (row, joinKey, mapping) => {
    if (!row) return null;
    const r = { ...row };
    const j = r[joinKey] ?? {};
    for (const [from, to] of Object.entries(mapping)) r[to] = j[from] ?? null;
    delete r[joinKey];
    return r;
};

// ── Express ───────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static("."));

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

// ── Auth middleware ───────────────────────────────────
function authMiddleware(req, res, next) {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) return res.status(401).json({ error: "Token requerido" });
    try {
        req.user = jwt.verify(h.split(" ")[1], JWT_SECRET);
        next();
    } catch { res.status(401).json({ error: "Token invalido o expirado" }); }
}
function adminOnly(req, res, next) {
    if (req.user.rol !== "admin") return res.status(403).json({ error: "Solo administradores" });
    next();
}

// ── AUTH ──────────────────────────────────────────────
app.post("/login", async (req, res) => {
    try {
        const { usuario, password } = req.body;
        const user = await sqOne(sb.from(T.u).select("id, rol, usuario, password").eq("usuario", usuario));
        if (!user) return res.status(401).json({ error: "Credenciales incorrectas" });
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: "Credenciales incorrectas" });
        const token = jwt.sign({ id: user.id, usuario: user.usuario, rol: user.rol }, JWT_SECRET, { expiresIn: "12h" });
        res.json({ id: user.id, usuario: user.usuario, rol: user.rol, token });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/usuarios/password", authMiddleware, async (req, res) => {
    try {
        const { password_actual, password_nuevo } = req.body;
        const user = await sqOne(sb.from(T.u).select("password").eq("id", req.user.id));
        if (!await bcrypt.compare(password_actual, user.password))
            return res.status(400).json({ error: "Contraseña actual incorrecta" });
        await sqUpdate(T.u, { password: await bcrypt.hash(password_nuevo, SALT_ROUNDS) }, req.user.id);
        res.json({ msg: "Contraseña actualizada" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CATEGORÍAS ────────────────────────────────────────
app.get("/categorias", authMiddleware, async (req, res) => {
    try { res.json(await sq(sb.from(T.ca).select("*").order("nombre"))); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/categorias", authMiddleware, async (req, res) => {
    try {
        const r = await sqInsert(T.ca, { nombre: req.body.nombre });
        res.json({ id: r.lastID, nombre: req.body.nombre });
    } catch (e) { res.status(500).send(e.message); }
});

// ── CLIENTES ──────────────────────────────────────────
app.get("/clientes", authMiddleware, async (req, res) => {
    try {
        const { buscar } = req.query;
        let q = sb.from(T.cl).select("*").order("nombre");
        if (buscar) q = q.or(`nombre.ilike.%${buscar}%,identificacion.ilike.%${buscar}%,telefono.ilike.%${buscar}%`);
        res.json(await sq(q));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/clientes", authMiddleware, async (req, res) => {
    try {
        const { nombre, telefono, direccion, identificacion } = req.body;
        const r = await sqInsert(T.cl, { nombre, telefono, direccion, identificacion });
        res.json({ id: r.lastID, nombre });
    } catch (e) { res.status(500).send("Error: identificacion duplicada o datos invalidos."); }
});
app.put("/clientes/:id", authMiddleware, async (req, res) => {
    try {
        const { nombre, telefono, direccion, identificacion } = req.body;
        await sqUpdate(T.cl, { nombre, telefono, direccion, identificacion }, req.params.id);
        res.json({ msg: "Actualizado" });
    } catch (e) { res.status(500).send(e.message); }
});
app.delete("/clientes/:id", authMiddleware, async (req, res) => {
    try { await sqDelete(T.cl, req.params.id); res.json({ msg: "Eliminado" }); }
    catch (e) { res.status(500).send(e.message); }
});

// ── ARTÍCULOS ─────────────────────────────────────────
app.get("/articulos", authMiddleware, async (req, res) => {
    try {
        const { buscar, categoria_id } = req.query;
        let q = sb.from(T.ar)
            .select(`*, categoria:${T.ca}!categoria_id(nombre)`)
            .order("nombre");
        if (buscar) q = q.or(`nombre.ilike.%${buscar}%,referencia.ilike.%${buscar}%`);
        if (categoria_id) q = q.eq("categoria_id", categoria_id);
        const rows = await sq(q);
        res.json(rows.map(a => ({ ...a, categoria_nombre: a.categoria?.nombre ?? null, categoria: undefined })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/articulos/alertas", authMiddleware, async (req, res) => {
    try { res.json(await sqRpc("equioriente_articulos_alertas")); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/articulos", authMiddleware, async (req, res) => {
    try {
        const { referencia, nombre, stock_total, precio_dia, es_externo, empresa_externa, costo_proveedor_dia, categoria_id, stock_minimo } = req.body;
        const stockInt = parseInt(stock_total) || 0;
        const r = await sqInsert(T.ar, {
            referencia: referencia.toUpperCase(), nombre, stock_total: stockInt,
            stock_disponible: stockInt, precio_dia,
            es_externo: parseInt(es_externo) === 1 ? 1 : 0,
            empresa_externa: empresa_externa || null,
            costo_proveedor_dia: costo_proveedor_dia || 0,
            categoria_id: categoria_id || null,
            stock_minimo: stock_minimo || 0
        });
        await logMov(r.lastID, "entrada", stockInt, "Creacion de articulo", null, req.user.id);
        res.json({ id: r.lastID });
    } catch (e) { res.status(500).send("Error: referencia duplicada o datos invalidos."); }
});

app.put("/articulos/:id", authMiddleware, async (req, res) => {
    try {
        const { nombre, stock_total, precio_dia, empresa_externa, costo_proveedor_dia, stock_minimo } = req.body;
        const old = await sqOne(sb.from(T.ar).select("stock_total").eq("id", req.params.id));
        await sqUpdate(T.ar, { nombre, stock_total, precio_dia, empresa_externa: empresa_externa || null, costo_proveedor_dia: costo_proveedor_dia || 0, stock_minimo: stock_minimo || 0 }, req.params.id);
        if (old) {
            const diff = stock_total - old.stock_total;
            if (diff !== 0) {
                await ajustarStock(req.params.id, { disponible: diff });
                await logMov(req.params.id, diff > 0 ? "entrada" : "salida", Math.abs(diff), "Ajuste manual de stock", null, req.user.id);
            }
        }
        res.json({ msg: "Actualizado" });
    } catch (e) { res.status(500).send(e.message); }
});

app.delete("/articulos/:id", authMiddleware, async (req, res) => {
    try { await sqDelete(T.ar, req.params.id); res.json({ msg: "Eliminado" }); }
    catch (e) { res.status(500).send(e.message); }
});

// ── MOVIMIENTOS ───────────────────────────────────────
app.get("/movimientos", authMiddleware, async (req, res) => {
    try {
        const { articulo_id, limit } = req.query;
        let q = sb.from(T.mv)
            .select(`*, articulo:${T.ar}!articulo_id(nombre, referencia), operario:${T.u}!usuario_id(usuario)`)
            .order("id", { ascending: false });
        if (articulo_id) q = q.eq("articulo_id", articulo_id);
        if (limit) q = q.limit(parseInt(limit));
        const rows = await sq(q);
        res.json(rows.map(r => ({
            ...r,
            articulo_nombre: r.articulo?.nombre, referencia: r.articulo?.referencia,
            operario: r.operario?.usuario,
            articulo: undefined, operario_obj: undefined
        })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ALQUILERES ────────────────────────────────────────
app.post("/alquileres", authMiddleware, async (req, res) => {
    try {
        const { cliente_id, usuario_id, fecha_devolucion_esperada, notas, items } = req.body;
        if (!items?.length) return res.status(400).send("Sin articulos");

        for (const item of items) {
            const art = await sqOne(sb.from(T.ar).select("stock_disponible, nombre").eq("id", item.articulo_id));
            if (!art || art.stock_disponible < item.cantidad)
                return res.status(400).send(`Stock insuficiente para ${art?.nombre ?? "articulo " + item.articulo_id}`);
        }

        const r = await sqInsert(T.al, {
            cliente_id, usuario_id: usuario_id || req.user.id,
            fecha_devolucion_esperada: fecha_devolucion_esperada || null,
            notas: notas || null
        });
        const alqId = r.lastID;

        for (const item of items) {
            await sqInsert(T.it, {
                alquiler_id: alqId, articulo_id: item.articulo_id,
                cantidad: item.cantidad, precio_dia_aplicado: item.precio_dia_aplicado,
                dias_acordados: item.dias_acordados
            });
            await ajustarStock(item.articulo_id, { disponible: -item.cantidad });
            await logMov(item.articulo_id, "salida", item.cantidad, "Alquiler #" + alqId, alqId, req.user.id);
        }
        res.json({ id: alqId });
    } catch (e) { res.status(500).send(e.message); }
});

app.get("/alquileres", authMiddleware, async (req, res) => {
    try {
        const { estado, buscar } = req.query;
        let q = sb.from(T.al)
            .select(`*, cliente:${T.cl}!cliente_id(nombre, identificacion, telefono), operario:${T.u}!usuario_id(usuario)`)
            .order("id", { ascending: false });
        if (estado) q = q.eq("estado", estado);
        if (buscar) q = q.or(`cliente.nombre.ilike.%${buscar}%,cliente.identificacion.ilike.%${buscar}%`);
        const rows = await sq(q);
        res.json(rows.map(a => ({
            ...a,
            cliente_nombre: a.cliente?.nombre, cliente_id_doc: a.cliente?.identificacion,
            cliente_tel: a.cliente?.telefono, operario: a.operario?.usuario,
            cliente: undefined, operario: undefined
        })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/alquileres/:id/items", authMiddleware, async (req, res) => {
    try {
        const rows = await sq(sb.from(T.it)
            .select(`*, art:${T.ar}!articulo_id(nombre, referencia, es_externo, empresa_externa)`)
            .eq("alquiler_id", req.params.id));
        res.json(rows.map(i => ({
            ...i,
            nombre: i.art?.nombre, referencia: i.art?.referencia,
            es_externo: i.art?.es_externo, empresa_externa: i.art?.empresa_externa,
            art: undefined
        })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/alquileres/:id/devolver", authMiddleware, async (req, res) => {
    try {
        const alqId = req.params.id;
        const { items_devueltos } = req.body;
        const alq = await sqOne(sb.from(T.al).select("fecha_salida, estado").eq("id", alqId));
        if (!alq) return res.status(404).send("Alquiler no encontrado");
        if (alq.estado === "devuelto") return res.status(400).send("Ya fue devuelto completamente");

        const ahora = new Date();
        const diasReales = Math.max(1, Math.ceil((ahora - new Date(alq.fecha_salida)) / 86400000));
        const allItems = await sq(sb.from(T.it).select("*").eq("alquiler_id", alqId));

        if (items_devueltos?.length) {
            for (const dev of items_devueltos) {
                const item = allItems.find(i => i.id === dev.item_id);
                if (!item) continue;
                const cantDev = Math.min(dev.cantidad_devolver, item.cantidad - item.cantidad_devuelta);
                if (cantDev <= 0) continue;
                const newDev = item.cantidad_devuelta + cantDev;
                await sqUpdate(T.it, {
                    cantidad_devuelta: newDev, dias_reales: diasReales,
                    total_calculado: item.precio_dia_aplicado * diasReales * newDev
                }, item.id);
                await ajustarStock(item.articulo_id, { disponible: cantDev });
                await logMov(item.articulo_id, "entrada", cantDev, "Devolucion parcial alquiler #" + alqId, alqId, req.user.id);
            }
        } else {
            for (const item of allItems) {
                const pendiente = item.cantidad - item.cantidad_devuelta;
                if (pendiente <= 0) continue;
                await sqUpdate(T.it, {
                    cantidad_devuelta: item.cantidad, dias_reales: diasReales,
                    total_calculado: item.precio_dia_aplicado * diasReales * item.cantidad
                }, item.id);
                await ajustarStock(item.articulo_id, { disponible: pendiente });
                await logMov(item.articulo_id, "entrada", pendiente, "Devolucion alquiler #" + alqId, alqId, req.user.id);
            }
        }

        const updated = await sq(sb.from(T.it).select("cantidad, cantidad_devuelta").eq("alquiler_id", alqId));
        const allRet  = updated.every(i => i.cantidad_devuelta >= i.cantidad);
        await sqUpdate(T.al, allRet
            ? { estado: "devuelto", fecha_devolucion_real: new Date().toISOString() }
            : { estado: "parcial" }, alqId);
        res.json({ msg: allRet ? "Devuelto completamente" : "Devolucion parcial registrada", diasReales });
    } catch (e) { res.status(500).send(e.message); }
});

// ── DAÑOS / PÉRDIDAS ──────────────────────────────────
app.post("/danos", authMiddleware, async (req, res) => {
    try {
        const { articulo_id, alquiler_id, cliente_id, cantidad, tipo, descripcion, costo_reparacion, cobrado_cliente, monto_cobrado } = req.body;
        if (!articulo_id || !cantidad) return res.status(400).send("Datos incompletos");
        const r = await sqInsert(T.dn, {
            articulo_id, alquiler_id: alquiler_id || null, cliente_id: cliente_id || null,
            cantidad, tipo: tipo || "dano", descripcion: descripcion || null,
            costo_reparacion: costo_reparacion || 0,
            cobrado_cliente: cobrado_cliente ? 1 : 0, monto_cobrado: monto_cobrado || 0,
            usuario_id: req.user.id
        });
        if (tipo === "perdida") {
            await ajustarStock(articulo_id, { total: -cantidad, disponible: -cantidad });
            await logMov(articulo_id, "perdida", cantidad, descripcion || "Perdida", alquiler_id, req.user.id);
        } else {
            await ajustarStock(articulo_id, { disponible: -cantidad, danado: cantidad });
            await logMov(articulo_id, "dano", cantidad, descripcion || "Dano", alquiler_id, req.user.id);
        }
        res.json({ id: r.lastID });
    } catch (e) { res.status(500).send(e.message); }
});

app.put("/danos/:id/reparar", authMiddleware, async (req, res) => {
    try {
        const dano = await sqOne(sb.from(T.dn).select("*").eq("id", req.params.id));
        if (!dano) return res.status(404).send("Registro no encontrado");
        await sqUpdate(T.dn, { estado: "reparado" }, req.params.id);
        await ajustarStock(dano.articulo_id, { danado: -dano.cantidad, disponible: dano.cantidad });
        await logMov(dano.articulo_id, "reparacion", dano.cantidad, "Reparacion completada", null, req.user.id);
        res.json({ msg: "Articulo reparado y devuelto al inventario" });
    } catch (e) { res.status(500).send(e.message); }
});

app.get("/danos", authMiddleware, async (req, res) => {
    try {
        const { estado } = req.query;
        let q = sb.from(T.dn)
            .select(`*, art:${T.ar}!articulo_id(nombre, referencia), cli:${T.cl}!cliente_id(nombre), op:${T.u}!usuario_id(usuario)`)
            .order("id", { ascending: false });
        if (estado) q = q.eq("estado", estado);
        const rows = await sq(q);
        res.json(rows.map(d => ({
            ...d,
            articulo_nombre: d.art?.nombre, referencia: d.art?.referencia,
            cliente_nombre: d.cli?.nombre, operario: d.op?.usuario,
            art: undefined, cli: undefined, op: undefined
        })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DEVOLUCIONES A PROVEEDOR ──────────────────────────
app.post("/devoluciones_proveedor", authMiddleware, async (req, res) => {
    try {
        const { articulo_id, cantidad, fecha_retiro, costo_proveedor_dia, notas } = req.body;
        if (!articulo_id || !cantidad) return res.status(400).send("Datos incompletos");
        const art = await sqOne(sb.from(T.ar).select("*").eq("id", articulo_id));
        if (!art) return res.status(404).send("Articulo no encontrado");
        if (art.stock_disponible < cantidad)
            return res.status(400).send(`Solo hay ${art.stock_disponible} unidades disponibles`);

        const fechaRetiro = fecha_retiro ? new Date(fecha_retiro) : new Date();
        const diasReales  = Math.max(1, Math.ceil((new Date() - fechaRetiro) / 86400000));
        const costoDia    = parseFloat(costo_proveedor_dia) || art.costo_proveedor_dia || 0;
        const totalCosto  = costoDia * diasReales * cantidad;

        const r = await sqInsert(T.dp, {
            articulo_id, cantidad, fecha_retiro: fecha_retiro || null,
            dias_reales: diasReales, costo_proveedor_dia: costoDia,
            total_costo: totalCosto, notas: notas || null, usuario_id: req.user.id
        });

        if (art.stock_total - cantidad <= 0) {
            await sqDelete(T.ar, articulo_id);
        } else {
            await ajustarStock(articulo_id, { total: -cantidad, disponible: -cantidad });
        }
        await logMov(articulo_id, "devolucion_proveedor", cantidad, "Devolucion a proveedor", r.lastID, req.user.id);
        res.json({ id: r.lastID, diasReales, totalCosto });
    } catch (e) { res.status(500).send(e.message); }
});

app.get("/devoluciones_proveedor", authMiddleware, async (req, res) => {
    try {
        const rows = await sq(sb.from(T.dp)
            .select(`*, art:${T.ar}!articulo_id(nombre, referencia, empresa_externa), op:${T.u}!usuario_id(usuario)`)
            .order("id", { ascending: false }));
        res.json(rows.map(d => ({
            ...d,
            nombre: d.art?.nombre, referencia: d.art?.referencia,
            empresa_externa: d.art?.empresa_externa, operario: d.op?.usuario,
            art: undefined, op: undefined
        })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REPORTES (via RPC) ────────────────────────────────
app.get("/reportes/articulos-top", authMiddleware, async (req, res) => {
    try { res.json(await sqRpc("equioriente_top_articulos")); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/reportes/ingresos", authMiddleware, async (req, res) => {
    try {
        const data = await sqRpc("equioriente_reporte_ingresos", {
            p_desde: req.query.desde || null, p_hasta: req.query.hasta || null
        });
        res.json({ detalle: data?.detalle ?? [], totales: data?.totales ?? {} });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/reportes/clientes-top", authMiddleware, async (req, res) => {
    try { res.json(await sqRpc("equioriente_top_clientes")); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/reportes/costos-externos", authMiddleware, async (req, res) => {
    try { res.json(await sqRpc("equioriente_costos_externos")); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/reportes/morosos", authMiddleware, async (req, res) => {
    try { res.json(await sqRpc("equioriente_morosos")); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/reportes/estadisticas", authMiddleware, async (req, res) => {
    try { res.json(await sqRpc("equioriente_estadisticas")); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BACKUP ────────────────────────────────────────────
app.post("/backup", authMiddleware, adminOnly, (req, res) => {
    res.json({ msg: "Supabase gestiona backups automaticos en la nube. Ve a tu proyecto → Settings → Backups." });
});
app.get("/backup/list", authMiddleware, adminOnly, (req, res) => {
    res.json([]);
});

// ── EXPORTAR XLSX ─────────────────────────────────────
function xlsxStyleHeader(ws, row) {
    row.eachCell(cell => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1e3a5f" } };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.border = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };
    });
    row.height = 22;
}
function xlsxStyleRow(row, isAlt) {
    row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: isAlt ? "FFf0f9ff" : "FFFFFFFF" } };
        cell.alignment = { vertical: "middle" };
        cell.border = { top: { style: "hair" }, left: { style: "hair" }, bottom: { style: "hair" }, right: { style: "hair" } };
    });
    row.height = 18;
}
function xlsxFinish(ws) {
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}
function currencyCell(row, colIdx) {
    row.getCell(colIdx).numFmt = '"$"#,##0';
    row.getCell(colIdx).alignment = { horizontal: "right", vertical: "middle" };
}
function tipoLabel(es_externo, empresa) { return es_externo ? (empresa || "Externo") : "Propio"; }

app.get("/exportar/cliente/:id", authMiddleware, async (req, res) => {
    try {
        const cliente = await sqOne(sb.from(T.cl).select("*").eq("id", req.params.id));
        if (!cliente) return res.status(404).send("Cliente no encontrado");

        const alqs = await sq(sb.from(T.al)
            .select(`id, fecha_salida, fecha_devolucion_esperada, fecha_devolucion_real, estado, notas, op:${T.u}!usuario_id(usuario)`)
            .eq("cliente_id", req.params.id).order("id", { ascending: false }));

        const alqIds = alqs.map(a => a.id);
        const items = alqIds.length ? await sq(sb.from(T.it)
            .select(`alquiler_id, cantidad, cantidad_devuelta, precio_dia_aplicado, dias_acordados, dias_reales, total_calculado, art:${T.ar}!articulo_id(referencia, nombre, es_externo, empresa_externa)`)
            .in("alquiler_id", alqIds).order("alquiler_id", { ascending: false })) : [];

        const wb = new ExcelJS.Workbook();
        wb.creator = "Equioriente";

        const ws1 = wb.addWorksheet("Alquileres");
        ws1.columns = [
            { header: "#", width: 8 }, { header: "Fecha Salida", width: 20 },
            { header: "Dev. Esperada", width: 14 }, { header: "Dev. Real", width: 20 },
            { header: "Estado", width: 12 }, { header: "Operario", width: 14 }, { header: "Notas", width: 35 }
        ];
        xlsxStyleHeader(ws1, ws1.getRow(1));
        alqs.forEach((a, i) => {
            const row = ws1.addRow([a.id,
                (a.fecha_salida || "").substring(0, 16).replace("T", " "),
                a.fecha_devolucion_esperada || "",
                (a.fecha_devolucion_real || "").substring(0, 16).replace("T", " "),
                a.estado, a.op?.usuario || "", a.notas || ""]);
            xlsxStyleRow(row, i % 2 !== 0);
        });
        xlsxFinish(ws1);

        const ws2 = wb.addWorksheet("Items");
        ws2.columns = [
            { header: "Alquiler #", width: 10 }, { header: "Referencia", width: 14 },
            { header: "Tipo", width: 14 }, { header: "Articulo", width: 30 },
            { header: "Cantidad", width: 9 }, { header: "Devuelto", width: 9 },
            { header: "Precio/dia", width: 13 }, { header: "Dias", width: 6 }, { header: "Subtotal", width: 16 }
        ];
        xlsxStyleHeader(ws2, ws2.getRow(1));
        items.forEach((it, i) => {
            const subtotal = it.total_calculado || (it.precio_dia_aplicado * (it.dias_reales || it.dias_acordados) * it.cantidad);
            const row = ws2.addRow([it.alquiler_id, it.art?.referencia, tipoLabel(it.art?.es_externo, it.art?.empresa_externa),
                it.art?.nombre, it.cantidad, it.cantidad_devuelta, it.precio_dia_aplicado,
                it.dias_reales || it.dias_acordados, subtotal]);
            xlsxStyleRow(row, i % 2 !== 0);
            currencyCell(row, 7); currencyCell(row, 9);
        });
        xlsxFinish(ws2);

        const safeName = cliente.nombre.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 30);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="equioriente_cliente_${safeName}.xlsx"`);
        res.send(await wb.xlsx.writeBuffer());
    } catch (e) { res.status(500).send(e.message); }
});

app.get("/exportar/dia/:fecha", authMiddleware, async (req, res) => {
    try {
        const fecha = req.params.fecha;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).send("Fecha invalida");

        const alqs = await sq(sb.from(T.al)
            .select(`id, fecha_salida, fecha_devolucion_esperada, fecha_devolucion_real, estado, notas, cli:${T.cl}!cliente_id(nombre, telefono, identificacion), op:${T.u}!usuario_id(usuario)`)
            .gte("fecha_salida", `${fecha}T00:00:00`)
            .lte("fecha_salida", `${fecha}T23:59:59`)
            .order("id"));

        const alqIds = alqs.map(a => a.id);
        const items = alqIds.length ? await sq(sb.from(T.it)
            .select(`alquiler_id, cantidad, cantidad_devuelta, precio_dia_aplicado, dias_acordados, dias_reales, total_calculado, art:${T.ar}!articulo_id(referencia, nombre, es_externo, empresa_externa)`)
            .in("alquiler_id", alqIds).order("alquiler_id")) : [];

        const wb = new ExcelJS.Workbook();
        wb.creator = "Equioriente";

        const ws1 = wb.addWorksheet(`Alquileres ${fecha}`);
        ws1.columns = [
            { header: "#", width: 8 }, { header: "Cliente", width: 26 },
            { header: "Telefono", width: 14 }, { header: "ID/NIT", width: 14 },
            { header: "Fecha Salida", width: 20 }, { header: "Dev. Esperada", width: 14 },
            { header: "Dev. Real", width: 20 }, { header: "Estado", width: 12 },
            { header: "Operario", width: 14 }, { header: "Notas", width: 35 }
        ];
        xlsxStyleHeader(ws1, ws1.getRow(1));
        alqs.forEach((a, i) => {
            const row = ws1.addRow([a.id, a.cli?.nombre, a.cli?.telefono || "", a.cli?.identificacion || "",
                (a.fecha_salida || "").substring(0, 16).replace("T", " "),
                a.fecha_devolucion_esperada || "",
                (a.fecha_devolucion_real || "").substring(0, 16).replace("T", " "),
                a.estado, a.op?.usuario || "", a.notas || ""]);
            xlsxStyleRow(row, i % 2 !== 0);
        });
        xlsxFinish(ws1);

        const ws2 = wb.addWorksheet("Items");
        ws2.columns = [
            { header: "Alquiler #", width: 10 }, { header: "Referencia", width: 14 },
            { header: "Tipo", width: 14 }, { header: "Articulo", width: 30 },
            { header: "Cantidad", width: 9 }, { header: "Devuelto", width: 9 },
            { header: "Precio/dia", width: 13 }, { header: "Dias", width: 6 }, { header: "Subtotal", width: 16 }
        ];
        xlsxStyleHeader(ws2, ws2.getRow(1));
        items.forEach((it, i) => {
            const subtotal = it.total_calculado || (it.precio_dia_aplicado * (it.dias_reales || it.dias_acordados) * it.cantidad);
            const row = ws2.addRow([it.alquiler_id, it.art?.referencia, tipoLabel(it.art?.es_externo, it.art?.empresa_externa),
                it.art?.nombre, it.cantidad, it.cantidad_devuelta, it.precio_dia_aplicado,
                it.dias_reales || it.dias_acordados, subtotal]);
            xlsxStyleRow(row, i % 2 !== 0);
            currencyCell(row, 7); currencyCell(row, 9);
        });
        xlsxFinish(ws2);

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="equioriente_dia_${fecha}.xlsx"`);
        res.send(await wb.xlsx.writeBuffer());
    } catch (e) { res.status(500).send(e.message); }
});

// ── PDF RECIBO ────────────────────────────────────────
app.get("/alquileres/:id/pdf", authMiddleware, async (req, res) => {
    const alqId = req.params.id;
    try {
        const alq = await sqOne(sb.from(T.al)
            .select(`*, cli:${T.cl}!cliente_id(nombre, identificacion, telefono, direccion), op:${T.u}!usuario_id(usuario)`)
            .eq("id", alqId));
        if (!alq) return res.status(404).send("No encontrado");

        const itemRows = await sq(sb.from(T.it)
            .select(`*, art:${T.ar}!articulo_id(nombre, referencia, es_externo, empresa_externa)`)
            .eq("alquiler_id", alqId));

        // Flatten for use in PDF
        alq.cliente_nombre  = alq.cli?.nombre;
        alq.cliente_id_doc  = alq.cli?.identificacion;
        alq.cliente_tel     = alq.cli?.telefono;
        alq.cliente_dir     = alq.cli?.direccion;
        alq.operario        = alq.op?.usuario;
        const items = itemRows.map(i => ({
            ...i,
            nombre: i.art?.nombre, referencia: i.art?.referencia,
            es_externo: i.art?.es_externo, empresa_externa: i.art?.empresa_externa
        }));

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="recibo_${alqId}.pdf"`);

        const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true });
        doc.pipe(res);

        const L = 40, PW = 515;
        const fmtMoney = n => "$" + Number(n || 0).toLocaleString("es-CO", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        const hline = (y, color = "#e5e7eb", w = 0.5) =>
            doc.moveTo(L, y).lineTo(L + PW, y).strokeColor(color).lineWidth(w).stroke();

        doc.font("Helvetica-Bold").fontSize(22).fillColor("#1e3a5f")
           .text("RECIBO DE ALQUILER", L, 40, { align: "center", width: PW });
        doc.font("Helvetica").fontSize(10).fillColor("#6b7280")
           .text("Gestion de Equipos y Materiales", L, 68, { align: "center", width: PW });
        hline(84, "#1e3a5f", 2);

        const estado = alq.estado;
        const estadoColor = estado === "devuelto" ? "#059669" : estado === "parcial" ? "#d97706" : "#dc2626";
        const estadoText  = estado === "devuelto" ? "DEVUELTO" : estado === "parcial" ? "PARCIAL" : "EN CURSO";
        const fechaSal  = (alq.fecha_salida || "").substring(0, 16).replace("T", " ");
        const fechaEsp  = alq.fecha_devolucion_esperada || "No especificada";
        const fechaReal = (alq.fecha_devolucion_real || "").substring(0, 16).replace("T", " ") || "-";

        const infoRows = [
            ["N° Alquiler:", "#" + String(alq.id).padStart(4, "0"), "Estado:", estadoText],
            ["Cliente:", alq.cliente_nombre || "", "ID/NIT:", alq.cliente_id_doc || ""],
            ["Telefono:", alq.cliente_tel || "", "Direccion:", alq.cliente_dir || ""],
            ["Fecha salida:", fechaSal, "Dev. esperada:", fechaEsp],
            ["Operario:", alq.operario || "", "Dev. real:", fechaReal],
        ];

        const IH = 18;
        const COL = [80, PW / 2 - 80, 80, PW / 2 - 80];
        let iy = 94;
        infoRows.forEach((row, ri) => {
            doc.fillColor(ri % 2 === 0 ? "#ffffff" : "#f8fafc").rect(L, iy, PW, IH).fill();
            let cx = L;
            row.forEach((cell, ci) => {
                const isLbl = ci % 2 === 0;
                const isStatus = ri === 0 && ci === 3;
                doc.font(isLbl || isStatus ? "Helvetica-Bold" : "Helvetica")
                   .fontSize(9).fillColor(isStatus ? estadoColor : "#111827")
                   .text(String(cell), cx + 4, iy + 4, { width: COL[ci] - 8, lineBreak: false, ellipsis: true });
                cx += COL[ci];
            });
            iy += IH;
        });
        doc.rect(L, 94, PW, IH * infoRows.length).strokeColor("#e5e7eb").lineWidth(0.4).stroke();

        iy += 14;
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#1e3a5f").text("Detalle de Articulos", L, iy);
        iy += 18;

        const CW  = [50, 46, 118, 30, 34, 52, 28, 65];
        const HDR = ["Ref.", "Tipo", "Articulo", "Cant.", "Dev.", "Precio/dia", "Dias", "Subtotal"];
        const RH  = 20;

        const drawRow = (cells, y, isHeader, isAlt) => {
            const totalW = CW.reduce((a, b) => a + b, 0);
            if (isHeader) doc.fillColor("#1e3a5f").rect(L, y, totalW, RH).fill();
            else doc.fillColor(isAlt ? "#f0f9ff" : "#ffffff").rect(L, y, totalW, RH).fill();
            let cx = L;
            cells.forEach((cell, i) => {
                doc.font(isHeader ? "Helvetica-Bold" : "Helvetica").fontSize(8.5)
                   .fillColor(isHeader ? "white" : "#111827")
                   .text(String(cell ?? ""), cx + 3, y + (RH - 8.5) / 2,
                         { width: CW[i] - 6, lineBreak: false, ellipsis: true, align: i >= 3 ? "center" : "left" });
                cx += CW[i];
            });
            doc.rect(L, y, totalW, RH).strokeColor("#e5e7eb").lineWidth(0.3).stroke();
        };

        drawRow(HDR, iy, true, false);
        iy += RH;
        let grandTotal = 0;
        items.forEach((item, ri) => {
            const dias     = item.dias_reales || item.dias_acordados || 1;
            const subtotal = item.total_calculado || (item.precio_dia_aplicado * dias * item.cantidad);
            grandTotal += subtotal;
            const tipo = item.es_externo ? (item.empresa_externa || "Externo") : "Propio";
            drawRow([item.referencia || "", tipo, item.nombre || "", item.cantidad,
                item.cantidad_devuelta || 0, fmtMoney(item.precio_dia_aplicado), dias, fmtMoney(subtotal)],
                iy, false, ri % 2 !== 0);
            iy += RH;
            if (iy > 760) { doc.addPage(); iy = 40; drawRow(HDR, iy, true, false); iy += RH; }
        });

        iy += 6;
        const TW = 135;
        doc.fillColor("#1e3a5f").rect(L + PW - TW, iy, TW, 26).fill();
        doc.font("Helvetica-Bold").fontSize(12).fillColor("white")
           .text("TOTAL: " + fmtMoney(grandTotal), L + PW - TW + 4, iy + 7,
                 { width: TW - 8, align: "center", lineBreak: false });
        iy += 34;

        if (alq.notas) {
            doc.fillColor("#fef9c3").rect(L, iy, PW, 28).fill();
            doc.rect(L, iy, PW, 28).strokeColor("#d97706").lineWidth(0.5).stroke();
            doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151")
               .text("Notas: ", L + 6, iy + 9, { continued: true, lineBreak: false });
            doc.font("Helvetica").fillColor("#374151").text(alq.notas, { lineBreak: false });
            iy += 36;
        }

        iy += 14; hline(iy, "#e5e7eb", 0.5); iy += 8;
        const nowStr = new Date().toLocaleString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
        doc.font("Helvetica").fontSize(8).fillColor("#9ca3af")
           .text(`Documento generado el ${nowStr}  |  Firma cliente: _________________________`,
                 L, iy, { align: "center", width: PW });
        doc.end();
    } catch (e) {
        console.error("PDF Error:", e.message);
        if (!res.headersSent) res.status(500).send("Error generando PDF: " + e.message);
    }
});

app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
