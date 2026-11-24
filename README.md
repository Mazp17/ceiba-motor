# Ceiba

**Español** · [English](docs/README.en.md)

Capa de mundo abierto para juegos en el navegador, sobre [Babylon.js](https://www.babylonjs.com/): streaming del mundo por chunks, física por chunk y un core de sistemas aislados.

> En desarrollo temprano. La API cambia sin aviso y todavía no hay paquetes publicados en npm.

## Paquetes

| Paquete | Estado | Qué hace |
| --- | --- | --- |
| `@ceiba/core` | listo | Loop de paso fijo, fases, aislamiento de errores, eventos, reloj, logger, plugins |
| `@ceiba/streaming` | pendiente | Grilla de chunks, cola de prioridad, presupuestos de memoria, LRU |
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
pnpm build
pnpm lint
pnpm test
pnpm size
```

## Roadmap

Estado del proyecto y resultado esperado en [ROADMAP.md](ROADMAP.md) (en inglés).

## Licencia

[MIT](LICENSE)

---

Hecho con ❤️ desde Colombia
