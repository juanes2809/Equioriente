-- Equioriente — modelo operativo 2026 (proyecto Supabase: Equioriente)
-- Cliente → obra → cuenta → periodo (mes). Fiscal/no fiscal = tipo de documento.
-- Prefijo equioriente_ para no chocar con otras tablas del mismo proyecto.

CREATE SCHEMA IF NOT EXISTS equioriente_internal;

CREATE TABLE IF NOT EXISTS equioriente_usuarios (
    id       BIGSERIAL PRIMARY KEY,
    usuario  TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    rol      TEXT NOT NULL DEFAULT 'operario'
);

CREATE TABLE IF NOT EXISTS equioriente_categorias (
    id     BIGSERIAL PRIMARY KEY,
    nombre TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS equioriente_clientes (
    id             BIGSERIAL PRIMARY KEY,
    nombre         TEXT NOT NULL,
    telefono       TEXT,
    direccion      TEXT,
    identificacion TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS equioriente_obras (
    id         BIGSERIAL PRIMARY KEY,
    cliente_id BIGINT NOT NULL REFERENCES equioriente_clientes(id),
    nombre     TEXT,
    direccion  TEXT
);

CREATE TABLE IF NOT EXISTS equioriente_cuentas (
    id              BIGSERIAL PRIMARY KEY,
    cliente_id      BIGINT NOT NULL REFERENCES equioriente_clientes(id),
    obra_id         BIGINT REFERENCES equioriente_obras(id),
    tipo_documento  TEXT NOT NULL DEFAULT 'seguimiento'
        CHECK (tipo_documento IN ('seguimiento', 'fiscal', 'no_fiscal')),
    telefono        TEXT
);

CREATE TABLE IF NOT EXISTS equioriente_articulos (
    id                  BIGSERIAL PRIMARY KEY,
    referencia          TEXT UNIQUE NOT NULL,
    nombre              TEXT NOT NULL,
    stock_total         INTEGER NOT NULL DEFAULT 0,
    stock_disponible    INTEGER NOT NULL DEFAULT 0,
    stock_mantenimiento INTEGER NOT NULL DEFAULT 0,
    stock_danado        INTEGER NOT NULL DEFAULT 0,
    stock_minimo        INTEGER NOT NULL DEFAULT 0,
    stock_alquilado     INTEGER NOT NULL DEFAULT 0,
    stock_subalquilado  INTEGER NOT NULL DEFAULT 0,
    precio_dia          FLOAT   NOT NULL DEFAULT 0,
    valor_unitario      FLOAT   NOT NULL DEFAULT 0,
    dias_minimos        INTEGER NOT NULL DEFAULT 1,
    es_externo          SMALLINT NOT NULL DEFAULT 0,
    empresa_externa     TEXT,
    costo_proveedor_dia FLOAT  DEFAULT 0,
    categoria_id        BIGINT REFERENCES equioriente_categorias(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS equioriente_alquileres (
    id                        BIGSERIAL PRIMARY KEY,
    cliente_id                BIGINT NOT NULL REFERENCES equioriente_clientes(id),
    usuario_id                BIGINT NOT NULL REFERENCES equioriente_usuarios(id),
    fecha_salida              TIMESTAMPTZ DEFAULT NOW(),
    fecha_devolucion_esperada TEXT,
    fecha_devolucion_real     TIMESTAMPTZ,
    estado                    TEXT DEFAULT 'activo',
    notas                     TEXT,
    tipo_fiscal               TEXT DEFAULT 'seguimiento',
    obra                      TEXT,
    periodo                   TEXT,
    fuente_archivo            TEXT,
    fuente_hoja               TEXT,
    transporte                FLOAT DEFAULT 0,
    total_cobrado             FLOAT DEFAULT 0,
    periodo_id                BIGINT
);

CREATE TABLE IF NOT EXISTS equioriente_periodos_cuenta (
    id             BIGSERIAL PRIMARY KEY,
    cuenta_id      BIGINT NOT NULL REFERENCES equioriente_cuentas(id) ON DELETE CASCADE,
    alquiler_id    BIGINT REFERENCES equioriente_alquileres(id),
    anio_mes       TEXT NOT NULL,
    fuente         TEXT,
    hoja           TEXT,
    notas          TEXT,
    transporte     FLOAT DEFAULT 0,
    total_cobrado  FLOAT DEFAULT 0,
    remitos_n      INTEGER DEFAULT 0,
    saldos_n       INTEGER DEFAULT 0,
    estado         TEXT DEFAULT 'activo',
    tipo_documento TEXT,
    UNIQUE (cuenta_id, anio_mes)
);

CREATE TABLE IF NOT EXISTS equioriente_alquiler_items (
    id                  BIGSERIAL PRIMARY KEY,
    alquiler_id         BIGINT NOT NULL REFERENCES equioriente_alquileres(id) ON DELETE CASCADE,
    articulo_id         BIGINT NOT NULL REFERENCES equioriente_articulos(id),
    cantidad            INTEGER NOT NULL,
    cantidad_devuelta   INTEGER NOT NULL DEFAULT 0,
    precio_dia_aplicado FLOAT   NOT NULL,
    dias_acordados      INTEGER NOT NULL DEFAULT 1,
    dias_reales         INTEGER,
    total_calculado     FLOAT,
    material_origen     TEXT
);

CREATE TABLE IF NOT EXISTS equioriente_remitos (
    id          BIGSERIAL PRIMARY KEY,
    alquiler_id BIGINT REFERENCES equioriente_alquileres(id) ON DELETE CASCADE,
    periodo_id  BIGINT REFERENCES equioriente_periodos_cuenta(id) ON DELETE SET NULL,
    numero      TEXT,
    fecha       TEXT,
    hora        TEXT,
    transporte  FLOAT DEFAULT 0,
    placa       TEXT,
    fuente      TEXT,
    UNIQUE (numero, periodo_id)
);

CREATE TABLE IF NOT EXISTS equioriente_remito_items (
    id              BIGSERIAL PRIMARY KEY,
    remito_id       BIGINT NOT NULL REFERENCES equioriente_remitos(id) ON DELETE CASCADE,
    articulo_id     BIGINT REFERENCES equioriente_articulos(id),
    cantidad        INTEGER NOT NULL,
    material_origen TEXT
);

CREATE TABLE IF NOT EXISTS equioriente_movimientos (
    id          BIGSERIAL PRIMARY KEY,
    remito_id   BIGINT NOT NULL REFERENCES equioriente_remitos(id) ON DELETE CASCADE,
    articulo_id BIGINT REFERENCES equioriente_articulos(id),
    material    TEXT,
    cantidad    FLOAT NOT NULL
);

CREATE TABLE IF NOT EXISTS equioriente_saldos_periodo (
    id          BIGSERIAL PRIMARY KEY,
    periodo_id  BIGINT NOT NULL REFERENCES equioriente_periodos_cuenta(id) ON DELETE CASCADE,
    articulo_id BIGINT REFERENCES equioriente_articulos(id),
    material    TEXT,
    cantidad    FLOAT NOT NULL
);

CREATE TABLE IF NOT EXISTS equioriente_cobros (
    id              BIGSERIAL PRIMARY KEY,
    periodo_id      BIGINT NOT NULL REFERENCES equioriente_periodos_cuenta(id) ON DELETE CASCADE,
    articulo_id     BIGINT REFERENCES equioriente_articulos(id),
    material        TEXT,
    dias            FLOAT DEFAULT 1,
    cantidad        FLOAT DEFAULT 0,
    valor_unitario  FLOAT DEFAULT 0,
    costo_diario    FLOAT DEFAULT 0,
    total           FLOAT DEFAULT 0,
    periodo_texto   TEXT
);

CREATE TABLE IF NOT EXISTS equioriente_pagos (
    id          BIGSERIAL PRIMARY KEY,
    cliente_id  BIGINT REFERENCES equioriente_clientes(id),
    alquiler_id BIGINT REFERENCES equioriente_alquileres(id),
    periodo_id  BIGINT REFERENCES equioriente_periodos_cuenta(id),
    fecha       TEXT,
    monto       FLOAT NOT NULL DEFAULT 0,
    medio       TEXT,
    detalle     TEXT,
    tipo        TEXT DEFAULT 'pago',
    fuente      TEXT
);

CREATE TABLE IF NOT EXISTS equioriente_viajes (
    id           BIGSERIAL PRIMARY KEY,
    alquiler_id  BIGINT REFERENCES equioriente_alquileres(id) ON DELETE CASCADE,
    periodo_id   BIGINT REFERENCES equioriente_periodos_cuenta(id) ON DELETE SET NULL,
    remito_id    BIGINT REFERENCES equioriente_remitos(id) ON DELETE SET NULL,
    tipo         TEXT NOT NULL DEFAULT 'llevada',
    quien        TEXT NOT NULL DEFAULT 'equioriente',
    precio       FLOAT DEFAULT 0,
    placa        TEXT,
    direccion    TEXT,
    fecha        TEXT,
    notas        TEXT
);

CREATE TABLE IF NOT EXISTS equioriente_flujo_caja (
    id      BIGSERIAL PRIMARY KEY,
    fecha   TEXT,
    detalle TEXT,
    valor   FLOAT NOT NULL DEFAULT 0,
    tipo    TEXT NOT NULL DEFAULT 'ingreso',
    medio   TEXT,
    mes     INTEGER,
    anio    INTEGER,
    fuente  TEXT
);

CREATE TABLE IF NOT EXISTS equioriente_documentos (
    id        BIGSERIAL PRIMARY KEY,
    tipo      TEXT,
    titulo    TEXT,
    archivo   TEXT,
    ruta      TEXT,
    extension TEXT,
    anio      INTEGER,
    mes       INTEGER,
    tamano    BIGINT,
    dominio   TEXT DEFAULT 'documento'
);

CREATE TABLE IF NOT EXISTS equioriente_cotizaciones (
    id             BIGSERIAL PRIMARY KEY,
    cliente_id     BIGINT REFERENCES equioriente_clientes(id),
    fecha          TEXT,
    estado         TEXT DEFAULT 'abierta',
    total          FLOAT DEFAULT 0,
    transporte     FLOAT DEFAULT 0,
    notas          TEXT,
    fuente_archivo TEXT,
    fuente_hoja    TEXT
);

CREATE TABLE IF NOT EXISTS equioriente_cotizacion_items (
    id              BIGSERIAL PRIMARY KEY,
    cotizacion_id   BIGINT NOT NULL REFERENCES equioriente_cotizaciones(id) ON DELETE CASCADE,
    articulo_id     BIGINT REFERENCES equioriente_articulos(id),
    cantidad        INTEGER,
    dias            INTEGER,
    valor_unitario  FLOAT,
    total           FLOAT
);

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

CREATE TABLE IF NOT EXISTS equioriente_movimientos_inventario (
    id            BIGSERIAL PRIMARY KEY,
    articulo_id   BIGINT NOT NULL REFERENCES equioriente_articulos(id),
    tipo          TEXT NOT NULL,
    cantidad      INTEGER NOT NULL,
    motivo        TEXT,
    referencia_id BIGINT,
    usuario_id    BIGINT REFERENCES equioriente_usuarios(id),
    fecha         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS equioriente_registro_danos (
    id               BIGSERIAL PRIMARY KEY,
    articulo_id      BIGINT NOT NULL REFERENCES equioriente_articulos(id),
    alquiler_id      BIGINT REFERENCES equioriente_alquileres(id),
    cliente_id       BIGINT REFERENCES equioriente_clientes(id),
    cantidad         INTEGER NOT NULL DEFAULT 1,
    tipo             TEXT NOT NULL DEFAULT 'dano',
    descripcion      TEXT,
    costo_reparacion FLOAT DEFAULT 0,
    cobrado_cliente  SMALLINT DEFAULT 0,
    monto_cobrado    FLOAT DEFAULT 0,
    estado           TEXT DEFAULT 'pendiente',
    usuario_id       BIGINT REFERENCES equioriente_usuarios(id),
    fecha            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS equioriente_internal.app_settings (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_equioriente_obras_cli ON equioriente_obras(cliente_id);
CREATE INDEX IF NOT EXISTS idx_equioriente_cuentas_cli ON equioriente_cuentas(cliente_id);
CREATE INDEX IF NOT EXISTS idx_equioriente_periodos_mes ON equioriente_periodos_cuenta(anio_mes);
CREATE INDEX IF NOT EXISTS idx_equioriente_periodos_cta ON equioriente_periodos_cuenta(cuenta_id);
CREATE INDEX IF NOT EXISTS idx_equioriente_alquileres_cliente ON equioriente_alquileres(cliente_id);
CREATE INDEX IF NOT EXISTS idx_equioriente_alquileres_estado ON equioriente_alquileres(estado);
CREATE INDEX IF NOT EXISTS idx_equioriente_items_alq ON equioriente_alquiler_items(alquiler_id);
CREATE INDEX IF NOT EXISTS idx_equioriente_remitos_per ON equioriente_remitos(periodo_id);
CREATE INDEX IF NOT EXISTS idx_equioriente_mov_remito ON equioriente_movimientos(remito_id);
CREATE INDEX IF NOT EXISTS idx_equioriente_saldos_per ON equioriente_saldos_periodo(periodo_id);
CREATE INDEX IF NOT EXISTS idx_equioriente_cobros_per ON equioriente_cobros(periodo_id);
CREATE INDEX IF NOT EXISTS idx_equioriente_pagos_cli ON equioriente_pagos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_equioriente_viajes_per ON equioriente_viajes(periodo_id);
CREATE INDEX IF NOT EXISTS idx_equioriente_flujo_fecha ON equioriente_flujo_caja(fecha);

CREATE OR REPLACE FUNCTION equioriente_internal.app_ok()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    hdr text;
    expected text;
BEGIN
    SELECT s.v INTO expected
    FROM equioriente_internal.app_settings s
    WHERE s.k = 'app_key';
    IF expected IS NULL OR length(expected) < 16 THEN
        RETURN false;
    END IF;
    hdr := coalesce(current_setting('request.headers', true)::json->>'x-equioriente-key', '');
    RETURN hdr = expected;
END;
$$;

REVOKE ALL ON FUNCTION equioriente_internal.app_ok() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION equioriente_internal.app_ok() TO anon, authenticated, service_role;
REVOKE ALL ON SCHEMA equioriente_internal FROM PUBLIC;
GRANT USAGE ON SCHEMA equioriente_internal TO anon, authenticated, service_role;
REVOKE ALL ON TABLE equioriente_internal.app_settings FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'equioriente_usuarios', 'equioriente_categorias', 'equioriente_clientes',
        'equioriente_obras', 'equioriente_cuentas', 'equioriente_articulos',
        'equioriente_alquileres', 'equioriente_periodos_cuenta', 'equioriente_alquiler_items',
        'equioriente_remitos', 'equioriente_remito_items', 'equioriente_movimientos',
        'equioriente_saldos_periodo', 'equioriente_cobros', 'equioriente_pagos',
        'equioriente_viajes', 'equioriente_flujo_caja', 'equioriente_documentos',
        'equioriente_cotizaciones', 'equioriente_cotizacion_items',
        'equioriente_devoluciones_proveedor', 'equioriente_movimientos_inventario',
        'equioriente_registro_danos'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS equioriente_app ON %I', t);
        EXECUTE format(
            'CREATE POLICY equioriente_app ON %I FOR ALL TO anon, authenticated USING (equioriente_internal.app_ok()) WITH CHECK (equioriente_internal.app_ok())',
            t
        );
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO anon, authenticated, service_role', t);
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I TO anon, authenticated, service_role', t || '_id_seq');
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION equioriente_ajustar_stock(
    p_id    BIGINT,
    p_total INT DEFAULT 0,
    p_disp  INT DEFAULT 0,
    p_dano  INT DEFAULT 0,
    p_alq   INT DEFAULT 0
)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    UPDATE equioriente_articulos
    SET stock_total      = stock_total      + p_total,
        stock_disponible = stock_disponible + p_disp,
        stock_danado     = stock_danado     + p_dano,
        stock_alquilado  = GREATEST(0, stock_alquilado + p_alq)
    WHERE id = p_id;
END;
$$;

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

CREATE OR REPLACE FUNCTION equioriente_top_articulos()
RETURNS TABLE(
    referencia      TEXT,
    nombre          TEXT,
    empresa_externa TEXT,
    veces_alquilado BIGINT,
    total_unidades  BIGINT
) LANGUAGE sql AS $$
    SELECT COALESCE(a.referencia, ''),
           COALESCE(a.nombre, cb.material),
           a.empresa_externa,
           COUNT(DISTINCT cb.periodo_id),
           COALESCE(SUM(cb.cantidad), 0)::BIGINT
    FROM equioriente_cobros cb
    LEFT JOIN equioriente_articulos a ON a.id = cb.articulo_id
    GROUP BY a.id, a.referencia, a.nombre, a.empresa_externa, cb.material
    ORDER BY COALESCE(SUM(cb.cantidad), 0) DESC
    LIMIT 20;
$$;

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
           COUNT(DISTINCT p.id),
           COALESCE(SUM(cb.cantidad), 0)::BIGINT,
           COALESCE(SUM(cb.total), 0)
    FROM equioriente_clientes c
    LEFT JOIN equioriente_cuentas cu ON cu.cliente_id = c.id
    LEFT JOIN equioriente_periodos_cuenta p ON p.cuenta_id = cu.id
    LEFT JOIN equioriente_cobros cb ON cb.periodo_id = p.id
    GROUP BY c.id, c.nombre, c.telefono, c.identificacion
    ORDER BY COALESCE(SUM(cb.total), 0) DESC
    LIMIT 20;
$$;

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
           COUNT(dp.id),
           COALESCE(SUM(dp.dias_reales), 0)::BIGINT,
           COALESCE(SUM(dp.total_costo), 0)
    FROM equioriente_articulos a
    JOIN equioriente_devoluciones_proveedor dp ON dp.articulo_id = a.id
    WHERE a.es_externo = 1
    GROUP BY a.id, a.nombre, a.empresa_externa, a.referencia
    ORDER BY COALESCE(SUM(dp.total_costo), 0) DESC;
$$;

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
    SELECT al.id, c.nombre, c.telefono, al.fecha_salida, al.fecha_devolucion_esperada,
           (CURRENT_DATE - al.fecha_devolucion_esperada::DATE)::INT, al.estado
    FROM equioriente_alquileres al
    JOIN equioriente_clientes c ON c.id = al.cliente_id
    WHERE al.estado IN ('activo', 'parcial')
      AND al.fecha_devolucion_esperada IS NOT NULL
      AND al.fecha_devolucion_esperada <> ''
      AND al.fecha_devolucion_esperada::DATE < CURRENT_DATE
    ORDER BY 6 DESC;
$$;

GRANT EXECUTE ON FUNCTION equioriente_ajustar_stock(BIGINT, INT, INT, INT, INT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION equioriente_articulos_alertas() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION equioriente_top_articulos() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION equioriente_top_clientes() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION equioriente_costos_externos() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION equioriente_morosos() TO anon, authenticated, service_role;
