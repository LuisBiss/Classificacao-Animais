# 🦁 Classificador de Animais com IA

> Sistema de identificação de animais em imagens utilizando **Machine Learning no navegador** — sem necessidade de servidor, sem instalação, 100% client-side.

---

## 📌 Sobre o Projeto

Este projeto foi desenvolvido como trabalho prático de **Inteligência Artificial**, com o objetivo de demonstrar a aplicação de modelos de Machine Learning para classificação e detecção de imagens diretamente no navegador.

O sistema passou por **duas fases de desenvolvimento**:

| Fase | Descrição |
|---|---|
| **Fase 1** | Classificação com Teachable Machine + avaliação rigorosa do modelo |
| **Fase 2** | Detecção de objetos com SSD MobileNet (COCO-SSD) e bounding boxes |

---

## 🐾 Classes Suportadas (Modelo Teachable Machine)

| Emoji | Classe | Emoji | Classe |
|---|---|---|---|
| 🐶 | Cachorro | 🐔 | Galinha |
| 🐴 | Cavalo | 🐱 | Gato |
| 🐘 | Elefante | 🐄 | Vaca |
| 🦋 | Borboleta | 🐑 | Ovelha |
| 🕷️ | Aranha | | |

---

## 🗂️ Estrutura do Projeto

```
Classificacao-Animais/
├── index.html        # Interface principal — 4 abas
├── style.css         # Estilos (dark mode, glassmorphism, animações)
├── app.js            # Lógica JavaScript completa
├── model.json        # Arquitetura do modelo Teachable Machine
├── weights.bin       # Pesos treinados (~2MB)
├── metadata.json     # Metadados do modelo (classes, versão)
└── serve.ps1         # Servidor HTTP local (PowerShell)
```

---

## 🚀 Como Executar

> ⚠️ **Importante:** O modelo TensorFlow.js **não funciona** ao abrir o `index.html` diretamente como arquivo local (`file://`). É necessário usar um servidor HTTP.

### 1. Inicie o servidor local

Abra o **PowerShell** dentro da pasta do projeto e execute:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```

O servidor inicia em `http://localhost:8080` e abre o navegador automaticamente.

### 2. Use a aplicação

Acesse **http://localhost:8080** e navegue pelas abas:

| Aba | Função |
|---|---|
| 🖼️ **Upload** | Seleciona ou arrasta uma imagem para classificar |
| 📷 **Webcam** | Classificação automática ao vivo pela câmera |
| 📊 **Avaliação** | Avalia o modelo com métricas estatísticas |
| 🔍 **Detecção** | Detecta múltiplos objetos com bounding boxes |

---

## 🧠 Fase 1 — Classificação com Teachable Machine

### Como o modelo foi treinado

O modelo de classificação foi criado com o **Google Teachable Machine**:

1. Coletadas imagens representativas das 9 classes de animais
2. Aplicado o **Princípio de Pareto (80/20)**: 80% para treino, 20% para teste
3. Treinado diretamente na plataforma [teachablemachine.withgoogle.com](https://teachablemachine.withgoogle.com)
4. Exportado no formato **TensorFlow.js** (`model.json` + `weights.bin`)

### Como a classificação funciona

```
Imagem/Webcam → TensorFlow.js → Modelo TM → Probabilidades por classe → Resultado
```

O modelo recebe a imagem, gera uma probabilidade (0–100%) para cada uma das 9 classes e exibe a classe com maior confiança.

---

## 📊 Fase 1 — Avaliação Rigorosa do Modelo

A aba **Avaliação** permite medir o desempenho real do modelo seguindo o **Princípio de Pareto**:

- **80%** dos dados → usados no treino (incorporados ao modelo)
- **20%** dos dados → conjunto de teste fornecido pelo usuário na interface

### Como usar a avaliação

1. Clique em cada classe e faça upload das imagens de teste
2. Clique em **🧪 Avaliar Modelo**
3. O modelo classifica cada imagem automaticamente
4. Os resultados são exibidos em um dashboard completo

### Métricas calculadas

| Métrica | Fórmula | Descrição |
|---|---|---|
| **Acurácia** | Acertos / Total | Proporção geral de predições corretas |
| **Precisão** | TP / (TP + FP) | Dos preditos como X, quantos eram X de fato |
| **Recall** | TP / (TP + FN) | Dos que eram X, quantos foram identificados |
| **F1-Score** | 2×(P×R)/(P+R) | Equilíbrio entre Precisão e Recall |
| **Matriz de Confusão** | — | Tabela 9×9 de predições vs. valores reais |

> Todas as métricas globais são calculadas via **macro-média** entre as classes.

### Código de cores dos resultados

| Cor | Intervalo | Interpretação |
|---|---|---|
| 🟢 Verde | ≥ 75% | Bom desempenho |
| 🟡 Amarelo | 50–74% | Desempenho moderado |
| 🔴 Vermelho | < 50% | Desempenho fraco |

---

## 🔍 Fase 2 — Detecção com SSD MobileNet (COCO-SSD)

### Por que SSD MobileNet?

Dentre os algoritmos disponíveis (YOLO, Faster R-CNN, EfficientDet, Detectron2, MediaPipe), o **SSD MobileNet** foi escolhido porque:

- ✅ Roda **100% no navegador** via TensorFlow.js (sem backend Python)
- ✅ **Tempo real** — ~10–30 FPS em CPU comum
- ✅ Detecta **múltiplos objetos** na mesma imagem com bounding boxes
- ✅ Cobertura de 6 das 9 classes do projeto (dog, horse, elephant, cat, cow, sheep)
- ✅ Biblioteca oficial do TensorFlow.js (`@tensorflow-models/coco-ssd`)
- ✅ **Zero dependências extras** — apenas um CDN adicional

### Como a detecção funciona

```
Imagem/Webcam → COCO-SSD → Bounding Boxes [x, y, w, h] + Classe + Confiança → Canvas Overlay
```

O modelo COCO-SSD foi treinado no dataset **COCO (Common Objects in Context)**, que contém 80 classes de objetos do cotidiano, incluindo vários animais.

### Alinhamento dos Bounding Boxes

Um desafio técnico importante foi garantir que os bounding boxes ficassem **exatamente sobre os objetos** na imagem exibida. A solução envolveu:

1. **Medir o container real** (`wrap.clientWidth/Height`) em vez do elemento `<img>`
2. **Calcular manualmente** o `object-fit: contain` via JavaScript:
   ```javascript
   const scale   = Math.min(cW / nW, cH / nH);   // escala de exibição
   const offsetX = (cW - nW * scale) / 2;          // espaço lateral
   const offsetY = (cH - nH * scale) / 2;          // espaço vertical
   ```
3. **Mapear coordenadas** do espaço natural da imagem para o espaço de exibição:
   ```javascript
   sx = offsetX + bbox_x * scale   // x do box na tela
   sy = offsetY + bbox_y * scale   // y do box na tela
   ```
4. **Canvas transparente** como overlay — a imagem continua visível pelo `<img>` abaixo, e os boxes são desenhados por cima no `<canvas>`

### Animais detectados pelo COCO-SSD

| Detectável | Classe |
|---|---|
| ✅ | 🐶 Cachorro (dog) |
| ✅ | 🐴 Cavalo (horse) |
| ✅ | 🐘 Elefante (elephant) |
| ✅ | 🐱 Gato (cat) |
| ✅ | 🐄 Vaca (cow) |
| ✅ | 🐑 Ovelha (sheep) |
| ❌ | 🦋 Borboleta — não está no COCO |
| ❌ | 🐔 Galinha — não está no COCO |
| ❌ | 🕷️ Aranha — não está no COCO |

> As 3 classes não cobertas pelo COCO-SSD continuam sendo classificadas pelo modelo Teachable Machine nas abas **Upload** e **Webcam**.

### Funcionalidades da aba Detecção

- **Modo Imagem** — upload/drag-and-drop, detecção com um clique
- **Modo Webcam** — detecção contínua a ~10 FPS com overlay em tempo real
- **Carregamento lazy** — o modelo COCO-SSD (~6MB) só é baixado ao abrir a aba pela primeira vez
- **Cores por classe** — cada tipo de objeto tem uma cor única e estável
- **Labels em português** — todos os 80 objetos COCO traduzidos
- **Threshold 30%** — detecções de baixa confiança são filtradas automaticamente
- **Barra de confiança** — indicador visual colorido por nível

---

## 🛠️ Tecnologias Utilizadas

| Tecnologia | Versão | Uso |
|---|---|---|
| [TensorFlow.js](https://www.tensorflow.org/js) | 1.3.1 | Engine de ML no browser |
| [@teachablemachine/image](https://teachablemachine.withgoogle.com) | 0.8 | Modelo de classificação |
| [@tensorflow-models/coco-ssd](https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd) | 2.2.2 | Detecção de objetos SSD MobileNet |
| HTML5 / CSS3 / JavaScript | — | Interface e lógica |
| Canvas API | — | Renderização dos bounding boxes |
| MediaDevices API | — | Acesso à webcam |
| PowerShell HttpListener | — | Servidor HTTP local |
| Google Fonts (Inter) | — | Tipografia |

---

## 📐 Arquitetura da Interface

```
┌─────────────────────────────────────────────────────────┐
│                  Classificador de Animais                │
├──────────┬───────────┬──────────────┬───────────────────┤
│ 🖼️ Upload │ 📷 Webcam │ 📊 Avaliação  │ 🔍 Detecção       │
├──────────┴───────────┴──────────────┴───────────────────┤
│                                                         │
│   Modelo Teachable Machine    │   COCO-SSD              │
│   (classifica 9 classes)      │   (detecta + bbox)      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 📎 Requisitos

- Navegador moderno com suporte a **WebGL** (Chrome, Edge, Firefox)
- **PowerShell** (já incluso no Windows 10/11)
- Conexão com internet no **primeiro acesso** (CDNs do TensorFlow.js e Google Fonts)

---

## 👤 Autor

**WallesBr2003**  
Projeto desenvolvido como demonstração prática de classificação e detecção de imagens com Machine Learning no navegador.
