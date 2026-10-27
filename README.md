# Compliance Service (`compliance-service`)

[![CI](https://github.com/Luisortiz2406/banklite-compliance-service/actions/workflows/ci.yml/badge.svg)](https://github.com/Luisortiz2406/banklite-compliance-service/actions/workflows/ci.yml)

Cumplimiento y antilavado (AML): indicadores, reportes de actividad sospechosa (SAR) y reportes regulatorios.

Parte de **BankLite**, banco digital académico construido con microservicios. Cada
microservicio tiene su propia base de datos y se comunica con los demás por HTTP
(red interna) o por eventos en RabbitMQ.

## Responsabilidad dentro de la arquitectura

Mantiene **proyecciones** de cuentas, identidades y movimientos a partir de los eventos
(sin leer las bases de otros servicios) y abre **SAR** cuando llega una alerta de
fraude o cuando el volumen de un cliente supera el umbral AML. Registra los **cierres de
cuenta** (`account.closed`) y marca para revisión los de clientes con alertas recientes.
Genera reportes y los KPI del panel.

**Reglas de negocio principales**

- SAR desde `fraud.alert` o desde la regla de volumen (`COMPLIANCE_AML_VOLUME_THRESHOLD`).
- Severidad `low` / `medium` / `high`; un SAR `open` se resuelve como `filed` (reportado) o `dismissed` (descartado), con motivo y responsable.
- Proyecciones idempotentes (clave única por `transactionId`).
- **Cierre de cuenta** (`account.closed`): un registro por cliente (el evento repetido no crea otro). Si el cliente tuvo alertas de fraude (SAR de `fraud.alert`) desde **30 días antes del cierre**, el cierre queda **por revisar**; una alerta que llega después del cierre lo vuelve a dejar por revisar. **No se crea un SAR automático**: un empleado lo revisa y lo marca como revisado con un motivo.
- Bitácora (`admin_audit`): cada consulta de cierres (`closure.list_viewed`, `closure.viewed`) y cada «Marcar revisado» (`closure.reviewed`, en la misma transacción que el cambio).
- Solo roles `compliance` y `admin`.

**Comunicación con otros servicios**

| | |
|---|---|
| Publica eventos | — |
| Consume eventos | `account.created` (auth)<br>`identity.verified`, `identity.rejected` (kyc)<br>`transaction.completed` (ledger)<br>`fraud.alert` (fraud)<br>`account.closed` (account) |
| Llama a | — |
| Lo llaman | api-gateway (rutas `/compliance/*`) |
| Integraciones externas | — |

Todo el tráfico externo entra por el **api-gateway** (único servicio público), que
enruta por prefijo (`/compliance`), aplica CORS y límite de peticiones, y bloquea las
rutas internas.

## Tecnologías

- Node.js 20, NestJS 10 y TypeScript
- PostgreSQL con TypeORM (`synchronize: true`: las tablas se crean desde las entidades)
- RabbitMQ (amqplib): exchange `banklite.events`, outbox, reintentos y DLQ
- JWT (`@nestjs/jwt`) y `class-validator` para validar todo lo que entra
- Docker (imagen `node:20-alpine`) y despliegue en Railway

## Base de datos (`compliance_db`)

| Tabla | Contenido |
|---|---|
| `compliance_accounts` | Clientes (proyección de `account.created`). |
| `compliance_identities` | Estado de identidad (proyección de kyc). |
| `compliance_transactions` | Movimientos (proyección de `transaction.completed`). |
| `compliance_closures` | Cierres de cuenta (proyección de `account.closed`): fecha, cuentas, alertas recientes y revisión. |
| `suspicious_activity_reports` | SAR y su resolución. |
| `aml_reports` | Reportes AML generados. |
| `admin_audit` | Bitácora de acciones del panel en este servicio (quién, rol, qué y cuándo). |

En `database/`:

| Archivo | Qué es |
|---|---|
| `schema.sql` | Esquema (tablas, índices, restricciones), generado con `pg_dump --schema-only` desde la base que crea TypeORM. |
| `seed.sql` | Datos de ejemplo de un escenario de demo compartido por todos los servicios (clientes ficticios Ana y Carlos, con los mismos UUID en todas las bases). |
| `backup.sql` | Respaldo completo (esquema + datos de ejemplo) listo para restaurar. |

Restaurar en una base vacía:

```bash
createdb compliance_db
psql "postgres://usuario:clave@localhost:5432/compliance_db" -f database/backup.sql
# o, por partes:
psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
```

Si se arranca el servicio con una base vacía, TypeORM crea las tablas solo.

## Instalación y ejecución

Requisitos: Node.js 20, PostgreSQL 16, RabbitMQ 3.

```bash
npm ci
cp .env.example .env     # completa los secretos (ver abajo)
npm run start:dev        # desarrollo, recarga al guardar
# producción:
npm run build && npm run start:prod
```

Con Docker:

```bash
docker build -t banklite-compliance-service .
docker run --env-file .env -p 3010:3010 banklite-compliance-service
```

El sistema completo (los 12 servicios, Postgres, RabbitMQ y el gateway) se levanta
desde el repositorio principal con `docker compose up -d --build`.

Comprobar: `curl http://localhost:3010/health`

## Endpoints principales

A través del gateway las rutas son las mismas (`http://localhost:8080/compliance/...`).

### Públicos (sin sesión)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servicio y de su base (`SELECT 1`); responde 503 con `status: down` si la base no contesta. |

### Panel administrativo (`Authorization: Bearer <token de empleado>`; el gateway además valida la sesión)

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/compliance/admin/kpis` | compliance, admin | Indicadores de cumplimiento (incluye `closedAccounts` del periodo y `closuresPendingReview`). |
| GET | `/compliance/admin/sars` | compliance, admin | Reportes de actividad sospechosa. |
| GET | `/compliance/admin/sars/:id` | compliance, admin | Detalle de un SAR. |
| PATCH | `/compliance/admin/sars/:id` | compliance, admin | Resuelve un SAR (lo reporta o lo descarta). |
| GET | `/compliance/admin/closures?estado=por_revisar|revisados|todos` | compliance, admin | Cierres de cuenta (queda en la bitácora). |
| GET | `/compliance/admin/closures/:idUser` | compliance, admin | Un cierre con sus alertas de fraude de la ventana (queda en la bitácora). |
| PATCH | `/compliance/admin/closures/:idUser` | compliance, admin | «Marcar revisado» (`{ note }`, 5 a 300 caracteres); 409 si no requiere revisión o ya se revisó. |
| GET | `/compliance/admin/reports` | compliance, admin | Reportes AML. |
| GET | `/compliance/admin/reports/:id` | compliance, admin | Detalle de un reporte. |
| POST | `/compliance/admin/reports` | compliance, admin | Genera un reporte AML de un periodo. |
| GET | `/compliance/admin/audit` | cualquier empleado | Bitácora de acciones del panel en este servicio (quién, rol, qué y cuándo). |
| GET | `/compliance/admin/dlq` | cualquier empleado | Mensajes en la cola de errores (DLQ). |
| GET | `/compliance/admin/dlq/messages` | cualquier empleado | Contenido de los mensajes de la DLQ. |
| POST | `/compliance/admin/dlq/requeue` | admin | Reencola mensajes de la DLQ (solo administradores). |

## Variables de entorno

Ver `.env.example`. Los secretos se generan con
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (uno distinto
por variable). El servicio **no arranca** si un secreto falta, es corto, es un valor de
ejemplo o se repite entre dos variables (`src/config/env.validation.ts`). En Railway
todas se configuran como variables del servicio, nunca en el código.

| Variable | Obligatoria | Ejemplo / por defecto | Para qué sirve |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development` en local; `production` en Railway (lo fija el Dockerfile). |
| `PORT` | No | `3010` | Puerto HTTP del servicio. |
| `DATABASE_URL` | **Sí** (no arranca sin ella) | `postgres://compliance_svc:<DB_PASSWORD_COMPLIANCE>@localhost:5432/compliance_db` | Conexión a PostgreSQL de **su** base (rol propio, sin acceso a las demás). |
| `STAFF_JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de empleados del panel (el mismo que en auth-service; distinto de JWT_SECRET). |
| `RABBITMQ_URL` | No | `amqp://banklite:<RABBITMQ_PASSWORD>@localhost:5672` | Conexión a RabbitMQ. Sin ella los eventos quedan en el outbox (o no se consumen). |
| `COMPLIANCE_AML_VOLUME_THRESHOLD` | No | `50000000` | Volumen (COP) desde el que se abre un SAR por la regla de volumen. |
| `RABBITMQ_EXCHANGE` | No | `banklite.events` | Exchange topic de eventos (`banklite.events`). |
| `RABBITMQ_QUEUE` | No | `compliance-service.events` | Cola propia del servicio (con `<cola>.retry` y `<cola>.dlq`). |
| `EVENT_MAX_RETRIES` | No | `5` | Reintentos de un evento antes de mandarlo a la DLQ. |
| `EVENT_RETRY_DELAY_MS` | No | `10000` | Espera entre reintentos de un evento. |

## Pruebas

Pruebas del panel (permisos por rol, bitácora y validación), del contenido de
`account.closed` y de los cierres de cuenta: registro único (evento repetido o
simultáneo), ventana de 30 días con sus bordes, alertas de otro cliente o de la regla de
volumen que no cuentan, sin SAR automático, alerta después del cierre, alerta y cierre a la
vez, «Marcar revisado» con su bitácora, filtros e indicadores.

Las de cierres corren contra un PostgreSQL real (transacciones y bloqueos). Cada corrida
crea una base temporal y la borra al terminar:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

Sin `TEST_DATABASE_URL` se omiten en local; en la CI son obligatorias (el workflow
levanta un Postgres de servicio).

`database/schema.sql` y `database/backup.sql` se verifican en CI (`npm run verificar:esquema`,
después de `npm run build`): se restauran en Postgres y TypeORM no debe encontrar
diferencias con las entidades (`src/entities.ts`). Un caso de control alterado a propósito
debe fallar.

## Despliegue

Desplegado en Railway **desde este repositorio** (rama `main`): `railway.json` en la
raíz define el build por `Dockerfile` y el health check en `/health`; cada push a
`main` redespliega el servicio. El servicio no tiene dominio público propio: se accede
por el gateway.

- Estado del servicio y de su base: [https://api-gateway-production-dd7f.up.railway.app/health](https://api-gateway-production-dd7f.up.railway.app/health) (entrada `compliance-service`: `status` y `database` deben estar en `ok`)
- Rutas de este servicio: `https://api-gateway-production-dd7f.up.railway.app/compliance/...`
- Aplicación web: https://frontend-production-eff3c.up.railway.app

## Repositorios relacionados

Servicios de BankLite con los que se comunica este. **Llama a** / **Lo llama**: HTTP
por la red interna; **Recibe** / **Envía**: eventos en RabbitMQ. Cada uno vive y se
despliega desde su propio repositorio.

| Repositorio | Relación con este servicio |
|---|---|
| [banklite-api-gateway](https://github.com/Luisortiz2406/banklite-api-gateway) | **Lo llama:** punto de entrada público, le enruta las rutas de este servicio |
| [banklite-auth-service](https://github.com/Luisortiz2406/banklite-auth-service) | **Recibe:** `account.created` |
| [banklite-kyc-service](https://github.com/Luisortiz2406/banklite-kyc-service) | **Recibe:** `identity.verified`, `identity.rejected` |
| [banklite-ledger-service](https://github.com/Luisortiz2406/banklite-ledger-service) | **Recibe:** `transaction.completed` |
| [banklite-fraud-service](https://github.com/Luisortiz2406/banklite-fraud-service) | **Recibe:** `fraud.alert` |
| [banklite-account-service](https://github.com/Luisortiz2406/banklite-account-service) | **Recibe:** `account.closed` |
