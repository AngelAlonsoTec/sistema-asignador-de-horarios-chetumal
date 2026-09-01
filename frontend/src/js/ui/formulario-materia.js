import { claveAId } from "../edicion.js";

/**
 * Diálogo de alta/edición de una materia. `abrir()` devuelve una promesa:
 * resuelve con la materia capturada al guardar, o con `null` si se cancela.
 */
export function crearFormularioMateria(el) {
    function abrir({ titulo, valores, especialidades }) {
        el.titulo.textContent = titulo;
        el.clave.value = valores?.clave ?? "";
        el.nombre.value = valores?.nombre ?? "";
        el.semestre.value = valores?.semestre ?? "";
        el.horas.value = valores?.horasSemana ?? "";
        el.creditos.value = valores?.creditos ?? "";
        llenarEspecialidades(el.especialidad, especialidades, valores?.especialidadId ?? null);
        el.error.hidden = true;

        el.dialogo.showModal();
        el.clave.focus();

        return new Promise((resolve) => {
            let guardado = false;

            function alEnviar(evento) {
                evento.preventDefault();
                try {
                    const materia = leer();
                    guardado = true;
                    el.dialogo.close();
                    resolve(materia);
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
        const clave = el.clave.value.trim().toUpperCase();
        const nombre = el.nombre.value.trim();
        if (!clave) throw new Error("La clave es obligatoria.");
        if (!nombre) throw new Error("El nombre es obligatorio.");

        return {
            id: claveAId(clave),
            clave,
            nombre,
            semestre: Number(el.semestre.value),
            horasSemana: Number(el.horas.value),
            creditos: Number(el.creditos.value),
            // "" es la opción "Tronco común": ausencia de especialidad, no un id vacío.
            especialidadId: el.especialidad.value || null
        };
    }

    el.cancelar.addEventListener("click", () => el.dialogo.close());

    return { abrir };
}

/** Tronco común es la opción por defecto: la mayoría de la retícula lo es. */
function llenarEspecialidades(select, especialidades, seleccionada) {
    const opciones = [crearOpcion("", "Tronco común")];
    for (const especialidad of especialidades) {
        opciones.push(crearOpcion(especialidad.id, especialidad.nombre));
    }
    select.replaceChildren(...opciones);
    select.value = seleccionada ?? "";
}

function crearOpcion(valor, texto) {
    const opcion = document.createElement("option");
    opcion.value = valor;
    opcion.textContent = texto;
    return opcion;
}
