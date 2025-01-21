from textblob import TextBlob
from textblob import download_corpora
download_corpora.download_all()

import ssl
import os
import certifi
ssl._create_default_https_context = ssl._create_unverified_context


import json

# List of ticker symbols to choose from
TICKER_SYMBOLS = [
    'AAPL', 'GOOGL', 'AMZN', 'MSFT', 'TSLA',
    'META', 'NFLX', 'NVDA', 'SPY', 'AMD',
    'BA', 'DIS', 'GS', 'BRK.A', 'V'
]

def analyze_sentiment(news_article):
    # Perform sentiment analysis on the news article's headline
    analysis = TextBlob(news_article['headline'])
    polarity = analysis.sentiment.polarity

    # Classify sentiment based on polarity
    if polarity > 0:
        return 'positive'
    elif polarity == 0:
        return 'neutral'
    else:
        return 'negative'

def process_news_data(symbol):
    # Load the news data from the previously fetched file
    with open(f'./data/{symbol}_news.json', 'r') as f:
        news_data = json.load(f)

    # Initialize counters
    sentiment_count = {'positive': 0, 'neutral': 0, 'negative': 0}
    summaries = []

    # Analyze sentiment for each article and update the data
    for article in news_data:
        if symbol in article['headline']:  # Focus on articles with the ticker symbol in the headline
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

def get_user_input():
    # Display the ticker symbols for the user to choose from
    print("Please choose a stock symbol to analyze from the list below:")
    for index, symbol in enumerate(TICKER_SYMBOLS, 1):
        print(f"{index}. {symbol}")

    # Get user input for the symbol
    while True:
        try:
            user_choice = int(input("\nEnter the number corresponding to your choice: "))
            if 1 <= user_choice <= len(TICKER_SYMBOLS):
                symbol = TICKER_SYMBOLS[user_choice - 1]
                return symbol
            else:
                print("Invalid choice. Please select a number between 1 and 15.")
        except ValueError:
            print("Invalid input. Please enter a number.")

def process_news_data(symbol):
    # Define the path to the news file
    news_file = f'./data/{symbol}_news.json'

    # Check if the news file exists
    if not os.path.exists(news_file):
        print(f"Error: News file for {symbol} not found.")
        return

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
    # Get user input for the ticker symbol
    selected_symbol = get_user_input()
    process_news_data(selected_symbol)
