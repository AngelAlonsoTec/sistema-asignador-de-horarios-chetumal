/**
 * Importación de disponibilidad desde CSV.
 *
 * Es para cargas masivas: cuando las respuestas ya están en una hoja de cálculo
 * y transcribirlas una por una no tiene sentido. Se eligió CSV y no `.xlsx`
 * porque un xlsx es un ZIP con XML dentro —unas cuatrocientas líneas frágiles—
 * mientras que Excel exporta CSV con un clic y se lee en treinta.
 *
 * Formato: una fila por docente, una columna por día. La primera columna
 * identifica al docente por id o por nombre. Las celdas llevan el rango en
 * cualquiera de estas formas, y vacío significa que ese día no puede:
 *
 *     docente,lunes,martes,miercoles,jueves,viernes
 *     doc001,7-14,7-14,,7-14,7-12
 *     Ricardo Nava Cortés,14:00-22:00,14-22,14-22,,
 */

import { bd, enTransaccion } from "./bd.js";
import { ErrorHttp } from "./http.js";

const DIAS = ["lunes", "martes", "miercoles", "jueves", "viernes"];

/**
 * Divide una línea respetando las comillas: un nombre con coma dentro es lo
 * normal en estos archivos y partir por `,` a secas lo rompería.
 */
function celdas(linea) {
    const salida = [];
    let actual = "";
    let entreComillas = false;

    for (let i = 0; i < linea.length; i++) {
        const c = linea[i];
        if (c === '"') {
            if (entreComillas && linea[i + 1] === '"') {
                actual += '"';
                i++;
            } else {
                entreComillas = !entreComillas;
            }
        } else if (c === "," && !entreComillas) {
            salida.push(actual.trim());
            actual = "";
        } else {
            actual += c;
        }
    }
    salida.push(actual.trim());
    return salida;
}

/** "7-14", "07:00-14:00", "7 a 14" -> {inicio, fin}. Vacío o ilegible -> null. */
function rango(celda) {
    if (!celda) return null;
    const numeros = celda.match(/\d{1,2}/g);
    if (!numeros || numeros.length < 2) return null;

    const inicio = Number(numeros[0]);
    // "07:00-14:00" da [07, 00, 14, 00]: la hora de fin es el tercer número.
    const fin = Number(numeros.length >= 4 ? numeros[2] : numeros[1]);

    if (!Number.isInteger(inicio) || !Number.isInteger(fin)) return null;
    if (inicio < 0 || fin > 24 || fin <= inicio) return null;
    return { inicio, fin };
}

const normalizar = (texto) =>
    texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

export function importarCsv(texto) {
    const lineas = String(texto ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

    if (lineas.length < 2) throw new ErrorHttp(400, "El archivo no tiene filas de datos.");

    const encabezado = celdas(lineas[0]).map(normalizar);
    const columnas = DIAS.map((dia) => encabezado.indexOf(dia)).map((i, n) => ({
        dia: DIAS[n],
        indice: i
    }));

    const conocidos = columnas.filter((c) => c.indice !== -1);
    if (conocidos.length === 0) {
        throw new ErrorHttp(
            400,
            `Ninguna columna coincide con un día. Se esperaba alguna de: ${DIAS.join(", ")}.`
        );
    }

    const db = bd();
    const docentes = db.prepare("SELECT id, nombre FROM docentes").all();
    const porId = new Map(docentes.map((d) => [normalizar(d.id), d.id]));
    const porNombre = new Map(docentes.map((d) => [normalizar(d.nombre), d.id]));

    const aplicados = [];
    const ignorados = [];

    for (const linea of lineas.slice(1)) {
        const campos = celdas(linea);
        const clave = normalizar(campos[0] ?? "");
        const docenteId = porId.get(clave) ?? porNombre.get(clave);

        if (!docenteId) {
            ignorados.push({ fila: campos[0] || "(vacía)", motivo: "docente desconocido" });
            continue;
        }

        const bloques = [];
        for (const { dia, indice } of conocidos) {
            const r = rango(campos[indice]);
            if (r) bloques.push({ dia, ...r });
        }

        if (bloques.length === 0) {
            ignorados.push({ fila: campos[0], motivo: "sin ningún día legible" });
            continue;
        }
        aplicados.push({ docenteId, nombre: campos[0], bloques });
    }

    // Se escribe todo junto: una importación a medias deja la plantilla en un
    // estado que nadie pidió.
    enTransaccion((tx) => {
        const borrar = tx.prepare(
            "DELETE FROM docente_horario WHERE docente_id = ? AND tipo = 'declarada'"
        );
        const ins = tx.prepare(
            "INSERT INTO docente_horario (docente_id, tipo, dia, inicio, fin) VALUES (?, 'declarada', ?, ?, ?)"
        );
        const marcar = tx.prepare(
            `INSERT INTO docente_token (docente_id, token, creado, contestado)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(docente_id) DO UPDATE SET contestado = excluded.contestado`
        );

        for (const { docenteId, bloques } of aplicados) {
            borrar.run(docenteId);
            for (const b of bloques) ins.run(docenteId, b.dia, b.inicio, b.fin);
            marcar.run(docenteId, `importado-${docenteId}`, new Date().toISOString(), new Date().toISOString());
        }
    });

    return {
        aplicados: aplicados.map((a) => ({ docenteId: a.docenteId, dias: a.bloques.length })),
        ignorados,
        diasReconocidos: conocidos.map((c) => c.dia)
    };
}
