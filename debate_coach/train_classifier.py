"""Train the debate-coach argument-strength classifier (CPU, best-in-class).

Model
-----
A sparse-text ensemble that is the strongest family for n ~= 6.5k labelled
arguments:

1. ``word`` TF-IDF (1-2 grams, sublinear tf)
2. ``char_wb`` TF-IDF (3-5 grams, sublinear tf)
3. handcrafted linguistic features (counts, markers, readability, Zipf)

estimators:
- LogisticRegression (multinomial, class-balanced)
- LinearSVC wrapped in sigmoid calibration (class-balanced)

The final predictor averages the two probability matrices. Hyper-parameter
``C`` is chosen by K-fold cross-validation on macro-F1.

Usage
-----
    python -m debate_coach.train_classifier            # full run
    python -m debate_coach.train_classifier --quick    # smoke test
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import joblib
import pandas as pd
from scipy import sparse
from sklearn.calibration import CalibratedClassifierCV
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
)
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.pipeline import FeatureUnion
from sklearn.preprocessing import Normalizer
from sklearn.svm import LinearSVC

from .config import (
    CLASSIFIER_BUNDLE,
    CONFUSION_CSV,
    COACH_TEMPLATES,
    ID2LABEL,
    LABELS,
    METRICS_JSON,
    MODELS_DIR,
    REPORTS_DIR,
)
from .data import describe, load_splits, xy
from .features import FEATURE_NAMES, texts_to_features


# ---------------------------------------------------------------------------
# Feature pipeline
# ---------------------------------------------------------------------------
def build_vectorizers() -> FeatureUnion:
    return FeatureUnion(
        [
            (
                "word",
                TfidfVectorizer(
                    analyzer="word",
                    ngram_range=(1, 2),
                    min_df=2,
                    max_features=50_000,
                    sublinear_tf=True,
                    strip_accents="unicode",
                    lowercase=True,
                ),
            ),
            (
                "char",
                TfidfVectorizer(
                    analyzer="char_wb",
                    ngram_range=(3, 5),
                    min_df=2,
                    max_features=120_000,
                    sublinear_tf=True,
                    lowercase=True,
                ),
            ),
        ]
    )


def featurize(
    vectorizer: FeatureUnion | None, texts: list[str], fit: bool = False
):
    """Return (X_tfidf, vectorizer). Dense features are handled separately."""
    if fit:
        X = vectorizer.fit_transform(texts)
    else:
        X = vectorizer.transform(texts)
    return X


def combine_features(X_tfidf: sparse.spmatrix, texts: list[str]) -> sparse.csr_matrix:
    X_dense = texts_to_features(texts)
    X_dense = Normalizer().fit_transform(X_dense) if X_dense.shape[0] else X_dense
    return sparse.hstack([X_tfidf, X_dense]).tocsr()


# ---------------------------------------------------------------------------
# Training / evaluation helpers
# ---------------------------------------------------------------------------
def _macro_f1(estimator, X, y) -> float:
    return float(cross_val_score(
        estimator, X, y, cv=3, scoring="f1_macro", n_jobs=1
    ).mean())


def tune_c(model_factory, X, y, c_grid, name: str) -> tuple[float, dict]:
    scores: dict[str, float] = {}
    best_c, best_score = c_grid[0], -1.0
    for c in c_grid:
        est = model_factory(c)
        score = _macro_f1(est, X, y)
        scores[str(c)] = score
        print(f"  [{name}] C={c:<4} cv macro-F1 = {score:.4f}")
        if score > best_score:
            best_c, best_score = c, score
    return best_c, scores


def evaluate(name: str, y_true, y_pred, label_ids=None) -> dict:
    acc = accuracy_score(y_true, y_pred)
    f1 = f1_score(y_true, y_pred, average="macro")
    print(f"\n== {name} ==")
    print(f"accuracy = {acc:.4f}   macro-F1 = {f1:.4f}")
    print(
        classification_report(
            y_true, y_pred, target_names=LABELS, digits=4, zero_division=0
        )
    )
    return {
        "accuracy": float(acc),
        "macro_f1": float(f1),
        "report": classification_report(
            y_true, y_pred, target_names=LABELS, digits=4,
            zero_division=0, output_dict=True,
        ),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quick", action="store_true",
                        help="smoke test: 2-fold CV, single C")
    parser.add_argument("--no-save", action="store_true")
    args = parser.parse_args()

    t0 = time.time()
    MODELS_DIR.mkdir(exist_ok=True)
    REPORTS_DIR.mkdir(exist_ok=True)

    print("Loading balanced corpus ...")
    train_df, test_df = load_splits()
    info = describe(train_df, test_df)
    print(
        f"train={info.n_train} {info.train_distribution}\n"
        f"test ={info.n_test} {info.test_distribution}\n"
        f"sources={info.sources}\n"
        f"t5_records={info.t5_records} unique_targets={info.t5_unique_targets}"
    )

    X_train_txt, y_train = xy(train_df)
    X_test_txt, y_test = xy(test_df)

    print("\nFitting TF-IDF (word 1-2 + char 3-5) ...")
    vectorizer = build_vectorizers()
    X_train_tfidf = featurize(vectorizer, X_train_txt, fit=True)
    X_train = combine_features(X_train_tfidf, X_train_txt)
    X_test = combine_features(
        featurize(vectorizer, X_test_txt, fit=False), X_test_txt
    )
    print(f"feature matrix: {X_train.shape}  nnz={X_train.nnz}")

    if args.quick:
        c_grid, cv = [1.0], 2
    else:
        c_grid, cv = [0.5, 1.0, 2.0], 3

    print("\nTuning C (logistic regression) ...")
    lr_factory = lambda c: LogisticRegression(
        C=c, class_weight="balanced", max_iter=3000, solver="lbfgs"
    )
    best_c_lr, lr_scores = tune_c(lr_factory, X_train, y_train, c_grid, "LR")

    print("\nTuning C (linear SVM) ...")
    svc_factory = lambda c: LinearSVC(C=c, class_weight="balanced")
    best_c_svc, svc_scores = tune_c(svc_factory, X_train, y_train, c_grid, "SVM")

    print(
        f"\nBest C: LR={best_c_lr}  SVM={best_c_svc}. Fitting final models ..."
    )
    lr = lr_factory(best_c_lr).fit(X_train, y_train)

    # Calibrated SVM (picklable; fewer folds in --quick mode).
    calib_cv = 2 if args.quick else 3
    svc = CalibratedClassifierCV(
        LinearSVC(C=best_c_svc, class_weight="balanced"),
        method="sigmoid",
        cv=calib_cv,
    ).fit(X_train, y_train)

    p_lr = lr.predict_proba(X_test)
    p_svc = svc.predict_proba(X_test)
    p_ens = (p_lr + p_svc) / 2.0
    y_pred_ens = p_ens.argmax(axis=1)
    y_pred_lr = p_lr.argmax(axis=1)
    y_pred_svc = p_svc.argmax(axis=1)

    metrics = {
        "model": "tfidf_word_char+linguistic_features/ensemble(lr+svm)",
        "n_train": info.n_train,
        "n_test": info.n_test,
        "feature_dims": int(X_train.shape[1]),
        "best_C": {"logreg": best_c_lr, "svm": best_c_svc},
        "cv_scores": {"logreg": lr_scores, "svm": svc_scores},
        "logreg": evaluate("LogisticRegression", y_test, y_pred_lr),
        "svm": evaluate("LinearSVC(calibrated)", y_test, y_pred_svc),
        "ensemble": evaluate("Ensemble (avg proba)", y_test, y_pred_ens),
        "feature_names_dense": FEATURE_NAMES,
    }

    cm = confusion_matrix(y_test, y_pred_ens, labels=list(range(len(LABELS))))
    pd.DataFrame(
        cm, index=[f"true_{l}" for l in LABELS],
        columns=[f"pred_{l}" for l in LABELS],
    ).to_csv(CONFUSION_CSV)
    print(f"\nconfusion matrix -> {CONFUSION_CSV}")
    print(cm)

    metrics["train_seconds"] = round(time.time() - t0, 1)
    with open(METRICS_JSON, "w") as fh:
        json.dump(metrics, fh, indent=2)
    print(f"metrics -> {METRICS_JSON}")

    if not args.no_save:
        bundle = {
            "vectorizer": vectorizer,
            "normalizer": Normalizer(),
            "logreg": lr,
            "svm": svc,
            "labels": LABELS,
            "id2label": ID2LABEL,
            "feature_names_dense": FEATURE_NAMES,
            "coach_templates": COACH_TEMPLATES,
        }
        joblib.dump(bundle, CLASSIFIER_BUNDLE, compress=3)
        size_mb = CLASSIFIER_BUNDLE.stat().st_size / 1e6
        print(f"saved bundle -> {CLASSIFIER_BUNDLE} ({size_mb:.1f} MB)")

    print(f"\ndone in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
