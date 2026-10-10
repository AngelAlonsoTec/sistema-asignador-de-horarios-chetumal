# Reestructuración de SchedulAI

Plan de trabajo para pasar de una herramienta de datos de una carrera a un
sistema de coordinación con plantilla docente compartida.

Documento vivo: se actualiza conforme avanzan las fases. El `README.md` describe
lo que el sistema **hace hoy**; este describe lo que **va a cambiar**.

---

## Por qué cambia

Los cinco requisitos nuevos no son cinco funciones sueltas. Son síntomas de una
sola inversión:

> Hoy el docente vive **dentro** del escenario de una carrera.
> En la realidad el docente es del instituto y las carreras **compiten** por sus horas.

La hoja de saturación de horas catedrático no es un reporte: es el **estado
compartido** sobre el que escriben varios coordinadores. Si ISIC ocupa el lunes
de 7 a 11 de un docente, TI ya no puede.

Mientras el docente sea propiedad del escenario, ningún campo nuevo resuelve
eso. Todo lo demás se ordena a partir de esta inversión.

---

## Decisiones tomadas

| Tema | Decisión | Consecuencia |
|---|---|---|
| Contención entre carreras | Todos en borrador; se concilia al final, con **cesión de horas** entre coordinadores | Hace falta identidad: para que A le pida a B, el sistema debe saber quién es cada uno |
| Alcance | Multi-carrera; un coordinador lleva **de 1 a N carreras** | El modelo es usuario → carreras, no usuario = carrera |
| Disponibilidad docente | **Formulario nativo** en la app, más importación de archivo | Sin credenciales de Google ni red saliente |
| Almacenamiento | `node:sqlite` | Verificado en Node 26 sin aviso experimental; transaccional, un solo archivo, **sin dependencias externas** |
| Importación | CSV | Un `.xlsx` es un ZIP con XML: ~400 líneas frágiles. Excel exporta CSV con un clic y se lee en 30 |
| Horas descarga | Las carga el **departamento académico** | Ni el coordinador ni el docente las editan. Son dato de entrada, igual que la autorización materia-docente |

### Por qué los JSON planos dejan de servir

Hoy `backend/src/almacen.js` escribe JSON con `rename` atómico. Funciona porque
hay **un** usuario. Con varios coordinadores tocando la misma plantilla docente,
dos guardados se pisan y el último gana en silencio.

`node:sqlite` resuelve la concurrencia sin romper la política de cero
dependencias del backend, y el archivo `.db` sigue siendo tan portable como los
JSON actuales.

**Corrección tras medirlo (2026-09-14):** resuelve que la base quede a medias, no
que un cambio se pierda. Con escrituras simultáneas reales —doce asignaciones a
la vez, dos coordinaciones apartando a la vez, seis guardados de la plantilla
completa— todo entra y la integridad aguanta. Pero `PUT /api/docentes` manda la
plantilla **entera**: dos personas editando a dos docentes distintos al mismo
tiempo siguen pisándose, y gana el último. El riesgo es acotado desde que solo el
departamento la escribe, pero la frase original prometía más de lo que el cambio
daba.

---

## Modelo de datos: antes y después

### Hoy

```
carrera/
  aulas.json
  escenarios/<id>/
    materias.json  docentes.json  semestres.json  especialidades.json
```

El docente pertenece al escenario. Dos carreras que comparten un docente tienen
**dos copias distintas** de esa persona.

### Después

```
instituto
├── docentes            plantilla única, del instituto
│   ├── autorizacion    materia ← departamento académico (punto 1)
│   ├── disponibilidad  declarada por el docente (punto 2)
│   └── descargas       horas administrativas (punto 3)
├── periodos            Agosto-Diciembre 2026, paridad, rejilla
├── saturacion          docente × periodo × día × hora  ← la hoja
├── carreras
│   └── escenarios      materias, especialidades, grupos  (lo que ya existe)
└── usuarios            coordinador → 1..N carreras
```

### La saturación

Una celda por docente, día y hora, en uno de cuatro estados:

| Estado | Origen | Quién lo edita |
|---|---|---|
| `no_declarada` | El docente no la ofreció | Nadie |
| `descarga` | Comisión administrativa | Departamento académico |
| `libre` | El gris de la hoja | — |
| `pretendida` / `ocupada` | Un escenario de carrera la tomó | Coordinador dueño |

**Esto simplifica el motor.** Hoy la disponibilidad son cuatro conceptos sueltos
—`turno`, `diasEvitar`, `horasEvitar` y sus tres penalizaciones— que pasan a ser
una **máscara de bits** por (docente, día, hora): disponible o no. Más expresiva
y más barata de evaluar.

---

## Fases

### Fase 0 — Ajustes del motor · **HECHA** (2026-09-11)

| Cambio | Estado | Detalle |
|---|---|---|
| Tope de 3 h/día | Hecho | `MAX_HORAS_POR_DIA` de 2 a 3 en `backend/src/problema.js` |
| Preferir 1-2 h | Hecho, **distinto a lo planeado** | Ver abajo |
| Fusión en el motor | Hecho | `Sesion.grupo` pasó a `Sesion.grupos: Vec<usize>` |

**El plan decía penalización blanda para el bloque de 3 h; no era la solución.**
El reparto es determinista: si el tope sube a 3, una materia de 5 h se parte en
3+2 antes de que la aptitud pueda opinar, y penalizar después no deshace un
bloque ya creado. La preferencia tenía que expresarse al **construir** los
bloques, no al evaluarlos.

`tope_para()` en `modelo.rs` busca el bloque más corto que permita repartir las
horas en los días disponibles: usa 2 mientras alcancen los cinco días hábiles y
sube a 3 solo cuando no alcanzan — a partir de 11 h semanales. Cero pesos
nuevos en la función de aptitud.

Verificado: con los datos reales todas las materias siguen en bloques de 1-2 h;
una materia forzada a 12 h salió 3+3+3+3 en cuatro días.

La fusión funciona en el motor pero **no es usable de verdad** hasta que existan
grupos de otras carreras (fase 2). Probada fusionando dos grupos del mismo
semestre: 4 sesiones de Taller de Ética pasaron a 2, con el mismo docente y la
misma aula, apareciendo en el horario de ambos grupos.

Falta la **capacidad del aula**: al juntar dos grupos hay que saber si caben.

### Fase 1 — El docente sale del escenario · **HECHA** (2026-09-11)

| Paso | Estado |
|---|---|
| Plantilla docente institucional | Hecho |
| Disponibilidad como máscara de horas | Hecho |
| Descargas administrativas respetadas | Hecho |
| Entidad `saturacion` | Hecho |
| Vista de la hoja de saturación | Hecho |

**Hecho (2026-09-11).** El docente vive en `data/docentes.json`, fuera de los
escenarios; `GET`/`PUT /api/docentes` lo administran. `disponibilidad` pasó de
`{turno, diasEvitar, horasEvitar}` a bloques declarados por día, y el motor
recibe una **máscara de horas** con las descargas ya descontadas.

Eso quitó tres conceptos del motor y dejó uno: `fueraDeTurnoDocente` y
`diaEvitado` desaparecieron, y en su lugar hay `horaNoDisponible`, que es
**dura**. Una hora que el docente no declaró deja de ser una molestia y pasa a
ser imposible, que es lo correcto.

Verificado: ambas paridades factibles, cero horas asignadas fuera de la
disponibilidad, cero clases encima de una descarga administrativa.

**La migración tenía un defecto y se corrigió.** El criterio de desempate entre
escenarios era "gana la versión que más materias autoriza", y eso eligió datos
viejos: un docente tenía cuatro materias en el escenario antiguo y dos en el
nuevo, así que se quedó con el turno equivocado y su materia se volvió
imposible de programar. Ahora gana **el escenario más reciente**, según la fecha
del manifiesto. `backend/herramientas/migrar-docentes.js` tiene modo simulación
(sin `--escribir`) justamente para ver esto antes de aplicar.

**La saturación.** `data/saturacion.json` guarda quién apartó qué hora de qué
docente, para qué grupo y en qué periodo. Un escenario **aparta** sus horas con
`PUT /api/carreras/:c/escenarios/:id/reserva` y las suelta con `DELETE`.

Al armar un horario se descuentan las horas que **otros** escenarios pretenden;
las propias no, porque se están reemplazando. Ese descuento es todo el mecanismo
de reparto entre carreras.

La vista es la sección **Saturación docente**: una rejilla por docente con los
cuatro estados —no declarada, descarga, libre, apartada— y quién tomó cada hora.
Es el Excel que hoy viaja por correo, con dueño.

Probado de punta a punta: el caso base apartó 56 sesiones (103 h de 16
docentes), la capacidad efectiva del otro escenario bajó de 565 a 462 h, apareció
el aviso, y el motor marcó como imposibles las 4 horas que ya no cabían. Ese
conflicto es justo lo que el coordinador necesita ver para ir a pedir horas.

**Lo que aún no existe** es el otro lado de ese conflicto: pedir y ceder. Eso es
la fase 3, y necesita identidad.

### Fase 2 — SQLite e identidad · **HECHA** (2026-09-11)

| Paso | Estado |
|---|---|
| Esquema y migración a SQLite | Hecho |
| Usuarios, contraseñas y sesiones | Hecho |
| `usuario → 1..N carreras` | Hecho |
| Segunda carrera para probar la contención | Hecho |

**SQLite.** `data/schedulai.db` sustituye a los JSON, con `node:sqlite` y sin
dependencias nuevas. `almacen.js` se reescribió entero pero **conservando su
interfaz**, así que las rutas no cambiaron: el resto del backend no se enteró.
Los JSON quedan como respaldo.

Las escrituras que borran y reinsertan —la plantilla docente, un escenario, una
reserva— van en transacción. Eso es lo que evita que dos guardados simultáneos
dejen la base a medias. Que un documento completo pise el cambio de otro es un
problema distinto, y la transacción no lo resuelve: se arregló después, dándole
ruta propia a cada nombramiento —ver *Un nombramiento a la vez*—.

**Identidad.** `scrypt` para las contraseñas y bytes aleatorios para el token de
sesión, todo con `node:crypto`. La cookie es `HttpOnly` y `SameSite=Lax`. La
comprobación de sesión vive en `server.js`, en un solo punto: una ruta nueva
nace protegida salvo que se declare abierta a propósito.

Un detalle que importa: al autenticar se deriva el hash **aunque el usuario no
exista**, para que un nombre inválido y una contraseña mala tarden lo mismo. Y
la comparación es en tiempo constante.

**Multi-carrera.** `usuario_carrera` define qué lleva cada quien. Un coordinador
solo ve y opera sus carreras; la hoja de saturación la ve completa, que es el
punto.

**Probado con dos carreras de verdad.** Se sembró ITIC con diez materias que
comparte con ISIC y su propio coordinador. El de TI generó su horario y apartó
26 sesiones; el de ISIC vio su capacidad caer de 565 a 519 h con el aviso
correspondiente, y al pedir las aulas de ITIC recibió *"No coordinas ITIC"*.

Hasta ahora la contención se demostraba con dos escenarios de la misma carrera,
que en la realidad no compiten: uno reemplaza al otro. Ahora son dos carreras
distintas peleándose los mismos docentes de ciencias básicas.

**Y apareció el conflicto que motiva la fase 3.** Con ITIC apartando primero,
el horario de ISIC ya no es factible: quedan una a tres horas imposibles según
la semilla, y con cinco semillas distintas el problema no desaparece. No es
ruido del algoritmo: ITIC se llevó 13 h de Héctor Loera, el único docente de
humanidades, y ISIC no tiene dónde poner algunas de sus clases.

Hoy el sistema **detecta y nombra** ese conflicto, que ya es más de lo que había.
Lo que falta es poder resolverlo dentro de la app: que el coordinador de ISIC le
pida esas horas al de TI y este ceda o rechace. Eso es la fase 3.

### Fase 3 — Conciliación y cesión · **HECHA** (2026-09-11)

**Primero hubo que cambiar el modelo.** Hasta la fase 2, quien apartaba primero
**bloqueaba**: las horas ajenas se restaban de la disponibilidad y la segunda
carrera no podía ni proponerlas. Eso no es "todos en borrador"; es "primero en
llegar, gana", y convertía un desacuerdo en un horario imposible.

Ahora las horas ajenas **no se restan**. Viajan al motor como `enDisputa`, con su
propia penalización dura (400) por debajo de la de indisponibilidad (900). El
orden que eso impone es el correcto:

1. Horas libres de verdad.
2. Si no alcanzan, horas que otra carrera pretende — quedan como conflicto.
3. Nunca una hora que el docente no declaró.

Y `horaEnDisputa` **no cuenta para la factibilidad**: el horario se puede aplicar
si el otro coordinador cede.

**El protocolo.** `detectarConflictos` compara la reserva propia contra las
ajenas y agrupa por clase, no por hora suelta: lo que el coordinador ve es "esta
clase mía choca con alguien". De ahí sale una solicitud con motivo, que el otro
**cede o rechaza** desde su bandeja.

Aceptar **libera de verdad**: borra de la reserva de quien cede los bloques que
se solapan. Si no, "aceptar" sería un gesto sin efecto y el conflicto seguiría
ahí. Se cede el bloque completo, porque lo que se cede es una clase, no media.

Probado de punta a punta entre ISIC e ITIC: conflicto detectado → solicitud con
motivo → repetirla se rechaza → ISIC no puede responderse a sí mismo → ITIC la ve
en su bandeja y cede → se libera 1 bloque → **el conflicto desaparece para los
dos**.

La vista es la sección **Conciliación**: lo que te piden arriba, tus choques en
medio, y el historial de lo que has pedido con la respuesta de cada quien. Es la
conversación de pasillo con registro, que es lo que falta cuando alguien dice
"pero si tú me la habías cedido".

### Fase 4 — Disponibilidad declarada · **HECHA** (2026-09-11)

| Paso | Estado |
|---|---|
| Formulario del docente con enlace personal | Hecho |
| Importación CSV | Hecho |
| Descargas restringidas al departamento | Hecho |

**El enlace personal.** Cada docente tiene un token largo y aleatorio; con él
abre `?disponibilidad=TOKEN` y declara su horario **sin cuenta ni contraseña**.
El token *es* la credencial y solo abre su propia hoja: probado que desde ahí
`GET /api/docentes` responde 401.

Enviar vacío se rechaza y no borra nada, que es el error caro de un formulario
así. Los bloques mal formados se descartan uno a uno en vez de tumbar el envío:
un día mal escrito no debería obligar al docente a empezar de nuevo.

**La importación.** CSV ancho —una fila por docente, una columna por día—, que
es la forma que sale de un formulario. Reconoce al docente por id o por nombre,
acepta `7-14`, `07:00-14:00` o `7 a 14`, respeta las comillas para los nombres
con coma, y **reporta lo que ignoró y por qué** en vez de fallar en silencio.
Todo en una transacción: una importación a medias dejaría la plantilla en un
estado que nadie pidió.

**Las descargas.** `PUT /api/docentes/:id/descargas`, restringido al rol
`departamento`. Probado: el coordinador recibe *"Las descargas las carga el
departamento académico"*. Se creó el usuario `depto` con ese rol.

Cierra los puntos 2 y 3 de los requisitos originales.

---

## Impacto medido

Conteo real del código actual, no estimación:

| Componente | Líneas | Se conserva | Cambia | Crece |
|---|---:|---:|---:|---:|
| Motor (Rust) | 3 059 | ~80% | ~20% | poco |
| Backend (Node) | 1 288 | ~50% | ~50% | +150% |
| Frontend (Vue) | 2 972 | ~65% | ~35% | +100% |
| Enfoque del producto | — | — | ~85% | — |

De unas 7 900 líneas a **15 000-16 000**. Es prácticamente un producto nuevo
construido sobre el mismo núcleo.

### Lo que sobrevive íntegro

Lo más caro de construir no se toca:

- **El motor memético completo**: cromosoma, operadores, búsqueda local dirigida,
  modelo de islas y su paralelismo. `json.rs`, `http.rs`, `azar.rs`, `islas.rs`,
  `main.rs` y `bin/salud.rs` — 1 112 de 3 059 líneas — quedan intactos.
- El shell de la interfaz, el sistema de diseño y la marca.
- La rejilla de horario semanal.
- Los tres servicios y el pipeline de Docker.

---

## Pendientes de decisión

- **Capacidad de aula**: la fusión la necesita. Hoy `Aula` es `{id, clave, tipo}`
  a propósito.
- **Aulas compartidas entre carreras**: ya estaba anotado como limitación; con
  varias carreras deja de ser hipotético.
- **Jefe de departamento**: fuera de alcance por ahora, pero el modelo de
  usuarios de la fase 2 debería dejarle sitio.

---

## Orden recomendado

**Las cinco fases están hechas**, los cuatro pendientes que quedaron anotados al
terminarlas, las tres ideas que quedaron después de esos, los tres huecos que
salieron de auditar el código, los cinco puntos que quedaban tras ellos, el
endurecimiento para uso real, la fusión entre carreras, el plantel completo y la
invitación entre coordinaciones, con una verificación de aceptación que los
recorre todos.

### Cierre: los cuatro pendientes · **HECHOS** (2026-09-12)

**Los espacios son del plantel.** `aulas` perdió la columna `carrera`: las
veintiuna de ISIC e ITIC se unificaron por clave, porque si dos carreras
listaban "V-1" es el mismo salón, no dos. Al repartir aula base se saltan las que
otra carrera ya usa en ese turno, y los laboratorios que elige el motor llevan
una máscara `ocupada` con lo ajeno. Probado: ISIC se quedó V-1 a V-4 e ITIC
recibió V-5 y V-6, con cero choques entre carreras.

**Capacidad.** `Aula.capacidad` y `Grupo.alumnos`. La restricción se comprueba
sobre la **suma** de los grupos de la sesión, que es donde importa: dos grupos
fusionados de 30 no caben en un salón de 30. Sin capacidad registrada no se
comprueba nada — inventar un número y rechazar horarios que sí caben sería peor
que no saber.

**Cierre de periodo.** `periodos_cerrados`. Mientras está abierto, cada
coordinador aparta y suelta; al cerrarlo, lo apartado es el horario del semestre
y `reservar`/`liberar` responden 409. Lo cierra el **departamento académico**,
porque afecta a todas las carreras a la vez. Probado: el coordinador recibe *"El
periodo lo cierra el departamento académico"*, y tras cerrar no puede soltar sus
horas hasta que se reabra.

**Vista del departamento.** Pantalla propia, no una sección más en la barra del
coordinador: aquí no se arman horarios. Se decide **quién puede impartir qué**
(punto 1 de los requisitos originales), se cargan las descargas y se cierra el
periodo.

---

### Las tres ideas anotadas · **HECHAS** (2026-09-12)

**Historial de la saturación.** Tabla `saturacion_historial`: quién apartó,
soltó o cedió cada hora, cuándo y con qué motivo. Saber quién tiene una hora no
resuelve un *"yo tenía esa hora"* — hace falta saber quién la tuvo antes. Se
anota en los tres puntos donde la hoja cambia: `reservar` (y las filas que
reemplaza, marcadas `reemplazada`), `liberar` y aceptar una cesión, que guarda a
quién se cedió. Es apéndice, no se edita ni se borra.

**Aviso de pendientes.** El contador en la barra lateral. Se recalcula al abrir
el escenario y al responder, **sin sondeo**: quien pide horas espera respuesta en
días, y un `setInterval` costaría una consulta por minuto y por pestaña para
enterarse antes de nada.

**Retícula de ITIC.** De 10 materias a 49 en nueve semestres, 39 de ellas
compartidas con ISIC por clave: 222 h/semana contra las 264 de ISIC. Con diez
materias la contención era anecdótica; con esto las dos carreras pelean de
verdad por la misma plantilla. Medido: ITIC aparta 63 horas, ISIC pasa a ver
cuatro horas en disputa y cuatro conflictos abiertos. Sigue siendo sintética —
el tamaño y la forma son realistas, el contenido no es el plan oficial.

Al sembrarla apareció un defecto que valía la prueba de regresión que ahora lo
cubre: `INSERT OR REPLACE INTO carreras` **borra y reinserta** la fila, y
`usuario_carrera` cuelga de `carreras(codigo)` con `ON DELETE CASCADE`.
Renombrar ITIC dejó a su coordinador sin carrera y la app respondía *"No
coordinas ITIC"* sin más pista. Ahora hay un solo `guardarCarrera()` con
`ON CONFLICT DO UPDATE`, y dos pruebas: una comprueba que renombrar conserva a
los coordinadores, la otra deja constancia de que el verbo descartado sí
cascadea.

---

### Auditoría del código · **HECHA** (2026-09-12)

Revisar el código en vez de la lista de pendientes encontró un hueco que no
estaba anotado en ninguna parte y pesaba más que todo lo demás.

**El horario apartado no se podía volver a ver.** No existía `GET /reserva`:
generar llenaba una variable en memoria y apartar guardaba solo las horas. El
coordinador cerraba la pestaña y perdía el horario, aunque las horas siguieran
tomadas — y regenerar no lo recupera, porque otra semilla da otro horario y el
apartado es el viejo. Ahora la tabla `horario` guarda la respuesta del motor
dentro de la misma transacción que aparta las horas.

Los dos **sí** se separan al ceder en una conciliación: las filas de
`saturacion` desaparecen y el documento sigue mostrando esa clase. No se corrige
solo, así que se dice: al abrir el panel se comparan hora por hora y se nombran
las clases que perdieron su lugar. Perder una hora de un bloque de dos ya lo
rompe.

**No había forma de sacar el horario de la app.** Cero coincidencias de
`imprimir`, `pdf` o `exportar` en todo el frontend, cuando el producto del
trabajo de un coordinador es justamente un horario que reparte. Ahora se
imprimen todos los grupos y todos los docentes de una pasada, uno por página. La
hoja del docente no es la del grupo con otro filtro: cambia lo que nombra cada
bloque —el grupo y el aula, no el docente— y acota la rejilla a las horas que de
verdad ocupa. El PDF lo hace `window.print()`; embarcar una librería para eso
sería hacer peor lo que el navegador ya hace bien.

**Las horas muertas se medían solo para el grupo.** La asimetría estaba al revés
de como duele: un alumno con una hora libre se queda en el campus, un docente con
clase a las 7 y a las 13 pierde el día. `huecoDocente` pesa 8 contra los 3 de
`huecoGrupo`. Medido con ocho semillas sobre `especialidades-2026`: los huecos de
docente bajan de una mediana de 13 a 4, sin que los de grupo suban de forma
apreciable.

---

### Lo que salió de la auditoría · **HECHO** (2026-09-12)

**Proponer fusiones.** La validación devuelve las materias que más de un grupo
cursa en el mismo turno, ordenadas por lo que ahorran; el coordinador marca las
que quiera. En ISIC salen cinco —7A y 7B comparten todo el tronco común de
séptimo— y aplicarlas bajan el horario de 158 a 134 horas-clase. Una fusión que
nombra un grupo que ya no se abre se descarta y se informa, en vez de tumbar el
horario: es un dato que quedó viejo, no un error.

Buscándolas apareció el límite de verdad: **la fusión entre carreras no se puede
expresar**. El problema que recibe el motor lleva solo los grupos de la carrera
abierta, y los ids ni siquiera son únicos entre carreras —ISIC e ITIC generan las
dos un `g-1a`—. El motor sabe programarla desde la fase 0; lo que falta está
antes, y es generar un horario que abarque varias carreras a la vez.

**Respaldo.** `VACUUM INTO` y no `cp`: en modo WAL los cambios recientes viven en
otro archivo, así que copiar el `.db` mientras alguien escribe deja un respaldo
roto sin avisar. Conserva los catorce últimos. Rotando apareció un defecto que
ahora cubre una prueba: ordenar por nombre borraba el respaldo **más nuevo**,
porque el sufijo anticolisión rompe el orden alfabético (`…25-1.db` va antes que
`…25.db`). Se ordena por fecha de escritura.

**Cuentas.** Alta, baja y reasignación de carreras desde la pantalla del
departamento, más cambio de contraseña propio. Retirar no borra la fila: el
historial apunta a quién hizo cada cosa. Aquí también apareció un defecto —
asignar una carrera inexistente rompía la clave foránea y salía un 500 opaco;
ahora es un 400 que la nombra.

**Pruebas del frontend.** Veinte sobre `src/dominio/`, con el corredor de Node y
sin dependencias nuevas. La primera que escribí falló por una suposición mía
—`sinDocente` es una lista de ids, no un conteo—, que es exactamente para lo que
sirven.

**Prioridad docente.** El mecanismo es el mismo —quién cede cuando dos evitan la
misma hora y solo uno puede librarse— pero el origen cambió: lo decide el
coordinador, no la antigüedad. Es una herramienta, no una regla automática; quién
merece la consideración lo sabe quien coordina.

Va **por carrera**, en `docente_prioridad`: la plantilla es del instituto y
priorizar a alguien en ISIC no se lo impone a quien coordina ITIC. Tres niveles
con nombre y no un número libre, porque una escala abierta acaba con todos en el
máximo, que equivale a que nadie la tenga.

El peso por omisión está **medido, no elegido a ojo**: marcando Máxima a los tres
docentes que más horas evitadas cargaban, en 1 la herramienta casi no se nota
(37→30) y en 20 los priorizados ya no mejoran pero los demás empeoran (21/33). En
5 bajan de 37 a 23 sin que el resto lo pague. La regla reparte y no quita: el
total apenas se mueve, que es lo correcto.

De paso quedó descartada la antigüedad automática. Al medirla había aparecido que
`antiguedad` guarda el **año de ingreso**, no años de servicio — un dato que sigue
capturándose y que nadie lee.

---

### Endurecido para uso real · **HECHO** (2026-09-12)

Auditar qué pasaba al sacarlo de `localhost` destapó un **defecto de sesión**:
la cookie llevaba `Max-Age=12h` pero el servidor nunca lo comprobaba. Tomando el
token más viejo de la base —de hace más de doce horas— seguía abriendo sesión.
`Max-Age` solo le pide al navegador que borre la cookie; quien la copie entra
igual, y entraba para siempre. Ahora la caducidad la decide el servidor, se mide
desde la creación —renovar en cada uso mantendría vivo justo el token robado— y
al entrar se barren las vencidas. `CON_TLS=1` añade `Secure`.

**Ninguna carrera se queda sin coordinador.** Retirar al único que la lleva, o
quitársela por reasignación, ahora es un 409. Una carrera huérfana no falla en
ninguna parte: nadie puede abrirla y solo se nota mirando la tabla.

**El choque consigo mismo.** Al probar el caso multi-carrera —un coordinador con
ISIC e ITIC— la misma solicitud salía en enviadas y en recibidas, y la bandeja
decía *"te piden horas"* por algo que esa persona escribió. Cuando las dos
carreras son suyas no hay nada que negociar: el conflicto se marca como propio y
se suelta directo.

**La configuración de generación se guarda.** Era un hueco que abrí yo al añadir
las fusiones: se guardaba el horario y no lo que lo produjo, así que al volver
las casillas salían en cero y "Generar" daba algo distinto de lo apartado.

**El respaldo corre solo**, dentro del servicio y no en un cron del anfitrión:
el `.db` vive en un volumen que el cron no alcanza sin montarlo otra vez.

---

### Fusión entre carreras · **HECHA** (2026-09-12)

Era lo único grande que quedaba y lo que el requisito original pedía. Se resolvió
programando las dos carreras **en un solo horario**: colar el grupo invitado solo
en la sesión compartida no sirve, porque sin conocer el resto de sus clases el
motor le pone la fusionada encima.

Los ids de grupo se repiten entre carreras, así que se prefijan (`ISIC:g-1a`).
Las materias se unen por id —es lo que hace posible la fusión— y si dos carreras
la definen con distintas horas se rechaza nombrándola. Al apartar, cada carrera
se queda con las sesiones de sus grupos; una fusionada es **una** hora
catedrático y se le carga a la del grupo principal.

**El resultado justifica la función.** ISIC e ITIC juntas, nueve grupos: sin
fusionar son 112 bloques y 206 horas-clase, y **no es factible** —la plantilla del
instituto no da—. Con las 18 fusiones son 68 bloques, 125 horas y cero
restricciones duras. Fusionar no es un ahorro cosmético: es lo que hace el
horario posible.

Queda un límite honesto: **exige que una sola persona coordine las carreras que
entren**. Generar un horario conjunto es decidir el de todas, y para dos
coordinadores distintos haría falta antes un acuerdo que no está modelado.

### Contraseña de arranque y alumnos · **HECHO** (2026-09-12)

Una cuenta nace obligada a cambiar la contraseña: hasta entonces la conocen dos
personas. El bloqueo está en el servidor, no solo en la pantalla. La migración
marca también las cuentas que ya existían, que son justo las que comparten la de
arranque.

Y la comprobación de capacidad de aula, que existía pero no comparaba nada: las
21 aulas tienen cupo y **ningún grupo tenía alumnos capturados**. Ahora la
validación lo advierte nombrando los grupos, y el campo se marca en el formulario.

---

### El plantel completo · **HECHO** (2026-09-12)

Las trece carreras de la oferta escolarizada del campus, con nombres y siglas
reales, repartidas en siete coordinaciones según la regla del coordinador: una
persona lleva las de su área. La de administración lleva la licenciatura, la
ingeniería y gestión empresarial; Sistemas y TI lleva ISIC, ITIC e IDAP.

El reparto **no está en el código**: es un dato, y se cambia marcando casillas en
la pantalla del departamento. `herramientas/sembrar-plantel.js` lo deja puesto.

Los datos académicos de las once carreras nuevas son mínimos y sintéticos —solo
el tronco común de primer semestre, con claves que ya existen en el plantel—. No
es su retícula: es lo justo para que la hoja tenga trece carreras compitiendo por
los mismos treinta docentes, que es el problema de origen. Medido con las siete
coordinaciones apartando: **299 horas tomadas de 1 108 declaradas**, con un
docente en 33 de sus 35.

Aquí la fusión entre carreras deja de ser una demostración: Administración
programa sus tres carreras juntas y ahorra 21 horas, porque Taller de Ética y
Fundamentos de Investigación se imparten una vez en lugar de tres.

---

### Invitación entre coordinaciones · **HECHA** (2026-09-12)

El horario conjunto exigía que una sola persona llevara las dos carreras. Ahora,
si son dos, la invitada tiene que **aceptar**. Es deliberadamente distinto de una
solicitud de horas: aquella se resuelve en horas concretas y deja rastro en la
hoja; esta es un permiso que vale mientras esté aceptado y que cualquiera de las
dos partes puede retirar. El backend lo comprueba al generar **y al apartar**:
sin la segunda comprobación bastaría con fabricar la petición para escribir en la
reserva ajena.

Probándolo apareció un defecto: `GET /api/carreras` devuelve solo las del
coordinador —correcto para navegar— así que la lista de a quién invitar salía
vacía. Se añadió `/api/plantel/carreras`, que da códigos y nombres sin datos.

### Los últimos cabos · **HECHOS** (2026-09-12)

**Antigüedad.** Era el único de los cuatro campos "sin usar" que además no se
mostraba en ninguna parte. Ahora sale en años de servicio junto al selector de
prioridad: no la usa el sistema, la usa quien decide a quién cuidar. Los otros
tres —`nivel`, `creditos`, `carreraBase`— sí se muestran; decir que no se usaban
era pasarse.

**Pruebas de componentes.** Doce, con vitest y happy-dom, sobre la rejilla y la
hoja imprimible. Corren en la construcción de la imagen, igual que las del
backend: una imagen no debería poder publicarse con la interfaz rota.

**TLS.** El bloque `443` queda escrito y comentado en la plantilla de nginx, con
los puntos de montaje en `docker-compose.yml` y el comando para un certificado de
prueba. Falta el certificado de la institución, que no es código.

---

### Verificación de aceptación · **HECHA** (2026-09-12)

`herramientas/verificar.js`: unas sesenta y cinco comprobaciones contra un
despliegue vivo, recorriendo los caminos completos en vez de las piezas. Es repetible y
limpia lo suyo.

**Encontró un fallo que las pruebas unitarias no veían.** Al añadir el horario
conjunto, `repartirPorCarrera` descartaba las sesiones sin prefijo de carrera —y
un horario de una sola carrera no prefija nada—, así que apartar devolvía
`reservadas: 0` **después** de haber borrado la reserva anterior. El camino más
usado del sistema vaciaba la hoja en silencio. Las pruebas de unidad no lo veían
porque probaban `repartirPorCarrera` con datos prefijados, que es como lo usa el
horario conjunto pero no como lo usa el normal.

De paso salieron dos huecos menores: no había forma de **abrir o cerrar una
carrera** por API —solo por sembrador— y el validador del código rechazaba
dígitos.

---

### La pantalla del departamento · **REHECHA** (2026-09-13)

Mirándola con trece carreras encima quedó claro que no servía para uso real.
Once cuentas por trece carreras eran **ciento cuarenta y tres botones** en la
tabla, y las dos o tres activas de cada fila se perdían entre las diez apagadas.
Además la barra lateral estaba vacía y las cuatro secciones iban apiladas en un
solo desplazamiento.

Ahora son cuatro secciones con navegación —Periodos, Carreras, Cuentas, Plantilla
docente—, las carreras de una cuenta se editan en un diálogo que las muestra con
clave y nombre, y en la tabla salen solo las que lleva. Las cuentas se buscan y
se ordenan poniendo las retiradas al final, apagadas.

**Carreras no existía como sección** aunque es lo que todo lo demás organiza. La
API para abrirlas y cerrarlas la había añadido el día anterior y no era
alcanzable desde ninguna pantalla.

La vista nueva destapó además un dato inconsistente: la cuenta de Sistemas se
llamaba "Coordinación" a secas —venía de antes del reparto por áreas— y en la
tabla de carreras eso no dice de cuál. El sembrador ahora corrige también el
nombre, no solo el reparto.

---

### Los espacios eran de cualquiera · **CORREGIDO** (2026-09-13)

Auditando qué funciones faltaban salió algo peor que un hueco. La tabla `aulas`
no tiene columna `carrera` —son del plantel desde hace semanas— pero la ruta
seguía siendo `PUT /api/carreras/:c/aulas`, y guardar **reemplaza la lista
entera**. Probado: la coordinación de Turismo guardó un aula suya y el plantel
pasó de veintiuna a una. Sistemas se quedó sin ninguna.

No es que faltara un permiso: es que un recurso compartido lo editaba quien
compite por él. Ahora los administra el departamento desde su propia sección,
las coordinaciones los ven en modo lectura, y vaciar la lista se niega.

De paso, `exigirDepartamento` daba siempre el mismo mensaje —"las cuentas las
administra el departamento"— aunque la ruta fuera de aulas, mandando a buscar el
problema donde no estaba.

---

### Ajuste a mano y contraseña olvidada · **HECHOS** (2026-09-13)

Las dos funciones que faltaban para un piloto real.

**Ajuste a mano.** El motor entrega un horario correcto según lo que sabe, pero
siempre hay algo que no sabe. Sin poder mover una clase, el coordinador abandona
la herramienta la primera vez que le pasa. Ahora se pulsa el bloque y se cambia
día, hora, docente o espacio.

Lo importante es **quién comprueba**: el horario editado vuelve al motor, que
reevalúa sin buscar con las mismas reglas que lo armaron. Escribir esa
comprobación en el navegador sería tener las reglas dos veces, y la segunda copia
envejece hasta decir que un horario está bien cuando no lo está. Para eso el
motor ganó `/api/evaluar` y cada sesión un `indice`.

Probándolo en el navegador apareció un defecto mío: la respuesta del ajuste no
incluía `resumen`, y la plantilla lo lee. El panel se **vaciaba entero** con un
`TypeError` en consola y ningún mensaje. Corregido, con una prueba que compara
los campos que devuelven generar y ajustar: un horario ajustado tiene que ser
indistinguible de uno generado para todo lo que viene después.

**Contraseña olvidada.** El departamento pone una provisional; la cuenta queda
obligada a cambiarla en su siguiente entrada y sus sesiones se cierran. Antes,
quien la olvidaba dejaba el sistema sin salida: había que entrar a la base.

---

### Simulación de un periodo · **HECHA** (2026-09-13)

`herramientas/simular.js`: ocho actos narrados contra el sistema vivo. La
verificación comprueba que cada cosa funcione; esto muestra cómo se usan juntas,
que es lo que hace falta para enseñar el sistema y para notar rarezas que ninguna
prueba aislada delata.

Escribiéndola salieron tres, todas del relato y no del sistema: movía una clase
al día en el que ya estaba —y narraba que un docente "no podía" ese día—,
escribía "1 choques", y cuando el motor no producía ningún conflicto el acto
central simplemente no ocurría. Lo último se resolvió **provocándolo**, que es lo
que pasa en la realidad: la coordinación insiste en un docente y aparta su hora
igual. El relato lo dice en voz alta en vez de fingir que salió solo.

---

### La plantilla docente era de cualquiera · **CORREGIDO** (2026-09-13)

Verificando cómo el departamento autoriza a sus docentes salió el mismo defecto
que con las aulas, pero sobre el punto uno de los requisitos: **quién puede
impartir qué**, que es exactamente lo que el departamento decide.

`PUT /api/docentes` reemplaza la plantilla entera y estaba abierta a cualquier
coordinación. Probado: el coordinador de Sistemas reescribió los treinta docentes
y el servidor contestó `{guardados: 30}`. Podía cambiar autorizaciones de otras
carreras o borrar personas.

No era solo la API: la interfaz del coordinador lo invitaba. `PanelDocentes`
tenía Editar y Eliminar, `PanelMaterias` dejaba marcar quién imparte cada materia,
y "Guardar cambios" mandaba la plantilla completa. Ahora el coordinador **lee**:
ve quién está autorizado —lo necesita, sin docente no puede generar— y si falta
alguien lo pide. Lo único suyo sobre un docente es la prioridad.

Verificada la cadena correcta de punta a punta: el departamento autoriza, el
coordinador lo ve sin hacer nada, y el motor le asigna esa materia.

---

### Buscar en el catálogo · **HECHO** (2026-09-13)

Autorizar es lo que más hace el departamento y el catálogo son sesenta y siete
materias: encontrar una era desplazarse. Buscador y un "solo las suyas", con una
regla que importa — el filtro **no oculta las ya autorizadas**, porque quitarle
una a un docente sin verla en la lista sería fácil de hacer sin querer.

Probándolo apareció algo que vale para toda la aplicación: **"etica" no
encontraba "Taller de Ética"**. En español se teclea sin acentos todo el tiempo,
y quien buscaba concluía que la materia no estaba en el catálogo. Ahora hay un
`dominio/texto.js` que pliega acentos, y lo usan los cuatro buscadores.

De paso se decidió que la `ñ` también se pliega: es una letra propia y no una
vocal acentuada, pero quien teclea "diseno" espera encontrar "Diseño", y que
"año" y "ano" colisionen no molesta a nadie buscando una materia.

---

### Cobertura, medida · **HECHA** (2026-09-13)

A la pregunta de si todos los casos estaban cubiertos, la respuesta honesta era
"no sé". Para saberlo el backend ganó `REGISTRAR_PETICIONES=1`, que anota el
patrón de cada ruta atendida; el diff contra la tabla de rutas dio la cifra.

**59 %.** Veintidós rutas que existían y ninguna prueba llamaba: importar
disponibilidad, guardar el formulario del docente, prioridad docente, la
configuración de generación, el ajuste a mano, reiniciar una contraseña, cerrar
sesión, resolver un choque propio. Una ruta que nadie llama es una que se rompe
en silencio.

Ahora son **220 comprobaciones y el 100 % de las 70 rutas**, estable en tres
corridas seguidas.

Dos cosas salieron de escribirlas. Una: encadenar verificar y simular fallaba
porque cada herramienta dejaba su propia contraseña y la lista de las conocidas
estaba repetida en las dos; ahora vive en `herramientas/acceso.js`. Otra: la
comprobación "reevaluar sin tocar nada da la misma aptitud" era **inestable** —
entre generar y reevaluar, otra carrera puede apartar horas de esos docentes y
entonces las mismas clases puntúan distinto, con razón—. Se cambió por dos
invariantes que sí se cumplen siempre: las clases quedan donde estaban, y
evaluar dos veces lo mismo da lo mismo. Una prueba que a veces falla es peor que
ninguna.

---

### El catálogo, del revés · **HECHO** (2026-09-13)

Asignar docente↔materia ya existía, pero solo **por docente**: se abría una ficha
y se marcaban sus materias. Para la pregunta que el jefe de departamento se hace
de verdad al sentarse a repartir —*qué le estoy dando a esta coordinación*— había
que abrir treinta fichas.

La sección **Quién imparte qué** lo da al revés: se elige la carrera y salen sus
materias con los autorizados en cada una. El selector lleva su propio aviso, que
es lo que hay que ver de un vistazo: cuántas materias no puede impartir nadie
—eso bloquea la generación— y cuántas dependen de una sola persona.

Sin horas en ninguna parte, a propósito. Y dejar una materia sin nadie se
permite, porque el departamento puede estar a medias; lo que no puede es pasar
desapercibido, así que se cuenta en rojo en la barra lateral.

Detalle de la primera versión: puse las trece carreras apiladas en columna y
empujaban la tabla entera fuera de la pantalla —justo lo que se viene a mirar—.
Van en fila.

---

### Una persona por clase, no un conjunto de capaces · **HECHO** (2026-09-13)

El catálogo entregaba a cada coordinación una **lista de autorizados por
materia** y el motor escogía de entre ellos. Está mal planteado: el jefe de
departamento no autoriza a cuatro para que el algoritmo elija, **decide quién se
para frente a ese grupo**.

Y la unidad tampoco era la materia. Si el primer semestre abre dos grupos, son
dos decisiones: pueden ser de la misma persona, o una de cada quien. La tabla
`asignacion` quedó con clave `(carrera, materia, grupo)` y el motor con un
`docente_fijo` por sesión: cuando viene, no elige, solo coloca el bloque.

**Sin escenario en la clave.** La primera versión lo llevaba y no funcionaba: el
departamento reparte sobre el base y el coordinador genera en una variante, así
que la asignación hecha en uno no la veía el otro. Se reparte para el periodo.
Hizo falta rehacer la tabla —SQLite no sabe quitar una columna de una clave
primaria—, y de ahí salió el primer cambio de esquema que no cabe en un
`ALTER TABLE ADD COLUMN`: `MIGRACIONES` en `bd.js`, cada uno con cómo saber si
ya se aplicó.

**Lo que ve el coordinador.** La validación previa a generar dice ahora cuántas
de sus clases tienen docente asignado y cuántas elegirá el motor. Sin eso, el
coordinador no podía distinguir lo que decidió el departamento de lo que decidió
el algoritmo, que es justo lo que necesita saber para ir a pedir un cambio.

**Los grupos contra los que se reparte.** El departamento necesita ver 1A y 1B
antes de asignar, y los grupos no existen hasta que el coordinador declara
cuántos abre. Se toma la configuración del escenario base si la tiene, y si no
la más reciente. Por el mismo motivo, generar sin líneas en la petición ya no
cae en la sugerencia de un grupo por semestre: usa las guardadas. Con la
sugerencia, la mitad de las clases que ya tenían a alguien al frente se quedaban
fuera del horario.

**Una clase la imparte una sola persona.** Cinco horas se programan en tres
bloques y cada bloque era un gen con su propio docente, así que el algoritmo
podía dar el lunes a una persona y el martes a otra —y lo hacía, porque a veces
puntúa mejor—. Ocho clases de treinta y cinco salían partidas. Cada sesión lleva
ahora el índice de su clase y el docente se propaga a todos sus bloques: en el
cruce, en la mutación, en la reparación dirigida y en la escalada del refinado.
Esta última fue la que costó encontrar: muta un gen suelto y deshacía el cambio
gen a gen, así que restauraba medio cambio.

De paso reduce el espacio de búsqueda —una decisión por clase en vez de una por
bloque— y la asignación entra por carrera y no por horario, que es lo correcto
en un horario conjunto: cada carrera tiene su reparto.

**Y el reparto se borraba solo.** Al medir la cobertura de nuevo apareció que
las asignaciones habían desaparecido sin que nadie las quitara. `PUT
/api/docentes` reemplaza la plantilla con un `DELETE FROM docentes` seguido de
las altas, y `asignacion` —como `docente_prioridad`— cuelga de `docentes(id)`
con `ON DELETE CASCADE`. Guardar la plantilla, que es lo más rutinario que hace
el departamento, se llevaba por delante todo el reparto del instituto y las
prioridades de todas las coordinaciones, en silencio.

Es el mismo defecto que tenía `INSERT OR REPLACE INTO carreras` con
`usuario_carrera`, y la lección es la misma: **borrar y reinsertar no es
actualizar** cuando algo cuelga en cascada de lo que se borra. Ahora se hace un
upsert por docente y solo se da de baja a quien ya no viene en la plantilla —eso
sí se lleva sus clases, porque es lo que significa darlo de baja—. Lo que sí es
de ese documento —disponibilidad, descargas, autorizaciones— se reemplaza, pero
por docente. Con dos pruebas: una de unidad y una de aceptación que guarda la
plantilla entera y comprueba que la asignación sigue ahí.

**La carga acumulada.** Asignar a alguien en dos carreras son dos decisiones
independientes; la persona no lo es. La segunda sección del departamento suma lo
que cada quien junta entre todas las coordinaciones y marca a quien se pasó. La
misma suma aparece en el diálogo de asignación, junto a cada nombre, que es
donde sirve: en el momento de sumarle una clase más.

---

### Pruebas de decisiones · **HECHAS** (2026-09-13)

Faltaba un eje. `verificar.js` comprueba que cada cosa funcione y `simular.js`
cuenta cómo se usan juntas; ninguna preguntaba **qué pasa cuando dos decisiones
legítimas no caben a la vez**, que es exactamente lo que hace falta saber en un
sistema donde deciden tres actores distintos.

`herramientas/decisiones.js` sube por niveles: una decisión suelta, varias del
mismo actor, decisiones que se contradicen, y dos coordinaciones más el
departamento. Monta dos carreras `DD*` y tres docentes de prueba con
disponibilidad y autorizaciones a medida —forzar una contradicción exige
controlar esos datos— y devuelve la plantilla del instituto como estaba.

La regla que quedó escrita: **una contradicción no se impide, se nombra.** El
departamento puede asignar a quien no está autorizado para esa materia o a quien
declaró dos horas para una clase de cuatro: son sus dos registros y puede tener
uno atrasado. El sistema entrega el horario, respeta la decisión y dice por dónde
no cuadra —`docenteNoCapacitado`, `horaNoDisponible`, `horasSobreMaximo`— en vez
de rechazarla o, peor, cambiarla por su cuenta.

> **La primera de las dos se cerró después**, con una medición que no existía
> cuando esto se escribió: asignar a quien no está autorizado no se nombra, se
> rechaza. El resto de la regla sigue en pie. Ver *El mapeo del departamento*.

**Y encontró el hueco que motivaba la prueba.** El ajuste a mano aceptaba
cualquier docente de la plantilla. El coordinador podía deshacer en dos clics lo
que el departamento repartió, y podía **partir una clase entre dos personas** —el
lunes de una, el martes de otra— que es justo lo que se acababa de cerrar en el
algoritmo. `leer_horario` rechaza las dos cosas nombrando el motivo: el motor es
quien tiene las reglas, y comprobarlo en el navegador habría sido tenerlas dos
veces.

Tres fallos más eran de la propia prueba, y también valían: suponía que una
persona con dos grupos enteros chocaría consigo misma —caben en la semana, y que
el motor los cuadre es el resultado bueno—, respondía a una solicitud sin decir
`acepta: true` y creía estar cediendo, y leía la hoja de saturación con una forma
que no era. Una prueba que da por buena una respuesta que no entiende es peor que
no tenerla.

---

### Los dos lados del mismo hueco · **HECHOS** (2026-09-13)

Auditando qué funcionalidades faltaban salieron dos que resultaron ser la misma
vista desde los dos extremos: **el coordinador no podía pedir y el docente no
podía ver**.

**Pedir un cambio de docente.** Era un cabo que abrí el mismo día: al cerrar el
ajuste a mano, el motor contesta *"esa clase la imparte X por decisión del
departamento académico: para cambiarlo hay que pedírselo"* — y no había por
dónde. `solicitudes` es entre coordinaciones y sobre **horas**; no existía el
caso "coordinación → departamento, sobre quién imparte esta clase", así que esa
conversación se iba por fuera y la decisión se cambiaba sin registro.

`peticion_cambio` lo modela aparte a propósito. La conciliación negocia entre
iguales y quien tiene la hora cede o no; esto sube una decisión a quien la tomó.
Por eso **aceptar es decir a quién se le da la clase** y el cambio queda aplicado
en el mismo gesto: aceptar sin elegir —o eligiendo a quien ya la imparte— se
rechaza, porque marcaría como resuelto algo que no cambió y la coordinación
volvería a pedirlo mañana. Es la misma lección que dejó ceder una hora: una
respuesta que no mueve nada es un gesto.

De paso se abrió la lectura del catálogo al coordinador de **sus** carreras.
Para poder pedir hay que poder ver, y hasta ahora solo tenía un número —"29 de
41 clases sin docente asignado"— sin manera de saber cuáles. Escribirlo sigue
siendo del departamento.

**El docente ve su horario.** Su enlace abría únicamente el formulario de
disponibilidad, así que la primera pregunta de cualquier docente —*¿qué me
tocó?*— no la contestaba nadie. Peor: la hoja imprimible sale del horario de una
carrera, de modo que quien da clase en tres tenía tres hojas parciales en poder
de tres coordinadores distintos y nadie tenía la semana entera.

`GET /api/mi-horario/:token` la arma desde la saturación, que es justamente la
tabla donde confluyen todas las carreras. Mismo token y mismo alcance que el
formulario: lo suyo y nada más. La página reutiliza la rejilla del coordinador
con un tono por carrera, y la hoja de papel es el mismo mecanismo que ya usaban
las del grupo —un bloque `.impresion` escondido en pantalla—, así que no hizo
falta ni una regla de impresión nueva.

Y dice que es un **borrador** mientras el periodo esté abierto. Alguien que
organiza su semana con un horario que todavía puede moverse tiene derecho a
saberlo.

---

### Las restricciones, contra el reglamento · **HECHO** (2026-09-13)

Los topes del sistema estaban elegidos por parecer razonables: cuatro materias
por docente, veinticuatro horas a un titular, la rejilla de 7 a 22. Razonables no
es lo mismo que correctos, y hay un reglamento federal que los fija: el
**Reglamento Interior de Trabajo del Personal Docente de los Institutos
Tecnológicos**, que rige al Campus Chetumal como a todo el subsistema.

Contrastados uno a uno, **dos estaban mal y uno estaba bien por casualidad**:

- **El tope de materias era 4 y el reglamento dice 3.** Artículos 155 y 156, con
  las mismas palabras para asignatura y para carrera: *"en ningún caso se les
  asignarán más de tres materias diferentes"*. Veintidós de los treinta docentes
  estaban capturados con cuatro.
- **Las horas frente a grupo no seguían ninguna tabla.** El artículo 143 las fija
  por categoría **y dedicación**, y la dedicación ni siquiera existía como dato:
  un titular de tiempo completo da 22 horas y uno de medio tiempo, 12, así que la
  categoría sola no dice nada. De paso salió que el sistema las tenía al revés:
  el titular estaba con más horas que el asociado, cuando el reglamento le da
  **menos** —a mayor categoría, más tiempo va a las funciones del artículo 27 y
  menos al aula—.
- **La rejilla de 7 a 22 de lunes a viernes coincidía exactamente** con el
  artículo 157, pero el comentario del código decía "reglas del departamento".
  Acertar sin saber por qué no sirve: ahora cita el artículo.

`src/tecnm.js` reúne las tablas con su cita, y la verificación de aceptación
comprueba que sigan siendo las que el sistema aplica. Los avisos **no bloquean**:
un plantel real tiene comisiones, plazas mixtas y nombramientos en trámite, y un
sistema que se niegue a programar por eso no se usa. Lo que no puede es que los
números sean inventados.

**Y el reglamento destapó un defecto de los datos.** Al apretar el tope a tres
materias, ISIC dejó de ser factible: veintitrés horas imposibles. No era el
reglamento —era mi propio sembrado de asignaciones, que repartía entre los
autorizados sin mirar su disponibilidad. Le había dado dos materias de cinco
horas a quien solo declaró los lunes.

De ahí salió la comprobación que faltaba, y es más fina que "¿tiene horas en ese
turno?": **una materia no se repite el mismo día**, así que hacen falta tantos
días declarados como bloques tenga. Siete horas un lunes no alcanzan para una
materia de cinco. El diálogo de asignación lo dice al elegir —*"declara 1 día de
matutino y la materia necesita 3"*— en vez de dejarlo salir después como un
diagnóstico de veinte horas imposibles. Con las asignaciones rehechas contra ese
criterio, ISIC vuelve a ser **factible con cero violaciones duras**, ya con el
tope de tres materias y las horas del artículo 143.

---

### El nombramiento, capturable · **HECHO** (2026-09-13)

Traer las reglas del reglamento dejó un cabo a la vista: **esos campos no se
podían editar desde ninguna pantalla**. La ficha del docente del departamento
solo tocaba descargas y materias autorizadas; el formulario completo vivía en el
panel del coordinador, que quedó de solo lectura cuando la plantilla pasó a ser
del departamento. Categoría, horas y topes venían sembrados y ahí se quedaban, y
la dedicación —que es la mitad de lo que decide las horas del artículo 143— no
existía ni como dato ni como campo.

La ficha del departamento lleva ahora un apartado de **Nombramiento**: categoría
con las seis del reglamento —incluidas asistente y profesor investigador, que
faltaban—, dedicación, nivel, horas y topes. Al cambiar categoría o dedicación se
**propone** lo que dice la norma y se puede dejar otra cosa; lo que quede fuera
se señala con su artículo, en la ficha y en un resumen sobre la tabla.

La interfaz no lleva su propia copia de las tablas: las pide a
`GET /api/plantel/normativa`. Una segunda versión envejecería aparte de la que el
sistema aplica y acabaría proponiendo horas que luego se marcan como incorrectas
—que es exactamente el defecto que se acaba de corregir, con los rangos por
categoría que el formulario tenía inventados por su cuenta—.

---

### Los tres que quedaban · **HECHOS** (2026-09-13)

Los tres huecos anotados al auditar qué funcionalidades faltaban, y resultó que
el tercero era la base de los otros dos.

**Historial del reparto.** Las horas tenían su historia desde hace días
—`saturacion_historial`— y las decisiones no, así que a *"¿quién cambió a Laura
por Ricardo, y cuándo?"* no contestaba nadie. `asignacion_historial` anota cada
cambio dentro de la misma transacción que lo provoca, con quién la tenía, quién
la tiene, quién lo hizo y por qué; un cambio aceptado a petición de una
coordinación lo dice en la nota. Solo se anota lo que **cambió de verdad**:
registrar un "cambio" de alguien por sí mismo llenaría la historia de ruido y
escondería los cambios que importan. Se consulta donde se decide —plegado en el
diálogo de asignación, junto a los candidatos— y no en una pantalla aparte a la
que hay que ir a propósito.

**Repartir en bloque.** Ciento cincuenta clases de una en una, y el caso más
común es que la misma persona lleve todos los grupos de una materia: tres
diálogos idénticos para decir lo mismo. Una casilla los toma juntos, y siguen
siendo decisiones por clase —cada una con su constancia—. La otra mitad era más
sutil: el reparto **se hereda** de un periodo al siguiente porque la asignación
no lleva periodo, lo cual casi siempre es lo que se quiere; lo que faltaba era
poder empezar de cero, que exigía quitar setenta clases a mano. **Vaciar** lo
hace de golpe, dice cuántas antes de hacerlo y deja la historia de lo que había
— que es justo lo que la vuelve segura.

**La carga académica en papel.** El horario se imprimía por grupo y por docente;
el reparto no, y es un documento con destinatarios. Dos hojas porque son dos
preguntas: **por carrera** —grupo, clave, materia, horas, quién la imparte, con
el formato de las hojas que el instituto ya usa— y **por docente**, lo que cada
persona junta entre todas las coordinaciones, que es la que no se podía sacar de
ningún lado. Reutiliza el mecanismo que ya existía: un bloque `.impresion`
escondido en pantalla y lo único visible en papel.

Un detalle de los que solo se ven imprimiendo: `.hoja-sub` llevaba
`text-transform: capitalize`, que en la hoja del grupo está bien —enumera datos
sueltos— y en esta produce *"Ingeniería En Sistemas · 13 De Septiembre De 2026"*.
Se acota a la hoja que lo necesita.

---

### Qué pasa cuando algo desaparece por debajo · **CORREGIDO** (2026-09-13)

Revisar los cruces que ninguna prueba tocaba —usuarios, materias, aulas,
escenarios— destapó cuatro defectos, y el más caro no era un permiso sino un
número mal.

**La carga acumulada contaba clases que ya no existen.** El reparto apunta a
materias y grupos que administra la coordinación. Si cierra un grupo o quita una
materia de la retícula después de repartir, esa asignación se queda sin nada a lo
que aplicarse: el catálogo dejaba de mostrarla —correcto— pero
`cargaPorDocente()` seguía leyendo la tabla `asignacion` y la contaba. Medido:
cuatro clases asignadas, se borra una materia, el catálogo muestra dos y **la
carga seguía diciendo cuatro**. Es el número que el departamento usa para decidir
a quién le cabe una clase más, y el que va en el documento que entrega.

Ahora la carga se arma **del catálogo vivo**, no de la tabla, así que las dos
cosas no pueden discrepar por construcción. Es la misma lección que ya había
aparecido dos veces hoy: una vista y su fuente tienen que salir del mismo sitio.

**Las huérfanas se nombran.** No se borran: si el grupo vuelve a abrirse la
decisión sigue valiendo y vuelve sola, que es lo que se quiere. Pero invisibles
y contadas era lo peor de los dos mundos; ahora `porCarrera` las devuelve aparte
y la pantalla las enumera.

**No se podía decir cuál escenario es el bueno.** `esBase` se ponía al sembrar y
no se podía mover, así que una coordinación que trabajaba en una variante no
tenía cómo declararlo y el catálogo lo adivinaba: *el base si estaba configurado,
si no el último configurado*. Con eso, crear un escenario de prueba y guardarle
una configuración **le robaba el catálogo al bueno**. Ahora la coordinación lo
marca, es exclusivo, el primero de una carrera nace siéndolo —una carrera sin
base es un estado roto— y `escenarioDeReferencia` es una línea sin heurística.

**Y crear un escenario a partir de otro nunca funcionó.** `crear()` guardaba los
datos copiados **antes** de registrar el escenario en el índice, así que las
materias se insertaban apuntando a una fila que todavía no existía y la clave
foránea las rechazaba. Sin `basadoEn` los datos van vacíos, no hay nada que
insertar y por eso ninguna prueba lo veía — pero es el camino normal para hacer
una variante, y la interfaz lo preselecciona. Sale un 500 opaco. Ahora el índice
va primero, y si la copia falla se deshace el registro: un escenario vacío que
parece bueno es peor que no haberlo creado.

Lo que **sí** aguantó: borrar aulas hasta dejar tres bloquea con `faltan-aulas` y
vaciarlas del todo se niega; una materia de cuarenta horas y un grupo que no cabe
en su turno se bloquean nombrando el motivo; dar de baja a un docente propuesto
en una petición pendiente la deja viva y aceptarla falla diciendo que ya no
existe; y quitarle todas las carreras a un coordinador se niega porque dejaría
carreras sin dueño.

---

### Formularios que no guardaban nada · **CORREGIDO** (2026-09-13)

Buscando bugs apareció lo que dejan los cambios a medias: **pantallas que siguen
ahí después de que su función se mudó**.

**El coordinador podía dar de alta a un docente y perderlo.** Cuando la plantilla
pasó a ser del instituto se cerró la escritura en el backend y se quitaron los
botones de editar y borrar del panel —pero el de **agregar** se quedó, colgado
del encabezado. Abría el formulario completo, lo aceptaba entero, lo metía en
`datos.docentes` en memoria y marcaba el escenario como sucio. Al guardar, `PUT
/escenarios/:id` manda materias, semestres y especialidades: el docente no iba en
ningún lado. Se capturaba a una persona y desaparecía al recargar, sin un error.

Con él se fueron `FormDocente.vue` entero, `editar`, `borrar`, `guardar` y tres
funciones de `dominio/edicion.js` que manipulaban una forma que ya no existe.
Nada de eso se alcanzaba desde la interfaz —y hoy mismo estuve mejorando ese
formulario sin darme cuenta de que nadie podía abrirlo—.

**Y el departamento no podía dar de alta a nadie.** El mismo hueco visto del otro
lado: la plantilla solo se podía sembrar o importar por CSV, así que una
contratación nueva no se capturaba. Ahora hay **Agregar docente** en su pantalla,
con el nombramiento completo; la disponibilidad no se pide porque la declara el
propio docente por su enlace, que es el modelo.

**Lo mismo con los espacios.** `PanelAulas` es de solo lectura desde que las
aulas pasaron al departamento, pero `App.vue` seguía declarando *"Agregar
espacio"* para esa sección: un botón que no hacía absolutamente nada, porque el
panel ya no expone el alta. `FormAula.vue` llevaba días sin que nadie lo
importara.

**Y un reparto en bloque a medias.** `asignarMateria` y `vaciar` escribían clase
por clase fuera de transacción —dejé escrito el porqué en un comentario y me
quedé ahí—, así que un fallo en la clase 40 de 72 dejaba 39 hechas y devolvía un
500. Ahora la lectura del catálogo va antes y las escrituras juntas: media
decisión es peor que ninguna, porque nadie sabría que quedó así.

---

### La hoja de las aulas · **HECHA** (2026-09-13)

El hueco simétrico del que se resolvió hace semanas. Los docentes tenían su hoja
de saturación —qué declaró cada quien y qué carrera tomó cada hora— y las aulas,
que son igual de compartidas, no tenían nada. El dato ya viajaba al motor: por
eso sabía marcar `aulaOcupadaPorOtros`. Pero solo se veía **como violación, al
final**, y para entonces el horario ya está armado y hay que rehacerlo.

La rejilla es la misma, con dos diferencias que vienen del recurso:

- **Un aula no declara disponibilidad.** Existe todo el día hábil, así que no hay
  gris de "no la ofreció": o está libre o está tomada. Dos estados en vez de
  cuatro.
- **Lo que importa de una tomada es quién la tiene.** La propia se mueve
  cambiando el horario; la ajena hay que ir a negociarla. Se pintan distinto —y
  con rayado, no solo con color: en una rejilla de setenta y cinco celdas dos
  tonos parecidos no se distinguen de un vistazo, que es justo para lo que sirve
  la hoja—. `propia` depende de quién mira, y la verificación lo comprueba
  pidiendo la misma hoja con las dos coordinaciones.

Medido sobre los datos del banco: 21 espacios, 145 horas tomadas, 1430 libres y
**15 aulas que nadie ha tocado**. V-5 sale con ocho horas de LADM, ajenas para
Sistemas, que es exactamente el caso que la hoja existe para enseñar.

---

### El relato, al día · **HECHO** (2026-09-13)

La simulación se había quedado vieja: empezaba a armar horarios sin que nadie
hubiera repartido, que es lo primero que pasa de verdad en un periodo. Contaba
un sistema que ya no era este.

Cuatro actos nuevos, en el sitio donde ocurren: **el departamento reparte** —con
los candidatos que pueden de verdad, el atajo de "a todos los grupos" y la
constancia en el historial—; **el coordinador descubre que quien le pusieron no
le cuadra y lo pide**; **mira qué aulas quedan** antes de mover nada; y **el
docente abre su enlace y ve su semana entera**, que es la que nadie le armaba
completa.

**Y el relato encontró dos defectos que ninguna prueba veía**, los dos de la
misma forma: ids internos llegando a los ojos de una persona.

- El motor rechazaba el ajuste a mano con *"esa clase la imparte **doc016** por
  decisión del departamento"*. El motor es ignorante del dominio a propósito
  —recibe ids y devuelve ids— y eso está bien hasta que uno de sus mensajes
  aterriza en una pantalla. Ahora el backend le pone los nombres antes de
  devolver el error.
- La hoja del docente decía *"aula **v_3**"*. En la puerta dice V-3. Faltaba unir
  con `aulas` para sacar la clave, y esa hoja la lee justamente quien tiene que
  llegar al salón.

También se vio en la primera corrida algo que no era del sistema sino del guion:
el acto pedía un cambio de docente sin comprobar que existiera alguien a quien
proponer, y el relato salió con `"undefined"` en dos renglones. Se corrigió el
acto —ahora busca una clase con relevo posible y lo dice si no lo hay— en vez de
maquillar la salida.

---

### Restaurar un respaldo · **HECHO** (2026-09-13)

Se creaban solos desde hacía días, rotaban catorce y nadie había restaurado
ninguno. Esa es la forma habitual de descubrir, en el peor momento posible, que
no servían: `respaldar.js` era media promesa.

`herramientas/restaurar.js` lista lo que hay, **enseña qué trae cada uno por
dentro** —integridad, tablas y filas por tabla, junto a las de la base vigente—
y solo escribe con `--escribir`. Ver la diferencia importa: *"asignacion 10"*
contra *"asignacion 20"* es lo que separa volver una hora atrás de volver una
semana, y restaurar es aceptar una pérdida deliberada.

Tres cosas que no son opcionales y que se hacen solas:

- **Comprobar antes de tocar.** Un archivo que no es una base de este sistema se
  rechaza nombrando qué le falta: restaurarlo dejaría el servicio sin arrancar,
  que es peor que la pérdida que motivó la restauración.
- **Apartar lo que reemplaza**, en `antes-de-restaurar-<marca>.db`. Una
  restauración equivocada es tan posible como la pérdida original.
- **Borrar el `-wal` y el `-shm`.** El diario de la base anterior junto a un
  archivo nuevo mezcla dos historias y la corrompe: es el error clásico al
  restaurar SQLite copiando solo el `.db`.

**Y una comprobación que escribí mal y hay que dejar anotada.** Puse un
`BEGIN EXCLUSIVE` para detectar que el servicio tuviera la base abierta, y al
probarlo con el backend corriendo **dijo que estaba libre**. En modo WAL varias
conexiones conviven y una inactiva no retiene candados, así que el bloqueo se
concede mientras el servicio atiende peticiones. Los `-wal`/`-shm` tampoco
sirven: sobreviven a un contenedor detenido. Lo único fiable es preguntarle al
servicio —si `/api/salud` contesta, está vivo—, y eso es lo que hace ahora. Una
guarda que da falsa confianza es peor que no tener ninguna.

Probado de verdad, no en teoría: con el sistema vivo se restauró un respaldo de
hace tres horas —las asignaciones pasaron de 20 a 10 en la aplicación— y después
se **deshizo la restauración** desde la copia que ella misma dejó, volviendo a
20. Con el backend arriba se niega y dice cómo pararlo.

---

### El plantel entero, repartido · **MEDIDO** (2026-09-14)

Lo único que no se había probado: repartir las ciento cincuenta clases y armar
los trece horarios. `herramientas/sembrar-reparto.js` puebla el reparto
respetando lo mismo que respetaría una persona —autorización, los topes del
reglamento, y que **pueda de verdad**: horas y días suficientes en el turno del
grupo— para poder medirlo sin pedirle a nadie ciento cincuenta decisiones a
mano. No es una función del producto: quién imparte cada clase lo decide una
persona, y un sistema que lo resolviera solo contradiría el modelo entero.

**El resultado importa más que el reparto.** A escala completa, la restricción
que aprieta no es la que se veía de cerca:

- **La plantilla no da.** Las 150 clases son **672 horas** y los treinta docentes
  suman **593 h** de tope contractual. Peor por turno: la mañana necesita 421 h y
  entre todos declaran 268 de mañana. **Ninguna clase se queda sin candidato por
  falta de autorización**: las 59 que no caben es porque *a quien puede ya no le
  cabe*. Faltan personas, no permisos.
- **Las aulas aprietan antes.** 22 grupos matutinos contra **16 aulas**: seis
  grupos de más. Once carreras generan horario factible con cero violaciones
  duras en 5,1 segundos entre todas; las dos últimas se bloquean con *"1 grupos
  se quedaron sin aula asignada"*. El bloqueo es correcto —nombra el motivo
  antes de generar— pero descubre algo del modelo: **las aulas se reparten por
  orden de llegada y no hay conciliación para ellas.** Las horas de un docente sí
  se negocian; un salón, no. La hoja de ocupación deja verlo; ceder un aula
  todavía no existe.

**Y la carga acumulada se ganó el sueldo.** Al medir salió un docente con 30 h
sobre un tope de 24 y seis materias sobre un tope de tres. No lo produjo el
sembrador —el historial dice que venía de guiones de prueba anteriores que no
miraban horas ni grupos— y la pantalla lo tenía señalado en rojo: *pasados de
horas 1, de materias 1, de grupos 1*. Redistribuido, el plantel queda en **88
clases repartidas y nadie por encima de su nombramiento**.

---

### El aula se comparte por horas, no por turno · **CORREGIDO** (2026-09-14)

La medición a escala completa dijo que faltaban seis aulas. No faltaban: **el
modelo era más grueso que la realidad**.

La regla del plantel es que los alumnos no se mueven de su salón —cada grupo
tiene su aula base— pero si el grupo de ingeniería termina a las cuatro, el de
arquitectura entra a las cuatro. El intercambio es **por franja horaria**. El
código repartía un aula por grupo y por **turno entero**, y además descartaba un
aula completa si otra carrera tenía en ella **una sola hora**. Con trece
carreras, eso agotaba los salones enseguida.

Los números lo dejan claro: 22 grupos matutinos necesitan 421 horas y 16 aulas
ofrecen 560 horas-aula. Con la regla real hacen falta **13 aulas y hay 16**; con
la regla implementada hacían falta 22.

Ahora el reparto es por presupuesto de horas, con dos criterios que importaron al
medir: **primero un salón vacío** —nadie comparte habiendo uno libre— y al
compartir, **la más vacía y no la primera que quepa**. La primera versión metía
los grupos rezagados en V-1, el salón más cargado del plantel, y salían horas
encimadas aunque en el papel cupieran. Quien resuelve que no se pisen es el
motor: `choqueAula` ya era restricción dura.

**El resultado, medido de punta a punta**: antes, once carreras generaban y dos
se bloqueaban sin poder intentarlo. Ahora **las trece generan horario factible
con cero violaciones duras en 6,6 segundos**, con 229 horas reservadas y dos
aulas compartidas entre carreras a horas distintas —V-11 entre LADM y LBIO, T-4
entre CPUB y LTUR—, que es exactamente la combinación que el plantel hace a mano.

**Y la fusión ya estaba bien.** Comprobado: `ACF-0901 1A+1B martes 7-9 · aula V-1
· un solo docente`. Es la otra combinación y es distinta —los dos grupos a la
misma hora en el mismo salón, porque es una sola clase—; el grupo visitante se
mueve solo para esa clase y conserva su aula base para lo suyo, y el cupo se
comprueba sobre la suma de los dos.

Un hallazgo de paso, sin relación con las aulas: ISIC salía con dos horas
imposibles y resultó ser **la semilla**. Con 2026 el algoritmo se atasca en ese
óptimo local aunque se le den 3000 generaciones; con 7 encuentra un horario
limpio en 900. A este tamaño conviene saber que volver a generar es una respuesta
legítima, y la interfaz ya lo permite.

---

### Los caminos que existían y nadie había pisado · **COMPROBADO** (2026-09-14)

Antes de decir qué falta, recorrer lo que hay pero no se usa. Tres caminos
estaban implementados y sin ejercitar con datos reales.

**El periodo par.** Todo lo medido hasta hoy era de impares. Probado: ISIC en
pares abre 5 grupos, 31 clases, 80 bloques, **factible con cero violaciones
duras**. La mitad del año que nadie había mirado funciona.

**Los laboratorios.** Los cinco del plantel eran decoración: **ninguna de las 57
materias pedía laboratorio**, así que `requiereLaboratorio` solo vivía en las
pruebas de unidad. Marcadas las ocho que en un ISIC real lo son —programación,
bases de datos, redes, sistemas operativos—, las sesiones aterrizan en N-1 a N-4
y TN-1 en las dos paridades, factible y sin violaciones. Queda revertido: es un
dato de la retícula real, no del sistema.

**El cupo del aula.** Ningún grupo tenía alumnos capturados, así que la
comparación no comparaba nada. Con 30 por grupo entra sin problema; con 45 el
sistema bloquea, que es lo correcto — **pero decía lo que no era**: *"8 grupos se
quedaron sin aula asignada: hay 16 aulas y el turno más cargado necesita más"*,
mandando a buscar más salones cuando lo que falta es cupo. Ahora son dos bloqueos
distintos porque son dos problemas distintos: `aulas-sin-cupo` dice *"8 grupos no
caben en ningún salón: el mayor es de 40 alumnos"* con el detalle por grupo, y
`faltan-aulas` habla de horas-aula, que es en lo que se mide desde que los
salones se comparten por franjas.

---

### Pedir un salón · **HECHO** (2026-09-14)

El último hueco de código. El instituto comparte dos recursos y solo uno se podía
negociar: las horas de un docente se piden y se ceden desde hace semanas; las de
un aula se tomaban por orden de llegada y punto.

Va por el mismo sitio —la misma tabla `solicitudes`, la misma bandeja, el mismo
historial— porque es la misma conversación. Hizo falta rehacer la tabla para que
`docente_id` admita nulos y entre `aula_id`, con un `CHECK` que obliga a que sea
uno u otro: una solicitud de las dos cosas a la vez no significa nada.

**La diferencia está en cómo se llega, y eso decidió dónde ponerlo.** Dos
carreras pueden pretender la misma hora de un docente a la vez: queda en disputa
y el sistema la nombra, así que la petición nace en Conciliación, junto al
choque. Un aula ocupada el motor simplemente no la usa —nadie choca y nadie se
entera—, así que la petición nace en la **hoja de ocupación**, pulsando la hora
que tiene la otra carrera. Ceder suelta esas horas de su reserva de verdad:
medido, LADM pasó de 8 a 6 horas en V-2 y quedó en el historial como *"cedida a
ISIC — toda tuya"*.

**Dos arreglos de las propias herramientas, de paso.** La verificación dejaba la
solicitud pendiente porque la cerraba como departamento, que no coordina ninguna
carrera y no puede responderla: la segunda pasada fallaba con un 409. Ahora la
cierra quien la tiene, y de paso comprueba que solo ese puede. Y el nivel 4 de
`decisiones.js` dependía de que el motor produjera un choque por su cuenta, así
que pasaba unas veces y otras no; ahora lo provoca si no ocurre, como ya hacía la
verificación. Una prueba intermitente es peor que ninguna.

---

### Lo que pasa cuando algo falla · **HECHO** (2026-09-14)

Buscando qué casos quedaban sin cubrir, los que aparecieron no eran funciones
que faltaran sino **averías que nadie había provocado**.

**Dos personas a la vez.** Toda la verificación era secuencial, y la concurrencia
es justamente por lo que los datos están en SQLite y no en archivos. Provocada:
doce asignaciones simultáneas entraron las doce; dos coordinaciones generando y
apartando a la vez, las dos; seis escrituras completas de la plantilla dejaron
treinta docentes e integridad `ok`. Pero la medición corrigió lo que decía esta
misma bitácora: SQLite evita la **corrupción**, no la **pérdida de la última
escritura**. `PUT /api/docentes` manda la plantilla entera, así que si dos
personas la editan a la vez gana quien guarda después. Está escrito ahora donde
antes se prometía de más.

**Que el motor no responda.** Se paró el contenedor y se pulsó Generar. Respondía
503 —no 500— en menos de cuatro segundos, y todo lo que no es el motor seguía en
pie: el catálogo, la plantilla, las cuentas, las peticiones. Pero en pantalla
aparecía `getaddrinfo ENOTFOUND engine`. Lo técnico ahora va al registro y quien
mira la pantalla lee que *el generador no está disponible, que lo demás sigue
funcionando y que avise al departamento si tarda*.

**Dar de baja a un docente.** El caso más caro de todos, y el que nadie había
provocado porque la pantalla no tiene un botón de borrar: la plantilla se guarda
entera, así que dar de baja es **guardar la lista sin esa persona**. Medido sobre
el plantel completo, quitar a uno —el que más horas tenía— borró **89 horas
apartadas repartidas entre once carreras** y tres clases del reparto, devolvió
`200 {"guardados":29}` y no dijo nada; los trece horarios ya guardados seguían
nombrándolo. Once coordinaciones habrían descubierto el hueco al imprimir.

El borrado en cascada está bien —quien se va no puede seguir bloqueando horas—;
lo que faltaba era **quién se entera**. Ahora se hace como el cierre de una
carrera, que ya se negaba por lo mismo: la baja se rechaza nombrando cuántas
horas son, de qué carreras y cuántas clases, para poder ir a pedirlas. Primero se
suelta, después se da de baja. Lo mismo con un salón: quitarlo de la lista del
plantel no borraba sus horas —`saturacion.aula_id` es texto suelto, sin
cascade— pero las dejaba señalando a un salón inexistente, invisibles en la hoja
de ocupación, que para quien las apartó es igual de malo.

De paso, esos avisos contaban **filas y no horas**: cada fila es un bloque y
puede valer tres. Donde decía "45 horas apartadas" eran 89. El cierre de carrera
tenía la misma cuenta y también se corrigió.

**Que la sesión caduque a media faena.** Dura doce horas y se mide desde que se
abrió, así que caduca trabajando, no entre visitas. El backend respondía `401`
correctamente; el frontend guardaba el código en el error **y no lo leía nadie**:
cada acción fallaba con "Hay que iniciar sesión" escrito en un hueco, con la
pantalla llena de datos que ya no se podían guardar y sin nada que llevara de
vuelta a la entrada. Ahora el `401` pasa por un solo sitio —el cliente HTTP, por
donde pasan todas las peticiones— y devuelve a la pantalla de entrada diciendo
que la sesión se cerró por tiempo, y si había cambios sin guardar, que se
perdieron.

**Retirar a alguien.** Retirar quita las carreras y cierra las sesiones, y la
cuenta se conserva a propósito porque el historial apunta a ella. Lo que no hacía
era **impedir entrar**: la contraseña seguía sirviendo y la persona retirada
aterrizaba en una pantalla en blanco, sin nada que explicara por qué. Y en la
lista del departamento se veía igual que una activa, porque "retirada" se
deducía de no tener carreras —lo mismo que una recién creada—. Ahora la cuenta
tiene `activo`, entrar se niega diciendo *que está retirada y que el
departamento la reactiva*, la lista las marca y las manda al final, y volver es
darle una contraseña nueva, que es exactamente lo que hay que hacer. Intentar
darla de alta otra vez o asignarle una carrera devuelve el mismo camino en vez
de un 409 mudo.

---

### El mapeo del departamento · **HECHO** (2026-10-09)

Llegó `papers/Mapeo materias.xlsx`: el modelo del problema tal como lo plantea
el departamento, en abstracto —cuatro áreas, ocho maestros cada una, siete
semestres de cinco materias— y con las reglas escritas al lado. No trae datos
reales; trae **las reglas y la forma**, que es lo que faltaba comprobar contra el
código. Confirmó casi todo el modelo de datos y corrigió cuatro cosas.

**El turno no se cortaba donde se corta.** Aquí decía matutino 07:00–14:00 y
vespertino 14:00–22:00, con un comentario que admitía que el corte era del
plantel y no del reglamento. El mapeo lo fija: **TM 07:00–13:00 y TV
13:00–22:00**. La mañana tiene seis horas, no siete, y eso cambia el presupuesto
de la rejilla: treinta ranuras por semana en vez de treinta y cinco. Con la
configuración guardada de ISIC —primero, tercero y quinto por la mañana, 27, 28 y
24 h— sigue cabiendo, y la batería entera pasó sin tocar nada más.

Con el corte viene el otro dato de la misma hoja: **primero y segundo en TM, de
tercero en adelante en TV**, igual en las cuatro áreas. Era un número puesto a
ojo —`SEMESTRE_VESPERTINO_DESDE = 6`— y ahora tiene fuente. Es una sugerencia: la
línea de grupos la decide el coordinador. Medido sobre el banco de pruebas, la
sugerencia nueva sale **peor** que la guardada (42 horas no disponibles contra 7),
y la causa es de los datos, no de la regla: quince de los treinta docentes
declararon 07:00–14:00 y son los autorizados para varias materias de semestres
altos, así que al mandar esos grupos a la tarde el motor los coloca donde esas
personas no están. Nueve de esas horas son el borde: quien declaró 14:00–22:00 no
cubre las 13:00, que ahora pertenecen a la tarde. **Las declaraciones del banco se
capturaron contra el corte viejo**; las reales salen del formulario y no se
inventan aquí.

**La jornada diaria no estaba modelada.** *"Horas máximo laborables: 8 hrs al
día"*. El motor tenía el tope semanal —el contrato— y el de una materia frente a
un grupo —tres horas—, pero nada que impidiera dejarle a alguien nueve horas
seguidas un martes. Es `Rejilla::max_horas_dia_docente`, viaja desde
`tecnm.MAX_HORAS_DIA_DOCENTE`, y pesa como el tope semanal: la misma clase de
violación, y ordenarlas entre sí sería inventar una jerarquía que nadie fijó. Se
mide en el mismo recorrido que los huecos del docente, que ya pasaba por esa
franja, así que no cuesta nada: cuenta **horas pisadas**, no bloques colocados,
de modo que dos clases encimadas son una hora de jornada y no dos —el empalme ya
se castiga aparte—. En el escenario de ISIC no ata: la jornada más larga es de
seis horas.

**El déficit de plantilla no es un error de captura.** La frase que más cambia el
sistema está al pie de la hoja de maestros: *"estas Reglas son estrictas, en caso
de que no haya maestro para cubrir alguna materia por esta razón u otra, se deja
esa materia para contratar a una persona por horas. Entonces se marca como una
necesidad"*. Y los números del propio mapeo dicen que el caso es la norma: 616
horas de clase contra 516 de capacidad frente a grupo —con su propia fórmula,
`(total/2)+2` para quien pasa de diez horas—, **100 horas de déficit, el 16 %**,
repartido parejo entre las cuatro áreas, así que no se cierra prestando gente.

Aquí había dos bloqueos que impedían generar: `materias-sin-docente` y
`capacidad-docente`. Los dos se habrían disparado siempre con esos datos, y
bloquear dejaba sin horario justo al plantel que tiene el déficit. Ahora son
**necesidades**: una tercera categoría junto a los bloqueos y las advertencias, y
lo que las separa es qué se puede hacer al respecto. Un bloqueo es que falta
capturar; una necesidad es que falta gente. La materia que nadie puede dar se
aparta del problema que va al motor —asignarla obligaría a poner a alguien sin
autorización, y eso vuelve el horario infactible por construcción— y sale
reportada con sus horas; el grupo la sigue listando y sus horas siguen contando
para el presupuesto del aula, porque cuando se contrate habrá que meterlas en ese
mismo salón. El déficit de capacidad se mide contra lo que de verdad queda por
programar, no contra la carga entera, para no contar dos veces las mismas horas.
El único bloqueo que queda de los dos es el caso extremo —**ninguna** materia del
periodo tiene quien la dé—, que no es un déficit sino una plantilla que no cubre
nada.

**Y el hueco que encontró la medición.** El mapeo deriva la asignación
materia-maestro de la tabla de autorizaciones, así que se fue a mirar cómo estaba
eso aquí: `7` de las `95` asignaciones de la base de demostración fijaban a
alguien **no autorizado** para esa materia. El efecto medido en el horario de
ISIC: `docenteNoCapacitado: 19` sobre 101 bloques, infactible, con una aptitud de
42 872 que ninguna semilla iba a arreglar. El motor respeta lo que el
departamento fija y no lo puede cambiar; el que se quedaba con el horario rojo
era el coordinador, que no había tomado la decisión y no tenía con qué deshacerla.
Llevaba ahí semanas sin que nadie lo viera, porque el diagnóstico decía *19
bloques* y no *estas siete clases*.

La pantalla del departamento ya solo ofrecía a los autorizados —*"Solo salen
quienes están autorizados para esa materia"*—; la API no. Ahora la regla vive en
`catalogo.asignar`, que es **el único sitio por donde pasa una asignación**: la
pantalla, el reparto en bloque de una materia y la aceptación de una petición de
cambio acaban las tres ahí. Primero autorizar, luego repartir; las dos decisiones
son del mismo departamento, así que no es pedirle permiso a nadie, es el orden. Y
por si una fila vieja sobrevive, la validación previa la nombra con clave, grupo
y persona en vez de dejar que el motor la traduzca a un número.

Las siete filas de la demostración se dejaron **sin asignar** por la API, para
que quedara en el historial de reparto: autorizar a alguien para una materia es
un juicio académico que no toca a esta herramienta, y sin asignar es el estado
normal a medio repartir —el motor elige entre los autorizados—. El horario de
ISIC pasó de catorce violaciones duras a **una**.

**Lo que el mapeo no cambió, y por qué.** Su fórmula de horas frente a grupo
—`(total/2)+2`— coincide con la fila de titular del artículo 143 en 40 h → 22 y
20 h → 12, pero ignora la categoría, y la tabla del reglamento es más fina: se
queda la tabla, y `tecnm.revisar` sigue avisando cuando lo capturado no cuadra.
Su prioridad de reparto es un número de 1 a 10 derivado del área y del contrato;
la de aquí son tres niveles que pone el coordinador. Son dos cosas distintas con
el mismo nombre —una regla institucional y un juicio de quien coordina— y
mezclarlas a medias habría sido peor que dejarlas separadas. Y el **área** no
existe como entidad: el mapeo organiza maestros, materias y prioridad por área, y
aquí la unidad es la carrera, con `esDeOtraArea` como un sí o un no. Cuatro áreas
no se corresponden con trece carreras sin que alguien diga qué es un área.

Dos cosas de limpieza del archivo, por si se importa: las claves se repiten de
copiar y pegar —dentro del área 1 el semestre 5 reusa las del 4, y las áreas 2 y
3 comparten 25 de sus 35— así que colisionan en la llave primaria de `materias`;
y las hojas *Materia-Maestros* y *Prioridades* traen el contenido cruzado.

### Un nombramiento a la vez · **CORREGIDO** (2026-10-10)

Editarle las horas a un docente mandaba la **plantilla entera**: el diálogo del
departamento cargaba los treinta, cambiaba uno y hacía `PUT /api/docentes` con
los treinta. Dos personas del departamento editando a la vez a dos docentes
distintos se pisaban —la segunda en guardar devolvía al otro al estado que ella
tenía en pantalla— y nadie se enteraba. Estaba medido y escrito como defecto
conocido desde hacía semanas; lo que lo volvió urgente fue que ahora hay que
autorizar antes de repartir, así que la captura de autorizaciones pasa
obligatoriamente por esa escritura.

`PUT /api/docentes/:id` escribe un nombramiento y nada más. Dos detalles que son
el fondo del asunto, no comodidades de la API:

- **Lo que no viene en el cuerpo no se toca.** Ningún formulario edita un
  nombramiento completo: el diálogo lleva la categoría, la dedicación y los
  topes, pero no la antigüedad ni el área de adscripción, que viajaban de rebote
  en el documento. Reemplazar el recurso entero las habría borrado. La lectura y
  la escritura van en la misma transacción, así que dos cambios al mismo docente
  no se mezclan a medias.
- **La disponibilidad no se escribe por aquí.** La declara el docente desde su
  enlace. Si la ficha la reemplazara, guardar un nombramiento pisaría lo que el
  docente contestó mientras el diálogo estaba abierto — el mismo defecto un
  nivel más abajo. Las descargas siguen en su propia ruta; las autorizaciones sí
  van con la ficha, porque son del departamento y se deciden en ese diálogo. Un
  arreglo vacío las borra, que es una decisión; la ausencia del campo no.

La ruta de la plantilla completa se queda para lo que es: un alta masiva o una
baja —quien no viene se va, con su aviso si deja horas apartadas—. Y la
verificación dejó de documentar el defecto para comprobar lo contrario: dos
escrituras simultáneas a dos fichas, las dos sobreviven.

### Lo que falta, también en el papel · **CORREGIDO** (2026-10-10)

Las necesidades de contratación se veían en la pantalla de quien generaba el
horario, y ahí se quedaban. La materia que nadie puede dar se aparta, así que la
rejilla sale con un hueco — y **en papel un hueco no se distingue de una hora
libre**. La hoja que recibe el alumno podía estar incompleta sin decirlo, que es
peor que no entregarla: nadie revisa un horario buscando lo que no está.

Los grupos del horario viajan ahora con las materias que cursan, no solo con las
que les tocaron. La hoja compara las dos cosas y lo que falta sale con su clave,
su nombre y sus horas, en un recuadro con borde: *"Faltan por asignar: SCH-1024
Taller de Administración (4 h) — el grupo las cursa y este horario todavía no las
incluye."*

Se compara en vez de reenviar la necesidad porque así se cubre cualquier motivo,
no solo el de la autorización: si una clase no se colocó, la hoja lo dice sea
por lo que sea. Y un horario apartado antes de este cambio no trae con qué
comparar, así que no avisa de nada — callar es mejor que inventar un faltante.

## Lo que queda

**Nada de código.** Lo que falta son datos y despliegue:

- **Las retículas reales de las trece carreras.** Las de ISIC e ITIC son
  realistas en tamaño y forma pero no son el plan oficial; las otras once son
  solo el tronco común de primer semestre.
- **La plantilla docente real.** Los treinta son banco de pruebas, ya con
  nombramientos que cumplen el reglamento.
- **Matrícula**: mientras no exista, el número de grupos y los alumnos se
  capturan a mano, y sin alumnos no se comprueba que quepan en el aula.
- **La plantilla docente no da para el plantel completo**, medido: 150 clases son
  672 horas y los treinta docentes suman 593 de tope contractual. Las aulas **sí**
  alcanzan desde que se comparten por horas. Es un dato del banco de pruebas, no
  del sistema, pero es lo que decidirá si el piloto se hace con una coordinación
  o con todas.

Y tres que abrió el mapeo del departamento:

- **Qué es un área.** El mapeo organiza maestros, materias y prioridad de reparto
  por área, y son cuatro. Aquí la unidad es la carrera, y son trece, con
  `esDeOtraArea` como un sí o un no. Mientras nadie diga si un área agrupa
  carreras o es un área de conocimiento, la prioridad que el mapeo deriva del
  área no tiene dónde vivir.
- **Prioridad de reparto: regla o juicio.** La del mapeo es un número de 1 a 10
  que sale del área y de las horas contratadas —40 h del área 1 va séptimo, 5 h
  va primero—. La del sistema son tres niveles que pone el coordinador para su
  propia carrera. Si la que manda es la del mapeo, el nivel se calcula y no se
  elige, y deja de ser del coordinador.
- **La disponibilidad declarada del banco está contra el corte viejo.** Quince
  docentes declararon 07:00–14:00 y quince 14:00–22:00, capturado cuando la tarde
  empezaba a las 14:00. Con el corte real a las 13:00 queda una hora que solo
  cubre el turno de la mañana. Se arregla con los formularios reales, no desde
  aquí: inventarle a alguien una hora que no declaró es exactamente lo que el
  formulario viene a evitar.

**Y una precisión sobre `antiguedad`, `nivel` y `creditos`**: sí se muestran —la
antigüedad junto al selector de prioridad, el nivel en el nombramiento, los
créditos en la ficha de la materia— pero **ninguno llega al motor**. No influyen
en nada que el sistema decida; los lee quien decide.

**Fuera del repositorio**: el certificado de la institución y dónde se despliega.
El bloque `443` está escrito y comentado en la plantilla de nginx.
