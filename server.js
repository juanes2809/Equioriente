const express = require("express");
const path    = require("path");
const fs      = require("fs");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const bcrypt  = require("bcrypt");
const jwt     = require("jsonwebtoken");
if (typeof global.WebSocket === "undefined") {
    try { global.WebSocket = require("ws"); }
    catch { global.WebSocket = class { constructor() {} close() {} addEventListener() {} removeEventListener() {} send() {} }; }
}
const { createClient } = require("@supabase/supabase-js");
const { createLocalDb } = require("./lib/localDb");

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

// ── Config ────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const JWT_SECRET   = process.env.JWT_SECRET || "equioriente_secret_change_me";
const SALT_ROUNDS  = 10;
const PORT = parseInt(process.env.PORT) || 3000;
const BACKUP_DIR = path.join(__dirname, "backups");
const DATA_DIR = path.join(__dirname, "Equioriente_Data");
const STORE_PATH = path.join(__dirname, "data", "store.json");

const supabaseConfigured = !!(SUPABASE_URL && SUPABASE_KEY
    && !/tu-proyecto|tu_service/i.test(String(SUPABASE_URL) + String(SUPABASE_KEY)));

const sb = supabaseConfigured
    ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
    : createLocalDb(STORE_PATH);

if (!supabaseConfigured) {
    console.log("Supabase no configurado — usando datos locales:", STORE_PATH);
}

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
    re: "equioriente_remitos",
    ri: "equioriente_remito_items",
    pg: "equioriente_pagos",
    fl: "equioriente_flujo_caja",
    doc:"equioriente_documentos",
    co: "equioriente_cotizaciones",
    ci: "equioriente_cotizacion_items",
    ob: "equioriente_obras",
    cu: "equioriente_cuentas",
    pe: "equioriente_periodos_cuenta",
    om: "equioriente_movimientos",
    sp: "equioriente_saldos_periodo",
    cb: "equioriente_cobros",
    vj: "equioriente_viajes",
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

function hoyYmd() {
    return new Date().toISOString().slice(0, 10);
}

async function insertViaje(data) {
    const tipo = ["llevada", "recogida", "ida_vuelta"].includes(data.tipo) ? data.tipo : "llevada";
    const quien = ["equioriente", "cliente"].includes(data.quien) ? data.quien : "equioriente";
    const r = await sqInsert(T.vj, {
        alquiler_id: data.alquiler_id || null,
        periodo_id: data.periodo_id || null,
        remito_id: data.remito_id || null,
        tipo,
        quien,
        precio: Number(data.precio) || 0,
        placa: data.placa || null,
        direccion: data.direccion || null,
        fecha: data.fecha || hoyYmd(),
        notas: data.notas || null
    });
    if (data.alquiler_id && quien === "equioriente") {
        const alq = await sqOne(sb.from(T.al).select("transporte").eq("id", data.alquiler_id));
        const sum = (Number(alq?.transporte) || 0) + (Number(data.precio) || 0);
        await sqUpdate(T.al, { transporte: sum }, data.alquiler_id);
        if (data.periodo_id) {
            const per = await sqOne(sb.from(T.pe).select("transporte").eq("id", data.periodo_id));
            if (per) await sqUpdate(T.pe, { transporte: (Number(per.transporte) || 0) + (Number(data.precio) || 0) }, data.periodo_id);
        }
    }
    return r.lastID;
}

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
app.use(express.static(__dirname));

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
app.get("/clientes/:id", authMiddleware, async (req, res) => {
    try {
        const cli = await sqOne(sb.from(T.cl).select("*").eq("id", req.params.id));
        if (!cli) return res.status(404).json({ error: "Cliente no encontrado" });
        const cuentas = await sq(sb.from(T.cu).select("*").eq("cliente_id", req.params.id));
        const obras = await sq(sb.from(T.ob).select("*").eq("cliente_id", req.params.id));
        const ctaMap = byId(cuentas);
        const obraMap = byId(obras);
        const cuentaIds = cuentas.map(c => c.id);
        const periodos = cuentaIds.length
            ? await sq(sb.from(T.pe).select("*").in("cuenta_id", cuentaIds).order("anio_mes", { ascending: false }))
            : [];
        const alquileres = await sq(sb.from(T.al).select("*").eq("cliente_id", req.params.id).order("id", { ascending: false }));
        const pagos = await sq(sb.from(T.pg).select("*").eq("cliente_id", req.params.id).order("id", { ascending: false }));
        res.json({
            ...cli,
            periodos: periodos.map(p => {
                const cta = ctaMap.get(String(p.cuenta_id)) || {};
                const obra = obraMap.get(String(cta.obra_id)) || {};
                return {
                    ...p,
                    tipo_documento: p.tipo_documento || cta.tipo_documento || null,
                    obra: obra.direccion || obra.nombre || null
                };
            }),
            alquileres,
            pagos
        });
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
        const { cliente_id, usuario_id, fecha_devolucion_esperada, notas, items, tipo_fiscal, obra, viajes } = req.body;
        if (!items?.length) return res.status(400).send("Sin articulos");

        for (const item of items) {
            const art = await sqOne(sb.from(T.ar).select("stock_disponible, nombre").eq("id", item.articulo_id));
            if (!art || art.stock_disponible < item.cantidad)
                return res.status(400).send(`Stock insuficiente para ${art?.nombre ?? "articulo " + item.articulo_id}`);
        }

        const r = await sqInsert(T.al, {
            cliente_id, usuario_id: usuario_id || req.user.id,
            fecha_salida: new Date().toISOString(),
            fecha_devolucion_esperada: fecha_devolucion_esperada || null,
            notas: notas || null,
            tipo_fiscal: tipo_fiscal || "no_fiscal",
            obra: obra || null,
            transporte: 0
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
        if (Array.isArray(viajes)) {
            for (const v of viajes) {
                await insertViaje({
                    ...v,
                    alquiler_id: alqId,
                    direccion: v.direccion || obra || null,
                    fecha: v.fecha || hoyYmd()
                });
            }
        }
        res.json({ id: alqId });
    } catch (e) { res.status(500).send(e.message); }
});

app.get("/alquileres", authMiddleware, async (req, res) => {
    try {
        const { estado, buscar, tipo_fiscal, periodo } = req.query;
        let q = sb.from(T.al)
            .select(`*, cliente:${T.cl}!cliente_id(nombre, identificacion, telefono), operario:${T.u}!usuario_id(usuario)`)
            .order("id", { ascending: false });
        if (estado) q = q.eq("estado", estado);
        if (tipo_fiscal) q = q.eq("tipo_fiscal", tipo_fiscal);
        if (periodo) q = q.eq("periodo", periodo);
        if (buscar) q = q.or(`cliente.nombre.ilike.%${buscar}%,cliente.identificacion.ilike.%${buscar}%`);
        const rows = await sq(q);
        res.json(rows.map(a => ({
            ...a,
            cliente_nombre: a.cliente?.nombre, cliente_id_doc: a.cliente?.identificacion,
            cliente_tel: a.cliente?.telefono, operario: a.operario?.usuario,
            cliente: undefined
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
        const { items_devueltos, recogida } = req.body;
        const alq = await sqOne(sb.from(T.al).select("fecha_salida, estado, obra, periodo_id").eq("id", alqId));
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
        if (recogida && (recogida.activa || Number(recogida.precio) > 0 || recogida.quien === "equioriente")) {
            await insertViaje({
                alquiler_id: alqId,
                periodo_id: alq.periodo_id || null,
                tipo: "recogida",
                quien: recogida.quien || "equioriente",
                precio: recogida.precio,
                placa: recogida.placa,
                direccion: recogida.direccion || alq.obra || null,
                fecha: hoyYmd(),
                notas: "Recogida en devolución"
            });
        }
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

app.post("/viajes", authMiddleware, async (req, res) => {
    try {
        const { alquiler_id, periodo_id, remito_id, tipo, quien, precio, placa, direccion, fecha, notas } = req.body;
        if (!alquiler_id && !periodo_id) return res.status(400).send("Falta alquiler o periodo");
        const id = await insertViaje({ alquiler_id, periodo_id, remito_id, tipo, quien, precio, placa, direccion, fecha, notas });
        res.json({ id });
    } catch (e) { res.status(500).send(e.message); }
});

app.get("/reportes/transporte", authMiddleware, async (req, res) => {
    try {
        const desde = req.query.desde || "";
        const hasta = req.query.hasta || "";
        const viajes = await sq(sb.from(T.vj).select("*").order("id", { ascending: false }));
        const alqs = await sq(sb.from(T.al).select("id, cliente_id, obra, periodo, tipo_fiscal"));
        const clis = await sq(sb.from(T.cl).select("id, nombre"));
        const rems = await sq(sb.from(T.re).select("id, numero"));
        const alqMap = byId(alqs);
        const cliMap = byId(clis);
        const remMap = byId(rems);
        const fiscalRank = tf => (tf === "fiscal" ? 0 : tf === "no_fiscal" ? 1 : 2);
        const inRange = v => {
            const f = String(v.fecha || "");
            if (desde && f && f < desde) return false;
            if (hasta && f && f > hasta) return false;
            return true;
        };
        const rows = viajes.filter(inRange).map(v => {
            const alq = alqMap.get(String(v.alquiler_id)) || {};
            const cli = cliMap.get(String(alq.cliente_id)) || {};
            const rem = remMap.get(String(v.remito_id)) || {};
            return {
                ...v,
                cliente_nombre: cli.nombre || "",
                obra: v.direccion || alq.obra || "",
                periodo: alq.periodo || (v.fecha || "").slice(0, 7),
                tipo_fiscal: alq.tipo_fiscal || "",
                remito_numero: rem.numero || null
            };
        });
        // Un remito = un viaje de camión. Seguimiento y factura no se cuentan dos veces.
        const best = new Map();
        for (const v of rows) {
            const key = v.remito_numero
                ? "R:" + v.remito_numero
                : "X:" + [v.cliente_nombre, v.fecha, v.tipo, v.precio].join("|");
            const prev = best.get(key);
            if (!prev || fiscalRank(v.tipo_fiscal) < fiscalRank(prev.tipo_fiscal)) best.set(key, v);
        }
        const unicos = [...best.values()];
        const camion = unicos.filter(v => v.quien === "equioriente");
        const ingreso = camion.reduce((s, v) => s + (Number(v.precio) || 0), 0);
        const porTipo = (t) => camion.filter(v => v.tipo === t);
        const porMes = {};
        for (const v of camion) {
            const m = (v.fecha || "").slice(0, 7) || v.periodo || "";
            if (!porMes[m]) porMes[m] = { mes: m, viajes: 0, ingreso: 0, llevadas: 0, recogidas: 0 };
            porMes[m].viajes += 1;
            porMes[m].ingreso += Number(v.precio) || 0;
            if (v.tipo === "llevada") porMes[m].llevadas += 1;
            if (v.tipo === "recogida" || v.tipo === "ida_vuelta") porMes[m].recogidas += 1;
        }
        res.json({
            totales: {
                ingreso_camion: ingreso,
                viajes_camion: camion.length,
                llevadas: porTipo("llevada").length,
                recogidas: porTipo("recogida").length + porTipo("ida_vuelta").length,
                cliente_sin_camion: unicos.filter(v => v.quien === "cliente").length,
                documentos_sin_dedup: rows.length
            },
            por_mes: Object.keys(porMes).sort().map(k => porMes[k]),
            detalle: unicos
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DATOS INTEGRADOS (Equioriente_Data) ───────────────
app.get("/datos/meta", authMiddleware, async (req, res) => {
    try {
        const meta = typeof sb._meta === "function" ? sb._meta() : {};
        res.json({
            origen: supabaseConfigured ? "supabase" : "local",
            ...meta,
            conteos: {
                articulos: (await sq(sb.from(T.ar).select("id"))).length,
                clientes: (await sq(sb.from(T.cl).select("id"))).length,
                alquileres: (await sq(sb.from(T.al).select("id"))).length,
                periodos: (await sq(sb.from(T.pe).select("id"))).length,
                remitos: (await sq(sb.from(T.re).select("id"))).length,
                cobros: (await sq(sb.from(T.cb).select("id"))).length,
                pagos: (await sq(sb.from(T.pg).select("id"))).length,
                flujo: (await sq(sb.from(T.fl).select("id"))).length,
                documentos: (await sq(sb.from(T.doc).select("id"))).length
            }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

function byId(rows) {
    const m = new Map();
    for (const r of rows) m.set(String(r.id), r);
    return m;
}

app.get("/periodos", authMiddleware, async (req, res) => {
    try {
        const { anio_mes, tipo_documento, buscar, estado } = req.query;
        let q = sb.from(T.pe).select("*").order("id", { ascending: false });
        if (anio_mes) q = q.eq("anio_mes", anio_mes);
        if (estado) q = q.eq("estado", estado);
        let periodos = await sq(q);
        const [cuentas, clientes, obras] = await Promise.all([
            sq(sb.from(T.cu).select("*")),
            sq(sb.from(T.cl).select("*")),
            sq(sb.from(T.ob).select("*"))
        ]);
        const ctaMap = byId(cuentas);
        const cliMap = byId(clientes);
        const obraMap = byId(obras);
        let rows = periodos.map(p => {
            const cta = ctaMap.get(String(p.cuenta_id)) || {};
            const cli = cliMap.get(String(cta.cliente_id)) || {};
            const obra = obraMap.get(String(cta.obra_id)) || {};
            return {
                ...p,
                tipo_documento: p.tipo_documento || cta.tipo_documento || null,
                cliente_id: cta.cliente_id || null,
                cliente_nombre: cli.nombre || "",
                cliente_tel: cli.telefono || cta.telefono || null,
                obra: obra.direccion || obra.nombre || null
            };
        });
        if (tipo_documento) rows = rows.filter(r => r.tipo_documento === tipo_documento);
        if (buscar) {
            const b = String(buscar).toLowerCase();
            rows = rows.filter(r =>
                (r.cliente_nombre || "").toLowerCase().includes(b) ||
                (r.obra || "").toLowerCase().includes(b) ||
                String(r.id).includes(b));
        }
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/periodos/:id", authMiddleware, async (req, res) => {
    try {
        const p = await sqOne(sb.from(T.pe).select("*").eq("id", req.params.id));
        if (!p) return res.status(404).json({ error: "Periodo no encontrado" });
        const cta = await sqOne(sb.from(T.cu).select("*").eq("id", p.cuenta_id));
        const cli = cta ? await sqOne(sb.from(T.cl).select("*").eq("id", cta.cliente_id)) : null;
        const obra = cta?.obra_id ? await sqOne(sb.from(T.ob).select("*").eq("id", cta.obra_id)) : null;
        const remitos = await sq(sb.from(T.re).select("*").eq("periodo_id", p.id).order("id"));
        const remIds = remitos.map(r => r.id);
        const movs = remIds.length
            ? await sq(sb.from(T.om).select("*").in("remito_id", remIds))
            : [];
        const byRem = {};
        for (const m of movs) (byRem[m.remito_id] = byRem[m.remito_id] || []).push(m);
        const saldos = await sq(sb.from(T.sp).select("*").eq("periodo_id", p.id));
        const cobros = await sq(sb.from(T.cb).select("*").eq("periodo_id", p.id));
        const pagos = await sq(sb.from(T.pg).select("*").eq("periodo_id", p.id));
        let viajes = await sq(sb.from(T.vj).select("*").eq("periodo_id", p.id));
        if (!viajes.length && p.alquiler_id) {
            viajes = await sq(sb.from(T.vj).select("*").eq("alquiler_id", p.alquiler_id));
        }
        res.json({
            ...p,
            tipo_documento: p.tipo_documento || cta?.tipo_documento || null,
            cliente_id: cta?.cliente_id || null,
            cliente_nombre: cli?.nombre || "",
            cliente_tel: cli?.telefono || cta?.telefono || null,
            cliente_direccion: cli?.direccion || null,
            obra: obra?.direccion || obra?.nombre || null,
            remitos: remitos.map(r => ({ ...r, items: byRem[r.id] || [] })),
            saldos,
            cobros,
            pagos,
            viajes
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/remitos", authMiddleware, async (req, res) => {
    try {
        const { alquiler_id } = req.query;
        let q = sb.from(T.re).select("*").order("id", { ascending: false });
        if (alquiler_id) q = q.eq("alquiler_id", alquiler_id);
        const remitos = await sq(q);
        const items = remitos.length
            ? await sq(sb.from(T.ri).select(`*, art:${T.ar}!articulo_id(nombre, referencia)`).in("remito_id", remitos.map(r => r.id)))
            : [];
        const byRem = {};
        for (const it of items) {
            (byRem[it.remito_id] = byRem[it.remito_id] || []).push({
                ...it,
                nombre: it.art?.nombre, referencia: it.art?.referencia, art: undefined
            });
        }
        res.json(remitos.map(r => ({ ...r, items: byRem[r.id] || [] })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/pagos", authMiddleware, async (req, res) => {
    try {
        const { cliente_id, alquiler_id } = req.query;
        let q = sb.from(T.pg)
            .select(`*, cli:${T.cl}!cliente_id(nombre)`)
            .order("id", { ascending: false });
        if (cliente_id) q = q.eq("cliente_id", cliente_id);
        if (alquiler_id) q = q.eq("alquiler_id", alquiler_id);
        const rows = await sq(q);
        res.json(rows.map(p => ({ ...p, cliente_nombre: p.cli?.nombre, cli: undefined })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/pagos", authMiddleware, async (req, res) => {
    try {
        const { cliente_id, alquiler_id, fecha, monto, medio, detalle, tipo } = req.body;
        if (!monto) return res.status(400).send("Monto requerido");
        const r = await sqInsert(T.pg, {
            cliente_id: cliente_id || null, alquiler_id: alquiler_id || null,
            fecha: fecha || new Date().toISOString().slice(0, 10),
            monto: parseFloat(monto) || 0, medio: medio || null,
            detalle: detalle || null, tipo: tipo || "pago"
        });
        res.json({ id: r.lastID });
    } catch (e) { res.status(500).send(e.message); }
});

app.post("/flujo", authMiddleware, async (req, res) => {
    try {
        const { fecha, detalle, valor, tipo, medio } = req.body || {};
        const det = String(detalle || "").trim();
        if (!det) return res.status(400).send("Detalle requerido");
        const v = parseFloat(valor);
        if (!Number.isFinite(v) || v === 0) return res.status(400).send("Valor requerido");
        const tipoOk = ["ingreso", "egreso", "traslado"].includes(tipo) ? tipo : "ingreso";
        const f = fecha || hoyYmd();
        const anio = parseInt(String(f).slice(0, 4), 10) || new Date().getFullYear();
        const mes = parseInt(String(f).slice(5, 7), 10) || (new Date().getMonth() + 1);
        const r = await sqInsert(T.fl, {
            fecha: f,
            detalle: det,
            valor: Math.abs(v),
            tipo: tipoOk,
            medio: medio || null,
            mes,
            anio,
            fuente: "manual"
        });
        res.json({ id: r.lastID });
    } catch (e) { res.status(500).send(e.message); }
});

app.delete("/flujo/:id", authMiddleware, async (req, res) => {
    try {
        const row = await sqOne(sb.from(T.fl).select("id, fuente").eq("id", req.params.id));
        if (!row) return res.status(404).send("Movimiento no encontrado");
        if (row.fuente && row.fuente !== "manual") {
            return res.status(400).send("Solo se pueden borrar movimientos añadidos a mano");
        }
        await sqDelete(T.fl, req.params.id);
        res.json({ msg: "Eliminado" });
    } catch (e) { res.status(500).send(e.message); }
});

app.get("/flujo", authMiddleware, async (req, res) => {
    try {
        const { anio, mes, tipo, buscar } = req.query;
        let q = sb.from(T.fl).select("*").order("id", { ascending: false });
        if (anio) q = q.eq("anio", parseInt(anio));
        if (mes) q = q.eq("mes", parseInt(mes));
        if (tipo) q = q.eq("tipo", tipo);
        let rows = await sq(q);
        if (buscar) {
            const b = buscar.toLowerCase();
            rows = rows.filter(r => (r.detalle || "").toLowerCase().includes(b));
        }
        const tot = { ingreso: 0, egreso: 0, traslado: 0 };
        for (const r of rows) tot[r.tipo] = (tot[r.tipo] || 0) + (r.valor || 0);
        res.json({ detalle: rows, totales: tot });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/documentos", authMiddleware, async (req, res) => {
    try {
        const { tipo, dominio, q: buscar } = req.query;
        let q = sb.from(T.doc).select("*").order("id", { ascending: false });
        if (tipo) q = q.eq("tipo", tipo);
        if (dominio) q = q.eq("dominio", dominio);
        let rows = await sq(q);
        if (buscar) {
            const b = buscar.toLowerCase();
            rows = rows.filter(r => (r.titulo || "").toLowerCase().includes(b) || (r.archivo || "").toLowerCase().includes(b));
        }
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/cotizaciones", authMiddleware, async (req, res) => {
    try {
        const rows = await sq(sb.from(T.co)
            .select(`*, cli:${T.cl}!cliente_id(nombre, telefono)`)
            .order("id", { ascending: false }));
        res.json(rows.map(c => ({
            ...c, cliente_nombre: c.cli?.nombre, cliente_tel: c.cli?.telefono, cli: undefined
        })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/cotizaciones/:id/items", authMiddleware, async (req, res) => {
    try {
        const rows = await sq(sb.from(T.ci)
            .select(`*, art:${T.ar}!articulo_id(nombre, referencia)`)
            .eq("cotizacion_id", req.params.id));
        res.json(rows.map(i => ({
            ...i, nombre: i.art?.nombre, referencia: i.art?.referencia, art: undefined
        })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/archivos/*rel", authMiddleware, (req, res) => {
    const rel = decodeURIComponent(String(req.params.rel || "").replace(/^\/+/, ""));
    const root = path.resolve(DATA_DIR);
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root)) return res.status(400).send("Ruta invalida");
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).send("No encontrado");
    res.download(abs);
});

// ── BACKUP ────────────────────────────────────────────
app.post("/backup", authMiddleware, adminOnly, (req, res) => {
    res.json({ msg: supabaseConfigured
        ? "Supabase gestiona backups automaticos en la nube. Ve a tu proyecto → Settings → Backups."
        : "Datos locales en data/store.json. Regenerar: node build_canon_2026.js && node import_canon.js" });
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

async function initUsuarios() {
    const admin = await sqOne(sb.from(T.u).select("id").eq("usuario", "admin"));
    if (!admin) {
        const hash = await bcrypt.hash("1234", SALT_ROUNDS);
        await sqInsert(T.u, { usuario: "admin",    password: hash, rol: "admin" });
        await sqInsert(T.u, { usuario: "operario", password: hash, rol: "operario" });
        console.log("Usuarios por defecto creados: admin/1234, operario/1234");
    }
}

initUsuarios().catch(e => console.error("Error creando usuarios:", e.message));
app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
