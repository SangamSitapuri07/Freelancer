"""The debate-coach generator: argument -> strength + coaching feedback.

This module reproduces the task defined by ``t5_training_data.json``:
every target is one of exactly three coaching templates keyed by strength
class (verified over all 8091 records). The optimal solution for this task
is therefore **classify -> render template**, which is what
:class:`CoachGenerator` does -- with the same output strings the T5 model
was trained to emit.

For GPU environments the true seq2seq trainer lives in
``debate_coach/hf/train_t5_hf.py`` (FLAN-T5-small fine-tune).
"""

from __future__ import annotations

from typing import Dict

import joblib

from .config import CLASSIFIER_BUNDLE, COACH_TEMPLATES, T5_PROMPT_PREFIX
from .smart_rules import apply_smart_rules


class CoachGenerator:
    """Strength classifier + template renderer (the coach).

    Parameters
    ----------
    bundle_path:
        joblib bundle written by ``debate_coach.train_classifier``.
    smart_rules:
        apply the legacy WEAK->MODERATE override rules from
        ``smart_predictor.py`` as post-processing.
    """

    def __init__(
        self,
        bundle_path=CLASSIFIER_BUNDLE,
        smart_rules: bool = False,
    ) -> None:
        self.bundle = joblib.load(bundle_path)
        self.vectorizer = self.bundle["vectorizer"]
        self.lr = self.bundle["logreg"]
        self.svm = self.bundle["svm"]
        self.labels = self.bundle["labels"]
        self.smart_rules = smart_rules

    # ------------------------------------------------------------------
    def predict_strength(self, text: str) -> Dict[str, object]:
        """Classify one argument; returns prediction, confidence, probs."""
        from .features import texts_to_features
        from scipy import sparse

        X_tfidf = self.vectorizer.transform([text])
        X_dense = texts_to_features([text])
        X_dense = self.bundle["normalizer"].transform(X_dense)
        X = sparse.hstack([X_tfidf, X_dense]).tocsr()

        p = (self.lr.predict_proba(X) + self.svm.predict_proba(X)) / 2.0
        idx = int(p.argmax(axis=1)[0])
        label = self.labels[idx]
        probs = {self.labels[i]: float(p[0][i]) for i in range(len(self.labels))}
        return {
            "prediction": label,
            "confidence": float(p[0][idx]),
            "probs": probs,
        }

    # ------------------------------------------------------------------
    def analyze(self, text: str) -> Dict[str, object]:
        """Full coach analysis: strength verdict + coaching feedback.

        Mirrors the T5 task:
        ``input_text = "Analyze argument strength: <argument>"``
        ``target_text = COACH_TEMPLATES[prediction]``
        """
        result = self.predict_strength(text)
        if self.smart_rules:
            ruled = apply_smart_rules(
                text, result["prediction"], result["confidence"]
            )
            result = {
                "prediction": ruled["prediction"],
                "confidence": ruled["confidence"],
                "probs": result["probs"],
                "original_prediction": ruled["original_prediction"],
                "was_overridden": ruled["was_overridden"],
            }
        label = result["prediction"]
        result["target_text"] = COACH_TEMPLATES[label]
        result["coaching_feedback"] = COACH_TEMPLATES[label]
        result["input_text"] = T5_PROMPT_PREFIX + text
        return result

    # ------------------------------------------------------------------
    def generate(self, text: str) -> str:
        """Return just the coaching feedback string (T5-style generation)."""
        return self.analyze(text)["target_text"]


def load_generator(
    bundle_path=CLASSIFIER_BUNDLE, smart_rules: bool = False
) -> CoachGenerator:
    return CoachGenerator(bundle_path=bundle_path, smart_rules=smart_rules)
