-- ════════════════════════════════════════════════════════════
--  EQUIORIENTE  —  Schema para Supabase (PostgreSQL)
--  Ejecutar en: Supabase → SQL Editor → New query → Run
--
--  Todas las tablas usan el prefijo EQUIORIENTE_ para evitar
--  conflictos si compartes la misma base de datos con otros proyectos.
-- ════════════════════════════════════════════════════════════

-- ── Usuarios ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS equioriente_usuarios (
    id       BIGSERIAL PRIMARY KEY,
    usuario  TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    rol      TEXT NOT NULL DEFAULT 'operario'
);

-- ── Categorías de artículos ───────────────────────────────────
CREATE TABLE IF NOT EXISTS equioriente_categorias (
    id     BIGSERIAL PRIMARY KEY,
    nombre TEXT UNIQUE NOT NULL
);

-- ── Clientes ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS equioriente_clientes (
    id             BIGSERIAL PRIMARY KEY,
    nombre         TEXT NOT NULL,
    telefono       TEXT,
    direccion      TEXT,
    identificacion TEXT UNIQUE
);

-- ── Artículos / Inventario ────────────────────────────────────
CREATE TABLE IF NOT EXISTS equioriente_articulos (
    id                  BIGSERIAL PRIMARY KEY,
    referencia          TEXT UNIQUE NOT NULL,
    nombre              TEXT NOT NULL,
    stock_total         INTEGER NOT NULL DEFAULT 0,
    stock_disponible    INTEGER NOT NULL DEFAULT 0,
    stock_mantenimiento INTEGER NOT NULL DEFAULT 0,
    stock_danado        INTEGER NOT NULL DEFAULT 0,
    stock_minimo        INTEGER NOT NULL DEFAULT 0,
    precio_dia          FLOAT   NOT NULL DEFAULT 0,
    es_externo          SMALLINT NOT NULL DEFAULT 0,   -- 0=Propio, 1=Externo
    empresa_externa     TEXT,
    costo_proveedor_dia FLOAT  DEFAULT 0,
    categoria_id        BIGINT REFERENCES equioriente_categorias(id) ON DELETE SET NULL
);

-- ── Alquileres (cabecera) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS equioriente_alquileres (
    id                        BIGSERIAL PRIMARY KEY,
    cliente_id                BIGINT NOT NULL REFERENCES equioriente_clientes(id),
    usuario_id                BIGINT NOT NULL REFERENCES equioriente_usuarios(id),
    fecha_salida              TIMESTAMPTZ DEFAULT NOW(),
    fecha_devolucion_esperada TEXT,
    fecha_devolucion_real     TIMESTAMPTZ,
    estado                    TEXT DEFAULT 'activo',   -- activo|parcial|devuelto
    notas                     TEXT
);

-- ── Ítems de alquiler (líneas) ────────────────────────────────
CREATE TABLE IF NOT EXISTS equioriente_alquiler_items (
    id                  BIGSERIAL PRIMARY KEY,
    alquiler_id         BIGINT NOT NULL REFERENCES equioriente_alquileres(id) ON DELETE CASCADE,
    articulo_id         BIGINT NOT NULL REFERENCES equioriente_articulos(id),
    cantidad            INTEGER NOT NULL,
    cantidad_devuelta   INTEGER NOT NULL DEFAULT 0,
    precio_dia_aplicado FLOAT   NOT NULL,
    dias_acordados      INTEGER NOT NULL DEFAULT 1,
    dias_reales         INTEGER,
    total_calculado     FLOAT
);

-- ── Devoluciones a proveedor externo ─────────────────────────
CREATE TABLE IF NOT EXISTS equioriente_devoluciones_proveedor (
    id                  BIGSERIAL PRIMARY KEY,
    articulo_id         BIGINT NOT NULL REFERENCES equioriente_articulos(id),
    cantidad            INTEGER NOT NULL,
    fecha_retiro        TEXT,
    fecha_devolucion    TIMESTAMPTZ DEFAULT NOW(),
    dias_reales         INTEGER,
    costo_proveedor_dia FLOAT,
    total_costo         FLOAT,
    notas               TEXT,
    usuario_id          BIGINT REFERENCES equioriente_usuarios(id)
);

-- ── Historial de movimientos de inventario ────────────────────
CREATE TABLE IF NOT EXISTS equioriente_movimientos_inventario (
    id            BIGSERIAL PRIMARY KEY,
    articulo_id   BIGINT NOT NULL REFERENCES equioriente_articulos(id),
    tipo          TEXT NOT NULL,   -- entrada|salida|perdida|dano|reparacion|devolucion_proveedor
    cantidad      INTEGER NOT NULL,
    motivo        TEXT,
    referencia_id BIGINT,
    usuario_id    BIGINT REFERENCES equioriente_usuarios(id),
    fecha         TIMESTAMPTZ DEFAULT NOW()
);

-- ── Registro de daños y pérdidas ─────────────────────────────
CREATE TABLE IF NOT EXISTS equioriente_registro_danos (
    id               BIGSERIAL PRIMARY KEY,
    articulo_id      BIGINT NOT NULL REFERENCES equioriente_articulos(id),
    alquiler_id      BIGINT REFERENCES equioriente_alquileres(id),
    cliente_id       BIGINT REFERENCES equioriente_clientes(id),
    cantidad         INTEGER NOT NULL DEFAULT 1,
    tipo             TEXT NOT NULL DEFAULT 'dano',   -- dano|perdida
    descripcion      TEXT,
    costo_reparacion FLOAT DEFAULT 0,
    cobrado_cliente  SMALLINT DEFAULT 0,
    monto_cobrado    FLOAT DEFAULT 0,
    estado           TEXT DEFAULT 'pendiente',       -- pendiente|reparado
    usuario_id       BIGINT REFERENCES equioriente_usuarios(id),
    fecha            TIMESTAMPTZ DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════
--  Índices para mejorar rendimiento en consultas frecuentes
-- ════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_equioriente_alquileres_cliente ON equioriente_alquileres(cliente_id);
CREATE INDEX IF NOT EXISTS idx_equioriente_alquileres_estado  ON equioriente_alquileres(estado);
CREATE INDEX IF NOT EXISTS idx_equioriente_alquileres_fecha   ON equioriente_alquileres(fecha_salida);
CREATE INDEX IF NOT EXISTS idx_equioriente_items_alq          ON equioriente_alquiler_items(alquiler_id);
CREATE INDEX IF NOT EXISTS idx_equioriente_items_art          ON equioriente_alquiler_items(articulo_id);
CREATE INDEX IF NOT EXISTS idx_equioriente_movimientos_art    ON equioriente_movimientos_inventario(articulo_id);
CREATE INDEX IF NOT EXISTS idx_equioriente_movimientos_fecha  ON equioriente_movimientos_inventario(fecha);
CREATE INDEX IF NOT EXISTS idx_equioriente_articulos_externo  ON equioriente_articulos(es_externo);

-- ════════════════════════════════════════════════════════════
--  Datos iniciales
-- ════════════════════════════════════════════════════════════
INSERT INTO equioriente_categorias (nombre) VALUES ('General') ON CONFLICT DO NOTHING;

-- Los usuarios admin/operario se crean automáticamente al iniciar el servidor
-- con SUPABASE_URL y SUPABASE_KEY configurados en .env.

-- ════════════════════════════════════════════════════════════
--  Funciones RPC (llamadas desde el servidor via sb.rpc())
-- ════════════════════════════════════════════════════════════

-- Ajuste atómico de stock (evita race conditions en actualizaciones concurrentes)
CREATE OR REPLACE FUNCTION equioriente_ajustar_stock(
    p_id    BIGINT,
    p_total INT DEFAULT 0,
    p_disp  INT DEFAULT 0,
    p_dano  INT DEFAULT 0
)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    UPDATE equioriente_articulos
    SET stock_total      = stock_total      + p_total,
        stock_disponible = stock_disponible + p_disp,
        stock_danado     = stock_danado     + p_dano
    WHERE id = p_id;
END;
$$;

-- Artículos con stock disponible <= stock mínimo (comparación columna-columna)
CREATE OR REPLACE FUNCTION equioriente_articulos_alertas()
RETURNS TABLE(
    id                  BIGINT,
    referencia          TEXT,
    nombre              TEXT,
    stock_total         INT,
    stock_disponible    INT,
    stock_mantenimiento INT,
    stock_danado        INT,
    stock_minimo        INT,
    precio_dia          FLOAT,
    es_externo          SMALLINT,
    empresa_externa     TEXT,
    costo_proveedor_dia FLOAT,
    categoria_id        BIGINT,
    categoria_nombre    TEXT
) LANGUAGE sql AS $$
    SELECT a.id, a.referencia, a.nombre, a.stock_total, a.stock_disponible,
           a.stock_mantenimiento, a.stock_danado, a.stock_minimo, a.precio_dia,
           a.es_externo, a.empresa_externa, a.costo_proveedor_dia,
           a.categoria_id, c.nombre AS categoria_nombre
    FROM equioriente_articulos a
    LEFT JOIN equioriente_categorias c ON c.id = a.categoria_id
    WHERE a.stock_minimo > 0 AND a.stock_disponible <= a.stock_minimo
    ORDER BY a.stock_disponible;
$$;

-- Top 20 artículos más alquilados
CREATE OR REPLACE FUNCTION equioriente_top_articulos()
RETURNS TABLE(
    referencia      TEXT,
    nombre          TEXT,
    empresa_externa TEXT,
    veces_alquilado BIGINT,
    total_unidades  BIGINT
) LANGUAGE sql AS $$
    SELECT a.referencia, a.nombre, a.empresa_externa,
           COUNT(DISTINCT i.alquiler_id) AS veces_alquilado,
           COALESCE(SUM(i.cantidad), 0)  AS total_unidades
    FROM equioriente_articulos a
    LEFT JOIN equioriente_alquiler_items i ON i.articulo_id = a.id
    GROUP BY a.id, a.referencia, a.nombre, a.empresa_externa
    ORDER BY veces_alquilado DESC
    LIMIT 20;
$$;

-- Reporte de ingresos filtrado por rango de fechas
-- Retorna JSONB con claves "detalle" (array) y "totales" (objeto)
CREATE OR REPLACE FUNCTION equioriente_reporte_ingresos(
    p_desde TEXT DEFAULT NULL,
    p_hasta TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_desde   TIMESTAMPTZ;
    v_hasta   TIMESTAMPTZ;
    v_detalle JSONB;
    v_totales JSONB;
BEGIN
    v_desde := CASE WHEN p_desde IS NOT NULL AND p_desde <> ''
                    THEN p_desde::DATE::TIMESTAMPTZ
                    ELSE '-infinity'::TIMESTAMPTZ END;
    v_hasta := CASE WHEN p_hasta IS NOT NULL AND p_hasta <> ''
                    THEN (p_hasta::DATE + INTERVAL '1 day')::TIMESTAMPTZ
                    ELSE 'infinity'::TIMESTAMPTZ END;

    SELECT COALESCE(jsonb_agg(row_to_json(d)::JSONB ORDER BY d.alquiler_id DESC), '[]'::JSONB)
    INTO v_detalle
    FROM (
        SELECT al.id                                    AS alquiler_id,
               c.nombre                                AS cliente_nombre,
               al.fecha_salida,
               al.fecha_devolucion_real,
               al.estado,
               COALESCE(SUM(it.total_calculado), 0)   AS total
        FROM equioriente_alquileres al
        JOIN equioriente_clientes c ON c.id = al.cliente_id
        LEFT JOIN equioriente_alquiler_items it ON it.alquiler_id = al.id
        WHERE al.fecha_salida >= v_desde AND al.fecha_salida < v_hasta
        GROUP BY al.id, c.nombre, al.fecha_salida, al.fecha_devolucion_real, al.estado
    ) d;

    SELECT jsonb_build_object(
        'total_alquileres', COUNT(DISTINCT al.id),
        'total_ingresos',   COALESCE(SUM(it.total_calculado), 0)
    )
    INTO v_totales
    FROM equioriente_alquileres al
    LEFT JOIN equioriente_alquiler_items it ON it.alquiler_id = al.id
    WHERE al.fecha_salida >= v_desde AND al.fecha_salida < v_hasta;

    RETURN jsonb_build_object(
        'detalle', v_detalle,
        'totales', COALESCE(v_totales, '{}'::JSONB)
    );
END;
$$;

-- Top 20 clientes por número de alquileres
CREATE OR REPLACE FUNCTION equioriente_top_clientes()
RETURNS TABLE(
    id               BIGINT,
    nombre           TEXT,
    telefono         TEXT,
    identificacion   TEXT,
    total_alquileres BIGINT,
    total_items      BIGINT,
    total_gastado    FLOAT
) LANGUAGE sql AS $$
    SELECT c.id, c.nombre, c.telefono, c.identificacion,
           COUNT(DISTINCT al.id)                AS total_alquileres,
           COALESCE(SUM(it.cantidad), 0)        AS total_items,
           COALESCE(SUM(it.total_calculado), 0) AS total_gastado
    FROM equioriente_clientes c
    LEFT JOIN equioriente_alquileres al ON al.cliente_id = c.id
    LEFT JOIN equioriente_alquiler_items it ON it.alquiler_id = al.id
    GROUP BY c.id, c.nombre, c.telefono, c.identificacion
    ORDER BY total_alquileres DESC
    LIMIT 20;
$$;

-- Costos acumulados de artículos externos devueltos a proveedor
CREATE OR REPLACE FUNCTION equioriente_costos_externos()
RETURNS TABLE(
    nombre             TEXT,
    empresa_externa    TEXT,
    referencia         TEXT,
    total_devoluciones BIGINT,
    total_dias         BIGINT,
    total_costo        FLOAT
) LANGUAGE sql AS $$
    SELECT a.nombre, a.empresa_externa, a.referencia,
           COUNT(dp.id)                      AS total_devoluciones,
           COALESCE(SUM(dp.dias_reales), 0)  AS total_dias,
           COALESCE(SUM(dp.total_costo), 0)  AS total_costo
    FROM equioriente_articulos a
    JOIN equioriente_devoluciones_proveedor dp ON dp.articulo_id = a.id
    WHERE a.es_externo = 1
    GROUP BY a.id, a.nombre, a.empresa_externa, a.referencia
    ORDER BY total_costo DESC;
$$;

-- Alquileres activos cuya fecha esperada de devolución ya pasó
CREATE OR REPLACE FUNCTION equioriente_morosos()
RETURNS TABLE(
    id                        BIGINT,
    cliente_nombre            TEXT,
    cliente_tel               TEXT,
    fecha_salida              TIMESTAMPTZ,
    fecha_devolucion_esperada TEXT,
    dias_mora                 INT,
    estado                    TEXT
) LANGUAGE sql AS $$
    SELECT al.id,
           c.nombre   AS cliente_nombre,
           c.telefono AS cliente_tel,
           al.fecha_salida,
           al.fecha_devolucion_esperada,
           (CURRENT_DATE - al.fecha_devolucion_esperada::DATE)::INT AS dias_mora,
           al.estado
    FROM equioriente_alquileres al
    JOIN equioriente_clientes c ON c.id = al.cliente_id
    WHERE al.estado IN ('activo', 'parcial')
      AND al.fecha_devolucion_esperada IS NOT NULL
      AND al.fecha_devolucion_esperada <> ''
      AND al.fecha_devolucion_esperada::DATE < CURRENT_DATE
    ORDER BY dias_mora DESC;
$$;

-- Estadísticas generales del dashboard
-- Retorna JSONB con: totalArticulos, totalClientes, alquileresActivos,
--   mesActual, mesPasado, meses (últimos 6), topCliente, topArticulo
CREATE OR REPLACE FUNCTION equioriente_estadisticas()
RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    RETURN jsonb_build_object(
        'totalArticulos',    (SELECT COUNT(*) FROM equioriente_articulos),
        'totalClientes',     (SELECT COUNT(*) FROM equioriente_clientes),
        'alquileresActivos', (SELECT COUNT(*) FROM equioriente_alquileres
                              WHERE estado IN ('activo','parcial')),
        'mesActual', jsonb_build_object(
            'alquileres', (
                SELECT COUNT(*) FROM equioriente_alquileres
                WHERE DATE_TRUNC('month', fecha_salida) = DATE_TRUNC('month', NOW())
            ),
            'ingresos', (
                SELECT COALESCE(SUM(it.total_calculado), 0)
                FROM equioriente_alquileres al
                JOIN equioriente_alquiler_items it ON it.alquiler_id = al.id
                WHERE DATE_TRUNC('month', al.fecha_salida) = DATE_TRUNC('month', NOW())
            )
        ),
        'mesPasado', jsonb_build_object(
            'alquileres', (
                SELECT COUNT(*) FROM equioriente_alquileres
                WHERE DATE_TRUNC('month', fecha_salida) =
                      DATE_TRUNC('month', NOW() - INTERVAL '1 month')
            ),
            'ingresos', (
                SELECT COALESCE(SUM(it.total_calculado), 0)
                FROM equioriente_alquileres al
                JOIN equioriente_alquiler_items it ON it.alquiler_id = al.id
                WHERE DATE_TRUNC('month', al.fecha_salida) =
                      DATE_TRUNC('month', NOW() - INTERVAL '1 month')
            )
        ),
        'meses', (
            SELECT COALESCE(jsonb_agg(m ORDER BY m->>'mes'), '[]'::JSONB)
            FROM (
                SELECT jsonb_build_object(
                    'mes',        TO_CHAR(DATE_TRUNC('month', al.fecha_salida), 'YYYY-MM'),
                    'alquileres', COUNT(DISTINCT al.id),
                    'ingresos',   COALESCE(SUM(it.total_calculado), 0)
                ) AS m
                FROM equioriente_alquileres al
                LEFT JOIN equioriente_alquiler_items it ON it.alquiler_id = al.id
                WHERE al.fecha_salida >= NOW() - INTERVAL '6 months'
                GROUP BY DATE_TRUNC('month', al.fecha_salida)
            ) sub
        ),
        'topCliente', (
            SELECT jsonb_build_object('nombre', c.nombre, 'total', COUNT(al.id))
            FROM equioriente_clientes c
            JOIN equioriente_alquileres al ON al.cliente_id = c.id
            WHERE al.fecha_salida >= DATE_TRUNC('month', NOW())
            GROUP BY c.id, c.nombre
            ORDER BY COUNT(al.id) DESC
            LIMIT 1
        ),
        'topArticulo', (
            SELECT jsonb_build_object('nombre', a.nombre, 'total', COUNT(it.id))
            FROM equioriente_articulos a
            JOIN equioriente_alquiler_items it ON it.articulo_id = a.id
            JOIN equioriente_alquileres al ON al.id = it.alquiler_id
            WHERE al.fecha_salida >= DATE_TRUNC('month', NOW())
            GROUP BY a.id, a.nombre
            ORDER BY COUNT(it.id) DESC
            LIMIT 1
        )
    );
END;
$$;
