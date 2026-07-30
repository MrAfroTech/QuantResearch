# ***************************************************************************************************** #
#                               Summarization Script                                                    #
# ***************************************************************************************************** #
# This script summarizes saved sentiment analysis output for stock news.                                #
# It uses an AI-based summarization library to provide concise insights.                                #
#                                                                                                       #
# Requirements:                                                                                         #
# - Python 3.x                                                                                          #
# - Libraries: `os`, `json`, `transformers`                                                             # 
# This script is the the final of three scripts. analyze_sentiment_specific_ticker MUST be ran first    #
# ***************************************************************************************************** #
import os
import json
from collections import Counter
from transformers import pipeline

def load_sentiment_data(file_path):
    """
    Load sentiment analysis results from a JSON file.
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")
    
    with open(file_path, 'r') as file:
        data = json.load(file)
    return data

def analyze_sentiment(data):
    """
    Analyze the sentiment data and return key metrics.
    """
    # Extract sentiments from the articles
    articles = data.get('feed', [])
    sentiments = [article.get('overall_sentiment_label', 'neutral').lower() for article in articles]
    
    # Count sentiment occurrences
    sentiment_counts = Counter(sentiments)
    total_articles = len(articles)
    
    # Determine overall sentiment
    if sentiment_counts['bullish'] > sentiment_counts['bearish']:
        overall_sentiment = 'Bullish'
    elif sentiment_counts['bearish'] > sentiment_counts['bullish']:
        overall_sentiment = 'Bearish'
    else:
        overall_sentiment = 'Neutral'
    
    return total_articles, sentiment_counts, overall_sentiment

def summarize_headlines(data):
    """
    Use AI to generate a written summary of the headlines.
    """
    articles = data.get('feed', [])
    headlines = [article.get('title', '') for article in articles if article.get('title')]
    
    if not headlines:
        return "No headlines available to summarize."
    
    # Combine all headlines into a single text block
    combined_headlines = " ".join(headlines)
    
    # Use a summarization pipeline to generate a summary
    summarizer = pipeline("summarization", model="facebook/bart-large-cnn")
    summary = summarizer(combined_headlines, max_length=100, min_length=20, do_sample=False)
    return summary[0]['summary_text']

def main():
    # Prompt for stock symbol to load corresponding file
    symbol = input("Enter Stock Symbol (e.g., AAPL): ")
    file_path = f'data/{symbol}_sentiment.json'
    
    try:
        # Load data
        sentiment_data = load_sentiment_data(file_path)
        
        # Analyze sentiment
        total_articles, sentiment_counts, overall_sentiment = analyze_sentiment(sentiment_data)
        
        # Summarize headlines
        headline_summary = summarize_headlines(sentiment_data)
        
        # Display results
        print("\n--- Market Sentiment Summary ---")
        print(f"Stock Symbol: {symbol}")
        print(f"Total Articles Analyzed: {total_articles}")
        print(f"Sentiment Counts: {dict(sentiment_counts)}")
        print(f"Overall Sentiment: {overall_sentiment}")
        print("\n--- Headline Summary ---")
        print(headline_summary)
    
    except FileNotFoundError:
        print(f"Error: File not found: {file_path}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    main()
