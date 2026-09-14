/**
 * Identidad: usuarios, contraseñas y sesiones.
 *
 * Hace falta porque la conciliación entre carreras necesita saber quién pide y
 * quién cede. Sin identidad, "el coordinador de ISIC le solicita horas al de
 * TI" no se puede registrar.
 *
 * Todo con `node:crypto`: scrypt para las contraseñas y bytes aleatorios para
 * los tokens de sesión. Sin dependencias externas, igual que el resto.
 */

import crypto from "node:crypto";
import { bd, enTransaccion } from "./bd.js";
import { CON_TLS } from "./config.js";
import { ErrorHttp } from "./http.js";

const COSTO = { N: 16384, r: 8, p: 1 };
const LARGO = 64;

/**
 * Cuánto vale una sesión. Es **el servidor** quien lo decide.
 *
 * La cookie ya llevaba `Max-Age`, pero eso solo le pide al navegador que la
 * borre: quien copie el token entra igual, y sin esta comprobación entraba para
 * siempre. La duración se mide desde que se creó, no desde el último uso: una
 * jornada de coordinación cabe de sobra en doce horas y volver a entrar cuesta
 * nada, mientras que renovar en cada petición haría que un token robado se
 * mantuviera vivo solo,  que es justo lo que hay que evitar.
 */
const HORAS_DE_SESION = 12;
const VIDA_MS = HORAS_DE_SESION * 60 * 60 * 1000;

function derivar(clave, sal) {
    return crypto.scryptSync(clave, sal, LARGO, COSTO).toString("hex");
}

/**
 * Comparación en tiempo constante. Con `===` el tiempo de respuesta depende de
 * cuántos caracteres coinciden, y eso filtra información sobre el hash.
 */
function iguales(a, b) {
    const x = Buffer.from(a, "hex");
    const y = Buffer.from(b, "hex");
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function crearUsuario({
    id, nombre, usuario, clave, rol = "coordinador", carreras = [], debeCambiar = true
}) {
    const sal = crypto.randomBytes(16).toString("hex");

    return enTransaccion((db) => {
        db.prepare(
            `INSERT INTO usuarios (id, nombre, usuario, clave, sal, rol, debe_cambiar_clave)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(id, nombre, usuario, derivar(clave, sal), sal, rol, debeCambiar ? 1 : 0);

        const ins = db.prepare(
            "INSERT OR IGNORE INTO usuario_carrera (usuario_id, carrera) VALUES (?, ?)"
        );
        for (const c of carreras) ins.run(id, c.toUpperCase());
        return { id, usuario, carreras };
    });
}

export function autenticar(usuario, clave) {
    const fila = bd().prepare("SELECT * FROM usuarios WHERE usuario = ?").get(usuario);

    // Se deriva igual aunque el usuario no exista, para que un nombre inválido
    // y una contraseña mala tarden lo mismo y no se puedan distinguir.
    const sal = fila?.sal ?? "00";
    const intento = derivar(clave ?? "", sal);
    if (!fila || !iguales(intento, fila.clave)) {
        throw new ErrorHttp(401, "Usuario o contraseña incorrectos.");
    }

    // Se comprueba después de la contraseña: si se dijera antes, cualquiera
    // podría averiguar qué cuentas existen probando nombres.
    if (fila.activo === 0) {
        throw new ErrorHttp(
            403,
            "Esa cuenta está retirada. Si te toca volver, el departamento académico " +
                "la reactiva dándote una contraseña nueva."
        );
    }

    const token = crypto.randomBytes(32).toString("hex");
    bd()
        .prepare("INSERT INTO sesiones (token, usuario_id, creada) VALUES (?, ?, ?)")
        .run(token, fila.id, new Date().toISOString());

    // Barrer aquí y no en un temporizador: entrar es justo cuando hay una
    // conexión abierta y nadie espera, y evita un proceso de fondo que
    // mantener.
    barrerVencidas();

    return { token, usuario: perfil(fila.id) };
}

/**
 * Requisitos de la contraseña. Deliberadamente mínimos: exigir mayúsculas y
 * símbolos produce contraseñas peores, apuntadas en un papel junto al monitor.
 * Un largo decente es lo que de verdad protege.
 */
const LARGO_MINIMO = 8;

function exigirClaveUsable(clave) {
    if (typeof clave !== "string" || clave.length < LARGO_MINIMO) {
        throw new ErrorHttp(400, `La contraseña necesita al menos ${LARGO_MINIMO} caracteres.`);
    }
}

/**
 * Cambia la contraseña propia. Pide la actual aunque haya sesión iniciada: una
 * sesión abierta en una máquina prestada no debe bastar para quedarse con la
 * cuenta.
 *
 * Cierra las demás sesiones. Si la contraseña se cambia porque alguien más la
 * sabía, dejar viva la sesión de esa persona vacía el cambio de sentido.
 */
export function cambiarClave({ usuarioId, actual, nueva }) {
    exigirClaveUsable(nueva);

    return enTransaccion((db) => {
        const fila = db.prepare("SELECT * FROM usuarios WHERE id = ?").get(usuarioId);
        if (!fila || !iguales(derivar(actual ?? "", fila.sal), fila.clave)) {
            throw new ErrorHttp(403, "La contraseña actual no es correcta.");
        }

        if (iguales(derivar(nueva, fila.sal), fila.clave)) {
            throw new ErrorHttp(400, "La contraseña nueva es la misma que la actual.");
        }

        const sal = crypto.randomBytes(16).toString("hex");
        db.prepare(
            "UPDATE usuarios SET clave = ?, sal = ?, debe_cambiar_clave = 0 WHERE id = ?"
        ).run(derivar(nueva, sal), sal, usuarioId);
        db.prepare("DELETE FROM sesiones WHERE usuario_id = ?").run(usuarioId);
        return { cambiada: true };
    });
}

/**
 * Normaliza y comprueba que las carreras existan.
 *
 * `usuario_carrera` apunta a `carreras(codigo)`, así que una carrera inventada
 * rompe la clave foránea y sale un 500 que no dice nada. Es un dato mal escrito,
 * no un fallo del servidor, y quien lo escribió merece saber cuál.
 */
function carrerasValidas(carreras) {
    const pedidas = (carreras ?? []).map((c) => String(c).toUpperCase());
    if (pedidas.length === 0) return [];

    const existen = new Set(bd().prepare("SELECT codigo FROM carreras").all().map((r) => r.codigo));
    const desconocidas = [...new Set(pedidas)].filter((c) => !existen.has(c));
    if (desconocidas.length > 0) {
        throw new ErrorHttp(400, `No existe la carrera ${desconocidas.join(", ")}.`);
    }
    return [...new Set(pedidas)];
}

/**
 * Alta de un coordinador. Solo el departamento académico: quien decide que
 * alguien coordina una carrera no es otro coordinador.
 */
export function altaUsuario({ nombre, usuario, clave, rol = "coordinador", carreras = [] }) {
    if (!nombre?.trim()) throw new ErrorHttp(400, "Falta el nombre.");
    if (!/^[a-z0-9._-]{3,32}$/i.test(usuario ?? "")) {
        throw new ErrorHttp(400, "El usuario son de 3 a 32 letras, números, punto, guion o guion bajo.");
    }
    exigirClaveUsable(clave);
    if (!["coordinador", "departamento"].includes(rol)) {
        throw new ErrorHttp(400, `Rol desconocido: ${rol}.`);
    }
    const previo = bd()
        .prepare("SELECT activo FROM usuarios WHERE usuario = ?")
        .get(usuario.toLowerCase());
    if (previo) {
        // Retirada y no borrada: quien la buscaba de alta en realidad la quiere
        // de vuelta, y lo que necesita es la contraseña, no una cuenta nueva.
        throw new ErrorHttp(
            409,
            previo.activo === 0
                ? `"${usuario}" existe, pero está retirada. Reactívala dándole una contraseña.`
                : `Ya existe el usuario "${usuario}".`
        );
    }

    return crearUsuario({
        id: `u-${crypto.randomUUID()}`,
        nombre: nombre.trim(),
        usuario: usuario.toLowerCase(),
        clave,
        rol,
        carreras: carrerasValidas(carreras)
    });
}

/**
 * Reinicia la contraseña de otro. Solo el departamento.
 *
 * Sin esto, un coordinador que la olvida deja el sistema sin salida: había que
 * entrar a la base. No se devuelve ninguna contraseña generada —se la dicta
 * quien la pone— y la cuenta queda **obligada a cambiarla**, así que el paso por
 * manos ajenas dura hasta su siguiente entrada. Se cierran sus sesiones: si la
 * olvidó porque alguien más la tenía, dejarlas vivas no arregla nada.
 *
 * Es también la vuelta de una cuenta retirada: reactivarla es exactamente esto
 * —darle una contraseña que solo ella sepa— y no hacía falta otra puerta.
 */
export function reiniciarClave({ usuarioId, nueva }) {
    exigirClaveUsable(nueva);

    return enTransaccion((db) => {
        const fila = db.prepare("SELECT id FROM usuarios WHERE id = ?").get(usuarioId);
        if (!fila) throw new ErrorHttp(404, "Ese usuario no existe.");

        const sal = crypto.randomBytes(16).toString("hex");
        db.prepare(
            "UPDATE usuarios SET clave = ?, sal = ?, debe_cambiar_clave = 1, activo = 1 WHERE id = ?"
        ).run(derivar(nueva, sal), sal, usuarioId);
        db.prepare("DELETE FROM sesiones WHERE usuario_id = ?").run(usuarioId);
        return { reiniciada: true };
    });
}

/**
 * Baja. No borra la fila: `saturacion_historial` y `solicitudes` apuntan a
 * quién hizo cada cosa, y borrarlo dejaría la historia sin autor. Se le quitan
 * las carreras, se cierran sus sesiones y la cuenta queda inactiva.
 *
 * Lo último faltaba: sin carreras no podía abrir nada, pero su contraseña
 * seguía sirviendo y entraba a una pantalla en blanco sin saber por qué.
 * Vuelve con `reiniciarClave`.
 */
export function retirarUsuario(usuarioId) {
    return enTransaccion((db) => {
        if (!db.prepare("SELECT 1 FROM usuarios WHERE id = ?").get(usuarioId)) {
            throw new ErrorHttp(404, "Ese usuario no existe.");
        }
        // Sin departamento no queda quien dé de alta a nadie ni cierre periodos.
        const jefes = db
            .prepare("SELECT count(*) c FROM usuarios WHERE rol = 'departamento'")
            .get().c;
        const suyo = db.prepare("SELECT rol FROM usuarios WHERE id = ?").get(usuarioId).rol;
        if (suyo === "departamento" && jefes <= 1) {
            throw new ErrorHttp(409, "Es la única cuenta de departamento académico: quedaría nadie.");
        }

        const huerfanas = sinOtroCoordinador(db, usuarioId);
        if (huerfanas.length > 0) {
            throw new ErrorHttp(
                409,
                `${huerfanas.join(" y ")} se quedaría sin coordinador. ` +
                    "Asigna la carrera a alguien más antes de retirar a esta persona."
            );
        }

        db.prepare("DELETE FROM usuario_carrera WHERE usuario_id = ?").run(usuarioId);
        db.prepare("DELETE FROM sesiones WHERE usuario_id = ?").run(usuarioId);
        db.prepare("UPDATE usuarios SET activo = 0 WHERE id = ?").run(usuarioId);
        return { retirado: true };
    });
}

/**
 * Carreras que este usuario lleva y nadie más.
 *
 * Una carrera sin coordinador no da error en ninguna parte: simplemente nadie
 * puede abrirla, y el departamento solo se enteraría mirando la tabla. Más vale
 * negarse a retirar que dejar el sistema en ese estado en silencio.
 */
function sinOtroCoordinador(db, usuarioId) {
    return db
        .prepare(
            `SELECT carrera FROM usuario_carrera WHERE usuario_id = ?
               AND carrera NOT IN (
                   SELECT carrera FROM usuario_carrera WHERE usuario_id <> ?
               )
             ORDER BY carrera`
        )
        .all(usuarioId, usuarioId)
        .map((r) => r.carrera);
}

/**
 * Lo mismo para quitarle carreras sin retirarlo: dejar a alguien con una menos
 * puede dejar la carrera sin nadie igual que retirarlo del todo.
 */
function exigirQueNadieQuedeHuerfana(db, usuarioId, futuras) {
    const quedan = new Set(futuras);
    const perdidas = sinOtroCoordinador(db, usuarioId).filter((c) => !quedan.has(c));
    if (perdidas.length > 0) {
        throw new ErrorHttp(
            409,
            `${perdidas.join(" y ")} se quedaría sin coordinador. ` +
                "Asígnala a alguien más antes de quitársela."
        );
    }
}

/** Quiénes hay, con las carreras que llevan. Para la vista del departamento. */
export function listarUsuarios() {
    const db = bd();
    return db
        .prepare(
            `SELECT id, nombre, usuario, rol, activo FROM usuarios
              ORDER BY activo DESC, rol, nombre`
        )
        .all()
        .map((u) => ({
            ...u,
            activo: u.activo === 1,
            carreras: db
                .prepare("SELECT carrera FROM usuario_carrera WHERE usuario_id = ? ORDER BY carrera")
                .all(u.id)
                .map((r) => r.carrera)
        }));
}

/** Reemplaza las carreras de un coordinador. */
export function asignarCarreras(usuarioId, carreras) {
    if (!Array.isArray(carreras)) throw new ErrorHttp(400, "Se esperaba un arreglo de carreras.");
    const validas = carrerasValidas(carreras);

    return enTransaccion((db) => {
        const fila = db.prepare("SELECT activo FROM usuarios WHERE id = ?").get(usuarioId);
        if (!fila) throw new ErrorHttp(404, "Ese usuario no existe.");
        if (fila.activo === 0 && validas.length > 0) {
            throw new ErrorHttp(
                409,
                "Esa cuenta está retirada: no podría abrir la carrera. Reactívala primero."
            );
        }
        exigirQueNadieQuedeHuerfana(db, usuarioId, validas);
        db.prepare("DELETE FROM usuario_carrera WHERE usuario_id = ?").run(usuarioId);
        const ins = db.prepare(
            "INSERT OR IGNORE INTO usuario_carrera (usuario_id, carrera) VALUES (?, ?)"
        );
        for (const c of validas) ins.run(usuarioId, c);
        return { carreras: validas };
    });
}

export function cerrarSesion(token) {
    if (!token) return;
    bd().prepare("DELETE FROM sesiones WHERE token = ?").run(token);
}

export function perfil(usuarioId) {
    const db = bd();
    const fila = db
        .prepare(
            `SELECT id, nombre, usuario, rol, debe_cambiar_clave AS debeCambiarClave
             FROM usuarios WHERE id = ?`
        )
        .get(usuarioId);
    if (!fila) return null;
    fila.debeCambiarClave = fila.debeCambiarClave === 1;

    const carreras = db
        .prepare("SELECT carrera FROM usuario_carrera WHERE usuario_id = ? ORDER BY carrera")
        .all(usuarioId)
        .map((r) => r.carrera);

    return { ...fila, carreras };
}

/** Usuario de una petición, o `null` si no ha iniciado sesión. */
export function usuarioDe(req) {
    const token = tokenDe(req);
    if (!token) return null;

    const sesion = bd()
        .prepare("SELECT usuario_id AS usuarioId, creada FROM sesiones WHERE token = ?")
        .get(token);
    if (!sesion) return null;

    if (venció(sesion.creada)) {
        // Se borra al encontrarla: si llegó hasta aquí es que alguien todavía
        // la está usando, y dejarla sería dejar viva una credencial caducada.
        bd().prepare("DELETE FROM sesiones WHERE token = ?").run(token);
        return null;
    }
    return perfil(sesion.usuarioId);
}

function venció(creada) {
    const nacida = Date.parse(creada);
    // Una fecha ilegible no puede comprobarse, así que no se acepta.
    return !Number.isFinite(nacida) || Date.now() - nacida >= VIDA_MS;
}

/** Borra de la tabla lo que ya no vale. Sin esto crece sin fin. */
export function barrerVencidas() {
    const limite = new Date(Date.now() - VIDA_MS).toISOString();
    return bd().prepare("DELETE FROM sesiones WHERE creada <= ?").run(limite).changes;
}

export function tokenDe(req) {
    const cookies = req.headers.cookie ?? "";
    const encontrada = cookies
        .split(";")
        .map((c) => c.trim().split("="))
        .find(([nombre]) => nombre === "sesion");
    return encontrada?.[1] ?? null;
}

export function cabeceraDeSesion(token) {
    // HttpOnly: el token no debe ser legible desde JavaScript. SameSite=Lax
    // evita que otro sitio dispare peticiones con esta sesión. `Secure` solo
    // cuando hay TLS: puesto sobre http:// el navegador descarta la cookie y
    // nadie puede entrar, así que se activa por entorno y no por omisión.
    const seguro = CON_TLS ? "; Secure" : "";
    return `sesion=${token}; HttpOnly; SameSite=Lax; Path=/${seguro}; Max-Age=${VIDA_MS / 1000}`;
}

export function cabeceraDeCierre() {
    return `sesion=; HttpOnly; SameSite=Lax; Path=/${CON_TLS ? "; Secure" : ""}; Max-Age=0`;
}

/** Comprueba que el usuario lleve esa carrera. La saturación se ve completa. */
export function exigirCarrera(usuario, carrera) {
    if (!usuario) throw new ErrorHttp(401, "Hay que iniciar sesión.");
    if (usuario.rol === "departamento") return;
    if (!usuario.carreras.includes(String(carrera).toUpperCase())) {
        throw new ErrorHttp(403, `No coordinas ${carrera}.`);
    }
}

export function hayUsuarios() {
    return bd().prepare("SELECT count(*) c FROM usuarios").get().c > 0;
}
