/**
 * Pruebas que necesitan base real. Corren sobre una carpeta temporal, así que
 * no tocan `backend/data/`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.DATOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "schedulai-test-"));

const { bd, guardarCarrera, enTransaccion } = await import("../src/bd.js");
const { crearUsuario, perfil } = await import("../src/auth.js");
const saturacion = await import("../src/saturacion.js");

function docente(id, nombre) {
    bd().prepare(
        "INSERT INTO docentes (id, nombre, categoria) VALUES (?, ?, 'Titular')"
    ).run(id, nombre);
}

/**
 * Autoriza a alguien para una materia, que es lo que el departamento hace antes
 * de repartirla: sin la autorización, asignarla se rechaza.
 */
function autorizar(docenteId, materiaId) {
    bd().prepare(
        "INSERT OR IGNORE INTO docente_materia (docente_id, materia_id) VALUES (?, ?)"
    ).run(docenteId, materiaId);
}

// ------------------------------------------------------------------ respaldos

test("un respaldo se revisa antes de restaurarlo, y uno inservible se rechaza", async () => {
    const { revisar, restaurar, disponibles } = await import("../herramientas/restaurar.js");
    const { respaldar } = await import("../herramientas/respaldar.js");

    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "schedulai-resp-"));
    guardarCarrera(bd(), "RES", "Carrera de respaldo");
    const { archivo } = respaldar({ destino: carpeta, conservar: 0 });

    const r = revisar(archivo);
    assert.equal(r.integridad, "ok");
    assert.equal(r.servible, true);
    assert.deepEqual(r.faltan, []);
    assert.ok(r.conteos.carreras >= 1, "tiene que contar lo que trae dentro");
    assert.ok(disponibles(carpeta).some((x) => x.ruta === archivo));

    // Un archivo que no es una base de SchedulAI no se restaura: dejaría el
    // servicio sin arrancar, que es peor que la pérdida que motivó restaurar.
    const impostor = path.join(carpeta, "impostor.db");
    const otra = new DatabaseSync(impostor);
    otra.exec("CREATE TABLE cualquiera (x INTEGER)");
    otra.close();
    assert.equal(revisar(impostor).servible, false);
    assert.ok(revisar(impostor).faltan.includes("usuarios"));
    assert.throws(
        () => restaurar({ origen: impostor, destino: path.join(carpeta, "destino.db"), carpetaPrevia: carpeta }),
        /no sirve/
    );

    // Y uno que no existe se nombra en vez de fallar de forma opaca.
    assert.throws(() => revisar(path.join(carpeta, "fantasma.db")), /No existe/);
});

test("restaurar aparta lo que reemplaza y no deja el diario de la base vieja", async () => {
    const { restaurar } = await import("../herramientas/restaurar.js");
    const { respaldar } = await import("../herramientas/respaldar.js");

    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "schedulai-resp2-"));
    const { archivo } = respaldar({ destino: carpeta, conservar: 0 });

    // Un destino con contenido distinto y con `-wal`/`-shm` al lado: es el
    // estado normal de una base que estuvo abierta.
    const destino = path.join(carpeta, "vigente.db");
    const antes = new DatabaseSync(destino);
    antes.exec("CREATE TABLE marca (x TEXT)");
    antes.exec("INSERT INTO marca VALUES ('la vieja')");
    antes.close();
    fs.writeFileSync(`${destino}-wal`, "diario viejo");
    fs.writeFileSync(`${destino}-shm`, "");

    const hecho = restaurar({ origen: archivo, destino, carpetaPrevia: carpeta });

    assert.ok(fs.existsSync(hecho.previa), "la base anterior tiene que quedar guardada");
    // Con el prefijo de los demás: si no, no entra en la rotación y se acumula.
    assert.match(path.basename(hecho.previa), /^schedulai-/);
    assert.equal(hecho.restaurado.servible, true);
    // Lo más fácil de olvidar restaurando SQLite a mano: el diario de la base
    // anterior junto a un archivo nuevo mezcla dos historias.
    assert.ok(!fs.existsSync(`${destino}-wal`), "el -wal viejo tiene que irse");
    assert.ok(!fs.existsSync(`${destino}-shm`), "el -shm viejo tiene que irse");

    // Y lo apartado se puede volver a leer: deshacer la restauración es posible.
    const previa = new DatabaseSync(hecho.previa, { readOnly: true });
    assert.equal(previa.prepare("SELECT x FROM marca").get().x, "la vieja");
    previa.close();
});

// ------------------------------------------------------------------ plantilla

test("guardar la plantilla docente no se lleva el reparto ni las prioridades", async () => {
    const almacen = await import("../src/almacen.js");
    const catalogo = await import("../src/catalogo.js");
    const prioridad = await import("../src/prioridad.js");
    const db = bd();
    guardarCarrera(db, "PLT", "Carrera de plantilla");

    const plantilla = [
        { id: "p1", nombre: "Uno", categoria: "Titular", materiasCapacitadas: ["m1"] },
        { id: "p2", nombre: "Dos", categoria: "Titular", materiasCapacitadas: [] }
    ];
    await almacen.guardarDocentes(plantilla);
    enTransaccion((tx) =>
        catalogo.asignar(tx, { carrera: "PLT", materiaId: "m1", grupoClave: "1A", docenteId: "p1" })
    );
    prioridad.guardar("PLT", [{ docenteId: "p1", prioridad: 2 }]);

    // Lo más rutinario que hace el departamento: reabrir la plantilla y guardar.
    await almacen.guardarDocentes(plantilla);

    assert.equal(catalogo.mapaDe("PLT").get("m1|1A"), "p1",
        "guardar la plantilla borró la asignación del departamento");
    assert.equal(prioridad.mapaDe("PLT").get("p1"), 2,
        "guardar la plantilla borró la prioridad del coordinador");

    // Pero quitarlo de la lista mientras tiene clases no se hace en silencio:
    // el reparto es de otra persona y el aviso dice cuánto hay que soltar.
    await assert.rejects(
        () => almacen.guardarDocentes(plantilla.filter((d) => d.id !== "p1")),
        /Uno tiene 1 clase asignada/
    );
    assert.equal(catalogo.mapaDe("PLT").get("m1|1A"), "p1", "y no se fue a medias");

    // Soltado el reparto, la baja procede y se lleva lo suyo.
    enTransaccion((tx) =>
        catalogo.asignar(tx, { carrera: "PLT", materiaId: "m1", grupoClave: "1A", docenteId: null })
    );
    await almacen.guardarDocentes(plantilla.filter((d) => d.id !== "p1"));
    assert.equal(catalogo.mapaDe("PLT").size, 0);
    assert.equal(prioridad.mapaDe("PLT").size, 0);
});

// ------------------------------------------------------------------ carreras

test("renombrar una carrera no se lleva a sus coordinadores", () => {
    const db = bd();
    guardarCarrera(db, "AAA", "Nombre viejo");
    crearUsuario({ id: "u1", nombre: "Coord", usuario: "c1", clave: "x", carreras: ["AAA"] });

    guardarCarrera(db, "AAA", "Nombre nuevo");

    assert.equal(db.prepare("SELECT nombre FROM carreras WHERE codigo = 'AAA'").get().nombre,
        "Nombre nuevo");
    assert.deepEqual(perfil("u1").carreras, ["AAA"]);
});

test("INSERT OR REPLACE sobre carreras sí borra en cascada: por eso no se usa", () => {
    const db = bd();
    guardarCarrera(db, "BBB", "Otra");
    crearUsuario({ id: "u2", nombre: "Coord", usuario: "c2", clave: "x", carreras: ["BBB"] });

    db.prepare("INSERT OR REPLACE INTO carreras (codigo, nombre) VALUES (?, ?)")
        .run("BBB", "Otra renombrada");

    // Documenta la trampa que `guardarCarrera` evita. Si SQLite dejara de
    // comportarse así, esta prueba avisa y el comentario de bd.js sobra.
    assert.deepEqual(perfil("u2").carreras, []);
});

// ----------------------------------------------------------------- historial

const BLOQUE = { dia: "lunes", horaInicio: 7, horaFin: 9, grupoClave: "1A", materiaClave: "ACF-0901" };

test("apartar y soltar horas deja rastro de quién y cuándo", async () => {
    const db = bd();
    guardarCarrera(db, "CCC", "Carrera C");
    docente("d1", "Docente Uno");

    await saturacion.reservar({
        carrera: "CCC", escenarioId: "e1", paridad: "impares",
        sesiones: [{ docenteId: "d1", ...BLOQUE }], usuarioId: "u1"
    });

    let h = await saturacion.historial({ docenteId: "d1" });
    assert.deepEqual(h.map((x) => x.accion), ["apartada"]);
    assert.equal(h[0].carrera, "CCC");
    assert.equal(h[0].docenteNombre, "Docente Uno");

    await saturacion.liberar({ carrera: "CCC", escenarioId: "e1", paridad: "impares", usuarioId: "u1" });

    h = await saturacion.historial({ docenteId: "d1" });
    assert.deepEqual(h.map((x) => x.accion), ["liberada", "apartada"], "lo más reciente primero");
});

test("no se da de baja a quien tiene horas apartadas por otras carreras", async () => {
    const almacen = await import("../src/almacen.js");
    const db = bd();
    guardarCarrera(db, "BAJ", "Carrera de bajas");
    // La plantilla viaja entera en cada guardado: se añade uno y se quita solo a
    // él, que es exactamente lo que hace la pantalla del departamento.
    const antes = await almacen.leerDocentes();
    const conBaja = [...antes, { id: "b1", nombre: "Baja Uno", categoria: "Titular" }];
    await almacen.guardarDocentes(conBaja);

    await saturacion.reservar({
        carrera: "BAJ", escenarioId: "e1", paridad: "impares",
        sesiones: [{ docenteId: "b1", ...BLOQUE }], usuarioId: "u1"
    });

    // Medido sobre el plantel entero, esto borraba 89 horas de once carreras
    // con un 200 y sin una palabra.
    await assert.rejects(
        () => almacen.guardarDocentes(antes),
        /Baja Uno tiene 2 horas apartadas por BAJ/
    );
    assert.equal(db.prepare("SELECT count(*) n FROM saturacion WHERE docente_id = 'b1'").get().n, 1,
        "y la reserva sigue en pie");

    await saturacion.liberar({ carrera: "BAJ", escenarioId: "e1", paridad: "impares", usuarioId: "u1" });
    await almacen.guardarDocentes(antes);
    assert.equal(db.prepare("SELECT count(*) n FROM docentes WHERE id = 'b1'").get().n, 0);
    assert.equal((await almacen.leerDocentes()).length, antes.length, "los demás siguen ahí");
});

test("ni se quita un salón que otra carrera tiene apartado", async () => {
    const almacen = await import("../src/almacen.js");
    const db = bd();
    guardarCarrera(db, "AUL", "Carrera de aulas");
    docente("a1", "Docente Aula");
    await almacen.guardarAulas("AUL", [
        { id: "v_9", clave: "V-9", tipo: "aula", capacidad: 40 },
        { id: "v_8", clave: "V-8", tipo: "aula", capacidad: 40 }
    ]);

    await saturacion.reservar({
        carrera: "AUL", escenarioId: "e1", paridad: "impares",
        sesiones: [{ docenteId: "a1", aulaId: "v_9", ...BLOQUE }], usuarioId: "u1"
    });

    await assert.rejects(
        () => almacen.guardarAulas("AUL", [{ id: "v_8", clave: "V-8", tipo: "aula", capacidad: 40 }]),
        /V-9 tiene 2 horas apartadas por AUL/
    );
    // Y el que no estorba sí se puede quitar.
    await almacen.guardarAulas("AUL", [{ id: "v_9", clave: "V-9", tipo: "aula", capacidad: 40 }]);
    assert.deepEqual((await almacen.leerAulas("AUL")).map((x) => x.id), ["v_9"]);
});

test("reservar de nuevo registra lo que reemplazó, no solo lo nuevo", async () => {
    const db = bd();
    guardarCarrera(db, "DDD", "Carrera D");
    docente("d2", "Docente Dos");

    const reserva = (dia) => saturacion.reservar({
        carrera: "DDD", escenarioId: "e2", paridad: "impares",
        sesiones: [{ docenteId: "d2", ...BLOQUE, dia }], usuarioId: "u1"
    });

    await reserva("lunes");
    await reserva("martes");

    const h = await saturacion.historial({ docenteId: "d2" });
    assert.deepEqual(h.map((x) => `${x.accion} ${x.dia}`),
        ["apartada martes", "liberada lunes", "apartada lunes"]);
    assert.equal(h[1].nota, "reemplazada");
});

test("el historial de un docente no arrastra el de los demás", async () => {
    const h = await saturacion.historial({ docenteId: "d1" });
    assert.equal(h.every((x) => x.docenteNombre === "Docente Uno"), true);
});

// ------------------------------------------------------------------ esquema

test("migrarEsquema es idempotente y añade las columnas tardías", () => {
    const columnas = (t) => bd().prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.equal(columnas("saturacion").includes("aula_id"), true);
    assert.equal(columnas("aulas").includes("capacidad"), true);
});

test("una transacción que falla no deja nada a medias", () => {
    const antes = bd().prepare("SELECT count(*) AS n FROM carreras").get().n;
    assert.throws(() => enTransaccion((db) => {
        guardarCarrera(db, "EEE", "Se revierte");
        throw new Error("boom");
    }), /boom/);
    assert.equal(bd().prepare("SELECT count(*) AS n FROM carreras").get().n, antes);
});

// ------------------------------------------------------- horario recuperable

const { leer: leerHorario } = await import("../src/horario.js");

const SESION = {
    grupoId: "g1", grupoClave: "1A", grupoIds: ["g1"], materiaClave: "ACF-0901",
    materiaNombre: "Cálculo", docenteId: "d9", docenteNombre: "Docente Nueve",
    dia: "lunes", horaInicio: 7, horaFin: 9
};

async function apartar(sesiones) {
    return saturacion.reservar({
        carrera: "FFF", escenarioId: "e9", paridad: "impares", sesiones,
        usuarioId: "u1",
        documento: { grupos: [{ id: "g1", clave: "1A" }], sesiones, aptitud: 12, factible: true }
    });
}

test("el horario apartado se recupera tal como se generó", async () => {
    guardarCarrera(bd(), "FFF", "Carrera F");
    docente("d9", "Docente Nueve");
    await apartar([SESION]);

    const r = leerHorario({ carrera: "FFF", escenarioId: "e9" });
    assert.equal(r.paridad, "impares");
    assert.equal(r.horario.factible, true);
    assert.deepEqual(r.horario.sesiones[0].grupoIds, ["g1"], "la fusión sobrevive al viaje");
    assert.equal(r.desfase.alDia, true);
});

test("volver a apartar sustituye el horario, no acumula", async () => {
    await apartar([{ ...SESION, dia: "martes" }]);
    const r = leerHorario({ carrera: "FFF", escenarioId: "e9" });
    assert.equal(r.horario.sesiones.length, 1);
    assert.equal(r.horario.sesiones[0].dia, "martes");
});

test("ceder horas deja el horario desfasado y nombra las clases perdidas", async () => {
    // Lo que hace una cesión: las horas se van de `saturacion` y el documento
    // guardado sigue mostrando la clase.
    bd().prepare("DELETE FROM saturacion WHERE carrera = 'FFF' AND escenario_id = 'e9'").run();

    const r = leerHorario({ carrera: "FFF", escenarioId: "e9" });
    assert.equal(r.desfase.alDia, false);
    assert.equal(r.desfase.sesionesPerdidas.length, 1);
    assert.equal(r.desfase.sesionesPerdidas[0].materiaClave, "ACF-0901");
});

test("perder una sola hora de un bloque ya lo rompe", async () => {
    await apartar([{ ...SESION, dia: "jueves", horaInicio: 7, horaFin: 9 }]);
    // Se cede solo la segunda hora del bloque de dos.
    bd().prepare(
        "UPDATE saturacion SET fin = 8 WHERE carrera = 'FFF' AND escenario_id = 'e9'"
    ).run();

    const r = leerHorario({ carrera: "FFF", escenarioId: "e9" });
    assert.equal(r.desfase.alDia, false, "media clase es una clase rota");
});

test("liberar borra el horario, no solo las horas", async () => {
    await apartar([SESION]);
    await saturacion.liberar({ carrera: "FFF", escenarioId: "e9", usuarioId: "u1" });
    assert.equal(leerHorario({ carrera: "FFF", escenarioId: "e9" }), null);
});

test("un escenario que nunca apartó no tiene horario", () => {
    assert.equal(leerHorario({ carrera: "FFF", escenarioId: "no-existe" }), null);
});

// ------------------------------------------------------------------ respaldo

const { respaldar } = await import("../herramientas/respaldar.js");

test("el respaldo es una base completa y consultable, no una copia a medias", async () => {
    const destino = fs.mkdtempSync(path.join(os.tmpdir(), "schedulai-resp-"));
    const { archivo, bytes } = respaldar({ destino });

    assert.equal(fs.existsSync(archivo), true);
    assert.ok(bytes > 0);

    const { DatabaseSync } = await import("node:sqlite");
    const copia = new DatabaseSync(archivo, { readOnly: true });
    assert.equal(copia.prepare("PRAGMA integrity_check").get().integrity_check, "ok");

    const tablas = (db) =>
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all()
            .map((r) => r.name);
    assert.deepEqual(tablas(copia), tablas(bd()), "el respaldo lleva el esquema entero");
    assert.equal(
        copia.prepare("SELECT count(*) AS n FROM carreras").get().n,
        bd().prepare("SELECT count(*) AS n FROM carreras").get().n
    );
    copia.close();
});

test("rotar conserva los más recientes, incluido el que colisionó en el nombre", () => {
    const destino = fs.mkdtempSync(path.join(os.tmpdir(), "schedulai-rot-"));
    // Tres seguidos caen en el mismo segundo: el segundo y el tercero llevan
    // sufijo, y por nombre ordenan antes que el primero.
    const hechos = [1, 2, 3].map(() => respaldar({ destino, conservar: 99 }).archivo);

    respaldar({ destino, conservar: 2 });
    const quedan = fs.readdirSync(destino);

    assert.equal(quedan.length, 2);
    assert.equal(
        quedan.includes(path.basename(hechos[2])),
        true,
        "el más nuevo de los previos no se borra por ordenar mal"
    );
});

// ------------------------------------------------------------------ cuentas

const auth = await import("../src/auth.js");

test("la contraseña nueva se exige de largo razonable", () => {
    guardarCarrera(bd(), "GGG", "Carrera G");
    assert.throws(
        () => auth.altaUsuario({ nombre: "N", usuario: "corta", clave: "1234" }),
        /al menos 8/
    );
});

test("un usuario con espacios o muy corto se rechaza antes de tocar la base", () => {
    assert.throws(() => auth.altaUsuario({ nombre: "N", usuario: "a b", clave: "schedulai" }), /3 a 32/);
    assert.throws(() => auth.altaUsuario({ nombre: "N", usuario: "ab", clave: "schedulai" }), /3 a 32/);
});

test("una carrera inexistente da 400 y la nombra, no un fallo de clave foránea", () => {
    // `usuario_carrera` apunta a `carreras(codigo)`: sin esta comprobación el
    // INSERT revienta y quien da de alta ve "Error interno del servidor".
    assert.throws(
        () => auth.altaUsuario({ nombre: "N", usuario: "fantasma", clave: "schedulai", carreras: ["NOEXISTE"] }),
        /No existe la carrera NOEXISTE/
    );
});

test("el usuario repetido da 409", () => {
    auth.altaUsuario({ nombre: "Uno", usuario: "repe", clave: "schedulai", carreras: ["GGG"] });
    assert.throws(() => auth.altaUsuario({ nombre: "Dos", usuario: "repe", clave: "schedulai" }), /Ya existe/);
});

test("cambiar la contraseña exige la actual y cierra las demás sesiones", () => {
    const u = auth.altaUsuario({ nombre: "Tres", usuario: "cambia", clave: "schedulai", carreras: ["GGG"] });
    auth.autenticar("cambia", "schedulai");
    auth.autenticar("cambia", "schedulai");
    const vivas = () =>
        bd().prepare("SELECT count(*) AS n FROM sesiones WHERE usuario_id = ?").get(u.id).n;
    assert.equal(vivas(), 2);

    assert.throws(() => auth.cambiarClave({ usuarioId: u.id, actual: "otra", nueva: "nuevaclave" }), /no es correcta/);
    assert.equal(vivas(), 2, "un intento fallido no cierra nada");

    auth.cambiarClave({ usuarioId: u.id, actual: "schedulai", nueva: "nuevaclave" });
    assert.equal(vivas(), 0, "cambiarla invalida las sesiones que alguien más pudiera tener");
    assert.throws(() => auth.autenticar("cambia", "schedulai"), /incorrectos/);
    assert.ok(auth.autenticar("cambia", "nuevaclave").token);
});

test("retirar deja la cuenta pero sin carreras ni sesiones", () => {
    const u = auth.altaUsuario({ nombre: "Cuatro", usuario: "retira", clave: "schedulai", carreras: ["GGG"] });
    auth.autenticar("retira", "schedulai");

    auth.retirarUsuario(u.id);

    // La cuenta sobrevive: el historial apunta a quién hizo cada cosa, y
    // borrarla dejaría la historia sin autor.
    assert.ok(auth.perfil(u.id), "la cuenta sigue existiendo");
    assert.deepEqual(auth.perfil(u.id).carreras, []);
    assert.equal(
        bd().prepare("SELECT count(*) AS n FROM sesiones WHERE usuario_id = ?").get(u.id).n,
        0
    );
});

test("una cuenta retirada ya no entra, y vuelve con una contraseña nueva", () => {
    const u = auth.altaUsuario({ nombre: "Cinco", usuario: "vuelve", clave: "schedulai", carreras: ["GGG"] });
    auth.retirarUsuario(u.id);

    // Antes entraba: la contraseña seguía siendo válida y aterrizaba en una
    // pantalla vacía, sin nada que dijera por qué.
    assert.throws(() => auth.autenticar("vuelve", "schedulai"), /retirada/);
    assert.equal(auth.listarUsuarios().find((x) => x.id === u.id).activo, false);

    // Y darla de alta otra vez no es la salida: la cuenta existe, con su
    // historial. El mensaje lleva a lo que de verdad hay que hacer.
    assert.throws(
        () => auth.altaUsuario({ nombre: "Cinco", usuario: "vuelve", clave: "schedulai" }),
        /está retirada/
    );
    assert.throws(() => auth.asignarCarreras(u.id, ["GGG"]), /Reactívala/);

    auth.reiniciarClave({ usuarioId: u.id, nueva: "otraclave" });
    assert.ok(auth.autenticar("vuelve", "otraclave").token);
    assert.equal(auth.listarUsuarios().find((x) => x.id === u.id).activo, true);
    assert.deepEqual(auth.asignarCarreras(u.id, ["GGG"]).carreras, ["GGG"]);
});

test("no se puede retirar a la única cuenta de departamento", () => {
    const jefe = auth.altaUsuario({ nombre: "Jefe", usuario: "jefe1", clave: "schedulai", rol: "departamento" });
    assert.throws(() => auth.retirarUsuario(jefe.id), /quedaría nadie/);

    auth.altaUsuario({ nombre: "Jefa", usuario: "jefe2", clave: "schedulai", rol: "departamento" });
    assert.deepEqual(auth.retirarUsuario(jefe.id), { retirado: true }, "con dos, sí");
});

test("reasignar carreras reemplaza, no acumula", () => {
    guardarCarrera(bd(), "HHH", "Carrera H");
    const u = auth.altaUsuario({ nombre: "Cinco", usuario: "reasig", clave: "schedulai", carreras: ["GGG"] });

    auth.asignarCarreras(u.id, ["HHH", "GGG"]);
    assert.deepEqual(auth.perfil(u.id).carreras, ["GGG", "HHH"]);

    auth.asignarCarreras(u.id, ["HHH"]);
    assert.deepEqual(auth.perfil(u.id).carreras, ["HHH"]);
});

// ----------------------------------------------------------------- prioridad

const prioridad = await import("../src/prioridad.js");

test("la prioridad es del coordinador, no del docente: no se cruza entre carreras", () => {
    guardarCarrera(bd(), "III", "Carrera I");
    guardarCarrera(bd(), "JJJ", "Carrera J");
    docente("dp1", "Docente P");

    prioridad.guardar("III", [{ docenteId: "dp1", prioridad: 2 }]);

    assert.equal(prioridad.mapaDe("III").get("dp1"), 2);
    assert.equal(prioridad.mapaDe("JJJ").has("dp1"), false, "JJJ no hereda el juicio de III");
});

test("volver a Normal borra la fila en vez de guardar un cero", () => {
    // La ausencia ya significa normal; guardarla llenaría la tabla de filas que
    // no dicen nada.
    prioridad.guardar("III", [{ docenteId: "dp1", prioridad: 0 }]);
    assert.equal(prioridad.listar("III").length, 0);
});

test("una prioridad fuera de rango o de un docente inexistente se rechaza", () => {
    assert.throws(() => prioridad.guardar("III", [{ docenteId: "dp1", prioridad: 9 }]), /fuera de rango/);
    assert.throws(() => prioridad.guardar("III", [{ docenteId: "dp1", prioridad: 1.5 }]), /fuera de rango/);
    assert.throws(() => prioridad.guardar("III", [{ docenteId: "nadie", prioridad: 1 }]), /No existe el docente/);
});

test("un lote con un error no deja la mitad guardada", () => {
    docente("dp2", "Docente Q");
    assert.throws(
        () => prioridad.guardar("III", [{ docenteId: "dp2", prioridad: 2 }, { docenteId: "nadie", prioridad: 1 }]),
        /No existe/
    );
    assert.equal(prioridad.mapaDe("III").has("dp2"), false, "la transacción revierte entera");
});

test("guardar dos veces actualiza, no duplica", () => {
    prioridad.guardar("III", [{ docenteId: "dp1", prioridad: 1, nota: "coordina tutorías" }]);
    prioridad.guardar("III", [{ docenteId: "dp1", prioridad: 2 }]);

    const filas = prioridad.listar("III");
    assert.equal(filas.length, 1);
    assert.equal(filas[0].prioridad, 2);
    assert.equal(filas[0].nota, null, "la nota se reemplaza junto con el nivel");
});

// ------------------------------------------------------------------ sesiones

test("una sesión caducada deja de valer aunque el token exista", () => {
    // Es el defecto que esto arregla: la cookie llevaba Max-Age pero el
    // servidor nunca lo comprobaba, así que un token copiado entraba siempre.
    guardarCarrera(bd(), "KKK", "Carrera K");
    const u = auth.altaUsuario({ nombre: "Sesión", usuario: "sesion1", clave: "schedulai", carreras: ["KKK"] });
    const { token } = auth.autenticar("sesion1", "schedulai");
    const req = { headers: { cookie: `sesion=${token}` } };

    assert.equal(auth.usuarioDe(req).id, u.id, "recién creada vale");

    const hace13h = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    bd().prepare("UPDATE sesiones SET creada = ? WHERE token = ?").run(hace13h, token);

    assert.equal(auth.usuarioDe(req), null, "pasadas las 12 h ya no");
    assert.equal(
        bd().prepare("SELECT count(*) AS n FROM sesiones WHERE token = ?").get(token).n,
        0,
        "y se borra al detectarla, no se deja viva"
    );
});

test("una fecha de creación ilegible no se acepta", () => {
    const { token } = auth.autenticar("sesion1", "schedulai");
    bd().prepare("UPDATE sesiones SET creada = 'ayer' WHERE token = ?").run(token);
    assert.equal(auth.usuarioDe({ headers: { cookie: `sesion=${token}` } }), null);
});

test("entrar barre las sesiones vencidas de todos", () => {
    const viejo = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    bd().prepare("INSERT INTO sesiones (token, usuario_id, creada) VALUES ('zombi', ?, ?)")
        .run(bd().prepare("SELECT id FROM usuarios WHERE usuario='sesion1'").get().id, viejo);

    auth.autenticar("sesion1", "schedulai");

    assert.equal(bd().prepare("SELECT count(*) AS n FROM sesiones WHERE token='zombi'").get().n, 0);
});

test("la cookie lleva HttpOnly y SameSite; Secure solo con TLS", () => {
    const cabecera = auth.cabeceraDeSesion("abc");
    assert.match(cabecera, /HttpOnly/);
    assert.match(cabecera, /SameSite=Lax/);
    assert.match(cabecera, /Max-Age=43200/);
    // Sin CON_TLS no debe llevar Secure: sobre http el navegador la descartaría
    // y nadie podría entrar.
    assert.equal(/Secure/.test(cabecera), false);
});

// -------------------------------------------------- carreras sin coordinador

test("no se puede retirar al único coordinador de una carrera", () => {
    // Una carrera sin coordinador no falla en ninguna parte: simplemente nadie
    // puede abrirla, y solo se notaría mirando la tabla.
    guardarCarrera(bd(), "LLL", "Carrera L");
    const solo = auth.altaUsuario({ nombre: "Solo", usuario: "solo1", clave: "schedulai", carreras: ["LLL"] });

    assert.throws(() => auth.retirarUsuario(solo.id), /LLL se quedaría sin coordinador/);
    assert.deepEqual(auth.perfil(solo.id).carreras, ["LLL"], "no se retiró a medias");

    const otro = auth.altaUsuario({ nombre: "Otro", usuario: "otro1", clave: "schedulai", carreras: ["LLL"] });
    assert.deepEqual(auth.retirarUsuario(solo.id), { retirado: true }, "con relevo, sí");
    assert.deepEqual(auth.perfil(otro.id).carreras, ["LLL"]);
});

test("tampoco quitársela por reasignación", () => {
    guardarCarrera(bd(), "MMM", "Carrera M");
    const u = auth.altaUsuario({ nombre: "Único", usuario: "unico1", clave: "schedulai", carreras: ["MMM"] });

    assert.throws(() => auth.asignarCarreras(u.id, []), /MMM se quedaría sin coordinador/);
    assert.throws(() => auth.asignarCarreras(u.id, ["LLL"]), /MMM se quedaría/);
    assert.deepEqual(auth.asignarCarreras(u.id, ["MMM", "LLL"]).carreras, ["MMM", "LLL"], "añadir sí");
});

// ------------------------------------------------ conflicto consigo mismo

const conciliacion = await import("../src/conciliacion.js");

test("un choque entre dos carreras propias se marca como propio", () => {
    guardarCarrera(bd(), "NNN", "Carrera N");
    guardarCarrera(bd(), "OOO", "Carrera O");
    docente("dc1", "Docente C");

    const apartar = (carrera, escenarioId, grupoClave) =>
        saturacion.reservar({
            carrera, escenarioId, paridad: "impares", usuarioId: "u1",
            sesiones: [{ docenteId: "dc1", dia: "lunes", horaInicio: 7, horaFin: 9,
                         grupoClave, materiaClave: "X" }]
        });

    return Promise.all([apartar("NNN", "e1", "1A"), apartar("OOO", "e1", "2A")]).then(() => {
        const ambas = conciliacion.detectarConflictos({
            carrera: "NNN", escenarioId: "e1", paridad: "impares", misCarreras: ["NNN", "OOO"]
        });
        assert.equal(ambas.length, 1);
        assert.equal(ambas[0].propio, true, "las dos son suyas: no hay a quién pedirle nada");

        const soloUna = conciliacion.detectarConflictos({
            carrera: "NNN", escenarioId: "e1", paridad: "impares", misCarreras: ["NNN"]
        });
        assert.equal(soloUna[0].propio, false, "aquí sí hay otro coordinador enfrente");
    });
});

test("una solicitud entre dos carreras propias no sale duplicada en la bandeja", () => {
    conciliacion.crear({
        de: { carrera: "NNN", escenarioId: "e1" },
        a: { carrera: "OOO", escenarioId: "e1" },
        docenteId: "dc1", dia: "lunes", inicio: 7, fin: 9, usuario: "u1"
    });

    const bandeja = conciliacion.listarSolicitudes({ carreras: ["NNN", "OOO"] });
    assert.equal(bandeja.enviadas.length, 1);
    assert.equal(bandeja.recibidas.length, 0, "no puede decir 'te piden horas' por algo propio");

    const ajena = conciliacion.listarSolicitudes({ carreras: ["OOO"] });
    assert.equal(ajena.recibidas.length, 1, "para quien solo lleva OOO, sí es una petición");
});

// ---------------------------------------------------- config del escenario

const configEscenario = await import("../src/config-escenario.js");

test("lo elegido antes de generar se recupera tal cual", () => {
    guardarCarrera(bd(), "PPP", "Carrera P");
    bd().prepare(
        "INSERT INTO escenarios (carrera, id, nombre, fecha) VALUES ('PPP','e1','Uno','2026-09-12')"
    ).run();

    assert.equal(configEscenario.leer({ carrera: "PPP", escenarioId: "e1" }), null, "sin guardar, nada");

    configEscenario.guardar({
        carrera: "PPP", escenarioId: "e1", paridad: "impares",
        lineas: [{ semestre: 1, especialidadId: null, porTurno: { matutino: 2 } }],
        fusiones: ["m1|g1,g2"]
    });

    const c = configEscenario.leer({ carrera: "PPP", escenarioId: "e1" });
    assert.equal(c.paridad, "impares");
    assert.equal(c.lineas[0].porTurno.matutino, 2);
    assert.deepEqual(c.fusiones, ["m1|g1,g2"]);
    assert.ok(c.guardada, "queda cuándo se guardó");
});

test("guardar dos veces reemplaza, no acumula", () => {
    configEscenario.guardar({ carrera: "PPP", escenarioId: "e1", paridad: "pares", lineas: [], fusiones: [] });
    const c = configEscenario.leer({ carrera: "PPP", escenarioId: "e1" });
    assert.equal(c.paridad, "pares");
    assert.deepEqual(c.fusiones, []);
    assert.equal(bd().prepare("SELECT count(*) AS n FROM escenario_config").get().n, 1);
});

test("borrar el escenario se lleva su configuración", () => {
    bd().prepare("DELETE FROM escenarios WHERE carrera='PPP' AND id='e1'").run();
    assert.equal(configEscenario.leer({ carrera: "PPP", escenarioId: "e1" }), null);
});

// ------------------------------------------------- contraseña de arranque

test("una cuenta nueva nace obligada a cambiar la contraseña", () => {
    guardarCarrera(bd(), "QQQ", "Carrera Q");
    const u = auth.altaUsuario({ nombre: "Nueva", usuario: "nueva1", clave: "schedulai", carreras: ["QQQ"] });
    assert.equal(auth.perfil(u.id).debeCambiarClave, true);

    auth.cambiarClave({ usuarioId: u.id, actual: "schedulai", nueva: "otraclave1" });
    assert.equal(auth.perfil(u.id).debeCambiarClave, false, "cambiarla levanta la obligación");
});

test("no vale 'cambiarla' por la misma", () => {
    const u = auth.altaUsuario({ nombre: "Otra", usuario: "otra2", clave: "schedulai", carreras: ["QQQ"] });
    assert.throws(
        () => auth.cambiarClave({ usuarioId: u.id, actual: "schedulai", nueva: "schedulai" }),
        /la misma que la actual/
    );
    assert.equal(auth.perfil(u.id).debeCambiarClave, true, "sigue obligada");
});

// ------------------------------------------------------------- invitaciones

const invitaciones = await import("../src/invitaciones.js");

test("sin invitación aceptada no se puede meter la carrera de otro", () => {
    guardarCarrera(bd(), "RRR", "Carrera R");
    guardarCarrera(bd(), "SSS", "Carrera S");
    bd().prepare("INSERT INTO escenarios (carrera,id,nombre,fecha) VALUES ('SSS','e1','Uno','2026-09-12')").run();

    const puede = (carreras) =>
        invitaciones.autorizada({ anfitriona: "RRR", invitada: "SSS", escenarioId: "e1", carreras });

    assert.equal(puede(["RRR"]), false);
    // Quien lleva las dos no tiene a quién pedirle permiso.
    assert.equal(puede(["RRR", "SSS"]), true);
});

test("la invitada acepta y entonces sí; revocarla lo deshace", () => {
    const i = invitaciones.crear({ anfitriona: "RRR", invitada: "SSS", escenarioId: "e1", usuario: "u1" });
    assert.equal(i.estado, "pendiente");

    const puede = () =>
        invitaciones.autorizada({ anfitriona: "RRR", invitada: "SSS", escenarioId: "e1", carreras: ["RRR"] });
    assert.equal(puede(), false, "pendiente no basta");

    invitaciones.responder({ id: i.id, acepta: true, carreras: ["SSS"], usuarioId: "u2" });
    assert.equal(puede(), true);

    // La puede retirar cualquiera de las dos partes.
    invitaciones.revocar({ id: i.id, carreras: ["SSS"] });
    assert.equal(puede(), false);
});

test("la anfitriona no puede aceptarse a sí misma la invitación", () => {
    const i = invitaciones.crear({ anfitriona: "RRR", invitada: "SSS", escenarioId: "e1", usuario: "u1" });
    assert.throws(
        () => invitaciones.responder({ id: i.id, acepta: true, carreras: ["RRR"], usuarioId: "u1" }),
        /no es tuya para responderla/
    );
});

test("no se duplica una invitación viva ni se invita a un escenario que no existe", () => {
    assert.throws(
        () => invitaciones.crear({ anfitriona: "RRR", invitada: "SSS", escenarioId: "e1" }),
        /ya está pendiente/
    );
    assert.throws(
        () => invitaciones.crear({ anfitriona: "RRR", invitada: "SSS", escenarioId: "no-existe" }),
        /no tiene el escenario/
    );
    assert.throws(
        () => invitaciones.crear({ anfitriona: "RRR", invitada: "RRR", escenarioId: "e1" }),
        /no se invita a sí misma/
    );
});

test("quien lleva las dos carreras no ve su propia invitación como recibida", () => {
    const bandeja = invitaciones.listar(["RRR", "SSS"]);
    assert.ok(bandeja.enviadas.length > 0);
    assert.equal(bandeja.recibidas.length, 0, "no puede decir 'te invitan' por algo propio");
    assert.equal(invitaciones.listar(["SSS"]).recibidas.length > 0, true);
});

// --------------------------------------------------------- aulas del plantel

test("una coordinación no puede reescribir los espacios del plantel", async () => {
    // La ruta por carrera guardaba reemplazando la lista entera, así que
    // guardar una sola aula dejaba al resto de las carreras sin ninguna.
    const { RUTAS } = await import("../src/rutas.js");
    const porCarrera = RUTAS.find(([m, p]) => m === "PUT" && p === "/api/carreras/:carrera/aulas");
    assert.ok(porCarrera, "la ruta sigue existiendo para dar un error claro");

    const req = { usuario: { rol: "coordinador", carreras: ["ZZZ"] } };
    await assert.rejects(() => porCarrera[2](req, {}, { carrera: "ZZZ" }), /los administra el departamento/);
});

test("el departamento reinicia una contraseña olvidada", () => {
    // Sin esto, quien la olvida deja el sistema sin salida: había que entrar a
    // la base de datos.
    guardarCarrera(bd(), "TTT", "Carrera T");
    const u = auth.altaUsuario({ nombre: "Olvida", usuario: "olvida1", clave: "schedulai", carreras: ["TTT"] });
    auth.cambiarClave({ usuarioId: u.id, actual: "schedulai", nueva: "laqueolvide" });
    auth.autenticar("olvida1", "laqueolvide");
    assert.equal(auth.perfil(u.id).debeCambiarClave, false);

    auth.reiniciarClave({ usuarioId: u.id, nueva: "provisional1" });

    assert.throws(() => auth.autenticar("olvida1", "laqueolvide"), /incorrectos/);
    assert.ok(auth.autenticar("olvida1", "provisional1").token);
    // Vuelve a quedar obligada: el paso por manos ajenas dura hasta su entrada.
    assert.equal(auth.perfil(u.id).debeCambiarClave, true);
    assert.equal(
        bd().prepare("SELECT count(*) AS n FROM sesiones WHERE usuario_id = ?").get(u.id).n,
        1,
        "las de antes se cerraron; queda la que acaba de abrir la prueba"
    );
});

test("una provisional corta se rechaza igual", () => {
    const u = bd().prepare("SELECT id FROM usuarios WHERE usuario='olvida1'").get();
    assert.throws(() => auth.reiniciarClave({ usuarioId: u.id, nueva: "123" }), /al menos 8/);
});


test("la respuesta de ajustar tiene la misma forma que la de generar", async () => {
    // Al ajustar faltaba `resumen` y la interfaz reventaba leyendo
    // `resumen.semestres`, vaciando el panel sin decir por qué. Un horario
    // ajustado tiene que ser indistinguible de uno generado.
    const { RUTAS } = await import("../src/rutas.js");
    const fuente = await import("node:fs").then((fs) =>
        fs.readFileSync(new URL("../src/rutas.js", import.meta.url), "utf8")
    );

    const trozo = (nombre) => {
        const desde = fuente.indexOf(`async function ${nombre}(`);
        assert.ok(desde > 0, `no encuentro ${nombre}`);
        return fuente.slice(desde, fuente.indexOf("\n}", desde));
    };
    const campos = (texto) =>
        new Set([...texto.matchAll(/^\s{8}(\w+)[:,]/gm)].map((m) => m[1]));

    const alGenerar = campos(trozo("generarHorario"));
    const alAjustar = campos(trozo("ajustarHorario"));
    for (const clave of ["resumen", "rejilla", "grupos", "paridad", "parametros"]) {
        assert.ok(alGenerar.has(clave), `generar debería devolver ${clave}`);
        assert.ok(alAjustar.has(clave), `ajustar no devuelve ${clave}`);
    }
    assert.ok(RUTAS.some(([m, r]) => m === "POST" && r.endsWith("/horario/ajuste")));
});

test("una coordinación no puede reescribir la plantilla del instituto", async () => {
    // Guardar reemplaza la lista entera: mientras esto estuvo abierto, una
    // coordinación podía cambiar quién imparte qué —lo que decide el
    // departamento— o borrar docentes de las demás carreras.
    const { RUTAS } = await import("../src/rutas.js");
    const ruta = RUTAS.find(([m, p]) => m === "PUT" && p === "/api/docentes");
    assert.ok(ruta);

    await assert.rejects(
        () => ruta[2]({ usuario: { rol: "coordinador", carreras: ["ZZZ"] } }, {}),
        /la administra el departamento/
    );
});

// ------------------------------------------------------------- catálogo

const catalogoMod = await import("../src/catalogo.js");

/** Un escenario mínimo con una materia y dos grupos que la cursan. */
async function prepararCatalogo() {
    guardarCarrera(bd(), "UUU", "Carrera U");
    bd().prepare(
        "INSERT OR IGNORE INTO escenarios (carrera,id,nombre,fecha,es_base) VALUES ('UUU','base','Base','2026-09-13',1)"
    ).run();
    bd().prepare(
        `INSERT OR IGNORE INTO materias (carrera,escenario_id,id,clave,nombre,semestre,horas_semana)
         VALUES ('UUU','base','uu1','UU-1','Una',1,4)`
    ).run();
    bd().prepare(
        `INSERT OR IGNORE INTO semestres (carrera,escenario_id,id,periodo,semanas,turnos,estado)
         VALUES ('UUU','base','s1','Agosto-Diciembre 2026',16,'["matutino"]','activo')`
    ).run();
    docente("dcat1", "Docente Cat 1");
    docente("dcat2", "Docente Cat 2");
    autorizar("dcat1", "uu1");
    autorizar("dcat2", "uu1");
    // Dos grupos de primero: 1A y 1B, que es lo que hace interesante el reparto.
    const config = await import("../src/config-escenario.js");
    config.guardar({
        carrera: "UUU",
        escenarioId: "base",
        paridad: "impares",
        lineas: [{ semestre: 1, especialidadId: null, porTurno: { matutino: 2 }, alumnos: 30 }],
        fusiones: [],
        invitadas: []
    });
}

test("el catálogo lista una fila por materia y grupo, no por materia", () => {
    // Una materia con tres grupos son tres decisiones distintas: el jefe puede
    // darle los tres a la misma persona o repartirlos.
    return prepararCatalogo().then(async () => {
        const c = await catalogoMod.porCarrera("UUU");
        assert.equal(c.escenarioId, "base");
        assert.deepEqual(c.filas.map((f) => f.grupoClave), ["1A", "1B"]);
        assert.ok(c.filas.every((f) => f.docenteId === null), "todavía sin asignar");
    });
});

test("se asigna por grupo, y una materia puede repartirse entre dos", async () => {
    enTransaccion((db) => {
        catalogoMod.asignar(db, {
            carrera: "UUU", materiaId: "uu1", grupoClave: "1A", docenteId: "dcat1"
        });
        catalogoMod.asignar(db, {
            carrera: "UUU", materiaId: "uu1", grupoClave: "1B", docenteId: "dcat2"
        });
    });
    const c = await catalogoMod.porCarrera("UUU");
    assert.deepEqual(
        c.filas.map((f) => [f.grupoClave, f.docenteNombre]),
        [["1A", "Docente Cat 1"], ["1B", "Docente Cat 2"]]
    );
});

test("o llevarlos la misma persona", async () => {
    enTransaccion((db) =>
        catalogoMod.asignar(db, {
            carrera: "UUU", materiaId: "uu1", grupoClave: "1B", docenteId: "dcat1"
        })
    );
    const c = await catalogoMod.porCarrera("UUU");
    assert.deepEqual(c.filas.map((f) => f.docenteId), ["dcat1", "dcat1"]);
});

test("dejar sin asignar es un estado legítimo, y se cuenta", async () => {
    // El departamento puede estar a medias de repartir. Lo que no puede es
    // pasar desapercibido: sin asignar, esa clase no se puede programar.
    enTransaccion((db) =>
        catalogoMod.asignar(db, {
            carrera: "UUU", materiaId: "uu1", grupoClave: "1B", docenteId: null
        })
    );
    const fila = (await catalogoMod.resumen()).find((c) => c.carrera === "UUU");
    assert.equal(fila.clases, 2);
    assert.equal(fila.sinAsignar, 1);
});

test("la carga de un docente suma lo de todas las carreras", async () => {
    // Asignarlo en dos carreras son decisiones independientes; la persona no lo
    // es, y es lo que hay que poder mirar.
    guardarCarrera(bd(), "WWW", "Carrera W");
    bd().prepare(
        "INSERT OR IGNORE INTO escenarios (carrera,id,nombre,fecha,es_base) VALUES ('WWW','base','Base','2026-09-13',1)"
    ).run();
    bd().prepare(
        `INSERT OR IGNORE INTO materias (carrera,escenario_id,id,clave,nombre,semestre,horas_semana)
         VALUES ('WWW','base','ww1','WW-1','Otra',1,5)`
    ).run();
    autorizar("dcat1", "ww1");
    enTransaccion((db) =>
        catalogoMod.asignar(db, {
            carrera: "WWW", materiaId: "ww1", grupoClave: "1A", docenteId: "dcat1"
        })
    );

    const suya = (await catalogoMod.cargaPorDocente()).find((d) => d.docenteId === "dcat1");
    assert.deepEqual(suya.carreras, ["UUU", "WWW"]);
    assert.equal(suya.clases, 2, "1A de UUU y 1A de WWW");
    assert.equal(suya.horas, 9, "4 h + 5 h");
});

test("y avisa cuando alguien se pasa de lo que puede", async () => {
    bd().prepare("UPDATE docentes SET horas_max = 5, max_grupos = 1 WHERE id = 'dcat1'").run();
    const suya = (await catalogoMod.cargaPorDocente()).find((d) => d.docenteId === "dcat1");
    assert.equal(suya.sobreHoras, true, "9 h sobre un máximo de 5");
    assert.equal(suya.sobreGrupos, true, "2 clases sobre un máximo de 1");
});

test("una asignación sin clase deja de contar, pero se nombra", async () => {
    // El coordinador cierra el grupo o quita la materia después de repartir: la
    // decisión queda sin clase a la que aplicarse. No se borra —si el grupo
    // vuelve, sigue valiendo— pero contarla daba una carga con clases que ya no
    // existen, que es peor que no contarla.
    //
    // La autorización se queda igual que la asignación: cuando se repartió, la
    // materia existía.
    autorizar("dcat1", "no-existe");
    enTransaccion((db) =>
        catalogoMod.asignar(db, {
            carrera: "UUU", materiaId: "no-existe", grupoClave: "9Z", docenteId: "dcat1"
        })
    );
    const suyo = await catalogoMod.porCarrera("UUU");
    assert.ok(
        suyo.huerfanas.some((h) => h.materiaId === "no-existe"),
        "la huérfana tiene que salir nombrada"
    );
    assert.ok(
        !suyo.filas.some((f) => f.materiaId === "no-existe"),
        "pero no como si fuera una clase"
    );
    const suya = (await catalogoMod.cargaPorDocente()).find((d) => d.docenteId === "dcat1");
    assert.equal(suya.clases, 2, "sigue siendo 1A de UUU y 1A de WWW, no tres");

    enTransaccion((db) =>
        catalogoMod.asignar(db, {
            carrera: "UUU", materiaId: "no-existe", grupoClave: "9Z", docenteId: null
        })
    );
});

test("guardar un nombramiento no toca al resto ni borra lo que no se manda", async () => {
    const almacen = await import("../src/almacen.js");
    docente("dper1", "Per Uno");
    docente("dper2", "Per Dos");

    // Campos que el diálogo del departamento no edita y que viajaban de rebote
    // en el documento completo. Si se perdieran aquí, el arreglo no serviría.
    bd().prepare(
        `UPDATE docentes SET antiguedad = 2011, carrera_base = 'CBAS', es_de_otra_area = 1,
         horas_max = 22 WHERE id = 'dper1'`
    ).run();
    autorizar("dper1", "uu1");
    bd().prepare(
        `INSERT INTO docente_horario (docente_id, tipo, dia, inicio, fin)
         VALUES ('dper1', 'declarada', 'lunes', 7, 13)`
    ).run();

    const r = almacen.guardarDocente({ id: "dper1", horasMax: 18, dedicacion: "medio tiempo" });
    assert.equal(r.nuevo, false);

    const fila = bd().prepare("SELECT * FROM docentes WHERE id = 'dper1'").get();
    assert.equal(fila.horas_max, 18, "lo que se manda sí cambia");
    assert.equal(fila.dedicacion, "medio tiempo");
    assert.equal(fila.antiguedad, 2011, "la antigüedad no venía y no se pierde");
    assert.equal(fila.carrera_base, "CBAS");
    assert.equal(fila.es_de_otra_area, 1);

    const cuantos = (tabla) =>
        bd().prepare(`SELECT count(*) n FROM ${tabla} WHERE docente_id = 'dper1'`).get().n;
    assert.equal(cuantos("docente_horario"), 1, "su disponibilidad la declara él, no esto");
    assert.equal(cuantos("docente_materia"), 1, "sin el campo, las autorizaciones se quedan");

    assert.equal(
        bd().prepare("SELECT nombre FROM docentes WHERE id = 'dper2'").get().nombre,
        "Per Dos",
        "y el resto de la plantilla ni se entera"
    );
});

test("un arreglo vacío de autorizaciones sí las quita: la ausencia no", async () => {
    const almacen = await import("../src/almacen.js");
    almacen.guardarDocente({ id: "dper1", materiasCapacitadas: [] });
    assert.equal(
        bd().prepare("SELECT count(*) n FROM docente_materia WHERE docente_id = 'dper1'").get().n,
        0
    );
});

test("un nombramiento nuevo se crea por la misma vía, y necesita categoría", async () => {
    const almacen = await import("../src/almacen.js");
    assert.throws(
        () => almacen.guardarDocente({ id: "dper3", nombre: "Per Tres" }),
        /necesita categoría/
    );
    const r = almacen.guardarDocente({
        id: "dper3", nombre: "Per Tres", categoria: "Asignatura", materiasCapacitadas: ["uu1"]
    });
    assert.equal(r.nuevo, true);
    assert.equal(r.autorizadas, 1);
    // El tope de materias por omisión es el del reglamento, no un número grande.
    assert.equal(bd().prepare("SELECT max_materias FROM docentes WHERE id = 'dper3'").get().max_materias, 3);
});

test("no se reparte una clase a quien no está autorizado para la materia", async () => {
    // El motor respeta lo que el departamento fija y no lo puede cambiar, así
    // que la clase saldría marcada como "docente no capacitado" y el horario
    // entero quedaría sin poder aplicarse.
    docente("dcat3", "Docente Cat 3");
    assert.throws(
        () =>
            enTransaccion((db) =>
                catalogoMod.asignar(db, {
                    carrera: "UUU", materiaId: "uu1", grupoClave: "1A", docenteId: "dcat3"
                })
            ),
        /Docente Cat 3 no está autorizado/
    );

    // Y no queda a medias: la transacción se deshizo entera.
    const c = await catalogoMod.porCarrera("UUU");
    assert.ok(!c.filas.some((f) => f.docenteId === "dcat3"));

    // Autorizándolo primero, que es el orden, entra sin problema.
    autorizar("dcat3", "uu1");
    enTransaccion((db) =>
        catalogoMod.asignar(db, {
            carrera: "UUU", materiaId: "uu1", grupoClave: "1A", docenteId: "dcat3"
        })
    );
    const despues = await catalogoMod.porCarrera("UUU");
    assert.equal(despues.filas.find((f) => f.grupoClave === "1A").docenteId, "dcat3");
});

test("repartir una materia entera es una sola escritura, no una por grupo", async () => {
    // A medias —la mitad de los grupos con una persona y la otra mitad con
    // otra— es peor que no haberlo hecho: nadie sabría que quedó así.
    const antes = bd().prepare("SELECT count(*) n FROM asignacion_historial").get().n;
    await assert.rejects(
        () => catalogoMod.asignarMateria({ carrera: "UUU", materiaId: "no-existe" }),
        /no imparte esa materia/
    );
    assert.equal(
        bd().prepare("SELECT count(*) n FROM asignacion_historial").get().n,
        antes,
        "una materia que no se imparte no debe dejar rastro"
    );
});

test("una carrera sin escenario no rompe el catálogo", async () => {
    guardarCarrera(bd(), "VVV", "Carrera V");
    const c = await catalogoMod.porCarrera("VVV");
    assert.equal(c.escenarioId, null);
    assert.deepEqual(c.filas, []);
});
