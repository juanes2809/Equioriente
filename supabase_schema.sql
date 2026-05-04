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
--  Datos iniciales (contraseña por defecto: 1234, hasheada con bcrypt)
-- ════════════════════════════════════════════════════════════
INSERT INTO equioriente_categorias (nombre) VALUES ('General') ON CONFLICT DO NOTHING;

-- Los usuarios admin/operario se crean automáticamente al iniciar el servidor
-- con DATABASE_URL configurado, o puedes crearlos aquí con su hash bcrypt.
