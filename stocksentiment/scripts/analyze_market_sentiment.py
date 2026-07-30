# ****************************************************************************
# Script: market_sentiment_summary.py
#
# Purpose:
# This script is designed to analyze and summarize market sentiment reports 
# by filtering relevant financial articles and leveraging AI to generate a 
# concise summary of market insights. It helps users understand the key market 
# trends and sentiments based on the provided data.
#
# Scope:
# - Input: JSON file containing market sentiment data, including bullish and 
#   bearish articles with titles and descriptions.
# - Process:
#   1. Load the market sentiment data from a JSON file.
#   2. Filter articles to focus on market-relevant content.
#   3. Combine the filtered articles and use the Hugging Face `transformers` 
#      library to generate an AI-driven summary.
#   4. Output the summary along with metadata such as the timeframe and 
#      market trend.
# - Output: 
#   1. AI-generated market sentiment summary printed to the console.
#   2. Metadata about the market trend and timeframe.
#
# Logic:
# 1. Identify the most recent market sentiment report from a directory.
# 2. Parse the JSON file to extract bullish and bearish articles.
# 3. Filter articles using predefined market-related keywords.
# 4. Use the BART-Large CNN model from Hugging Face to summarize the top 
#    filtered articles.
# 5. Display the summary and additional metadata in a readable format.
#
# Dependencies:
# - Python 3.8+
# - Hugging Face Transformers library
# - JSON files containing market sentiment data
#
# Usage:
# 1. Place the market sentiment report files in the `market_sentiment_reports` directory.
# 2. Run this script with `python market_sentiment_summary.py`.
# 3. The AI-generated summary and metadata will be printed to the console.
#
# Example:
# Run the script in a directory with market sentiment JSON files:
# `python market_sentiment_summary.py`
# The output will include the AI-generated summary and market trend.
#
# ****************************************************************************


import requests
import json
import os
from datetime import datetime, timedelta
from textblob import TextBlob
import logging
import urllib3

# Disable SSL warnings
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

class MarketSentimentAnalyzer:
    def __init__(self, alpha_vantage_key, newsapi_key):
        """
        Initialize with API keys and set analysis timeframe.
        """
        self.alpha_vantage_key = alpha_vantage_key
        self.newsapi_key = newsapi_key
        self.logger = logging.getLogger(__name__)
        logging.basicConfig(level=logging.INFO)
        self.analysis_start_time = datetime.now()

    def fetch_market_news(self, hours_back=24):
        """
        Fetch market news within specified hours.
        """
        cutoff_time = datetime.now() - timedelta(hours=hours_back)
        
        news_sources = [
            'https://newsapi.org/v2/top-headlines?country=us',
            'https://newsapi.org/v2/everything?q=market+finance'
        ]
        
        all_articles = []
        
        for source in news_sources:
            params = {
                'apiKey': self.newsapi_key,
                'pageSize': 100,
                'language': 'en',
                'from': cutoff_time.isoformat()
            }
            
            try:
                response = requests.get(source, params=params, verify=False)
                response.raise_for_status()
                news_data = response.json()
                
                articles = news_data.get('articles', [])
                all_articles.extend(articles)
                
                self.logger.info(f"Retrieved {len(articles)} articles from {source}")
                
                if len(all_articles) >= 50:
                    break
            
            except requests.RequestException as e:
                self.logger.error(f"Error fetching news from {source}: {e}")
        
        return all_articles

    def analyze_sentiment(self, articles):
        """
        Perform sentiment analysis on news articles.
        """
        sentiments = {
            'bullish': [],
            'bearish': [],
            'neutral': []
        }
        
        for article in articles:
            text = f"{article.get('title', '')} {article.get('description', '')}"
            
            if not text.strip():
                continue
            
            blob = TextBlob(text)
            sentiment_score = blob.sentiment.polarity
            
            if sentiment_score > 0.1:
                sentiments['bullish'].append(article)
            elif sentiment_score < -0.1:
                sentiments['bearish'].append(article)
            else:
                sentiments['neutral'].append(article)
        
        return sentiments

    def determine_market_trend(self, sentiment_analysis):
        """
        Determine overall market trend based on sentiment.
        """
        total_articles = len(sentiment_analysis['bullish']) + len(sentiment_analysis['bearish'])
        
        if total_articles == 0:
            return 'Unable to Determine'
        
        bullish_percentage = len(sentiment_analysis['bullish']) / total_articles * 100
        
        if bullish_percentage > 60:
            return 'Strongly Bullish'
        elif bullish_percentage > 50:
            return 'Moderately Bullish'
        elif bullish_percentage < 40:
            return 'Strongly Bearish'
        elif bullish_percentage < 45:
            return 'Moderately Bearish'
        else:
            return 'Neutral'

    def generate_market_sentiment_report(self, hours_back=24):
        """
        Generate market sentiment report for specified timeframe.
        """
        # Fetch news and analyze sentiment
        articles = self.fetch_market_news(hours_back)
        sentiment_analysis = self.analyze_sentiment(articles)
        
        # Determine market trend
        market_trend = self.determine_market_trend(sentiment_analysis)
        
        # Prepare report
        report = {
            'timestamp': self.analysis_start_time.isoformat(),
            'timeframe': f'Last {hours_back} hours',
            'news_sentiment': {
                'total_articles': len(articles),
                'bullish_count': len(sentiment_analysis['bullish']),
                'bearish_count': len(sentiment_analysis['bearish']),
                'neutral_count': len(sentiment_analysis['neutral'])
            },
            'market_trend': market_trend,
            'top_bullish_articles': [
                {'title': a['title'], 'url': a['url']} 
                for a in sentiment_analysis['bullish'][:5]
            ],
            'top_bearish_articles': [
                {'title': a['title'], 'url': a['url']} 
                for a in sentiment_analysis['bearish'][:5]
            ]
        }
        
        # Save report
        output_dir = "market_sentiment_reports"
        os.makedirs(output_dir, exist_ok=True)
        report_filename = os.path.join(
            output_dir, 
            f"market_sentiment_{self.analysis_start_time.strftime('%Y%m%d_%H%M%S')}.json"
        )
        
        with open(report_filename, 'w') as f:
            json.dump(report, f, indent=2)
        
        self.logger.info(f"Market sentiment report saved to {report_filename}")
        
        return report

def main():
    # Prompt for API keys
    alpha_vantage_key = input("Enter Alpha Vantage API Key: ")
    newsapi_key = input("Enter NewsAPI Key: ")
    
    # Initialize and run analyzer
    analyzer = MarketSentimentAnalyzer(alpha_vantage_key, newsapi_key)
    
    # Default to 24-hour analysis, but can be changed
    market_report = analyzer.generate_market_sentiment_report(hours_back=24)
    
    # Print summary
    print("\n--- Market Sentiment Summary ---")
    print(f"Timeframe: {market_report['timeframe']}")
    print(f"Total Articles: {market_report['news_sentiment']['total_articles']}")
    print(f"Bullish Articles: {market_report['news_sentiment']['bullish_count']}")
    print(f"Bearish Articles: {market_report['news_sentiment']['bearish_count']}")
    print(f"Neutral Articles: {market_report['news_sentiment']['neutral_count']}")
    print(f"Overall Market Trend: {market_report['market_trend']}")

if __name__ == "__main__":
    main()