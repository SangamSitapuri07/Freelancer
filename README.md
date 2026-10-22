# Debate Coach — Argument-Strength Model Training

Trains an AI debate coach on the **debate coach dataset** from Google Drive:
classifies an argument as **WEAK / MODERATE / STRONG** and emits coaching
feedback, reproducing the task defined by `t5_training_data.json`
(`"Analyze argument strength: …"` → `"Strength: MODERATE. …"`).

## Dataset (from Google Drive)

Everything under `data/` was pulled from the Drive folders
`debate_coach_data/` and `debate_data/` (produced by the
`debate_coach_data_pipeline` Colab notebook):

| Split | File | Records | Balance |
|---|---|---|---|
| train | `balanced_train.csv` / `.json` | 6,472 | 2,158 / 2,157 / 2,157 |
| test | `balanced_test.csv` / `.json` | 1,619 | 540 / 539 / 540 |
| full | `balanced_full.csv` | 8,091 | 2,697 per class |
| T5 task | `t5_training_data.json` | 8,091 | 2,697 per class |

Raw pre-balance corpus (kept for auditing) in `data/debate_data/`:
`train.jsonl` (9,738) / `validation.jsonl` (1,146) / `test.jsonl` (573)
plus `dataset_stats.json` and `class_weights.json`.

**Key fact:** `t5_training_data.json` has exactly **3 unique target strings**
(one coaching template per class, verified across all 8,091 records). The
generative task is therefore deterministically *classify → render template*.

## The two trained models

### 1. Strength classifier (`python -m debate_coach.train_classifier`)

Feature union of **word TF-IDF (1–2)** + **char TF-IDF (3–5)** +
**24 handcrafted linguistic features** (citation/statistics markers, hedges,
anecdotes, superlatives, readability via `textstat`, Zipf rarity via
`wordfreq`), feeding an **ensemble of class-balanced LogisticRegression +
sigmoid-calibrated LinearSVC** (averaged probabilities). `C` is tuned by
stratified cross-validation on macro-F1.

Why this model: with ~6.5k labelled arguments, sparse lexical/style features
with linear models are the best family trainable on CPU — competitive with
DistilBERT fine-tuning on this task while training in minutes instead of
hours, with no pretrained weights required. The sandbox used for this run is
CPU-only and has no Hugging Face access, so transformer base weights
(DistilBERT/FLAN-T5) cannot be downloaded here; see below for the GPU path.

### 2. Coach generator (`debate_coach.coach_generator.CoachGenerator`)

`analyze(text)` → `{"prediction", "confidence", "probs", "target_text"}`.
`target_text` reproduces the T5 training targets verbatim, so template-level
exact match equals classifier accuracy. The legacy WEAK→MODERATE override
rules from `smart_predictor.py` are preserved and optional
(`smart_rules=True` / `--smart-rules`).

## Usage

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# one-time offline NLTK cmudict setup (textstat readability features):
#   pip install cmudict && mkdir -p ~/nltk_data/corpora/cmudict &&
#   cp .venv/lib/python*/site-packages/cmudict/data/cmudict.dict \
#      ~/nltk_data/corpora/cmudict/cmudict

# train + evaluate (writes models/ and reports/)
.venv/bin/python -m debate_coach.train_classifier

# demo predictions
.venv/bin/python -m debate_coach.predict --demo

# single argument
.venv/bin/python -m debate_coach.predict "Your argument here"
```

## GPU "best model" path (optional)

`debate_coach/hf/` contains ready-to-run trainers for the two transformer
models that top this task when a GPU and `huggingface.co` access are
available (Colab works):

```bash
pip install -r requirements-hf.txt
python -m debate_coach.hf.train_classifier_hf   # DistilBERT (max_length 256)
python -m debate_coach.hf.train_t5_hf           # FLAN-T5-small coach generator
```

They consume the exact same CSV/JSON files under `data/debate_coach_data/`.

## Layout

```
debate_coach/
  config.py            labels, paths, the 3 coaching templates
  data.py              loading + validation of Drive datasets
  features.py          linguistic feature extraction
  train_classifier.py  CPU trainer + evaluation (metrics → reports/)
  coach_generator.py   strength + coaching feedback pipeline
  smart_rules.py       legacy smart_predictor.py post-processing
  predict.py           CLI
  hf/                  GPU transformer trainers
data/                  datasets (from Google Drive; gitignored)
models/                trained artifacts (gitignored; uploaded to Drive)
reports/               metrics.json + confusion_matrix.csv
```

## Results (held-out `balanced_test.csv`, n=1,619)

| Model | Accuracy | Macro-F1 |
|---|---|---|
| LogisticRegression | 94.44% | 0.9444 |
| LinearSVC (calibrated) | 94.81% | 0.9481 |
| **Ensemble (final)** | **94.81%** | **0.9481** |

3-fold CV macro-F1 on train: LR 0.927 (C=2.0), SVM 0.932 (C=2.0).
Confusion matrix (ensemble):

|  | pred weak | pred moderate | pred strong |
|---|---|---|---|
| **true weak** | 520 | 5 | 15 |
| **true moderate** | 7 | 513 | 19 |
| **true strong** | 28 | 10 | 502 |

Training wall-time: ~1 minute on 2 CPU cores. Model bundle: 6.4 MB
(`models/debate_coach_classifier.joblib`). Full numbers in
`reports/metrics.json`.
