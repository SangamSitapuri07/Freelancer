"""GPU-ready transformer trainer: DistilBERT strength classifier.

This is the highest-accuracy path for the weak/moderate/strong task when
GPU + huggingface.co access are available. It is not runnable inside the
CPU-only sandbox (pretrained weights cannot be downloaded there); use
``python -m debate_coach.train_classifier`` there instead.

Usage (Colab / GPU machine):
    pip install -r requirements-hf.txt
    python -m debate_coach.hf.train_classifier_hf \
        --train-csv data/debate_coach_data/balanced_train.csv \
        --test-csv  data/debate_coach_data/balanced_test.csv \
        --output-dir models/distilbert_strength --epochs 4 --batch-size 32
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--train-csv", default="data/debate_coach_data/balanced_train.csv")
    p.add_argument("--test-csv", default="data/debate_coach_data/balanced_test.csv")
    p.add_argument("--base-model", default="distilbert-base-uncased")
    p.add_argument("--output-dir", default="models/distilbert_strength")
    p.add_argument("--epochs", type=float, default=4.0)
    p.add_argument("--batch-size", type=int, default=32)
    p.add_argument("--lr", type=float, default=2e-5)
    p.add_argument("--max-length", type=int, default=256)
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


def main() -> None:
    args = parse_args()

    import evaluate as hf_evaluate
    import pandas as pd
    import torch
    from datasets import Dataset
    from transformers import (
        AutoModelForSequenceClassification,
        AutoTokenizer,
        DataCollatorWithPadding,
        EarlyStoppingCallback,
        Trainer,
        TrainingArguments,
        set_seed,
    )

    set_seed(args.seed)

    label_list = ["weak", "moderate", "strong"]
    label2id = {l: i for i, l in enumerate(label_list)}
    id2label = {i: l for l, i in label2id.items()}

    def load_ds(path: str) -> Dataset:
        df = pd.read_csv(path)
        df = df[["text", "label"]].dropna()
        df["label"] = df["label"].str.lower().map(label2id)
        return Dataset.from_pandas(df)

    train_ds, test_ds = load_ds(args.train_csv), load_ds(args.test_csv)

    tokenizer = AutoTokenizer.from_pretrained(args.base_model)

    def tokenize(batch):
        return tokenizer(
            batch["text"], truncation=True, max_length=args.max_length
        )

    train_tok = train_ds.map(tokenize, batched=True, remove_columns=["text"])
    test_tok = test_ds.map(tokenize, batched=True, remove_columns=["text"])

    model = AutoModelForSequenceClassification.from_pretrained(
        args.base_model,
        num_labels=3,
        id2label=id2label,
        label2id=label2id,
    )

    metric_acc = hf_evaluate.load("accuracy")
    metric_f1 = hf_evaluate.load("f1")

    def compute_metrics(eval_pred):
        logits, labels = eval_pred
        preds = np.argmax(logits, axis=-1)
        return {
            "accuracy": metric_acc.compute(predictions=preds, references=labels)["accuracy"],
            "macro_f1": metric_f1.compute(
                predictions=preds, references=labels, average="macro"
            )["f1"],
        }

    args_out = TrainingArguments(
        output_dir=args.output_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size * 2,
        learning_rate=args.lr,
        weight_decay=0.01,
        warmup_ratio=0.1,
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="macro_f1",
        greater_is_better=True,
        fp16=torch.cuda.is_available(),
        report_to=[],
        seed=args.seed,
    )

    trainer = Trainer(
        model=model,
        args=args_out,
        train_dataset=train_tok,
        eval_dataset=test_tok,
        tokenizer=tokenizer,
        data_collator=DataCollatorWithPadding(tokenizer),
        compute_metrics=compute_metrics,
        callbacks=[EarlyStoppingCallback(early_stopping_patience=2)],
    )

    trainer.train()
    metrics = trainer.evaluate()
    print(json.dumps(metrics, indent=2))

    Path(args.output_dir).mkdir(parents=True, exist_ok=True)
    trainer.save_model(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    with open(Path(args.output_dir) / "eval_metrics.json", "w") as fh:
        json.dump(metrics, fh, indent=2)


if __name__ == "__main__":
    main()
