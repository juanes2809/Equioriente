/**
 * Almacén JSON local con la misma interfaz mínima que usa server.js
 * contra Supabase (from/select/eq/insert/update/delete/rpc).
 */
const fs = require("fs");
const path = require("path");

const REL = {
    cliente:  { table: "equioriente_clientes",  fk: "cliente_id" },
    articulo: { table: "equioriente_articulos", fk: "articulo_id" },
    art:      { table: "equioriente_articulos", fk: "articulo_id" },
    cli:      { table: "equioriente_clientes",  fk: "cliente_id" },
    op:       { table: "equioriente_usuarios",  fk: "usuario_id" },
    operario: { table: "equioriente_usuarios",  fk: "usuario_id" },
    categoria:{ table: "equioriente_categorias",fk: "categoria_id" },
    cuenta:   { table: "equioriente_cuentas",   fk: "cuenta_id" },
    obra:     { table: "equioriente_obras",     fk: "obra_id" },
    periodo:  { table: "equioriente_periodos_cuenta", fk: "periodo_id" },
};

function loadFile(filePath) {
    if (!fs.existsSync(filePath)) return { tables: {}, seq: {}, meta: {} };
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return { tables: {}, seq: {}, meta: {} };
    }
}

function parseJoinSelect(spec) {
    if (!spec || spec === "*") return { joins: [] };
    const joins = [];
    const re = /(\w+)\s*:\s*(\w+)\s*!\s*(\w+)\s*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(spec))) {
        joins.push({
            as: m[1],
            table: m[2],
            fk: m[3],
            fields: m[4].split(",").map(s => s.trim()).filter(Boolean)
        });
    }
    return { joins };
}

function matchIlike(value, pattern) {
    const raw = String(pattern || "").replace(/^%/, "").replace(/%$/, "");
    return String(value ?? "").toLowerCase().includes(raw.toLowerCase());
}

function cmp(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b), "es", { numeric: true });
}

function createLocalDb(filePath) {
    let db = loadFile(filePath);
    if (!db.tables) db.tables = {};
    if (!db.seq) db.seq = {};
    let persistTimer = null;
    let paused = false;

    function persist() {
        if (paused) return;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(db));
    }
    function schedulePersist() {
        if (paused) return;
        clearTimeout(persistTimer);
        persistTimer = setTimeout(persist, 80);
    }
    function ensure(table) {
        if (!db.tables[table]) db.tables[table] = [];
        if (db.seq[table] == null) {
            db.seq[table] = db.tables[table].reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
        }
    }
    function rowsOf(table) {
        ensure(table);
        return db.tables[table];
    }
    function lookup(table, id) {
        if (id == null) return null;
        return rowsOf(table).find(r => String(r.id) === String(id)) || null;
    }
    function resolveField(row, key) {
        if (!key.includes(".")) return row[key];
        const [rel, field] = key.split(".");
        const info = REL[rel];
        if (!info) return undefined;
        const parent = lookup(info.table, row[info.fk]);
        return parent ? parent[field] : undefined;
    }
    function applyFilters(table, filters, orExpr) {
        let rows = rowsOf(table).slice();
        for (const f of filters) {
            rows = rows.filter(r => {
                const val = resolveField(r, f.k);
                if (f.op === "eq") return String(val) === String(f.v);
                if (f.op === "in") return (f.v || []).some(x => String(x) === String(val));
                if (f.op === "gte") return val >= f.v;
                if (f.op === "lte") return val <= f.v;
                return true;
            });
        }
        if (orExpr) {
            const parts = String(orExpr).split(",").map(s => s.trim()).filter(Boolean);
            rows = rows.filter(r => parts.some(p => {
                const [left, op, ...rest] = p.split(".");
                // nombre.ilike.%x%  OR cliente.nombre.ilike.%x%
                if (rest.length >= 1 && (op === "ilike" || rest[0] === "ilike" || rest.includes("ilike"))) {
                    if (REL[left]) {
                        const field = op;
                        const pattern = rest.slice(rest[0] === "ilike" ? 1 : 1).join(".");
                        // cliente.nombre.ilike.%x%
                        const info = REL[left];
                        const parent = lookup(info.table, r[info.fk]);
                        const pat = p.split("ilike.")[1] || "";
                        return parent && matchIlike(parent[field], pat);
                    }
                    const pat = p.split("ilike.")[1] || "";
                    return matchIlike(r[left], pat);
                }
                const ilikeIdx = p.indexOf(".ilike.");
                if (ilikeIdx > 0) {
                    const field = p.slice(0, ilikeIdx);
                    const pat = p.slice(ilikeIdx + 7);
                    return matchIlike(resolveField(r, field), pat);
                }
                return false;
            }));
        }
        return rows;
    }
    function applyJoins(rows, spec) {
        const { joins } = parseJoinSelect(spec);
        if (!joins.length) return rows.map(r => ({ ...r }));
        return rows.map(r => {
            const out = { ...r };
            for (const j of joins) {
                const parent = lookup(j.table, r[j.fk]);
                const obj = {};
                if (parent) {
                    for (const f of j.fields) obj[f] = parent[f];
                } else {
                    for (const f of j.fields) obj[f] = null;
                }
                out[j.as] = obj;
            }
            return out;
        });
    }

    function runRpc(fn, params = {}) {
        const arts = () => rowsOf("equioriente_articulos");
        const cats = () => rowsOf("equioriente_categorias");
        const clis = () => rowsOf("equioriente_clientes");
        const alqs = () => rowsOf("equioriente_alquileres");
        const items = () => rowsOf("equioriente_alquiler_items");
        const dps = () => rowsOf("equioriente_devoluciones_proveedor");

        if (fn === "equioriente_ajustar_stock") {
            const a = lookup("equioriente_articulos", params.p_id);
            if (a) {
                a.stock_total = (a.stock_total || 0) + (params.p_total || 0);
                a.stock_disponible = (a.stock_disponible || 0) + (params.p_disp || 0);
                a.stock_danado = (a.stock_danado || 0) + (params.p_dano || 0);
                schedulePersist();
            }
            return null;
        }
        if (fn === "equioriente_articulos_alertas") {
            return arts()
                .filter(a => (a.stock_minimo || 0) > 0 && (a.stock_disponible || 0) <= a.stock_minimo)
                .sort((a, b) => (a.stock_disponible || 0) - (b.stock_disponible || 0))
                .map(a => {
                    const c = lookup("equioriente_categorias", a.categoria_id);
                    return { ...a, categoria_nombre: c ? c.nombre : null };
                });
        }
        if (fn === "equioriente_top_articulos") {
            return arts().map(a => {
                const its = items().filter(i => String(i.articulo_id) === String(a.id));
                const alqIds = new Set(its.map(i => i.alquiler_id));
                return {
                    referencia: a.referencia, nombre: a.nombre, empresa_externa: a.empresa_externa,
                    veces_alquilado: alqIds.size,
                    total_unidades: its.reduce((s, i) => s + (i.cantidad || 0), 0),
                    total_alquilado: its.reduce((s, i) => s + (i.cantidad || 0), 0)
                };
            }).sort((a, b) => b.veces_alquilado - a.veces_alquilado).slice(0, 20);
        }
        if (fn === "equioriente_top_clientes") {
            return clis().map(c => {
                const als = alqs().filter(a => String(a.cliente_id) === String(c.id));
                const its = items().filter(i => als.some(a => String(a.id) === String(i.alquiler_id)));
                return {
                    id: c.id, nombre: c.nombre, telefono: c.telefono, identificacion: c.identificacion,
                    total_alquileres: als.length,
                    total_items: its.reduce((s, i) => s + (i.cantidad || 0), 0),
                    total_gastado: its.reduce((s, i) => s + (i.total_calculado || 0), 0)
                };
            }).sort((a, b) => b.total_alquileres - a.total_alquileres).slice(0, 20);
        }
        if (fn === "equioriente_costos_externos") {
            return arts().filter(a => a.es_externo == 1).map(a => {
                const rows = dps().filter(d => String(d.articulo_id) === String(a.id));
                const ingreso = items().filter(i => String(i.articulo_id) === String(a.id))
                    .reduce((s, i) => s + (i.total_calculado || 0), 0);
                const costo = rows.reduce((s, d) => s + (d.total_costo || 0), 0);
                return {
                    nombre: a.nombre, empresa_externa: a.empresa_externa, referencia: a.referencia,
                    total_devoluciones: rows.length,
                    total_dias: rows.reduce((s, d) => s + (d.dias_reales || 0), 0),
                    total_costo: costo,
                    costo_total_proveedor: costo,
                    ingreso_generado: ingreso
                };
            }).sort((a, b) => (b.total_costo || 0) - (a.total_costo || 0));
        }
        if (fn === "equioriente_morosos") {
            const today = new Date().toISOString().slice(0, 10);
            return alqs()
                .filter(a => ["activo", "parcial"].includes(a.estado) && a.fecha_devolucion_esperada)
                .map(a => {
                    const c = lookup("equioriente_clientes", a.cliente_id);
                    const esp = String(a.fecha_devolucion_esperada).slice(0, 10);
                    const dias = Math.floor((new Date(today) - new Date(esp)) / 86400000);
                    return {
                        id: a.id, alquiler_id: a.id,
                        cliente_nombre: c ? c.nombre : "",
                        nombre: c ? c.nombre : "",
                        cliente_tel: c ? c.telefono : "",
                        telefono: c ? c.telefono : "",
                        identificacion: c ? c.identificacion : "",
                        fecha_salida: a.fecha_salida,
                        fecha_devolucion_esperada: a.fecha_devolucion_esperada,
                        dias_mora: dias, dias_retraso: dias, estado: a.estado
                    };
                })
                .filter(r => r.dias_mora > 0)
                .sort((a, b) => b.dias_mora - a.dias_mora);
        }
        if (fn === "equioriente_reporte_ingresos") {
            const desde = params.p_desde ? new Date(params.p_desde) : new Date("1970-01-01");
            const hasta = params.p_hasta ? new Date(params.p_hasta + "T23:59:59") : new Date("2999-12-31");
            const detalle = alqs()
                .filter(a => {
                    const f = new Date(a.fecha_salida || 0);
                    return f >= desde && f <= hasta;
                })
                .map(a => {
                    const c = lookup("equioriente_clientes", a.cliente_id);
                    const itemTotal = items().filter(i => String(i.alquiler_id) === String(a.id))
                        .reduce((s, i) => s + (i.total_calculado || (i.precio_dia_aplicado || 0) * (i.dias_reales || i.dias_acordados || 1) * (i.cantidad || 0)), 0);
                    const total = Number(a.total_cobrado) || itemTotal;
                    return {
                        alquiler_id: a.id,
                        cliente_nombre: c ? c.nombre : "",
                        fecha_salida: a.fecha_salida,
                        fecha_devolucion_real: a.fecha_devolucion_real,
                        fecha: (a.fecha_salida || "").slice(0, 10),
                        estado: a.estado,
                        total,
                        total_alquileres: 1,
                        ingreso_total: total
                    };
                })
                .sort((a, b) => (b.alquiler_id || 0) - (a.alquiler_id || 0));
            const totalIngresos = detalle.reduce((s, d) => s + (d.total || 0), 0);
            return {
                detalle,
                totales: {
                    total_alquileres: detalle.length,
                    total_ingresos: totalIngresos,
                    ingreso_total: totalIngresos
                }
            };
        }
        if (fn === "equioriente_estadisticas") {
            const now = new Date();
            const ym = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            const thisMonth = ym(now);
            const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const prevMonth = ym(prev);
            const inMonth = (a, m) => (a.periodo || (a.fecha_salida || "").slice(0, 7)) === m;
            const ingresoMes = m => alqs().filter(a => inMonth(a, m))
                .reduce((s, a) => s + (Number(a.total_cobrado) || 0), 0);
            const meses = [];
            for (let i = 5; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const m = ym(d);
                const als = alqs().filter(a => inMonth(a, m));
                meses.push({
                    mes: m,
                    alquileres: als.length,
                    ingresos: ingresoMes(m),
                    ingreso: ingresoMes(m)
                });
            }
            const alsMes = alqs().filter(a => inMonth(a, thisMonth));
            let topCliente = null;
            const byCli = {};
            for (const a of alsMes) byCli[a.cliente_id] = (byCli[a.cliente_id] || 0) + 1;
            const topCid = Object.keys(byCli).sort((a, b) => byCli[b] - byCli[a])[0];
            if (topCid) {
                const c = lookup("equioriente_clientes", topCid);
                topCliente = { nombre: c ? c.nombre : "", total: byCli[topCid] };
            }
            const byArt = {};
            for (const it of items()) {
                const a = lookup("equioriente_alquileres", it.alquiler_id);
                if (a && inMonth(a, thisMonth)) byArt[it.articulo_id] = (byArt[it.articulo_id] || 0) + (it.cantidad || 1);
            }
            const topAid = Object.keys(byArt).sort((a, b) => byArt[b] - byArt[a])[0];
            let topArticulo = null;
            if (topAid) {
                const ar = lookup("equioriente_articulos", topAid);
                topArticulo = { nombre: ar ? ar.nombre : "", total: byArt[topAid], total_cant: byArt[topAid] };
            }
            return {
                totalArticulos: arts().length,
                totalClientes: clis().length,
                alquileresActivos: alqs().filter(a => a.estado === "activo" || a.estado === "parcial").length,
                mesActual: { alquileres: alsMes.length, ingresos: ingresoMes(thisMonth), ingreso: ingresoMes(thisMonth) },
                mesPasado: {
                    alquileres: alqs().filter(a => inMonth(a, prevMonth)).length,
                    ingresos: ingresoMes(prevMonth),
                    ingreso: ingresoMes(prevMonth)
                },
                meses,
                topCliente,
                topArticulo
            };
        }
        throw new Error("RPC no implementado: " + fn);
    }

    class Query {
        constructor(table) {
            this.table = table;
            this._filters = [];
            this._or = null;
            this._order = null;
            this._limit = null;
            this._selectSpec = "*";
            this._mode = "select";
            this._payload = null;
            this._single = false;
            this._maybe = false;
        }
        select(spec) { this._selectSpec = spec || "*"; return this; }
        eq(k, v) { this._filters.push({ k, op: "eq", v }); return this; }
        in(k, arr) { this._filters.push({ k, op: "in", v: arr }); return this; }
        gte(k, v) { this._filters.push({ k, op: "gte", v }); return this; }
        lte(k, v) { this._filters.push({ k, op: "lte", v }); return this; }
        or(expr) { this._or = expr; return this; }
        order(k, opts = {}) { this._order = { k, asc: opts.ascending !== false }; return this; }
        limit(n) { this._limit = n; return this; }
        insert(data) { this._mode = "insert"; this._payload = data; return this; }
        update(data) { this._mode = "update"; this._payload = data; return this; }
        delete() { this._mode = "delete"; return this; }
        single() { this._single = true; return this; }
        maybeSingle() { this._maybe = true; return this; }
        then(resolve, reject) { return this._run().then(resolve, reject); }
        async _run() {
            try { return { data: this._execute(), error: null }; }
            catch (e) { return { data: null, error: { message: e.message } }; }
        }
        _execute() {
            ensure(this.table);
            if (this._mode === "insert") {
                const payload = this._payload;
                const list = Array.isArray(payload) ? payload : [payload];
                const inserted = list.map(p => {
                    const row = { ...p };
                    if (row.id == null) row.id = ++db.seq[this.table];
                    else db.seq[this.table] = Math.max(db.seq[this.table] || 0, Number(row.id) || 0);
                    db.tables[this.table].push(row);
                    return row;
                });
                schedulePersist();
                if (this._single || this._maybe) return { id: inserted[0].id, ...inserted[0] };
                return inserted;
            }
            if (this._mode === "update") {
                const rows = applyFilters(this.table, this._filters, this._or);
                for (const r of rows) Object.assign(r, this._payload);
                schedulePersist();
                return rows.map(r => ({ ...r }));
            }
            if (this._mode === "delete") {
                const del = applyFilters(this.table, this._filters, this._or);
                const ids = new Set(del.map(r => r.id));
                db.tables[this.table] = db.tables[this.table].filter(r => !ids.has(r.id));
                schedulePersist();
                return del;
            }
            let rows = applyFilters(this.table, this._filters, this._or);
            if (this._order) {
                const { k, asc } = this._order;
                rows.sort((a, b) => {
                    const d = cmp(resolveField(a, k), resolveField(b, k));
                    return asc ? d : -d;
                });
            }
            if (this._limit) rows = rows.slice(0, this._limit);
            rows = applyJoins(rows, this._selectSpec);
            if (this._single) {
                if (!rows.length) throw new Error("No rows");
                return rows[0];
            }
            if (this._maybe) return rows[0] || null;
            return rows;
        }
    }

    return {
        from(table) { return new Query(table); },
        rpc(fn, params) {
            return {
                then(resolve, reject) {
                    try { resolve({ data: runRpc(fn, params), error: null }); }
                    catch (e) { resolve({ data: null, error: { message: e.message } }); }
                }
            };
        },
        _pause() { paused = true; },
        _resume() { paused = false; persist(); },
        _reload() { db = loadFile(filePath); if (!db.tables) db.tables = {}; if (!db.seq) db.seq = {}; },
        _meta() { return db.meta || {}; },
        _path: filePath
    };
}

module.exports = { createLocalDb };
