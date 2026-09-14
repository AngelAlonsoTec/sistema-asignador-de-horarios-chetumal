/**
 * Base de datos: esquema y conexión.
 *
 * Se pasó de archivos JSON a SQLite porque el sistema deja de tener un solo
 * usuario. Con varios coordinadores tocando la misma plantilla docente, dos
 * guardados sobre el mismo archivo se pisan y el último gana en silencio; aquí
 * hay transacciones.
 *
 * `node:sqlite` viene en Node 22+ y no añade dependencias: la política de cero
 * paquetes externos del backend se mantiene, y el archivo `.db` sigue siendo tan
 * portable como los JSON que sustituye.
 *
 * La API es **síncrona**. Bloquea el hilo, pero las consultas son de un archivo
 * local y de unos cuantos kilobytes: el costo real es menor que el de coordinar
 * promesas, y a cambio las transacciones se leen de arriba abajo.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { DATOS } from "./config.js";

const ESQUEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- instituto

CREATE TABLE IF NOT EXISTS carreras (
    codigo TEXT PRIMARY KEY,
    nombre TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS docentes (
    id             TEXT PRIMARY KEY,
    nombre         TEXT NOT NULL,
    categoria      TEXT NOT NULL,
    nivel          TEXT,
    horas_min      INTEGER NOT NULL DEFAULT 0,
    horas_max      INTEGER NOT NULL DEFAULT 40,
    max_materias   INTEGER NOT NULL DEFAULT 99,
    max_grupos     INTEGER NOT NULL DEFAULT 99,
    antiguedad     INTEGER,
    carrera_base   TEXT,
    es_de_otra_area INTEGER NOT NULL DEFAULT 0
);

-- Bloques declarados en el formulario de disponibilidad y los que prefiere
-- evitar. Se separan por 'tipo' en vez de en dos tablas: misma forma, mismo uso.
CREATE TABLE IF NOT EXISTS docente_horario (
    docente_id TEXT NOT NULL REFERENCES docentes(id) ON DELETE CASCADE,
    tipo       TEXT NOT NULL CHECK (tipo IN ('declarada', 'evitar')),
    dia        TEXT NOT NULL,
    inicio     INTEGER NOT NULL,
    fin        INTEGER NOT NULL
);

-- Las carga el departamento académico; ni el coordinador ni el docente.
CREATE TABLE IF NOT EXISTS docente_descarga (
    docente_id TEXT NOT NULL REFERENCES docentes(id) ON DELETE CASCADE,
    dia        TEXT NOT NULL,
    inicio     INTEGER NOT NULL,
    fin        INTEGER NOT NULL,
    motivo     TEXT
);

-- Autorización materia-docente: la define el departamento académico.
CREATE TABLE IF NOT EXISTS docente_materia (
    docente_id TEXT NOT NULL REFERENCES docentes(id) ON DELETE CASCADE,
    materia_id TEXT NOT NULL,
    PRIMARY KEY (docente_id, materia_id)
);

-- ---------------------------------------------------------------- carrera

-- Los espacios son del plantel, no de una carrera: el mismo salón lo usan
-- varias, y tener un juego por carrera significaba no poder detectar que dos
-- lo ocupan a la misma hora.
CREATE TABLE IF NOT EXISTS aulas (
    id        TEXT PRIMARY KEY,
    clave     TEXT NOT NULL,
    tipo      TEXT NOT NULL DEFAULT 'aula',
    capacidad INTEGER
);

CREATE TABLE IF NOT EXISTS escenarios (
    carrera TEXT NOT NULL REFERENCES carreras(codigo) ON DELETE CASCADE,
    id      TEXT NOT NULL,
    nombre  TEXT NOT NULL,
    fecha   TEXT NOT NULL,
    es_base INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (carrera, id)
);

CREATE TABLE IF NOT EXISTS materias (
    carrera        TEXT NOT NULL,
    escenario_id   TEXT NOT NULL,
    id             TEXT NOT NULL,
    clave          TEXT NOT NULL,
    nombre         TEXT NOT NULL,
    semestre       INTEGER NOT NULL,
    horas_semana   INTEGER NOT NULL,
    creditos       INTEGER,
    especialidad_id TEXT,
    requiere_laboratorio INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (carrera, escenario_id, id),
    FOREIGN KEY (carrera, escenario_id) REFERENCES escenarios(carrera, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS especialidades (
    carrera      TEXT NOT NULL,
    escenario_id TEXT NOT NULL,
    id           TEXT NOT NULL,
    nombre       TEXT NOT NULL,
    PRIMARY KEY (carrera, escenario_id, id),
    FOREIGN KEY (carrera, escenario_id) REFERENCES escenarios(carrera, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS semestres (
    carrera      TEXT NOT NULL,
    escenario_id TEXT NOT NULL,
    id           TEXT NOT NULL,
    periodo      TEXT NOT NULL,
    semanas      INTEGER,
    turnos       TEXT NOT NULL DEFAULT '[]',
    estado       TEXT,
    PRIMARY KEY (carrera, escenario_id, id),
    FOREIGN KEY (carrera, escenario_id) REFERENCES escenarios(carrera, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- saturación

CREATE TABLE IF NOT EXISTS saturacion (
    carrera       TEXT NOT NULL,
    escenario_id  TEXT NOT NULL,
    periodo       TEXT,
    paridad       TEXT,
    docente_id    TEXT NOT NULL REFERENCES docentes(id) ON DELETE CASCADE,
    dia           TEXT NOT NULL,
    inicio        INTEGER NOT NULL,
    fin           INTEGER NOT NULL,
    grupo_clave   TEXT,
    materia_clave TEXT,
    aula_id       TEXT
);

CREATE INDEX IF NOT EXISTS idx_saturacion_docente ON saturacion(docente_id, paridad);
CREATE INDEX IF NOT EXISTS idx_saturacion_duenio ON saturacion(carrera, escenario_id);

-- Quién tuvo cada hora antes. La saturación dice quién la tiene ahora; sin
-- esto, "pero si tú me la habías cedido" no se puede resolver.
CREATE TABLE IF NOT EXISTS saturacion_historial (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    momento       TEXT NOT NULL,
    accion        TEXT NOT NULL CHECK (accion IN ('apartada', 'liberada', 'cedida')),
    carrera       TEXT NOT NULL,
    escenario_id  TEXT NOT NULL,
    paridad       TEXT,
    docente_id    TEXT NOT NULL,
    dia           TEXT NOT NULL,
    inicio        INTEGER NOT NULL,
    fin           INTEGER NOT NULL,
    grupo_clave   TEXT,
    materia_clave TEXT,
    usuario_id    TEXT,
    nota          TEXT
);

CREATE INDEX IF NOT EXISTS idx_historial_docente ON saturacion_historial(docente_id, momento);

/*
 * Quién ha impartido cada clase antes de quien la imparte ahora.
 *
 * Las horas ya tenían su historia en 'saturacion_historial' y las decisiones no,
 * así que a la pregunta "¿quién cambió a Laura por Ricardo, y cuándo?" no
 * contestaba nadie. Es apéndice: se escribe y no se edita.
 *
 * 'antes' y 'despues' guardan el id del docente, nulo cuando la clase quedó o
 * estaba sin asignar. Sin clave foránea a propósito, por lo mismo que en
 * 'peticion_cambio': dar de baja a alguien no debe borrar la constancia de que
 * impartió una clase.
 */
CREATE TABLE IF NOT EXISTS asignacion_historial (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    momento     TEXT NOT NULL,
    accion      TEXT NOT NULL CHECK (accion IN ('asignada', 'cambiada', 'retirada')),
    carrera     TEXT NOT NULL,
    materia_id  TEXT NOT NULL,
    grupo_clave TEXT NOT NULL,
    antes       TEXT,
    despues     TEXT,
    usuario_id  TEXT,
    nota        TEXT
);

CREATE INDEX IF NOT EXISTS idx_asig_hist_clase
    ON asignacion_historial(carrera, materia_id, grupo_clave, momento);

-- Periodo cerrado: lo conciliado deja de ser borrador y nadie lo mueve.
-- Permiso para meter el escenario de otra carrera en un horario conjunto.
--
-- Generar un horario multi-carrera es decidir el de todas, así que hasta aquí
-- exigía que una sola persona las coordinara. Cuando son dos personas hace falta
-- que la invitada diga que sí: es una decisión suya sobre su propia carrera, no
-- una hora que se negocia.
--
-- Se revoca soltando las horas: si la invitada libera su reserva, el horario
-- conjunto deja de sostenerse y ambas lo ven desfasado. El permiso no caduca
-- solo, pero se puede retirar.
CREATE TABLE IF NOT EXISTS invitacion_conjunta (
    id            TEXT PRIMARY KEY,
    creada        TEXT NOT NULL,
    estado        TEXT NOT NULL DEFAULT 'pendiente'
                  CHECK (estado IN ('pendiente', 'aceptada', 'rechazada')),
    anfitriona    TEXT NOT NULL,
    invitada      TEXT NOT NULL,
    escenario_id  TEXT NOT NULL,
    de_usuario    TEXT,
    respondida    TEXT,
    respuesta     TEXT
);

CREATE INDEX IF NOT EXISTS idx_invitacion_par
    ON invitacion_conjunta(anfitriona, invitada, estado);

-- Lo que el coordinador eligió antes de generar: paridad, cuántos grupos abre
-- cada semestre y qué materias fusiona.
--
-- Se guardaba el horario y no lo que lo produjo: al volver, el horario apartado
-- aparecía pero las casillas de fusión estaban en cero y los grupos vueltos a
-- la sugerencia. Pulsar "Generar" daba algo distinto sin avisar.
--
-- Es un documento y no columnas por la misma razón que 'horario': se escribe
-- entero, se lee entero, y nadie consulta dentro.
CREATE TABLE IF NOT EXISTS escenario_config (
    carrera      TEXT NOT NULL,
    escenario_id TEXT NOT NULL,
    guardada     TEXT NOT NULL,
    documento    TEXT NOT NULL,
    PRIMARY KEY (carrera, escenario_id),
    FOREIGN KEY (carrera, escenario_id) REFERENCES escenarios(carrera, id) ON DELETE CASCADE
);

-- Quién imparte cada materia a cada grupo. Lo decide el departamento.
--
-- Es una **asignación**, no una lista de capaces: el departamento no dice
-- "estos cinco podrían dar Cálculo", dice "a 1A se lo da Laura". Por grupo y no
-- por materia porque una materia con tres grupos puede repartirse entre varias
-- personas, o darla una sola: los dos casos existen.
--
-- La misma persona asignada en dos carreras son dos decisiones independientes.
-- Lo que no es independiente es la carga que acumula, y para verla está la vista
-- de saturación: por eso la asignación no lleva horas. Las horas las reparte el
-- coordinador con el generador.
--
-- El grupo se nombra por su clave ("1A") y no por id: los grupos no se guardan,
-- se derivan de la configuración del escenario, y la clave es lo estable.
--
-- **No lleva escenario.** Un escenario es una variante para probar cambios; la
-- asignación es la decisión del periodo. Colgarla del escenario hacía que el
-- departamento asignara en uno y el coordinador generara en otro, con el motor
-- ignorando lo asignado sin decir nada.
CREATE TABLE IF NOT EXISTS asignacion (
    carrera      TEXT NOT NULL,
    materia_id   TEXT NOT NULL,
    grupo_clave  TEXT NOT NULL,
    docente_id   TEXT NOT NULL REFERENCES docentes(id) ON DELETE CASCADE,
    PRIMARY KEY (carrera, materia_id, grupo_clave),
    FOREIGN KEY (carrera) REFERENCES carreras(codigo) ON DELETE CASCADE
);


-- Prioridad que un coordinador le da a un docente dentro de SU carrera.
--
-- Es un juicio, no un dato del docente: por eso cuelga de la carrera y no de la
-- plantilla institucional. Que ISIC priorice a alguien no se lo impone a ITIC,
-- igual que un escenario de ISIC no decide los grupos de ITIC. Sin fila, la
-- prioridad es 0, que es lo normal.
CREATE TABLE IF NOT EXISTS docente_prioridad (
    carrera    TEXT NOT NULL REFERENCES carreras(codigo) ON DELETE CASCADE,
    docente_id TEXT NOT NULL REFERENCES docentes(id) ON DELETE CASCADE,
    prioridad  INTEGER NOT NULL DEFAULT 0,
    nota       TEXT,
    PRIMARY KEY (carrera, docente_id)
);

-- El horario que un escenario apartó, tal como se generó.
--
-- La tabla 'saturacion' guarda la proyección que las demás carreras necesitan:
-- qué hora de qué docente está tomada. No alcanza para volver a dibujar el
-- horario: le faltan los grupos (que viajan en la petición y no se guardaban en
-- ningún lado), la pertenencia a una fusión y el diagnóstico. Sin esto, apartar
-- y cerrar la pestaña perdía el horario, y regenerar con otra semilla daba uno
-- distinto del que se apartó.
--
-- Se guarda como documento y no en columnas a propósito: la vista consultable
-- ya existe en 'saturacion', y repetirla campo por campo daría dos verdades
-- relacionales que se separan. Esto se escribe entero y se lee entero.
CREATE TABLE IF NOT EXISTS horario (
    carrera      TEXT NOT NULL,
    escenario_id TEXT NOT NULL,
    paridad      TEXT,
    guardado     TEXT NOT NULL,
    usuario_id   TEXT,
    documento    TEXT NOT NULL,
    PRIMARY KEY (carrera, escenario_id)
);

CREATE TABLE IF NOT EXISTS periodos_cerrados (
    paridad TEXT PRIMARY KEY,
    cerrado TEXT NOT NULL,
    por     TEXT
);

-- ---------------------------------------------------------------- identidad

CREATE TABLE IF NOT EXISTS usuarios (
    id     TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    usuario TEXT NOT NULL UNIQUE,
    clave  TEXT NOT NULL,
    sal    TEXT NOT NULL,
    rol    TEXT NOT NULL DEFAULT 'coordinador'
);

-- Un coordinador puede llevar de una a varias carreras.
CREATE TABLE IF NOT EXISTS usuario_carrera (
    usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    carrera    TEXT NOT NULL REFERENCES carreras(codigo) ON DELETE CASCADE,
    PRIMARY KEY (usuario_id, carrera)
);

-- Enlace personal para que el docente declare su disponibilidad sin tener
-- cuenta. El token es la credencial: largo, aleatorio y revocable.
CREATE TABLE IF NOT EXISTS docente_token (
    docente_id TEXT PRIMARY KEY REFERENCES docentes(id) ON DELETE CASCADE,
    token      TEXT NOT NULL UNIQUE,
    creado     TEXT NOT NULL,
    contestado TEXT
);

-- Petición de horas entre coordinadores: la conversación de pasillo, con
-- registro. Quien pide, a quién, qué horas y con qué motivo.
CREATE TABLE IF NOT EXISTS solicitudes (
    id            TEXT PRIMARY KEY,
    creada        TEXT NOT NULL,
    estado        TEXT NOT NULL DEFAULT 'pendiente'
                  CHECK (estado IN ('pendiente', 'aceptada', 'rechazada')),
    de_carrera    TEXT NOT NULL,
    de_escenario  TEXT NOT NULL,
    de_usuario    TEXT,
    a_carrera     TEXT NOT NULL,
    a_escenario   TEXT NOT NULL,
    docente_id    TEXT NOT NULL,
    dia           TEXT NOT NULL,
    inicio        INTEGER NOT NULL,
    fin           INTEGER NOT NULL,
    motivo        TEXT,
    respuesta     TEXT,
    respondida    TEXT
);

/*
 * Lo que una coordinación le pide al departamento sobre **quién imparte** una
 * clase. Es deliberadamente distinto de 'solicitudes': aquella se negocia entre
 * coordinaciones y va de horas concretas; esta sube al departamento y va de una
 * decisión suya. Sin este canal, el coordinador que necesitaba otro docente se
 * quedaba con un mensaje que le decía que lo pidiera y ningún sitio donde
 * hacerlo.
 *
 * 'actual' y 'propuesto' no llevan clave foránea a propósito: son el registro de
 * lo que se pidió, y dar de baja a alguien no debería borrar la petición que
 * explica por qué se le quitó una clase.
 */
CREATE TABLE IF NOT EXISTS peticion_cambio (
    id           TEXT PRIMARY KEY,
    creada       TEXT NOT NULL,
    estado       TEXT NOT NULL DEFAULT 'pendiente'
                 CHECK (estado IN ('pendiente', 'aceptada', 'rechazada')),
    carrera      TEXT NOT NULL REFERENCES carreras(codigo) ON DELETE CASCADE,
    materia_id   TEXT NOT NULL,
    materia      TEXT,
    grupo_clave  TEXT NOT NULL,
    de_usuario   TEXT,
    actual       TEXT,
    propuesto    TEXT,
    motivo       TEXT,
    respuesta    TEXT,
    respondida   TEXT
);

CREATE INDEX IF NOT EXISTS idx_solicitudes_destino ON solicitudes(a_carrera, estado);
CREATE INDEX IF NOT EXISTS idx_solicitudes_origen ON solicitudes(de_carrera, estado);

CREATE TABLE IF NOT EXISTS sesiones (
    token      TEXT PRIMARY KEY,
    usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    creada     TEXT NOT NULL
);
`;

let conexion = null;

/**
 * Columnas añadidas después de la primera versión del esquema.
 *
 * `CREATE TABLE IF NOT EXISTS` no toca una tabla que ya existe, así que una
 * columna nueva no aparece sola en bases ya creadas. Esto la agrega si falta, y
 * es idempotente: correrlo dos veces no hace nada la segunda.
 */
const COLUMNAS_NUEVAS = [
    ["saturacion", "aula_id", "TEXT"],
    ["aulas", "capacidad", "INTEGER"],
    // Las cuentas nacen con una contraseña que alguien más eligió y dictó de
    // viva voz. Mientras no se cambie, quien la dictó puede entrar.
    //
    // El tercer elemento corre **solo la vez que la columna se añade**. Sin él
    // las cuentas que ya existían quedarían exentas, que son precisamente las
    // que comparten la contraseña de arranque.
    // Dedicación del nombramiento: es lo que decide cuántas horas frente a grupo
    // le tocan según el artículo 143 del Reglamento Interior de Trabajo. Sin
    // ella la categoría sola no dice nada: un titular de tiempo completo da 22
    // horas y uno de medio tiempo, 12.
    //
    // Al añadirla se deduce de lo que ya había: quien es de asignatura lo es, y
    // del resto se supone tiempo completo, que es el caso más común. Es una
    // suposición y por eso la pantalla la marca para revisarla.
    [
        "docentes",
        "dedicacion",
        "TEXT",
        `UPDATE docentes SET dedicacion =
             CASE WHEN lower(categoria) = 'asignatura' THEN 'asignatura'
                  ELSE 'tiempo completo' END`
    ],
    [
        "usuarios",
        "debe_cambiar_clave",
        "INTEGER NOT NULL DEFAULT 0",
        "UPDATE usuarios SET debe_cambiar_clave = 1"
    ],
    // Retirar a alguien no borra su cuenta: el historial de asignaciones y las
    // solicitudes guardan quién hizo cada cosa. Pero mientras la fila siguiera
    // siendo indistinguible de una activa, la persona retirada seguía entrando
    // —a una pantalla vacía— y el departamento no veía a quién había retirado.
    ["usuarios", "activo", "INTEGER NOT NULL DEFAULT 1"]
];

/**
 * Cambios que no caben en un `ALTER TABLE ADD COLUMN`.
 *
 * Cada uno dice cómo saber si ya se aplicó y qué correr si no. Se rehace la
 * tabla entera porque SQLite no sabe quitar una columna de una clave primaria.
 */
const MIGRACIONES = [
    {
        // 'solicitudes' nació solo para horas de docente. Pedir un salón es la
        // misma conversación —quien lo tiene cede o no— sobre el otro recurso
        // compartido, así que va en la misma tabla y no en una paralela. Hace
        // falta rehacerla porque SQLite no sabe quitar un NOT NULL.
        nombre: "solicitudes tambien de aulas",
        pendiente: (db) =>
            !db
                .prepare("PRAGMA table_info(solicitudes)")
                .all()
                .some((c) => c.name === "aula_id"),
        aplicar: (db) => {
            db.exec(`
                CREATE TABLE solicitudes_nueva (
                    id            TEXT PRIMARY KEY,
                    creada        TEXT NOT NULL,
                    estado        TEXT NOT NULL DEFAULT 'pendiente'
                                  CHECK (estado IN ('pendiente', 'aceptada', 'rechazada')),
                    de_carrera    TEXT NOT NULL,
                    de_escenario  TEXT NOT NULL,
                    de_usuario    TEXT,
                    a_carrera     TEXT NOT NULL,
                    a_escenario   TEXT NOT NULL,
                    docente_id    TEXT,
                    aula_id       TEXT,
                    dia           TEXT NOT NULL,
                    inicio        INTEGER NOT NULL,
                    fin           INTEGER NOT NULL,
                    motivo        TEXT,
                    respuesta     TEXT,
                    respondida    TEXT,
                    -- Una solicitud es de una hora de docente o de una de aula,
                    -- nunca de las dos ni de ninguna.
                    CHECK ((docente_id IS NULL) <> (aula_id IS NULL))
                );
                INSERT INTO solicitudes_nueva
                    (id, creada, estado, de_carrera, de_escenario, de_usuario,
                     a_carrera, a_escenario, docente_id, dia, inicio, fin,
                     motivo, respuesta, respondida)
                    SELECT id, creada, estado, de_carrera, de_escenario, de_usuario,
                           a_carrera, a_escenario, docente_id, dia, inicio, fin,
                           motivo, respuesta, respondida
                    FROM solicitudes;
                DROP TABLE solicitudes;
                ALTER TABLE solicitudes_nueva RENAME TO solicitudes;
            `);
        }
    },
    {
        // `asignacion` nació con el escenario en la clave, y estaba mal: el
        // departamento reparte para el periodo, no para un "qué pasaría si".
        // Con el escenario dentro, una asignación hecha en el base no la veía
        // el coordinador que trabajaba en una variante.
        nombre: "asignacion sin escenario",
        pendiente: (db) =>
            db
                .prepare("PRAGMA table_info(asignacion)")
                .all()
                .some((c) => c.name === "escenario_id"),
        aplicar: (db) => {
            db.exec(`
                CREATE TABLE asignacion_nueva (
                    carrera      TEXT NOT NULL,
                    materia_id   TEXT NOT NULL,
                    grupo_clave  TEXT NOT NULL,
                    docente_id   TEXT NOT NULL REFERENCES docentes(id) ON DELETE CASCADE,
                    PRIMARY KEY (carrera, materia_id, grupo_clave),
                    FOREIGN KEY (carrera) REFERENCES carreras(codigo) ON DELETE CASCADE
                );
                INSERT INTO asignacion_nueva (carrera, materia_id, grupo_clave, docente_id)
                    SELECT carrera, materia_id, grupo_clave, docente_id
                    FROM asignacion
                    GROUP BY carrera, materia_id, grupo_clave;
                DROP TABLE asignacion;
                ALTER TABLE asignacion_nueva RENAME TO asignacion;
            `);
        }
    }
];

const INDICES_TARDIOS = [
    "CREATE INDEX IF NOT EXISTS idx_saturacion_aula ON saturacion(aula_id, paridad)",
    // Va aquí y no en el esquema porque rehacer `asignacion` se lleva el índice
    // por delante: los índices se crean después de migrar, no antes.
    "CREATE INDEX IF NOT EXISTS idx_asignacion_docente ON asignacion(docente_id)",
    "CREATE INDEX IF NOT EXISTS idx_peticion_estado ON peticion_cambio(estado, carrera)",
    // Los de 'solicitudes' se rehacen con la tabla, así que se crean aquí.
    "CREATE INDEX IF NOT EXISTS idx_solicitudes_destino ON solicitudes(a_carrera, estado)",
    "CREATE INDEX IF NOT EXISTS idx_solicitudes_origen ON solicitudes(de_carrera, estado)"
];

function migrarEsquema(db) {
    for (const [tabla, columna, tipo, alAñadir] of COLUMNAS_NUEVAS) {
        const existe = db
            .prepare(`PRAGMA table_info(${tabla})`)
            .all()
            .some((c) => c.name === columna);
        if (existe) continue;

        db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${tipo}`);
        if (alAñadir) db.exec(alAñadir);
    }
    for (const m of MIGRACIONES) {
        if (m.pendiente(db)) m.aplicar(db);
    }
    for (const sql of INDICES_TARDIOS) db.exec(sql);
}

export function bd() {
    if (conexion) return conexion;

    fs.mkdirSync(DATOS, { recursive: true });
    conexion = new DatabaseSync(path.join(DATOS, "schedulai.db"));
    conexion.exec(ESQUEMA);
    migrarEsquema(conexion);
    return conexion;
}

/**
 * Alta o renombre de una carrera.
 *
 * Existe para que nadie vuelva a escribir `INSERT OR REPLACE INTO carreras`.
 * Ese verbo **borra y reinserta** la fila, y varias tablas apuntan a
 * `carreras(codigo)` con `ON DELETE CASCADE`: reemplazar una carrera para
 * corregirle el nombre se llevaría por delante a sus coordinadores
 * (`usuario_carrera`) sin decir nada. `ON CONFLICT DO UPDATE` actualiza en
 * sitio y no dispara la cascada.
 */
export function guardarCarrera(db, codigo, nombre) {
    db.prepare(
        `INSERT INTO carreras (codigo, nombre) VALUES (?, ?)
         ON CONFLICT(codigo) DO UPDATE SET nombre = excluded.nombre`
    ).run(codigo, nombre);
}

/**
 * Corre `accion` dentro de una transacción. Es lo que hace que dos
 * coordinadores guardando a la vez no se pisen: o entra todo, o no entra nada.
 */
export function enTransaccion(accion) {
    const db = bd();
    db.exec("BEGIN");
    try {
        const salida = accion(db);
        db.exec("COMMIT");
        return salida;
    } catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
}

export function cerrar() {
    conexion?.close();
    conexion = null;
}
