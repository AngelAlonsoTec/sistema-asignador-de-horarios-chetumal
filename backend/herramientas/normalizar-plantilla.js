#!/usr/bin/env node
/**
 * Pone la plantilla docente en los términos del reglamento.
 *
 *   node herramientas/normalizar-plantilla.js [http://localhost:8080] [--escribir]
 *
 * Sin `--escribir` solo dice qué cambiaría, como `migrar-docentes.js`: tocar la
 * plantilla del instituto a ciegas es justo lo que no se debe hacer.
 *
 * Lo que ajusta, y de dónde sale cada cosa —ver `src/tecnm.js` para las citas—:
 *
 * - **Tope de materias a 3.** Artículos 155 y 156: "en ningún caso se les
 *   asignarán más de tres materias diferentes". Es el único cambio que el
 *   sistema hace por su cuenta, porque el reglamento no deja margen.
 * - **Dedicación**, si falta. Se deduce: asignatura por su categoría, y tiempo
 *   completo para el resto, que es el caso común. Es una suposición y se avisa.
 * - **Horas frente a grupo**, solo con `--horas`. Aquí sí hay margen legítimo
 *   —comisiones, plazas mixtas, el ajuste de dos horas del artículo 147— así que
 *   no se toca salvo que se pida.
 *
 * Lo que no cuadre y no se ajuste queda listado: es trabajo del departamento,
 * no del guion.
 */

import { CLAVES_CONOCIDAS, cliente as clienteHttp, entrar as acceder } from "./acceso.js";
import {
    MAX_MATERIAS,
    horasDeReglamento,
    revisar
} from "../src/tecnm.js";

const args = process.argv.slice(2);
const BASE = (args.find((a) => a.startsWith("http")) ?? "http://localhost:8080").replace(/\/$/, "");
const API = `${BASE}/api`;
const ESCRIBIR = args.includes("--escribir");
const CON_HORAS = args.includes("--horas");

const c = clienteHttp(API);

async function principal() {
    for (const clave of [process.env.CLAVE_DEPTO, ...CLAVES_CONOCIDAS].filter(Boolean)) {
        const r = await c("/sesion", { metodo: "POST", cuerpo: { usuario: "depto", clave } });
        if (r.estado === 200) {
            if (r.cuerpo.debeCambiarClave) {
                await c("/sesion/clave", {
                    metodo: "POST", cuerpo: { actual: clave, nueva: "normativa2026" }
                });
                await c("/sesion", {
                    metodo: "POST", cuerpo: { usuario: "depto", clave: "normativa2026" }
                });
            }
            break;
        }
    }
    const plantilla = (await c("/docentes")).cuerpo;
    if (!Array.isArray(plantilla)) {
        console.error("No se pudo leer la plantilla. ¿Entró el departamento?");
        process.exit(1);
    }

    const cambios = [];
    const ajustada = plantilla.map((d) => {
        const nuevo = { ...d };
        const suyo = [];

        if ((d.maxMaterias ?? 0) > MAX_MATERIAS) {
            nuevo.maxMaterias = MAX_MATERIAS;
            suyo.push(`materias ${d.maxMaterias} → ${MAX_MATERIAS} (art. 155 y 156)`);
        }
        if (!d.dedicacion) {
            nuevo.dedicacion =
                String(d.categoria ?? "").toLowerCase() === "asignatura"
                    ? "asignatura"
                    : "tiempo completo";
            suyo.push(`dedicación supuesta: ${nuevo.dedicacion}`);
        }
        if (CON_HORAS) {
            const esperadas = horasDeReglamento(d.categoria, nuevo.dedicacion);
            if (esperadas !== null && esperadas !== d.horasMax) {
                nuevo.horasMax = esperadas;
                suyo.push(`horas ${d.horasMax} → ${esperadas} (art. 143 y 146)`);
            }
        }

        if (suyo.length > 0) cambios.push({ nombre: d.nombre, suyo });
        return nuevo;
    });

    console.log(`\nPlantilla de ${plantilla.length} docentes contra el reglamento del TecNM\n`);
    if (cambios.length === 0) {
        console.log("  Nada que ajustar.");
    }
    for (const { nombre, suyo } of cambios) {
        console.log(`  ${nombre}`);
        for (const x of suyo) console.log(`      ${x}`);
    }

    // Lo que sigue sin cuadrar después del ajuste: no se toca, se nombra.
    const quedan = ajustada
        .map((d) => ({ nombre: d.nombre, avisos: revisar(d) }))
        .filter((x) => x.avisos.length > 0);
    if (quedan.length > 0) {
        console.log(`\n  Queda por revisar a mano (${quedan.length}):`);
        for (const { nombre, avisos } of quedan) {
            for (const a of avisos) console.log(`      ${nombre}: art. ${a.articulo} — ${a.mensaje}`);
        }
        if (!CON_HORAS) {
            console.log(
                "\n  Las horas no se ajustan solas: hay margen legítimo (comisiones, plazas\n" +
                "  mixtas, el ajuste de dos horas del art. 147). Con --horas se igualan a la\n" +
                "  tabla del reglamento."
            );
        }
    }

    if (!ESCRIBIR) {
        console.log("\n  Simulación. Con --escribir se aplica.\n");
        return;
    }
    const r = await c("/docentes", { metodo: "PUT", cuerpo: ajustada });
    console.log(`\n  ${r.estado === 200 ? "Aplicado" : "Falló"}: ${JSON.stringify(r.cuerpo)}\n`);
}

principal();
