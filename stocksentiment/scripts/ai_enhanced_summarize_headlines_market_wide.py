import json
import os
from textblob import TextBlob  # Example for sentiment analysis
from transformers import pipeline  # Hugging Face for AI-based summarization

def summarize_headlines(symbol):
    """
    Summarize the headlines and sentiments for a selected stock ticker.
    Determine if the sentiment leans bullish or bearish.
    Generate an AI-based summary of the headlines.
    """
    # Define the path to the news file
    news_file = f'./data/{symbol}_news_with_sentiment.json'

    # Check if the news file exists
    if not os.path.exists(news_file):
        print(f"Error: News file for {symbol} not found.")
        return

    # Load the news data
    try:
        with open(news_file, 'r') as f:
            news_data = json.load(f)
    except json.JSONDecodeError:
        print(f"Error: Unable to decode JSON data from {news_file}.")
        return

    # Initialize counters and collect headlines
    sentiment_count = {'positive': 0, 'neutral': 0, 'negative': 0}
    headlines = []

    # Process and analyze sentiment
    for article in news_data:
        sentiment = article.get('sentiment', 'neutral')  # Default to 'neutral' if sentiment is missing
        sentiment_count[sentiment] += 1
        headline = article.get('headline', '')
        headlines.append(headline)

    # Determine overall sentiment (bullish/bearish)
    total_headlines = sum(sentiment_count.values())
    sentiment_score = sentiment_count['positive'] - sentiment_count['negative']
    if sentiment_score > 0:
        overall_sentiment = "Bullish"
    elif sentiment_score < 0:
        overall_sentiment = "Bearish"
    else:
        overall_sentiment = "Neutral"

    # AI-based summarization of headlines
    summarizer = pipeline("summarization", model="facebook/bart-large-cnn")
    combined_headlines = " ".join(headlines)
    ai_summary = summarizer(combined_headlines, max_length=100, min_length=25, do_sample=False)[0]['summary_text']

    # Save the sentiment summary and AI-generated summary to a text file
    summary_file = f'./data/{symbol}_headline_summary.txt'
    os.makedirs('./data', exist_ok=True)
    with open(summary_file, 'w') as f:
        f.write(f"Sentiment Analysis for {symbol}:\n")
        f.write(f"Positive: {sentiment_count['positive']}\n")
        f.write(f"Neutral: {sentiment_count['neutral']}\n")
        f.write(f"Negative: {sentiment_count['negative']}\n\n")
        f.write(f"Overall Sentiment: {overall_sentiment}\n\n")
        f.write("AI-Generated Summary of Headlines:\n")
        f.write(ai_summary)

    print(f"Headline summary saved to {summary_file}.")
    print(f"Overall Sentiment: {overall_sentiment}")
    print("AI-Generated Summary:\n", ai_summary)

if __name__ == "__main__":
    # Prompt the user for input
    ticker_symbols = ['AAPL', 'GOOGL', 'AMZN', 'MSFT', 'TSLA', 'META', 'NFLX', 
                      'NVDA', 'SPY', 'AMD', 'BA', 'DIS', 'GS', 'BRK.A', 'V']
    print("Please choose a stock symbol to summarize from the list below:")
    for idx, symbol in enumerate(ticker_symbols, start=1):
        print(f"{idx}. {symbol}")

    try:
        choice = int(input("\nEnter the number corresponding to your choice: "))
        if 1 <= choice <= len(ticker_symbols):
            selected_symbol = ticker_symbols[choice - 1]
            summarize_headlines(selected_symbol)
        else:
            print("Invalid choice. Please run the script again.")
    except ValueError:
        print("Invalid input. Please enter a valid number.")
