# ****************************************************************************
#
# Purpose:
# This script performs sentiment analysis on news headlines related to a 
# specific stock ticker symbol. It uses TextBlob for sentiment classification 
# and generates both a detailed JSON file and a concise text summary of the 
# sentiment results.
#
# Scope:
# - Input: A JSON file containing news headlines for a specific stock symbol.
# - Process:
#   1. Load news data from the provided JSON file.
#   2. Perform sentiment analysis on each headline to classify it as positive, 
#      neutral, or negative using TextBlob's polarity score.
#   3. Update the JSON file with sentiment classifications for each article.
#   4. Generate a summary of all headlines and count sentiment categories.
#   5. Save the updated data and summary to separate output files.
# - Output: 
#   1. A JSON file with sentiment classifications for each news article.
#   2. A text file summarizing the sentiment counts and listing all headlines.
#
# Logic:
# 1. Load the JSON file containing news data for a specified stock symbol.
# 2. Use TextBlob to analyze the sentiment polarity of each article's headline:
#    - Positive if polarity > 0
#    - Neutral if polarity == 0
#    - Negative if polarity < 0
# 3. Count occurrences of each sentiment category.
# 4. Save the sentiment classifications back to the JSON file.
# 5. Create a separate text file summarizing sentiment counts and all headlines.
#
# Dependencies:
# - Python 3.8+
# - TextBlob library
# - JSON file with news data for a specific stock symbol
#
# Usage:
# 1. Place a JSON file with stock-related news headlines in the `./data` folder 
#    using the naming convention `{symbol}_news.json`.
# 2. Update the `symbol` variable in the script to match your target stock.
# 3. Run this script with `python sentiment_analysis_news_processor.py`.
# 4. The results will be saved in the `./data` folder as:
#    - `{symbol}_news_with_sentiment.json`: Updated JSON with sentiment analysis.
#    - `{symbol}_sentiment_summary.txt`: Text summary of sentiment analysis.
#
# Example:
# To analyze news for Apple Inc. (AAPL):
# 1. Save the news file as `./data/AAPL_news.json`.
# 2. Run the script: `python sentiment_analysis_news_processor.py`.
# 3. The output files will be located in the `./data` directory.
#
# ****************************************************************************


from textblob import TextBlob
import json

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
    symbol = 'AAPL'  # Example: Use AAPL (Apple) for testing; change as needed
    process_news_data(symbol)
