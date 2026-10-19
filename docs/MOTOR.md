# Motor y ejecutables

Qué se instala, qué ejecutable hace cada cosa, cómo los lanza la app y cómo usarlos a mano para depurar o experimentar. La guía de modelos está en [MODELOS.md](MODELOS.md) y el diseño interno en [ARQUITECTURA.md](ARQUITECTURA.md).

## 1. Las piezas

```
Iniciar Image Studio.cmd ─▶ scripts/start.ps1 ─▶ node scripts/server.mjs  (interfaz + API, 127.0.0.1:7871)
                                                      │ arranca y vigila
                                                      ▼
                                   runtime-*/sd-server.exe  (motor stable-diffusion.cpp, 127.0.0.1:7872)
```

- **La app no ejecuta la IA.** El servidor Node valida peticiones, gestiona la cola, guarda la biblioteca y decide cómo arrancar el motor.
- **Quien calcula es `sd-server.exe`**, de [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) (leejet). Está escrito en C++ sobre [ggml](https://github.com/ggml-org/ggml), la misma librería de tensores que usa llama.cpp.
- Ventaja de este diseño: no hace falta Python, PyTorch ni CUDA Toolkit. El motor carga los pesos una vez y queda residente entre imágenes.

## 2. Qué instala el instalador

| Carpeta | Contenido | Cuándo se instala |
| --- | --- | --- |
| `runtime-cpu-v0.2.1\` | Motor para CPU (AVX/AVX2/AVX-512, elige la variante en tiempo de ejecución) | Siempre |
| `runtime-v0.2.1\` | Motor CUDA 12 + `cudart64_12.dll`, `cublas64_12.dll`, `cublasLt64_12.dll` | Si hay GPU NVIDIA (`nvidia-smi`) o con `-Backend cuda` |
| `runtime-vulkan-v0.2.1\` | Motor Vulkan (AMD, Intel, también NVIDIA) | Con `-Backend auto` o `vulkan` |
| `node\` | Node.js portable | Si no tienes Node 22+ |
| `models\` | Pesos de los modelos ([MODELOS.md](MODELOS.md)) | Según `-Models` |
| `logs\`, `outputs\` | Registros y biblioteca | Al usar la app |

Todos los motores son la versión **`master-908-88411ef`** de stable-diffusion.cpp. Las URLs y los SHA256 de los ZIP están fijados en `scripts/install.ps1` (función `Runtime`). Cada carpeta `runtime-*` contiene:

| Archivo | Para qué |
| --- | --- |
| `sd-server.exe` | **Servidor HTTP del motor.** Es el que lanza la app |
| `sd-cli.exe` | Línea de comandos: generar una imagen, convertir y cuantizar modelos a GGUF, leer metadatos |
| `stable-diffusion.dll` | El motor en sí (modelos, muestreadores, VAE) |
| `ggml*.dll` | Operaciones con tensores. En CPU hay una DLL por familia de procesador (`haswell`, `alderlake`…) y se carga la mejor |
| `libwebp*.dll`, `webm.dll` | Lectura y escritura de imágenes y vídeo |

Los motores necesitan el runtime de **Visual C++ 2015–2022 x64**: el instalador lo comprueba e instala si falta.

## 3. Cómo arranca la app el motor

`scripts/engine-manager.mjs` lo hace en este orden:

1. **Detecta dispositivos.** Ejecuta `sd-server.exe --list-devices` en cada runtime instalado. La salida (`CPU`, `CUDA0`, `Vulkan0`…) decide qué modos ofrece la interfaz.
2. **Elige el modo.** Automático usa GPU dedicada → GPU; solo GPU integrada → CPU + GPU; sin GPU → CPU.
3. **Arma los argumentos** según el modelo y el modo (tabla siguiente).
4. **Arranca un único `sd-server.exe`** en el puerto 7872 con `--eager-load`, para que cargue los pesos mientras escribes el prompt. Espera a que `/sdcpp/v1/capabilities` responda.
5. **Lo reutiliza** mientras no cambien el modelo, el dispositivo, los hilos ni la atención. Si cambian, lo detiene y arranca otro: un solo motor a la vez para no duplicar memoria.

### Argumentos por familia

| | SDXL | Qwen-Image |
| --- | --- | --- |
| Pesos | `--model <checkpoint>` (UNet, CLIP y VAE en un archivo) | `--diffusion-model <gguf> --llm <Qwen3-VL> --llm_vision <mmproj> --vae <vae>` |
| LoRAs | `--lora-model-dir models\sdxl\loras --lora-apply-mode at_runtime` | Fusionado en el modelo, o `models\loras` en modo compatible |
| Atención | `--diffusion-fa` | `--sage-attn` en RTX 30+, si no `--diffusion-fa` |
| Muestreo | Por petición (CFG, sampler, pasos) | `--cfg-scale 1 --sampling-method euler` + sigmas Turbo por petición |

Comunes a ambos:
- `--backend <cpu | CUDA0 | Vulkan0 | all=cpu,diffusion=X,vae=X>`, `--threads N` y `--vae-conv-direct`.
- `--mmap` en CPU: lee los pesos en su sitio, desde la caché de archivos del sistema.
- `--offload-to-cpu` en GPU: pesos en RAM, copiados a la VRAM por bloques.
- `--listen-ip 127.0.0.1 --listen-port 7872 --log-level info --eager-load`.

Cada arranque queda anotado en `logs\engine.out.log` con el modelo, el modo y las opciones:

```
[Image Studio 2026-10-19T18:00:00.000Z] model=sdxl:NoobAI-XL-v1.1.safetensors mode=gpu backend=CUDA0 ...
```

## 4. Ejecutar el motor a mano

Útil para depurar un modelo que no carga o para probar opciones del motor sin tocar la app. Antes, cierra la app con `Detener Image Studio.cmd` para liberar memoria y el puerto.

```powershell
# SDXL en GPU NVIDIA (igual que la app):
runtime-v0.2.1\sd-server.exe --model models\sdxl\checkpoints\NoobAI-XL-v1.1.safetensors `
  --lora-model-dir models\sdxl\loras --lora-apply-mode at_runtime --backend CUDA0 `
  --diffusion-fa --vae-conv-direct --offload-to-cpu --listen-ip 127.0.0.1 --listen-port 7872 --eager-load
```

Opciones útiles para experimentar:

| Opción | Efecto |
| --- | --- |
| `--max-vram -1` | Reserva ~1 GiB de VRAM libre para otros programas; el motor segmenta más |
| `--params-backend diffusion=disk` | Lee la UNet del disco bajo demanda: menos RAM, más lento |
| `--type q8_0` | Cuantiza al cargar (sin convertir el archivo); cada arranque tarda más |
| `--vae-on-cpu` / `--clip-on-cpu` | Mueve el VAE o el codificador a la CPU para ahorrar VRAM |
| `--log-level debug` | Muestra el tamaño de cada búfer de cálculo en VRAM |
| `--help` | Lista completa |

Con el motor a mano, la app puede usarlo como **motor externo**: ejecuta `node scripts\server.mjs` sin `QWEN_ENGINE_MANAGED`. La app no lo arranca ni lo cambia; asume ajustes Qwen y no permite elegir CPU/GPU.

### API del motor que usa la app

| Método y ruta | Uso |
| --- | --- |
| `GET /sdcpp/v1/capabilities` | ¿Está listo? (`supported_modes` incluye `img_gen`) |
| `POST /sdcpp/v1/img_gen` | Encola una imagen. Responde con un `id` |
| `GET /sdcpp/v1/jobs/{id}` | Estado: `queued`, `generating`, `completed` (PNG en base64), `failed`, `cancelled` |
| `POST /sdcpp/v1/jobs/{id}/cancel` | Cancela |

La app pide **una imagen por petición** (`batch_count: 1`) y repite con semilla + 1. Así cada imagen se guarda en cuanto termina y un lote se puede detener a la mitad. Los campos que envía están en `scripts/core.mjs` (`enginePayload` para Qwen y `sdxlPayload` para SDXL). La referencia completa está en el [`api.md` del motor](https://github.com/leejet/stable-diffusion.cpp/blob/88411ef1e0688ff2df1010aeeb5d92b2d8cea2be/examples/server/api.md).

## 5. `sd-cli.exe`: convertir y probar

```powershell
# Una imagen SDXL desde la línea de comandos (aquí sí funciona <lora:nombre:peso> en el prompt):
runtime-v0.2.1\sd-cli.exe -m models\sdxl\checkpoints\NoobAI-XL-v1.1.safetensors `
  -p "masterpiece, best quality, 1girl, solo, scenery <lora:frieren_sdxl:0.8>" -n "worst quality, lowres" `
  --lora-model-dir models\sdxl\loras --cfg-scale 5 --sampling-method euler_a --steps 28 -W 1024 -H 1024 -s 42 `
  --diffusion-fa --offload-to-cpu -o prueba.png

# Convertir y cuantizar un checkpoint a GGUF (una sola vez):
runtime-cpu-v0.2.1\sd-cli.exe -M convert -m models\sdxl\checkpoints\NoobAI-XL-v1.1.safetensors `
  -o models\sdxl\checkpoints\NoobAI-XL-v1.1-q8_0.gguf --type q8_0 -v
```

`-M` (modo) admite `img_gen`, `convert`, `upscale`, `metadata`, `adetailer` y `vid_gen`. Por qué conviene cuantizar y qué se pierde: [MODELOS.md §7](MODELOS.md#7-memoria-cuantización-y-gguf).

## 6. Puertos, variables y registros

| Variable | Por defecto | Uso |
| --- | --- | --- |
| `QWEN_PORT` | `7871` | Puerto de la interfaz (`start.ps1 -Port`) |
| `QWEN_ENGINE_PORT` | interfaz + 1 | Puerto del motor |
| `QWEN_ENGINE_MANAGED` | sin definir | `1` = la app arranca y cambia el motor (lo define `start.ps1`) |
| `QWEN_OUTPUT_DIR` | `outputs` | Carpeta de la biblioteca |

Los nombres conservan el prefijo `QWEN_` del proyecto original para no romper instalaciones existentes. Todo escucha solo en `127.0.0.1`. Además, el servidor rechaza peticiones con otro `Host` u `Origin`, para que una web externa no pueda usar tu motor desde el navegador.

| Registro | Qué contiene |
| --- | --- |
| `logs\engine.out.log` | Arranques del motor y su salida (carga de pesos, tiempos por paso) |
| `logs\engine.err.log` | Errores del motor. La app lo lee para distinguir falta de RAM de falta de VRAM |
| `logs\app.out.log`, `logs\app.err.log` | Servidor Node |
| `logs\engine-process.json`, `logs\app-process.json` | PID de los procesos, para que `Detener Image Studio.cmd` cierre solo los suyos |

## 7. Actualizar el motor

1. Elige una versión en las [releases de stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp/releases).
2. En `scripts/install.ps1`, cambia la URL y los SHA256 de los ZIP (`Runtime ... 'cpu'`, `'vulkan'`, `'cuda12'` y el ZIP `cudart`).
3. En `model-config.json`, cambia `engineRevision`. Si quieres que se instale junto a la anterior, cambia también `runtime`, `runtimeCpu` y `runtimeVulkan` a carpetas nuevas.
4. Ejecuta el instalador, luego `node scripts/test-memory.mjs` y `node scripts/test-sdxl.mjs`, y genera con cada familia.

Revisa el changelog: el motor cambia nombres de opciones con cierta frecuencia. Si una opción desaparece, el motor no arranca, y `logs\engine.err.log` dice cuál.
