/**
 * Importa solo data/canon/ → data/store.json
 *
 *   node import_canon.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const { readCsvFile } = require("./lib/csvUtil");

const CANON = path.join(__dirname, "data", "canon");
const STORE = path.join(__dirname, "data", "store.json");

function stripAccents(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function upper(s) { return stripAccents(s).toUpperCase().replace(/\s+/g, " ").trim(); }

function normMaterial(s) {
    let t = upper(s);
    t = t.replace(/FORAMLETA/g, "FORMALETA");
    t = t.replace(/FORMALETAS?/g, "TABLERO METALICO");
    t = t.replace(/TABLEROS? METALICOS?/g, "TABLERO METALICO");
    t = t.replace(/MTROS|METROS|MTRS|MTS\b/g, "M");
    t = t.replace(/CENTIMETROS|CMS\b/g, "CM");
    t = t.replace(/CHAPETAS?( CUADRADAS?)?/g, "CHAPETAS");
    t = t.replace(/CRUCETAS?( DE ANDAMIOS?)?/g, "CRUCETAS");
    t = t.replace(/MARCOS DE ANDAMIOS?/g, "MARCOS ANDAMIO");
    t = t.replace(/MARCOS DE ANDAMIO/g, "MARCOS ANDAMIO");
    t = t.replace(/CERCHAS?/g, "CERCHA");
    t = t.replace(/PARALES/g, "PARAL");
    t = t.replace(/ALINEADORES/g, "ALINEADOR");
    t = t.replace(/ANGULOS/g, "ANGULO");
    t = t.replace(/RINCONERAS/g, "RINCONERA");
    t = t.replace(/TABLONES/g, "TABLON");
    t = t.replace(/BANDAS/g, "BANDA");
    t = t.replace(/TABLEROS DE MADERA|TABLERO DE MADERA|TABREROS DE MADERA/g, "TABLERO MADERA");
    t = t.replace(/RUEDAS( NIVELADORAS| PARA ANDAMIOS| DE ANDAMIO)?/g, "RUEDAS ANDAMIO");
    t = t.replace(/CAJAS METALICAS|CAJA METALICA/g, "CAJA METALICA");
    t = t.replace(/SECCIONES DE ANDAMIO|SECCION DE ANDAMIO/g, "MARCOS ANDAMIO");
    t = t.replace(/CORBATAS|CRORBATAS/g, "CORBATA");
    t = t.replace(/[,]/g, ".");
    t = t.replace(/[xX×]/g, "*");
    t = t.replace(/[^A-Z0-9*. ]/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    return t;
}
function dims(s) {
    const nums = String(s).match(/\d+(?:\.\d+)?/g) || [];
    return nums.map(n => {
        let x = Number(n);
        if (x > 0 && x <= 10) x = Math.round(x * 100);
        return Math.round(x);
    }).sort((a, b) => a - b);
}
function materialKey(s) {
    const n = normMaterial(s);
    const d = dims(n);
    const words = n.replace(/[0-9*.]/g, " ").split(" ").filter(w => w.length > 1);
    return words.slice(0, 4).join(" ") + (d.length ? " " + d.join("*") : "");
}

function categoriaDe(nombre) {
    const n = upper(nombre);
    if (/ANDAMIO|MARCOS|CRUCETA|TABLON|RUEDA|PASAMANOS/.test(n)) return "Andamios";
    if (/TABLERO METALICO|FORMALETA|RINCONERA|ANGULO|CHAPETA|TENSOR|ALINEADOR|CORBATA/.test(n)) return "Formaleta";
    if (/PARAL/.test(n)) return "Puntales";
    if (/CERCHA/.test(n)) return "Cerchas";
    if (/MADERA|BANDA|TABLERO MADERA/.test(n)) return "Madera";
    if (/ESCALERA|POLEA|MEZCLADORA|ARNES|SLINGA|BALDE/.test(n)) return "Equipos";
    if (/CAMION/.test(n)) return "Activos";
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

function nextId(seq, table) {
    seq[table] = (seq[table] || 0) + 1;
    return seq[table];
}

function num(v, d = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
}

function findArticulo(articulos, nombre) {
    const key = materialKey(nombre);
    let hit = articulos.find(a => a._key === key);
    if (hit) return hit;
    const n = normMaterial(nombre);
    hit = articulos.find(a => a._norm === n);
    if (hit) return hit;
    const d = dims(n).join("*");
    const head = n.split(" ").filter(w => !/^\d/.test(w)).slice(0, 2).join(" ");
    if (d && head) {
        hit = articulos.find(a => a._dims === d && a._norm.startsWith(head));
        if (hit) return hit;
    }
    return null;
}

async function main() {
    if (!fs.existsSync(CANON)) {
        console.error("No existe data/canon/. Corre primero: node build_canon_2026.js");
        process.exit(1);
    }

    let existingUsers = [];
    if (fs.existsSync(STORE)) {
        try {
            const old = JSON.parse(fs.readFileSync(STORE, "utf8"));
            existingUsers = old.tables?.equioriente_usuarios || [];
        } catch { /* ignore */ }
    }
    if (!existingUsers.length) {
        const hash = await bcrypt.hash("1234", 10);
        existingUsers = [
            { id: 1, usuario: "admin", password: hash, rol: "admin" },
            { id: 2, usuario: "operario", password: hash, rol: "operario" }
        ];
    }

    const tables = {
        equioriente_usuarios: existingUsers.slice(),
        equioriente_categorias: [],
        equioriente_clientes: [],
        equioriente_obras: [],
        equioriente_cuentas: [],
        equioriente_periodos_cuenta: [],
        equioriente_articulos: [],
        equioriente_alquileres: [],
        equioriente_alquiler_items: [],
        equioriente_devoluciones_proveedor: [],
        equioriente_movimientos_inventario: [],
        equioriente_registro_danos: [],
        equioriente_remitos: [],
        equioriente_movimientos: [],
        equioriente_remito_items: [],
        equioriente_saldos_periodo: [],
        equioriente_cobros: [],
        equioriente_pagos: [],
        equioriente_flujo_caja: [],
        equioriente_documentos: [],
        equioriente_cotizaciones: [],
        equioriente_cotizacion_items: [],
        equioriente_viajes: []
    };
    const seq = {};
    seq.equioriente_usuarios = existingUsers.reduce((m, u) => Math.max(m, Number(u.id) || 0), 0);

    const usedRef = new Set();
    const catByName = {};
    function catId(nombre) {
        if (!catByName[nombre]) {
            const id = nextId(seq, "equioriente_categorias");
            catByName[nombre] = id;
            tables.equioriente_categorias.push({ id, nombre });
        }
        return catByName[nombre];
    }
    catId("General");

    const precios = readCsvFile(path.join(CANON, "catalogo", "precios.csv"));
    const inv = readCsvFile(path.join(CANON, "catalogo", "articulos.csv"));
    const articulos = [];
    for (const row of inv) {
        const id = nextId(seq, "equioriente_articulos");
        const precioHit = precios.find(p => materialKey(p.nombre) === materialKey(row.nombre));
        const total = num(row.total);
        const art = {
            id,
            referencia: makeRef(row.nombre, usedRef),
            nombre: row.nombre,
            stock_total: total,
            stock_disponible: total,
            stock_mantenimiento: 0,
            stock_danado: 0,
            stock_minimo: 0,
            stock_alquilado: 0,
            stock_subalquilado: 0,
            precio_dia: precioHit ? num(precioHit.precio_dia) : 0,
            valor_unitario: num(row.valor_unitario),
            dias_minimos: precioHit ? num(precioHit.dias_minimos, 1) : 1,
            es_externo: 0,
            empresa_externa: null,
            costo_proveedor_dia: 0,
            categoria_id: catId(categoriaDe(row.nombre)),
            _key: materialKey(row.nombre),
            _norm: normMaterial(row.nombre),
            _dims: dims(normMaterial(row.nombre)).join("*")
        };
        articulos.push(art);
        const { _key, _norm, _dims, ...clean } = art;
        tables.equioriente_articulos.push(clean);
        art._key = _key; art._norm = _norm; art._dims = _dims;
    }
    console.log("Artículos (solo catálogo):", articulos.length);

    const usedIdent = new Set();
    const cliByName = new Map();
    function identFromName(nombre) {
        let base = "C-" + upper(nombre).replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
        let idn = base, i = 2;
        while (usedIdent.has(idn)) idn = `${base}-${i++}`;
        usedIdent.add(idn);
        return idn;
    }
    function getCliente(nombre) {
        const key = upper(nombre);
        if (!cliByName.has(key)) {
            const rowCsv = clientesCsv.find(c => upper(c.nombre_normalizado) === key);
            const id = nextId(seq, "equioriente_clientes");
            const row = {
                id,
                nombre: rowCsv?.nombre_origen || nombre,
                telefono: rowCsv?.telefono || null,
                direccion: rowCsv?.direccion || null,
                identificacion: identFromName(nombre)
            };
            tables.equioriente_clientes.push(row);
            cliByName.set(key, row);
        }
        const row = cliByName.get(key);
        return row;
    }

    const clientesCsv = readCsvFile(path.join(CANON, "clientes", "clientes.csv"));
    for (const c of clientesCsv) getCliente(c.nombre_normalizado);

    const obraByKey = new Map();
    function getObra(cliente, direccion) {
        const cid = cliente.id;
        const dir = (direccion || cliente.direccion || "").trim();
        const k = cid + "|" + upper(dir);
        if (!obraByKey.has(k)) {
            const id = nextId(seq, "equioriente_obras");
            const row = { id, cliente_id: cid, nombre: dir || cliente.nombre, direccion: dir || null };
            tables.equioriente_obras.push(row);
            obraByKey.set(k, row);
        }
        return obraByKey.get(k);
    }

    const cuentaByKey = new Map();
    function getCuenta(cliente, obra, tipo) {
        const k = cliente.id + "|" + obra.id + "|" + tipo;
        if (!cuentaByKey.has(k)) {
            const id = nextId(seq, "equioriente_cuentas");
            const row = {
                id,
                cliente_id: cliente.id,
                obra_id: obra.id,
                tipo_documento: tipo,
                telefono: cliente.telefono || null
            };
            tables.equioriente_cuentas.push(row);
            cuentaByKey.set(k, row);
        }
        return cuentaByKey.get(k);
    }

    const opDir = path.join(CANON, "operacion");
    const meses = fs.existsSync(opDir)
        ? fs.readdirSync(opDir).filter(d => /^\d{4}-\d{2}$/.test(d)).sort()
        : [];

    const adminId = existingUsers.find(u => u.rol === "admin")?.id || existingUsers[0]?.id || 1;

    for (const ym of meses) {
        const dir = path.join(opDir, ym);
        const cuentas = readCsvFile(path.join(dir, "cuentas.csv"));
        const remitos = readCsvFile(path.join(dir, "remitos.csv"));
        const movimientos = readCsvFile(path.join(dir, "movimientos.csv"));
        const saldos = readCsvFile(path.join(dir, "saldos.csv"));
        const cobros = readCsvFile(path.join(dir, "cobros.csv"));
        const pagos = readCsvFile(path.join(dir, "pagos.csv"));

        const periodoByCuenta = new Map();

        for (const c of cuentas) {
            const cli = getCliente(c.cliente);
            if (c.telefono && !cli.telefono) cli.telefono = c.telefono;
            if (c.direccion && !cli.direccion) cli.direccion = c.direccion;
            const obra = getObra(cli, c.obra || c.direccion);
            const cuentaTipo = c.tipo || "seguimiento";
            const tipoDoc = c.tipo_documento || cuentaTipo;
            const cuenta = getCuenta(cli, obra, cuentaTipo);
            if (tipoDoc && tipoDoc !== "seguimiento") cuenta.tipo_documento = tipoDoc;
            const pk = cuenta.id + "|" + ym;
            if (periodoByCuenta.has(pk)) continue;

            const saldoRows = saldos.filter(s => s.cliente === c.cliente && s.tipo === c.tipo && s.obra === c.obra);
            const cobroRows = cobros.filter(s => s.cliente === c.cliente && s.tipo === c.tipo && s.obra === c.obra);
            const remRows = remitos.filter(s => s.cliente === c.cliente && s.tipo === c.tipo && s.obra === c.obra);
            const pagoRows = pagos.filter(s => s.cliente === c.cliente && s.tipo === c.tipo && s.obra === c.obra);
            const cobroTotal = cobroRows.reduce((s, x) => s + num(x.total), 0);
            const transporte = num(c.transporte) || remRows.reduce((s, x) => s + num(x.transporte), 0);
            const hasSaldo = saldoRows.some(s => num(s.cantidad) !== 0);
            const firstFecha = remRows.map(r => r.fecha).filter(Boolean).sort()[0] || `${ym}-01`;

            const alqId = nextId(seq, "equioriente_alquileres");
            tables.equioriente_alquileres.push({
                id: alqId,
                cliente_id: cli.id,
                usuario_id: adminId,
                fecha_salida: firstFecha,
                fecha_devolucion_esperada: null,
                fecha_devolucion_real: hasSaldo ? null : firstFecha,
                estado: hasSaldo ? "activo" : "devuelto",
                notas: c.notas || null,
                tipo_fiscal: tipoDoc,
                obra: c.obra || null,
                periodo: ym,
                fuente_archivo: c.fuente || null,
                fuente_hoja: c.hoja || null,
                transporte,
                total_cobrado: cobroTotal,
                periodo_id: null
            });

            const perId = nextId(seq, "equioriente_periodos_cuenta");
            const periodo = {
                id: perId,
                cuenta_id: cuenta.id,
                alquiler_id: alqId,
                anio_mes: ym,
                tipo_documento: tipoDoc,
                fuente: c.fuente || null,
                hoja: c.hoja || null,
                notas: c.notas || null,
                transporte,
                total_cobrado: cobroTotal,
                remitos_n: remRows.length,
                saldos_n: saldoRows.length,
                estado: hasSaldo ? "activo" : "cerrado"
            };
            tables.equioriente_periodos_cuenta.push(periodo);
            const alq = tables.equioriente_alquileres.find(a => a.id === alqId);
            alq.periodo_id = perId;
            periodoByCuenta.set(pk, { periodo, alqId, cliente: c.cliente, tipo: c.tipo, obra: c.obra, cli });

            for (const s of saldoRows) {
                const art = findArticulo(articulos, s.material);
                const sid = nextId(seq, "equioriente_saldos_periodo");
                tables.equioriente_saldos_periodo.push({
                    id: sid,
                    periodo_id: perId,
                    articulo_id: art ? art.id : null,
                    material: s.material,
                    cantidad: num(s.cantidad)
                });
                if (art && num(s.cantidad) !== 0) {
                    tables.equioriente_alquiler_items.push({
                        id: nextId(seq, "equioriente_alquiler_items"),
                        alquiler_id: alqId,
                        articulo_id: art.id,
                        cantidad: Math.abs(num(s.cantidad)),
                        cantidad_devuelta: hasSaldo ? 0 : Math.abs(num(s.cantidad)),
                        precio_dia_aplicado: art.precio_dia || 0,
                        dias_acordados: 1,
                        dias_reales: null,
                        total_calculado: 0,
                        material_origen: s.material
                    });
                }
            }
            for (const cob of cobroRows) {
                const art = findArticulo(articulos, cob.material);
                tables.equioriente_cobros.push({
                    id: nextId(seq, "equioriente_cobros"),
                    periodo_id: perId,
                    articulo_id: art ? art.id : null,
                    material: cob.material,
                    dias: num(cob.dias, 1),
                    cantidad: num(cob.cantidad),
                    valor_unitario: num(cob.valor_unitario),
                    costo_diario: num(cob.costo_diario),
                    total: num(cob.total),
                    periodo_texto: cob.periodo_texto || null
                });
            }
            let transRemitos = 0;
            for (const rem of remRows) {
                const rid = nextId(seq, "equioriente_remitos");
                const trans = num(rem.transporte);
                transRemitos += trans;
                tables.equioriente_remitos.push({
                    id: rid,
                    alquiler_id: alqId,
                    periodo_id: perId,
                    numero: rem.numero,
                    fecha: rem.fecha || null,
                    hora: rem.hora || null,
                    transporte: trans,
                    placa: rem.placa || null,
                    fuente: rem.fuente || null
                });
                const movs = movimientos.filter(m => m.cliente === c.cliente && m.tipo === c.tipo && String(m.remito) === String(rem.numero));
                const qtys = movs.map(m => num(m.cantidad));
                const allNeg = qtys.length > 0 && qtys.every(q => q <= 0);
                for (const mv of movs) {
                    const art = findArticulo(articulos, mv.material);
                    const mid = nextId(seq, "equioriente_movimientos");
                    tables.equioriente_movimientos.push({
                        id: mid,
                        remito_id: rid,
                        articulo_id: art ? art.id : null,
                        material: mv.material,
                        cantidad: num(mv.cantidad)
                    });
                    if (art) {
                        tables.equioriente_remito_items.push({
                            id: nextId(seq, "equioriente_remito_items"),
                            remito_id: rid,
                            articulo_id: art.id,
                            cantidad: num(mv.cantidad),
                            material_origen: mv.material
                        });
                    }
                }
                if (trans >= 100) {
                    tables.equioriente_viajes.push({
                        id: nextId(seq, "equioriente_viajes"),
                        alquiler_id: alqId,
                        periodo_id: perId,
                        remito_id: rid,
                        tipo: allNeg ? "recogida" : "llevada",
                        quien: "equioriente",
                        precio: trans,
                        placa: rem.placa || null,
                        direccion: c.direccion || c.obra || null,
                        fecha: rem.fecha || `${ym}-01`,
                        notas: rem.numero ? ("Remito " + rem.numero) : null
                    });
                }
            }
            const extraTrans = transporte - transRemitos;
            if (extraTrans >= 1000) {
                tables.equioriente_viajes.push({
                    id: nextId(seq, "equioriente_viajes"),
                    alquiler_id: alqId,
                    periodo_id: perId,
                    remito_id: null,
                    tipo: transRemitos > 0 ? "recogida" : "ida_vuelta",
                    quien: "equioriente",
                    precio: extraTrans,
                    placa: null,
                    direccion: c.direccion || c.obra || null,
                    fecha: `${ym}-01`,
                    notas: transRemitos > 0 ? "Llevada y traída (complemento)" : "Llevada y traída"
                });
            }
            for (const p of pagoRows) {
                tables.equioriente_pagos.push({
                    id: nextId(seq, "equioriente_pagos"),
                    cliente_id: cli.id,
                    alquiler_id: alqId,
                    periodo_id: perId,
                    fecha: p.fecha || `${ym}-01`,
                    monto: num(p.monto),
                    medio: p.medio || null,
                    detalle: p.detalle || null,
                    tipo: p.tipo_pago || "pago",
                    fuente: c.fuente || null
                });
            }
        }
        console.log(ym, "periodos", tables.equioriente_periodos_cuenta.filter(p => p.anio_mes === ym).length);
    }

    const flujo = readCsvFile(path.join(CANON, "caja", "flujo_2026.csv"));
    for (const f of flujo) {
        tables.equioriente_flujo_caja.push({
            id: nextId(seq, "equioriente_flujo_caja"),
            fecha: f.fecha || null,
            detalle: f.detalle,
            valor: num(f.valor),
            tipo: f.tipo || "ingreso",
            medio: f.medio || null,
            mes: f.mes ? num(f.mes) : null,
            anio: f.anio ? num(f.anio) : 2026,
            fuente: f.fuente || null
        });
    }
    console.log("Flujo:", tables.equioriente_flujo_caja.length);

    const docs = readCsvFile(path.join(CANON, "archivo", "documentos.csv"));
    for (const d of docs) {
        tables.equioriente_documentos.push({
            id: nextId(seq, "equioriente_documentos"),
            tipo: d.tipo || "documento",
            dominio: d.dominio || "documento",
            titulo: d.titulo || d.archivo,
            archivo: d.archivo,
            ruta: d.ruta,
            extension: d.extension,
            anio: d.anio ? num(d.anio) : null,
            mes: d.mes ? num(d.mes) : null,
            tamano: d.tamano ? num(d.tamano) : null
        });
    }
    console.log("Documentos:", tables.equioriente_documentos.length);

    const junk = tables.equioriente_articulos.filter(a =>
        /TOTAL MATERIAL|ADEUDADO|INFORME|P Y G|VALOR EMPRESA|HORA$|^TRANSPORTE$/i.test(a.nombre));
    if (junk.length) {
        console.warn("AVISO: artículos sospechosos en catálogo:", junk.map(a => a.nombre));
    }
    console.log("Inventario propio:", tables.equioriente_articulos.length,
        "piezas", tables.equioriente_articulos.reduce((s, a) => s + (a.stock_total || 0), 0));

    const store = {
        tables,
        seq,
        meta: {
            imported_at: new Date().toISOString(),
            source: "data/canon",
            alcance: "operacion-2026",
            stats: {
                articulos: tables.equioriente_articulos.length,
                clientes: tables.equioriente_clientes.length,
                cuentas: tables.equioriente_cuentas.length,
                periodos: tables.equioriente_periodos_cuenta.length,
                alquileres: tables.equioriente_alquileres.length,
                remitos: tables.equioriente_remitos.length,
                cobros: tables.equioriente_cobros.length,
                viajes: tables.equioriente_viajes.length,
                flujo: tables.equioriente_flujo_caja.length,
                documentos: tables.equioriente_documentos.length
            }
        }
    };
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(store));
    console.log("\nEscrito", STORE);
    console.log(store.meta.stats);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
