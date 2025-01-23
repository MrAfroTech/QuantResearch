import os
import json
from textblob import TextBlob
from fetch_news import fetch_news  # Import fetch_news function

def analyze_sentiment(news_article):
    analysis = TextBlob(news_article['headline'])
    polarity = analysis.sentiment.polarity
    if polarity > 0:
        return 'positive'
    elif polarity == 0:
        return 'neutral'
    else:
        return 'negative'

def process_news_data(symbol, api_key):
    # Define the path to the news file
    news_file = f'./data/{symbol}_news.json'

    # Fetch news if the file doesn't exist
    if not os.path.exists(news_file):
        print(f"No news data found for {symbol}. Fetching news...")
        news_data = fetch_news(symbol, api_key)
        if not news_data:
            print(f"Error: No news data fetched for {symbol}. Exiting.")
            return
        with open(news_file, 'w') as f:
            json.dump(news_data, f, indent=4)

    # Load the news data from the file
    with open(news_file, 'r') as f:
        news_data = json.load(f)

    # Initialize counters
    sentiment_count = {'positive': 0, 'neutral': 0, 'negative': 0}
    summaries = []

    # Analyze sentiment for each article and update the data
    for article in news_data:
        sentiment = analyze_sentiment(article)
        article['sentiment'] = sentiment
        sentiment_count[sentiment] += 1
        summaries.append(article['headline'])

    # Create a summary of all headlines
    summary_text = "\n".join(summaries)

    # Save the updated news data with sentiment analysis and summary
    with open(f'./data/{symbol}_news_with_sentiment.json', 'w') as f:
        json.dump(news_data, f, indent=4)

    # Save the sentiment count and summary to a separate text file
    with open(f'./data/{symbol}_sentiment_summary.txt', 'w') as f:
        f.write(f"Sentiment Analysis for {symbol}:\n")
        f.write(f"Positive: {sentiment_count['positive']}\n")
        f.write(f"Neutral: {sentiment_count['neutral']}\n")
        f.write(f"Negative: {sentiment_count['negative']}\n\n")
        f.write("Summary of all news headlines:\n")
        f.write(summary_text)

    print(f"Sentiment analysis and summary for {symbol} completed successfully.")

if __name__ == "__main__":
    # Define available stock symbols
    symbols = ['AAPL', 'GOOGL', 'AMZN', 'MSFT', 'TSLA', 'META', 'NFLX', 'NVDA', 'SPY', 'AMD', 'BA', 'DIS', 'GS', 'BRK.A', 'V']

    # Prompt user to select a stock symbol
    print("Please choose a stock symbol to analyze from the list below:")
    for idx, sym in enumerate(symbols, start=1):
        print(f"{idx}. {sym}")

    choice = int(input("\nEnter the number corresponding to your choice: "))
    if 1 <= choice <= len(symbols):
        selected_symbol = symbols[choice - 1]
    else:
        print("Invalid choice. Exiting.")
        exit(1)

    # API Key for Finnhub
    api_key = 'cu7gu51r01qkuccsvq50cu7gu51r01qkuccsvq5g'  # Replace with your actual API key

    # Process news data for the selected symbol
    process_news_data(selected_symbol, api_key)
