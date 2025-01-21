import os
import json
import torch
from transformers import pipeline

# Ensure PyTorch operates entirely on the CPU
torch.set_default_device("cpu")

# Load the summarizer pipeline, forcing it to use the CPU
summarizer = pipeline("summarization", model="facebook/bart-large-cnn", device=-1)

def summarize_headlines(symbol):
    news_file_path = f'./data/{symbol}_news_with_sentiment.json'

    if not os.path.exists(news_file_path):
        print(f"Error: The file {news_file_path} does not exist. Please fetch the news data first.")
        return

    # Load the news data with sentiment analysis (assumed to have headlines)
    with open(news_file_path, 'r') as f:
        news_data = json.load(f)

    # Extract the headlines from the news data
    headlines = [article['headline'] for article in news_data]

    # Combine all headlines into a single string for summarization
    combined_headlines = " ".join(headlines)

    # Break the text into chunks to fit within the model's maximum input length
    chunk_size = 500  # Approximate character limit for BART's token limit
    chunks = [combined_headlines[i:i+chunk_size] for i in range(0, len(combined_headlines), chunk_size)]

    # Summarize each chunk and combine the summaries
    summaries = []
    for chunk in chunks:
        summary = summarizer(chunk, max_length=300, min_length=100, do_sample=False)
        summaries.append(summary[0]['summary_text'])

    combined_summary = " ".join(summaries)

    # Save the combined summary to a text file
    summary_file_path = f'./data/{symbol}_headline_summary.txt'
    with open(summary_file_path, 'w') as f:
        f.write("Cliff Notes-style Summary of News Headlines:\n\n")
        f.write(combined_summary)

    print(f"Summary for {symbol} saved to {summary_file_path}")

if __name__ == "__main__":
    symbol = 'AAPL'  # Example: Use AAPL (Apple) for testing
    summarize_headlines(symbol)