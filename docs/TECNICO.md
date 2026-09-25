# Qwen Imagen Studio · Detalles técnicos

Documento para quien quiera entender o modificar la app. Las instrucciones de instalación y uso están en el [README](../README.md).

## Arquitectura

```
Navegador (app/)  ──HTTP──▶  Servidor Node (scripts/server.mjs, 127.0.0.1:7871)
                                 │  valida, encola lotes, guarda PNG + JSON en outputs/
                                 ▼
                        Gestor del motor (scripts/engine-manager.mjs)
                                 │  detecta CPU/GPU con --list-devices, elige argumentos,
                                 │  arranca/cambia/precarga un único sd-server
                                 ▼
                 stable-diffusion.cpp sd-server (127.0.0.1:7872)
                 runtime-cpu-v0.2.1 · runtime-v0.2.1 (CUDA) · runtime-vulkan-v0.2.1
```

- `scripts/core.mjs`: validación de peticiones, planificador Turbo (sigmas), carga útil del motor y política del VAE.
- `scripts/engine-manager.mjs`: detección de hardware, modo automático, argumentos del motor por modo y arranque serializado.
- `scripts/merge-lora.mjs` + `scripts/gguf.mjs`: creación del modelo optimizado (LoRA fusionado).
- `scripts/install.ps1`, `start.ps1`, `stop.ps1`, `common.ps1`: instalación y ciclo de vida en Windows.

## Rendimiento

RTX 4070 Laptop 8 GB, Ryzen 7 8845HS, 32 GB. 6 pasos, tiempo por imagen con el motor ya cargado:

| Caso | Versión anterior | Actual |
| --- | ---: | ---: |
| GPU · 1024 × 1024 | 58 s | **17–18 s** |
| GPU · 1344 × 768 | — | **17,5 s** |
| GPU · 512 × 512 | — | **4,4 s** |
| GPU · primera imagen tras abrir (con precarga) | 61 s | **18 s** |
| GPU · 2048 × 2048 | — | **88 s** |
| CPU · 256 × 256 | 79 s | **52 s** |
| CPU + GPU · 1024 × 1024 | 344 s | **17–19 s** |
| GPU integrada Radeon 780M (CPU + GPU) · 512 × 512 | falla en modo GPU | **74 s** (CPU: 227 s) |

Qué aporta cada ajuste (GPU, 1024 × 1024). Todas las mediciones están en `qa/optimizacion/benchmarks.jsonl` (script `qa/optimizacion/bench.mjs`):

1. **Pesos en RAM** (`--offload-to-cpu`) en vez de leerlos del disco en cada paso (`--params-backend disk`): 58 → 30 s.
2. **VAE con convolución directa y sin mosaico** hasta 1 MP (`--vae-conv-direct`): decodificación 7,8 → 2,6 s, resultado prácticamente idéntico (PSNR 49,7 dB). Los tamaños mayores usan mosaico y el motor reintenta con mosaico si falta VRAM.
3. **LoRA fusionado en los pesos**: el transformer (4 GB) cabe entero en la VRAM y cada paso baja de 3,7 a 2,6 s; ahorra 1,76 GB de VRAM.
4. **SageAttention** en NVIDIA (`--sage-attn`): otro −12 % en los pasos. Cambia detalles finos (misma composición; el texto dentro de la imagen se mantiene correcto); se desactiva con **Atención rápida**.
5. **Precarga** (`--eager-load`) al abrir la página y sondeo cada 250 ms: los ~10 s de carga ocurren mientras se escribe el prompt.
6. CPU: pesos leídos en su sitio con `--mmap` (como llama.cpp) y modelo fusionado: −34 %.
7. CPU + GPU deja solo el codificador de texto en CPU; con el VAE en CPU una imagen de 1024 px tardaba ~5 min.

Otras pruebas descartadas: ajuste automático de sd.cpp con el transformer fijo en VRAM (el VAE se queda sin memoria, 22,5 s), `--mmap` en GPU (+0,5 s por imagen, memoria no fijada), 16 hilos en CPU (solo −6 % frente a 8).

**¿Por qué no llama.cpp?** llama.cpp ejecuta modelos de lenguaje, no modelos de difusión de imágenes como Qwen-Image. `stable-diffusion.cpp` es el motor equivalente del mismo ecosistema ggml (backends CPU/CUDA/Vulkan, GGUF, `mmap`) y aquí se mantiene como servidor persistente: los modelos no se recargan en cada imagen.

## Modos de cálculo

| Modo | Argumentos principales |
| --- | --- |
| Automático | GPU dedicada → `gpu`; solo GPU integrada → `hybrid`; sin GPU → `cpu`. |
| CPU | `--backend cpu --mmap` |
| GPU | `--backend <GPU> --offload-to-cpu` |
| CPU + GPU | `--backend all=cpu,diffusion=<GPU>,vae=<GPU> --offload-to-cpu` |

Comunes: `--vae-conv-direct`, `--eager-load`, `--diffusion-fa` (o `--sage-attn` en CUDA), `--cfg-scale 1`, `--sampling-method euler`. NVIDIA usa CUDA; AMD, Intel y otras usan Vulkan. Validado en RTX 4070 (CUDA y Vulkan) y Radeon 780M (Vulkan). En la 780M el modo GPU no puede reservar el codificador de texto (búfer de 1 GB); con el texto en CPU funciona.

## Modelo optimizado (LoRA fusionado)

`scripts/merge-lora.mjs` suma el LoRA oficial de Viggle una sola vez: `W = base + (α/r)·B·A` en float32 (α = r = 256), a partir de la base **Q8_0** oficial de leejet, y recodifica el resultado con los mismos tensores, orden y tipos que la publicación Q4_K de leejet (cuantizador Q4_K de referencia de ggml portado a JavaScript; reproduce el 99,4 % de los bytes al recuantizar y el mismo error que la cuantización oficial). Partir de Q8_0 evita la doble cuantización. Tarda unos 8 minutos con 16 hilos.

- `models/merged-lora.json` guarda hashes de origen y resultado, tamaño y el cambio relativo de cada uno de los 195 tensores fusionados (se usan los 454 tensores del LoRA).
- Validación visual con la misma semilla: el fusionado y el LoRA en tiempo de ejecución dan la misma imagen Turbo con variaciones menores (PSNR 25 dB, equivalente al ruido de cuantización); la base sin LoRA da otra imagen, borrosa (PSNR 13,8 dB). Comparación en `qa/optimizacion/calidad-lora-fusionado-base.jpg`.
- Si no existe el fusionado (o se instala con `-NoMerge`), la app usa la base Q4_K + el LoRA aplicado en cada paso (`scripts/prepare-lora.mjs` adapta las capas `gate_layer`/`proj` al `gate_up` del GGUF sin alterar valores).

## Particularidades de Turbo

- Configuración de Viggle: **6 pasos, CFG 1, Euler, sin prompt negativo**. Nodos oficiales `[1, 0.9375, 0.875, 0.75, 0.5, 0.25]` antes del desplazamiento por resolución; más pasos conservan los nodos de bajo ruido; menos de 4 es experimental.
- Planificador según `scheduler_config.json` de Viggle: desplazamiento exponencial dependiente de resolución (`base_shift=0.5`, `max_shift=0.9`, longitudes 256/8192, `shift_terminal=null`). Se entregan los sigmas finales a sd.cpp. Qwen 2.1 usa un token por cada 16 × 16 píxeles.
- **Fondo transparente** añade la instrucción RGBA oficial al prompt; el modelo decide el canal alfa.
- Referencias: hasta 2; el navegador las normaliza a RGB y limita su lado mayor a 1536 px. Con dos referencias, la caché de prefijo de Qwen 2.1 no cabe en 8 GB y el motor continúa sin ella (aparece un `ERROR` controlado en el registro).

## Archivos de modelos

| Archivo en `models/` | Tamaño | Procedencia |
| --- | ---: | --- |
| `qwen_image_2.1-viggle-turbo-v0.2.1-merged-Q4_K.gguf` | 4,2 GB | Creado por el instalador desde la base Q8_0 de [leejet/Qwen-Image-2.1-GGUF](https://huggingface.co/leejet/Qwen-Image-2.1-GGUF) (revisión `cc114339`) y el LoRA de [Viggle](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo) (revisión `b77064be`) |
| `Qwen3VL-8B-Instruct-Q4_K_M.gguf` | 5,0 GB | [Qwen/Qwen3-VL-8B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF) |
| `mmproj-Qwen3VL-8B-Instruct-F16.gguf` | 1,2 GB | Mismo repositorio Qwen (lectura de imágenes de referencia) |
| `qwen_image_2.1_vae_bf16.safetensors` | 0,7 GB | VAE de Qwen-Image 2.1 publicado por [Comfy-Org](https://huggingface.co/Comfy-Org/Qwen-Image-2.1) |

Todas las revisiones y SHA256 están fijados en `model-config.json` y en `scripts/install.ps1`. Los motores `stable-diffusion.cpp` están fijados en la versión `88411ef`.

## Pruebas

| Comando | Qué comprueba | Requiere |
| --- | --- | --- |
| `node scripts/test-hardware.mjs` | Modo automático (sin GPU, GPU integrada), argumentos por modo, validación | — |
| `node scripts/test-memory.mjs` | Colocación de pesos, VAE, atención, carga útil con modelo fusionado, diagnóstico de RAM/GPU | — |
| `node scripts/test-library.mjs` | Lotes de 8 y borrado individual/múltiple/total con motor simulado | — |
| `node scripts/test-lora.mjs` | Adaptación exacta del LoRA (solo en modo compatible) | LoRA instalado |
| `node scripts/test.mjs` | Validación, semillas, planificador, aislamiento de origen | App abierta |
| `node scripts/verify-real.mjs` | Lote real, repetición exacta de semilla, edición con 2 referencias | App abierta |
| `node scripts/verify-hardware.mjs` | Generación real en CPU, GPU y CPU + GPU con cambio de motor | App abierta |
| `node scripts/verify-memory.mjs` | Lote real de 4 imágenes 768 × 1344 en CPU + GPU | App abierta |
| `node scripts/merge-lora.mjs --verify` | Hash del modelo fusionado | — |

Registros: `logs/engine.out.log`, `logs/engine.err.log`, `logs/app.err.log`. Los fallos por falta de memoria de RAM o GPU (CUDA y Vulkan) se clasifican leyendo solo las líneas nuevas del registro del trabajo; al fallar, la app libera su motor y conserva las imágenes ya terminadas del lote.

## Fuentes

- [Modelo y configuración de Viggle](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo)
- [Motor y guía Qwen 2.1 en stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/qwen_image_2.1.md)
- [Pipeline QwenImage21 en Diffusers](https://github.com/huggingface/diffusers/blob/80c7ed262aeffbeb43ef13ae04baeb9b84515a69/src/diffusers/pipelines/qwenimage21/pipeline_qwenimage21.py)
- [Codificador y proyector Qwen3-VL](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF)
