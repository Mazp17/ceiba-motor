# Ceiba

**Español** · [English](docs/README.en.md)

[![CI](https://github.com/Mazp17/ceiba-motor/actions/workflows/ci.yml/badge.svg)](https://github.com/Mazp17/ceiba-motor/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Mazp17/ceiba-motor)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)
![Babylon.js](https://img.shields.io/badge/sobre-Babylon.js-BB464B)
![Status](https://img.shields.io/badge/estado-desarrollo%20temprano-orange)

Capa de mundo abierto para juegos en el navegador, sobre [Babylon.js](https://www.babylonjs.com/): streaming del mundo por chunks, física por chunk y un core de sistemas aislados.

> En desarrollo temprano. La API cambia sin aviso y todavía no hay paquetes publicados en npm.

## Paquetes

| Paquete | Estado | Qué hace |
| --- | --- | --- |
| `@ceiba/core` | listo | Loop de paso fijo, fases, aislamiento de errores, eventos, reloj, logger, plugins |
| `@ceiba/babylon` | listo | Motor de Babylon (WebGPU o WebGL2) y escena, renderizados desde el loop del core |
| `@ceiba/streaming` | lógica pura lista, falta el adaptador a Babylon | Grilla de chunks, cola de prioridad, presupuestos de memoria, LRU |
| `@ceiba/physics` | pendiente | Colisionadores por chunk y vehículo sobre Havok |
| `@ceiba/input` | pendiente | Mapeo de acciones sobre teclado, mouse y gamepad |
| `@ceiba/save` | pendiente | Estado a IndexedDB con versionado de esquema |
| `@ceiba/debug` | pendiente | Overlay de rendimiento y visualizador de chunks |

## Uso

```ts
import { createEngine } from '@ceiba/core'

const engine = createEngine({ canvas })

engine.addSystem({
  name: 'mover',
  phase: 'update', // input | update | physics | lateUpdate | render
  update({ dt }) {
    // fixed-step simulation
  },
})

engine.start()
```

Un sistema que lanza un error se deshabilita, emite `system:error` y el resto sigue corriendo.

## Desarrollo

Requiere Node 24 y pnpm 12.

```sh
pnpm install
pnpm dev
pnpm build
pnpm lint
pnpm test
pnpm size
```

`pnpm dev` abre el sandbox (Vite) en `http://localhost:5173/?scene=hello`.

## Roadmap

Estado del proyecto y resultado esperado en [ROADMAP.md](ROADMAP.md) (en inglés).

## Licencia

[MIT](LICENSE)

---

Hecho con ❤️ desde Colombia
