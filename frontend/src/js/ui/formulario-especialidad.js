/**
 * Diálogo de alta/edición de una especialidad. `abrir()` devuelve una promesa:
 * resuelve con { nombre, materiaIds } al guardar, o con `null` si se cancela.
 *
 * La lista de materias se reconstruye cada vez que se abre, con las del
 * escenario en ese momento. Aparecen todas, no solo las libres: una materia
 * ya ligada a otra especialidad se puede mover a esta, y marcarla aquí la
 * desliga de la anterior (una materia pertenece a un solo módulo).
 */
export function crearFormularioEspecialidad(el) {
    function abrir({ titulo, valores, materias, especialidades }) {
        el.titulo.textContent = titulo;
        el.nombre.value = valores?.nombre ?? "";
        generarChecklist(el.materiasChecklist, materias, especialidades, valores?.id ?? null);
        el.error.hidden = true;

        el.dialogo.showModal();
        el.nombre.focus();

        return new Promise((resolve) => {
            let guardado = false;

            function alEnviar(evento) {
                evento.preventDefault();
                const nombre = el.nombre.value.trim();
                if (!nombre) {
                    el.error.textContent = "El nombre es obligatorio.";
                    el.error.hidden = false;
                    return;
                }
                guardado = true;
                el.dialogo.close();
                resolve({ nombre, materiaIds: seleccionadas(el.materiasChecklist) });
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

    el.cancelar.addEventListener("click", () => el.dialogo.close());

    return { abrir };
}

/**
 * Materias agrupadas por semestre, igual que en el formulario de docente.
 * Las que ya pertenecen a otra especialidad se anotan con su nombre, para
 * que marcarlas sea una decisión informada y no un robo silencioso.
 */
function generarChecklist(contenedor, materias, especialidades, especialidadActual) {
    const nombrePorId = new Map(especialidades.map((e) => [e.id, e.nombre]));
    const porSemestre = new Map();

    for (const materia of materias) {
        if (!porSemestre.has(materia.semestre)) porSemestre.set(materia.semestre, []);
        porSemestre.get(materia.semestre).push(materia);
    }

    const grupos = [...porSemestre]
        .sort(([a], [b]) => a - b)
        .map(([semestre, delSemestre]) => {
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
                casilla.checked = materia.especialidadId === especialidadActual
                    && especialidadActual !== null;

                etiqueta.append(casilla, document.createTextNode(`${materia.clave} · ${materia.nombre}`));

                const otra = materia.especialidadId && materia.especialidadId !== especialidadActual;
                if (otra) {
                    const nota = document.createElement("span");
                    nota.className = "materia-check-nota";
                    nota.textContent = nombrePorId.get(materia.especialidadId) ?? "otra especialidad";
                    etiqueta.appendChild(nota);
                }

                grupo.appendChild(etiqueta);
            }

            return grupo;
        });

    contenedor.replaceChildren(...(grupos.length ? grupos : [avisoVacio()]));
}

function seleccionadas(contenedor) {
    return [...contenedor.querySelectorAll("input:checked")].map((casilla) => casilla.value);
}

function avisoVacio() {
    const aviso = document.createElement("p");
    aviso.className = "empty-state";
    aviso.textContent = "Este escenario todavía no tiene materias que agrupar.";
    return aviso;
}
