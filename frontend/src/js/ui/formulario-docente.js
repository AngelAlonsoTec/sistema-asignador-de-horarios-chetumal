const DIAS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes"];

/**
 * Diálogo de alta/edición de un docente. `abrir()` devuelve una promesa:
 * resuelve con el docente capturado al guardar, o con `null` si se cancela.
 *
 * La lista de "materias que puede impartir" se reconstruye cada vez que se
 * abre, con las materias del escenario en ese momento: si se agregó o borró
 * una materia, el formulario del docente debe reflejarlo.
 */
export function crearFormularioDocente(el) {
    generarDias(el.diasPreferidos);
    generarDias(el.diasEvitar);

    function abrir({ titulo, valores, materias }) {
        el.titulo.textContent = titulo;
        el.nombre.value = valores?.nombre ?? "";
        el.categoria.value = valores?.categoria ?? "Titular";
        el.nivel.value = valores?.nivel ?? "A";
        el.horasMin.value = valores?.horasMin ?? 20;
        el.horasMax.value = valores?.horasMax ?? 24;
        el.maxMaterias.value = valores?.maxMaterias ?? 4;
        el.maxGrupos.value = valores?.maxGrupos ?? 5;
        el.antiguedad.value = valores?.antiguedad ?? "";
        el.carreraBase.value = valores?.carreraBase ?? "";
        el.otraArea.checked = valores?.esDeOtraArea ?? false;
        el.turno.value = valores?.disponibilidad?.turno ?? "matutino";
        el.horasEvitar.value = (valores?.disponibilidad?.horasEvitar ?? []).join(", ");
        marcarDias(el.diasPreferidos, valores?.disponibilidad?.diasPreferidos ?? []);
        marcarDias(el.diasEvitar, valores?.disponibilidad?.diasEvitar ?? []);
        generarChecklistMaterias(el.materiasChecklist, materias, valores?.materiasCapacitadas ?? []);
        el.error.hidden = true;

        el.dialogo.showModal();
        el.nombre.focus();

        return new Promise((resolve) => {
            let guardado = false;

            function alEnviar(evento) {
                evento.preventDefault();
                try {
                    const docente = leer();
                    guardado = true;
                    el.dialogo.close();
                    resolve(docente);
                } catch (error) {
                    el.error.textContent = error.message;
                    el.error.hidden = false;
                }
            }

            function alCerrar() {
                el.form.removeEventListener("submit", alEnviar);
                el.dialogo.removeEventListener("close", alCerrar);
                if (!guardado) resolve(null);
            }

            el.form.addEventListener("submit", alEnviar);
            el.dialogo.addEventListener("close", alCerrar);
        });
    }

    function leer() {
        const nombre = el.nombre.value.trim();
        const horasMin = Number(el.horasMin.value);
        const horasMax = Number(el.horasMax.value);
        if (!nombre) throw new Error("El nombre es obligatorio.");
        if (horasMin > horasMax) throw new Error("Las horas mínimas no pueden superar a las máximas.");

        return {
            nombre,
            categoria: el.categoria.value,
            nivel: el.nivel.value,
            horasMin,
            horasMax,
            maxMaterias: Number(el.maxMaterias.value),
            maxGrupos: Number(el.maxGrupos.value),
            antiguedad: Number(el.antiguedad.value) || undefined,
            carreraBase: el.carreraBase.value.trim(),
            esDeOtraArea: el.otraArea.checked,
            disponibilidad: {
                turno: el.turno.value,
                diasPreferidos: diasMarcados(el.diasPreferidos),
                diasEvitar: diasMarcados(el.diasEvitar),
                horasEvitar: el.horasEvitar.value
                    .split(",")
                    .map((hora) => hora.trim())
                    .filter(Boolean)
            },
            materiasCapacitadas: materiasMarcadas(el.materiasChecklist)
        };
    }

    el.cancelar.addEventListener("click", () => el.dialogo.close());

    return { abrir };
}

// ---------- días ----------

function generarDias(contenedor) {
    contenedor.replaceChildren(
        ...DIAS.map((dia) => {
            const etiqueta = document.createElement("label");
            etiqueta.className = "dia-check";

            const casilla = document.createElement("input");
            casilla.type = "checkbox";
            casilla.value = dia;

            etiqueta.append(casilla, document.createTextNode(dia));
            return etiqueta;
        })
    );
}

function marcarDias(contenedor, dias) {
    const activos = new Set(dias);
    for (const casilla of contenedor.querySelectorAll("input")) {
        casilla.checked = activos.has(casilla.value);
    }
}

function diasMarcados(contenedor) {
    return [...contenedor.querySelectorAll("input:checked")].map((casilla) => casilla.value);
}

// ---------- materias que puede impartir ----------

function generarChecklistMaterias(contenedor, materias, capacitadas) {
    const activas = new Set(capacitadas);
    const porSemestre = new Map();

    for (const materia of materias) {
        if (!porSemestre.has(materia.semestre)) porSemestre.set(materia.semestre, []);
        porSemestre.get(materia.semestre).push(materia);
    }

    const grupos = [...porSemestre].sort(([a], [b]) => a - b).map(([semestre, delSemestre]) => {
        const grupo = document.createElement("fieldset");
        grupo.className = "materias-checklist-grupo";

        const leyenda = document.createElement("legend");
        leyenda.textContent = `Semestre ${semestre}`;
        grupo.appendChild(leyenda);

        for (const materia of delSemestre) {
            const etiqueta = document.createElement("label");
            etiqueta.className = "materia-check";

            const casilla = document.createElement("input");
            casilla.type = "checkbox";
            casilla.value = materia.id;
            casilla.checked = activas.has(materia.id);

            etiqueta.append(casilla, document.createTextNode(`${materia.clave} · ${materia.nombre}`));
            grupo.appendChild(etiqueta);
        }

        return grupo;
    });

    contenedor.replaceChildren(
        ...(grupos.length ? grupos : [crearAvisoSinMaterias()])
    );
}

function materiasMarcadas(contenedor) {
    return [...contenedor.querySelectorAll("input:checked")].map((casilla) => casilla.value);
}

function crearAvisoSinMaterias() {
    const aviso = document.createElement("p");
    aviso.className = "empty-state";
    aviso.textContent = "Este escenario todavía no tiene materias.";
    return aviso;
}
