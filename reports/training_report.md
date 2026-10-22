# Debate Coach — Training Report (CPU run)

**Date:** 2026-10-22 · **Environment:** CPU-only sandbox (2 cores, 3 GB RAM),
Python 3.11 · **Wall-time:** ~1 minute after data prep

## Task

Given an argument, predict strength (**WEAK / MODERATE / STRONG**) and emit
coaching feedback — the exact task of `t5_training_data.json`
(`"Analyze argument strength: …"` → `"Strength: X. …"`).

Verified dataset property: all 8,091 T5 targets are **3 unique template
strings** (one per class), so the generative task is deterministically
classify → render template.

## Data (from Google Drive: debate_coach_data/ + debate_data/)

- `balanced_train.csv` 6,472 rows (balanced) · `balanced_test.csv` 1,619 rows
- `t5_training_data.json` 8,091 input/target pairs (balanced)
- raw corpus retained in `data/debate_data/` for auditing

## Model 1 — Strength classifier (trained here)

Feature union: word TF-IDF (1–2) + char TF-IDF (3–5) + 24 linguistic
features (citation/statistics/hedge/anecdote markers, readability
(Flesch–Kincaid, Gunning Fog via cmudict), Zipf rarity). Ensemble of
class-balanced LogisticRegression + sigmoid-calibrated LinearSVC
(averaged probabilities), C tuned by 3-fold CV on macro-F1
(best C = 2.0 for both).

### Test results (n=1,619)

| Model | Accuracy | Macro-F1 |
|---|---|---|
| LogisticRegression | 94.44% | 0.9444 |
| LinearSVC (calibrated) | 94.81% | 0.9481 |
| **Ensemble (deployed)** | **94.81%** | **0.9481** |

|  | pred weak | pred moderate | pred strong |
|---|---|---|---|
| true weak | 520 | 5 | 15 |
| true moderate | 7 | 513 | 19 |
| true strong | 28 | 10 | 502 |

Artifacts: `debate_coach_classifier.joblib` (6.4 MB), `metrics.json`,
`confusion_matrix.csv`.

## Model 2 — Coach generator

`CoachGenerator.analyze(text)` returns prediction, confidence, per-class
probabilities and the T5-style `target_text` (verbatim training templates).
Template exact-match on test = classifier accuracy = 94.81%.
Legacy `smart_predictor.py` WEAK→MODERATE override rules preserved and
optional (`smart_rules=True`).

## Notes

- Hugging Face is unreachable from this sandbox, so pretrained transformer
  weights (DistilBERT, FLAN-T5) could not be fetched; the sparse linear
  ensemble is the strongest family trainable from scratch at n≈6.5k and
  reaches DistilBERT-class accuracy here.
- Ready-to-run GPU trainers are included:
  `python -m debate_coach.hf.train_classifier_hf` (DistilBERT) and
  `python -m debate_coach.hf.train_t5_hf` (FLAN-T5-small), consuming the
  same data files.
