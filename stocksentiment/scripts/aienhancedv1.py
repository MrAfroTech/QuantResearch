import os
import json
import requests
from datetime import datetime
from transformers import pipeline

API_KEY = 'X8BYJR32247PQFN8'  # Replace with your actual key

def fetch_stock_news(symbol, api_key):
    """
    Fetch stock-related news from Alpha Vantage API
    """
    url = 'https://www.alphavantage.co/query'
    params = {
        'function': 'NEWS_SENTIMENT',
        'ticks': symbol,
        'apikey': api_key
    }
    
    try:
        response = requests.get(url, params=params)
        data = response.json()
        
        if 'feed' in data:
            return data['feed']
        return []
    
    except Exception as e:
        print(f"Error fetching news for {symbol}: {e}")
        return []

def analyze_headlines_with_ai(headlines):
    """
    Use AI to analyze headlines and determine overall market sentiment
    """
    summarizer = pipeline("summarization", model="facebook/bart-large-cnn")
    sentiment_classifier = pipeline("sentiment-analysis")

    # Combine headlines into a single text
    combined_text = " ".join([h['title'] for h in headlines])

    # Get AI summary
    summary = summarizer(
        combined_text, 
        max_length=150, 
        min_length=50, 
        do_sample=False
    )[0]['summary_text']

    # Sentiment analysis on summary
    sentiment_result = sentiment_classifier(summary)[0]
    
    # Determine bullish/bearish based on sentiment and summary
    sentiment_label = sentiment_result['label']
    sentiment_score = sentiment_result['score']
    
    if sentiment_label == 'POSITIVE' and sentiment_score > 0.7:
        market_sentiment = "STRONGLY BULLISH"
    elif sentiment_label == 'POSITIVE':
        market_sentiment = "Mildly Bullish"
    elif sentiment_label == 'NEGATIVE' and sentiment_score > 0.7:
        market_sentiment = "STRONGLY BEARISH"
    elif sentiment_label == 'NEGATIVE':
        market_sentiment = "Mildly Bearish"
    else:
        market_sentiment = "Neutral"

    return {
        'summary': summary,
        'market_sentiment': market_sentiment,
        'total_headlines': len(headlines)
    }

def generate_daily_report(stocks, api_key):
    """
    Generate comprehensive AI-enhanced stock sentiment report
    """
    today = datetime.now().strftime("%Y-%m-%d")
    report_dir = './ai_sentiment_reports'
    os.makedirs(report_dir, exist_ok=True)
    report_path = f'{report_dir}/ai_stock_sentiment_report_{today}.txt'
    
    with open(report_path, 'w') as report:
        report.write(f"AI Stock Sentiment Report - {today}\n")
        report.write("=" * 50 + "\n\n")
        
        for symbol in stocks:
            news_articles = fetch_stock_news(symbol, api_key)
            
            if not news_articles:
                report.write(f"{symbol}: Insufficient data for analysis\n\n")
                continue
            
            ai_analysis = analyze_headlines_with_ai(news_articles)
            
            report.write(f"Stock: {symbol}\n")
            report.write(f"Total Headlines: {ai_analysis['total_headlines']}\n")
            report.write(f"Market Sentiment: {ai_analysis['market_sentiment']}\n\n")
            report.write("AI Summary:\n")
            report.write(f"{ai_analysis['summary']}\n\n")
            report.write("=" * 50 + "\n\n")
    
    print(f"AI Sentiment report generated: {report_path}")

def main():
    stocks = ['JBLU', 'AAL', 'SORL', 'PTON', 'AAPL', 'GOOGL', 'MSFT', 'AMZN', 'NVDA', 'META']
    generate_daily_report(stocks, API_KEY)

if __name__ == "__main__":
    main()