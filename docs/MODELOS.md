# Guía de modelos

Cómo elegir, descargar, verificar, registrar y usar modelos en Image Studio. Para entender qué hace el motor con ellos, mira [MOTOR.md](MOTOR.md); para añadir una familia de modelos nueva al código, [ARQUITECTURA.md](ARQUITECTURA.md#añadir-una-familia-de-modelos).

## 1. Conceptos en dos minutos

Un generador de imágenes por difusión tiene tres piezas. Saber cuál es cuál explica casi todas las diferencias de memoria y de uso entre modelos:

| Pieza | Qué hace | SDXL | Qwen-Image 2.1 |
| --- | --- | --- | --- |
| **Codificador de texto** | Convierte el prompt en vectores (*embeddings*) | CLIP-L + OpenCLIP-G, ~0,8 B parámetros | Qwen3-VL, un LLM de 8 B |
| **Modelo de difusión** | Parte de ruido y lo va quitando, paso a paso, guiado por esos vectores | UNet, ~2,6 B | Transformer (MMDiT), ~20 B |
| **VAE** | Pasa de la imagen comprimida (latente, 8× más pequeña por lado) a píxeles | 84 M | Propio de Qwen |

- **Por qué SDXL cabe en 4–6 GB y Qwen pide 8 GB:** el codificador de Qwen es un LLM completo y su transformer es casi 8 veces más grande que la UNet de SDXL.
- **Por qué SDXL se escribe con tags:** CLIP se entrenó con pares imagen–texto corto. Entiende listas de conceptos mejor que frases largas. Los modelos anime (NoobAI, Illustrious, Pony) se ajustaron además con las etiquetas de [Danbooru](https://danbooru.donmai.us/wiki_pages/howto:tag), así que reconocen exactamente esos tags: `1girl, silver hair, witch hat`.
- **Por qué Qwen entiende instrucciones y referencias:** su codificador es un modelo de lenguaje con visión. Lee frases completas e imágenes («pon el zorro de la imagen 1 en…»).

## 2. Familias que soporta la app

| Familia | Estado | Para qué | VRAM práctica | Dónde va |
| --- | --- | --- | --- | --- |
| **SDXL** (NoobAI-XL, Illustrious, Pony, Animagine, Juggernaut…) | Soportada | Anime, ilustración, fotografía según el checkpoint, LoRAs, wallpapers | 4–6 GB (o CPU, lento) | `models/sdxl/checkpoints/` |
| **Qwen-Image 2.1 + Viggle Turbo** | Soportada | Lenguaje natural, texto dentro de la imagen, edición con 2 referencias | 8 GB o más | Archivos fijos que descarga el instalador |
| SD 1.5, FLUX, SD3, Anima, Chroma… | El motor las soporta, la app todavía no | — | — | Ver [cómo añadir una familia](ARQUITECTURA.md#añadir-una-familia-de-modelos) |

> **SD 1.5 en la carpeta de SDXL:** el motor detecta la arquitectura leyendo los nombres de los tensores, así que un checkpoint SD 1.5 probablemente cargue. No está probado, y los ajustes por defecto (1024 px) no le sirven: SD 1.5 trabaja a 512–768 px.

## 3. Instalar un modelo del catálogo

El catálogo de checkpoints SDXL es [`sdxl-models.json`](../sdxl-models.json). Para cada archivo conocido guarda de dónde viene y sus ajustes recomendados.

```powershell
# Menú interactivo (anime, Qwen o ambos):
"Instalar Image Studio.cmd"

# Atajo para el modelo anime:
"Instalar modelo anime (NoobAI-XL).cmd"

# Desde PowerShell, eligiendo checkpoints del catálogo:
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Models anime -Checkpoints 'NoobAI-XL-v1.1.safetensors'
```

| Parámetro de `install.ps1` | Valores | Efecto |
| --- | --- | --- |
| `-Models` | `anime`, `qwen`, `all` (sin él, pregunta) | Qué familias descargar. Los motores se instalan siempre |
| `-Checkpoints` | Nombres de archivo del catálogo | Qué checkpoints SDXL bajar. Por defecto, NoobAI-XL 1.1 |
| `-Backend` | `auto`, `cpu`, `cuda`, `vulkan` | Qué motores instalar |
| `-NoMerge` | — | Qwen: no fusionar el LoRA (modo compatible) |

Cada descarga se reanuda si se corta (`curl --continue-at`). Solo toma su nombre final cuando su SHA256 coincide.

## 4. Añadir un checkpoint propio

### Opción rápida: copiar el archivo

1. Descarga un checkpoint **SDXL** en `.safetensors` (o `.gguf`, ver §7).
2. Cópialo en `models\sdxl\checkpoints\`.
3. Recarga la página: aparece en **01 · Modelo** con ajustes SDXL genéricos (28 pasos, CFG 5,5, Euler a).

El nombre del archivo solo puede tener letras, números, espacios y `_ . - ( )`, y debe empezar por letra, número o `_`. Así se evitan rutas como `..\` y caracteres que el motor no resuelve.

### Opción completa: registrarlo en el catálogo

Añade una entrada en `known` de `sdxl-models.json`, con el **nombre exacto del archivo** como clave:

```json
"MiModelo-v2.safetensors": {
  "label": "Mi modelo v2 · ilustración",
  "source": "usuario/repositorio-en-hugging-face",
  "url": "https://huggingface.co/usuario/repositorio-en-hugging-face/resolve/main/MiModelo-v2.safetensors",
  "license": "openrail++",
  "sizeGB": 6.9,
  "steps": 28,
  "cfg": 6,
  "sampler": "euler_a",
  "prefix": "masterpiece, best quality, ",
  "negative": "worst quality, low quality, lowres, bad anatomy, watermark",
  "ideas": ["1girl, solo, scenery, sunset"]
}
```

| Campo | Obligatorio | Uso |
| --- | --- | --- |
| `label` | Sí | Nombre en el selector y en la biblioteca |
| `url` | Para el instalador | Enlace directo de descarga (`/resolve/` en Hugging Face, no `/blob/`) |
| `sha256` | Si la url no es de Hugging Face | Hash esperado. En Hugging Face se obtiene solo (cabecera `X-Linked-Etag`) |
| `source`, `license`, `sizeGB` | Recomendado | Se muestran en la interfaz y en el instalador |
| `steps`, `cfg`, `sampler` | No | Ajustes recomendados. `sampler`: `euler_a`, `euler`, `dpm++2m_karras` o `dpm++2s_a` |
| `prefix` | No | Etiquetas de calidad que se anteponen si el interruptor está activo |
| `negative` | No | Prompt negativo por defecto |
| `ideas` | No | Prompts de ejemplo para «Dame una idea» |

Después, `scripts\install.ps1 -Models anime -Checkpoints 'MiModelo-v2.safetensors'` lo descarga y verifica.

### Ajustes habituales por familia de checkpoint

Son puntos de partida frecuentes; **la ficha del modelo manda**.

| Base | Etiquetas de calidad típicas | CFG | Notas |
| --- | --- | --- | --- |
| NoobAI-XL (eps) | `masterpiece, best quality, newest, absurdres, highres` | 4–5 | Ya registrado. La variante *V-pred* necesita otra predicción: no la uses aquí |
| Illustrious-XL | `masterpiece, best quality, very aesthetic, absurdres` | 5–7 | Tags Danbooru |
| Pony Diffusion V6 XL | `score_9, score_8_up, score_7_up` | 6–8 | Usa *clip skip* 2 en otras apps; aquí el motor usa el valor del modelo |
| SDXL fotográficos | Ninguna | 4–7 | Frases cortas descriptivas |

## 5. Dónde descargar y cómo elegir

- **Hugging Face** (`huggingface.co`): pestaña **Files and versions** → archivo → **Download**. Copia el enlace con `/resolve/` para el catálogo. Algunos repositorios son *gated*: hay que iniciar sesión y aceptar la licencia antes de descargar, y el instalador no puede bajarlos sin tu sesión. Descárgalos a mano y cópialos.
- **Civitai** (`civitai.com`): fíjate en el campo **Base Model** de la ficha. Tiene que decir *SDXL 1.0*, *Illustrious*, *Pony* o *NoobAI*. *SD 1.5* o *Flux* no funcionan en la carpeta SDXL. La ficha muestra el **SHA256** en *Details → Hashes*.
- Prefiere `.safetensors` con *pruned* o *fp16* en el nombre (~6,5–7 GB). Las variantes *full* o *fp32* (~13 GB) no mejoran la imagen y piden el doble de RAM.

### Formatos: por qué no se aceptan `.ckpt` ni `.pt`

`.ckpt` y `.pt` son archivos *pickle* de Python. Al abrirlos se puede ejecutar código arbitrario, y un modelo descargado podría instalar malware. `.safetensors` solo contiene tensores y una cabecera JSON: abrirlo es leer datos, nunca ejecutar nada. Si un modelo solo existe en `.ckpt`, conviértelo en un entorno aislado o busca otra versión.

### Verificar lo que descargaste a mano

```powershell
Get-FileHash -Algorithm SHA256 "models\sdxl\checkpoints\MiModelo-v2.safetensors"
```

Compara el resultado con el SHA256 de la página del archivo (Hugging Face: icono de LFS junto al archivo; Civitai: *Hashes*).

## 6. LoRAs: personajes, estilos y conceptos

Un **LoRA** (*Low-Rank Adaptation*) no es un modelo completo. Son dos matrices pequeñas A y B por capa, y el motor suma `W + peso · B·A` a los pesos originales al generar. Por eso pesa 20–200 MB en lugar de 7 GB, y por eso **solo funciona sobre la arquitectura para la que se entrenó**.

1. Descarga LoRAs cuyo *Base Model* sea SDXL, Illustrious, Pony o NoobAI. Los de SD 1.5 o Flux no son compatibles: sus capas tienen otros nombres y tamaños.
2. Cópialos en `models\sdxl\loras\` y recarga la página. Aparecen en **03 · LoRAs**.
3. Márcalos y ajusta el peso:
   - 0,6–1,0 es lo habitual.
   - Por encima de 1, la imagen se deforma.
   - Un peso negativo resta el concepto.
4. Escribe su **trigger word** en el prompt si la ficha la indica, por ejemplo `frieren` o `wtrcolor style`.
5. Puedes combinar hasta 4. Cada uno añade cálculo en cada paso, porque se aplican en tiempo de ejecución (`--lora-apply-mode at_runtime`) para poder cambiarlos entre imágenes sin recargar el modelo.

> **Antes de buscar un LoRA de personaje**, prueba su tag Danbooru con NoobAI o Illustrious, por ejemplo `frieren, sousou no frieren`. Se entrenaron con millones de imágenes etiquetadas y conocen muchos personajes populares sin ayuda.

Para entrenar tus propios LoRAs necesitas más VRAM que para usarlos: gradientes y estados del optimizador ocupan memoria. Lo práctico es entrenar en un notebook en la nube (Kaggle o Colab con [kohya sd-scripts](https://github.com/kohya-ss/sd-scripts)) y copiar el `.safetensors` resultante a esta carpeta.

## 7. Memoria, cuantización y GGUF

Con **GPU**, la app deja los pesos en RAM y los pasa a la VRAM por bloques cuando se necesitan (`--offload-to-cpu`). El motor parte el cálculo en segmentos si no cabe entero. Por eso un SDXL de 6,9 GB funciona en tarjetas de 4 GB. La **RAM** sí tiene que contener el modelo: con 16 GB, cierra aplicaciones pesadas.

Si te falta RAM o quieres que las capas viajen más rápido a la VRAM, puedes **cuantizar** el checkpoint, es decir, guardar cada peso con menos bits:

| Formato de la UNet SDXL | Bits por peso | Tamaño aproximado | Calidad |
| --- | ---: | ---: | --- |
| f16 (original) | 16 | ~5,1 GB | Referencia |
| q8_0 | 8,5 | ~2,7 GB | Prácticamente igual |
| q4_K | ~4,5 | ~1,5 GB | Pierde algo de detalle fino |

Conversión única con el `sd-cli.exe` que trae el motor (detalles en [MOTOR.md](MOTOR.md#sd-cliexe-convertir-y-probar)):

```powershell
runtime-cpu-v0.2.1\sd-cli.exe -M convert -m models\sdxl\checkpoints\NoobAI-XL-v1.1.safetensors -o models\sdxl\checkpoints\NoobAI-XL-v1.1-q8_0.gguf --type q8_0 -v
```

El `.gguf` resultante aparece como un modelo más en el selector. Para que use los ajustes de NoobAI, regístralo en el catálogo con su propio nombre.

## 8. Licencias y uso responsable

- Cada checkpoint y LoRA tiene su licencia, que se muestra en la interfaz cuando está en el catálogo:
  - NoobAI-XL: *Fair AI Public License 1.0-SD*.
  - Qwen-Image y Viggle Turbo: *Qwen Research License*, solo uso no comercial.
- Las licencias del código (MIT) y de los modelos son independientes: que la app sea MIT no hace libre a un modelo.
- Los personajes de anime, series y videojuegos tienen derechos de autor. Usa sus LoRAs y tags para fan art personal.
- No generes imágenes de personas reales sin su consentimiento. Cualquier contenido explícito debe representar solo a adultos.
