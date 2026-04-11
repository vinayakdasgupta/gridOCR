@echo off
echo Installing dependencies...
pip install transformers torch accelerate --break-system-packages

echo Downloading OCRonos-Vintage model...
python -c "from transformers import GPT2LMHeadModel, GPT2Tokenizer; GPT2Tokenizer.from_pretrained('PleIAs/OCRonos-Vintage'); GPT2LMHeadModel.from_pretrained('PleIAs/OCRonos-Vintage'); print('Model downloaded successfully')"

echo Done.
