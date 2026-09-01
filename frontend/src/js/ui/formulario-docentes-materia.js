/**
 * Diálogo para elegir qué docentes pueden impartir una materia. Es la vista
 * inversa del checklist de "materias que puede impartir" del formulario de
 * docente: escribe exactamente el mismo `materiasCapacitadas`, solo que
 * partiendo de la materia. Sirve para tapar un hueco de cobertura sin tener
 * que adivinar en cuál de los N docentes hay que entrar.
 *
 * `abrir()` resuelve con el arreglo de ids de docente elegidos, o con `null`
 * si se cancela.
 */
export function crearFormularioDocentesMateria(el) {
    function abrir({ materia, docentes }) {
        el.titulo.textContent = `Docentes para ${materia.clave}`;
        el.nota.textContent = materia.nombre;
        generarChecklist(el.checklist, docentes, materia.id);

        el.dialogo.showModal();

        return new Promise((resolve) => {
            let guardado = false;

            function alEnviar(evento) {
                evento.preventDefault();
                guardado = true;
                el.dialogo.close();
                resolve(seleccionados(el.checklist));
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
 * Los docentes de otra área van primero: por regla del departamento eligen
 * horario antes, así que son los candidatos que el coordinador revisa primero.
 */
function generarChecklist(contenedor, docentes, materiaId) {
    if (docentes.length === 0) {
        contenedor.replaceChildren(avisoVacio());
        return;
    }

    const ordenados = [...docentes].sort((a, b) =>
        Number(b.esDeOtraArea) - Number(a.esDeOtraArea) || a.nombre.localeCompare(b.nombre)
    );

    contenedor.replaceChildren(...ordenados.map((docente) => {
        const etiqueta = document.createElement("label");
        etiqueta.className = "materia-check";

        const casilla = document.createElement("input");
        casilla.type = "checkbox";
        casilla.value = docente.id;
        casilla.checked = docente.materiasCapacitadas.includes(materiaId);

        etiqueta.append(casilla, document.createTextNode(docente.nombre));

        const nota = document.createElement("span");
        nota.className = "materia-check-nota";
        nota.textContent = docente.esDeOtraArea
            ? `${docente.carreraBase} (otra área)`
            : `${docente.materiasCapacitadas.length} materias`;
        etiqueta.appendChild(nota);

        return etiqueta;
    }));
}

function seleccionados(contenedor) {
    return [...contenedor.querySelectorAll("input:checked")].map((casilla) => casilla.value);
}

function avisoVacio() {
    const aviso = document.createElement("p");
    aviso.className = "empty-state";
    aviso.textContent = "Este escenario todavía no tiene docentes que asignar.";
    return aviso;
}
