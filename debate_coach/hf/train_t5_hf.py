"""GPU-ready seq2seq trainer: FLAN-T5 debate coach.

Trains a generator on t5_training_data.json
(``input_text = "Analyze argument strength: ..."`` -> ``target_text``).
In this corpus every target is one of three coaching templates (verified:
8091 records / 3 unique targets), so the CPU equivalent
(``debate_coach.coach_generator.CoachGenerator``) reaches the same outputs
via classify->render; this script reproduces the generative model itself.

Usage (Colab / GPU machine):
    pip install -r requirements-hf.txt
    python -m debate_coach.hf.train_t5_hf \
        --data data/debate_coach_data/t5_training_data.json \
        --output-dir models/t5_coach_v2 --epochs 4
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data", default="data/debate_coach_data/t5_training_data.json")
    p.add_argument("--base-model", default="google/flan-t5-small")
    p.add_argument("--output-dir", default="models/t5_coach_v2")
    p.add_argument("--epochs", type=float, default=4.0)
    p.add_argument("--batch-size", type=int, default=16)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--max-source-length", type=int, default=256)
    p.add_argument("--max-target-length", type=int, default=64)
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


def main() -> None:
    args = parse_args()

    import numpy as np
    import torch
    from datasets import Dataset
    from transformers import (
        AutoModelForSeq2SeqLM,
        AutoTokenizer,
        DataCollatorForSeq2Seq,
        EarlyStoppingCallback,
        Seq2SeqTrainer,
        Seq2SeqTrainingArguments,
        set_seed,
    )

    set_seed(args.seed)

    with open(args.data) as fh:
        records = json.load(fh)
    ds = Dataset.from_list(
        [{"input_text": r["input_text"], "target_text": r["target_text"]}
         for r in records]
    ).train_test_split(test_size=0.15, seed=args.seed)

    tokenizer = AutoTokenizer.from_pretrained(args.base_model)

    def tokenize(batch):
        model_in = tokenizer(
            batch["input_text"], truncation=True,
            max_length=args.max_source_length,
        )
        labels = tokenizer(
            text_target=batch["target_text"], truncation=True,
            max_length=args.max_target_length,
        )
        model_in["labels"] = labels["input_ids"]
        return model_in

    train_tok = ds["train"].map(tokenize, batched=True,
                                remove_columns=["input_text", "target_text"])
    eval_tok = ds["test"].map(tokenize, batched=True,
                              remove_columns=["input_text", "target_text"])

    model = AutoModelForSeq2SeqLM.from_pretrained(args.base_model)

    def compute_metrics(eval_pred):
        preds, labels = eval_pred
        if isinstance(preds, tuple):
            preds = preds[0]
        decoded = tokenizer.batch_decode(preds, skip_special_tokens=True)
        labels = np.where(labels != -100, labels, tokenizer.pad_token_id)
        refs = tokenizer.batch_decode(labels, skip_special_tokens=True)
        decoded = [d.strip().lower() for d in decoded]
        refs = [r.strip().lower() for r in refs]
        exact = float(np.mean([d == r for d, r in zip(decoded, refs)]))
        return {"exact_match": exact}

    targs = Seq2SeqTrainingArguments(
        output_dir=args.output_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size * 2,
        learning_rate=args.lr,
        weight_decay=0.01,
        warmup_ratio=0.1,
        eval_strategy="epoch",
        save_strategy="epoch",
        predict_with_generate=True,
        generation_max_length=args.max_target_length,
        load_best_model_at_end=True,
        metric_for_best_model="exact_match",
        greater_is_better=True,
        fp16=torch.cuda.is_available(),
        report_to=[],
        seed=args.seed,
    )

    trainer = Seq2SeqTrainer(
        model=model,
        args=targs,
        train_dataset=train_tok,
        eval_dataset=eval_tok,
        tokenizer=tokenizer,
        data_collator=DataCollatorForSeq2Seq(tokenizer, model=model),
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
