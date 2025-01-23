# **************************************************************************** #
#                            Stock News Sentiment Analyzer                     #
# **************************************************************************** #
# This script allows users to analyze sentiment in news articles related to a  #
# specific stock ticker symbol.                                                #
#                                                                              #
# Key Features:                                                                #
# 1. Fetches news articles for the selected stock symbol using the Finnhub API.#
# 2. Filters articles that mention the company's vanity name or ticker symbol  #
#    in their headlines.                                                       #
# 3. Analyzes the sentiment (positive, neutral, or negative) of each article   #
#    headline using the TextBlob library.                                      #
# 4. Provides a summary of sentiment analysis, including counts for each       #
#    sentiment type.                                                           #
# 5. Saves the detailed sentiment analysis and the summary to JSON and text    #
#    files, respectively.                                                      #
#                                                                              #
# How to Use:                                                                  #
# 1. The user selects a stock symbol from a pre-defined list.                  #
# 2. The script fetches news data for the last year, filters relevant          #
#    headlines, and processes sentiment.                                       #
# 3. The results are saved in the 'data' directory as both a JSON file         #
#    (detailed) and a text file (summary).                                     #
#                                                                              #
# Requirements:                                                                #
# - Python 3.x                                                                 #
# - Libraries: `os`, `requests`, `json`, `textblob`                            #
# - Finnhub API key (replace `your_api_key_here` with your actual API key)     #
#                                                                              #
# Note:                                                                        #
# Ensure that the `textblob` library is installed and an active Finnhub API    #
# key is provided for proper functionality.                                    #
# **************************************************************************** #

import os
import requests
import json
from textblob import TextBlob

def fetch_news(symbol, api_key):
    """
    Fetch news for a given stock ticker symbol.
    """
    url = f'https://finnhub.io/api/v1/company-news?symbol={symbol}&from=2024-01-01&to=2025-01-01&token={api_key}'
    response = requests.get(url)
    if response.status_code == 200:
        return response.json()
    else:
        print(f"Failed to fetch news for {symbol}. HTTP Status: {response.status_code}")
        return None

def analyze_sentiment(news_article):
    """
    Analyze sentiment for a news article headline.
    """
    analysis = TextBlob(news_article['headline'])
    polarity = analysis.sentiment.polarity
    if polarity > 0:
        return 'positive'
    elif polarity == 0:
        return 'neutral'
    else:
        return 'negative'

def process_news_data(symbol, api_key):
    """
    Fetch news, analyze sentiment, and save results for a specific stock ticker.
    """
    # Fetch news data
    news_data = fetch_news(symbol, api_key)
    if not news_data:
        print(f"No news data found for {symbol}.")
        return

    # Initialize sentiment counters and summaries
    sentiment_count = {'positive': 0, 'neutral': 0, 'negative': 0}

    # Print the fetched headlines for debugging purposes
    print(f"\nFetched headlines for {symbol}:")
    filtered_headlines = []
    for article in news_data:
        headline = article.get('headline', '')
        # Filter headlines related to the symbol
        if symbol.lower() in headline.lower():
            filtered_headlines.append(headline)
            print(f"- {headline}")  # Print the relevant headlines

    # If no relevant headlines were found, exit early
    if not filtered_headlines:
        print(f"No relevant headlines found for {symbol}.")
        return

    # Analyze sentiment for the filtered headlines
    for article in news_data:
        if article['headline'] in filtered_headlines:
            sentiment = analyze_sentiment(article)
            article['sentiment'] = sentiment
            sentiment_count[sentiment] += 1

    # Save sentiment analysis to file
    os.makedirs('./data', exist_ok=True)
    sentiment_file = f'./data/{symbol}_news_with_sentiment.json'
    with open(sentiment_file, 'w') as f:
        json.dump(news_data, f, indent=4)
    print(f"Sentiment data saved to {sentiment_file}.")

    # Save sentiment summary to file
    summary_file = f'./data/{symbol}_sentiment_summary.txt'
    with open(summary_file, 'w') as f:
        f.write(f"Sentiment Analysis for {symbol}:\n")
        f.write(f"Positive: {sentiment_count['positive']}\n")
        f.write(f"Neutral: {sentiment_count['neutral']}\n")
        f.write(f"Negative: {sentiment_count['negative']}\n")

    print(f"Sentiment summary saved to {summary_file}.")

    # Save the stock symbol to a file for use in the summarize script
    with open('./data/last_processed_symbol.txt', 'w') as f:
        f.write(symbol)
        print(f"Last processed symbol {symbol} saved.")

if __name__ == "__main__":
    stock_symbols = [
        "AAPL", "GOOGL", "AMZN", "MSFT", "TSLA",
        "META", "NFLX", "NVDA", "SPY", "AMD",
        "BA", "DIS", "GS", "BRK.A", "V"
    ]

    print("Please choose a stock symbol to analyze from the list below:")
    for i, symbol in enumerate(stock_symbols, start=1):
        print(f"{i}. {symbol}")

    choice = int(input("\nEnter the number corresponding to your choice: "))
    if 1 <= choice <= len(stock_symbols):
        selected_symbol = stock_symbols[choice - 1]
        api_key = 'cu7gu51r01qkuccsvq50cu7gu51r01qkuccsvq5g'  # Replace with your actual API key
        process_news_data(selected_symbol, api_key)
    else:
        print("Invalid choice. Please run the script again and select a valid number.")
