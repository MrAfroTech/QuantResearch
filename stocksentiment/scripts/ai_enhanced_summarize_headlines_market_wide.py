import os
import json
import requests
from datetime import datetime
from transformers import pipeline
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Use environment variable or secure configuration for API key
API_KEY = os.environ.get('ALPHA_VANTAGE_API_KEY', 'X8BYJR32247PQFN8')

def fetch_stock_news(symbol, api_key):
    """
    Fetch stock-related news from Alpha Vantage API with robust error handling
    """
    url = 'https://www.alphavantage.co/query'
    params = {
        'function': 'NEWS_SENTIMENT',
        'tickers': symbol,  # Corrected parameter name
        'apikey': api_key
    }
    
    try:
        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()  # Raise exception for bad status codes
        
        data = response.json()
        
        # Validate and filter news
        if 'feed' in data:
            # Filter for relevant headlines
            relevant_news = [
                article for article in data['feed'] 
                if symbol in article.get('ticker_sentiment', [])
            ]
            
            # Limit to most recent 10 headlines
            return relevant_news[:10]
        
        logging.warning(f"No news feed found for {symbol}")
        return []
    
    except requests.RequestException as e:
        logging.error(f"Network error fetching news for {symbol}: {e}")
        return []
    except json.JSONDecodeError:
        logging.error(f"JSON decoding error for {symbol}")
        return []
    except Exception as e:
        logging.error(f"Unexpected error fetching news for {symbol}: {e}")
        return []

def analyze_headlines_with_ai(headlines, symbol):
    """
    Use AI to analyze headlines and determine overall market sentiment
    """
    if not headlines:
        return {
            'summary': f'No recent news available for {symbol}.',
            'market_sentiment': 'Inconclusive',
            'total_headlines': 0
        }

    try:
        # Use more robust AI pipelines
        summarizer = pipeline("summarization", model="facebook/bart-large-cnn")
        sentiment_classifier = pipeline("text-classification", model="distilbert-base-uncased-finetuned-sst-2-english")

        # Extract and combine headlines
        headline_texts = [h.get('title', '') for h in headlines]
        combined_text = " ".join(headline_texts)

        # Generate summary
        summary = summarizer(
            combined_text, 
            max_length=150, 
            min_length=30, 
            do_sample=False
        )[0]['summary_text'] if len(combined_text) > 0 else 'No significant news.'

        # Sentiment analysis
        sentiment_result = sentiment_classifier(summary)[0]
        
        # Enhanced sentiment mapping
        sentiment_map = {
            'POSITIVE': {
                0.7 <= sentiment_result['score'] <= 1.0: 'STRONGLY BULLISH',
                0.5 <= sentiment_result['score'] < 0.7: 'Mildly Bullish'
            },
            'NEGATIVE': {
                0.7 <= sentiment_result['score'] <= 1.0: 'STRONGLY BEARISH',
                0.5 <= sentiment_result['score'] < 0.7: 'Mildly Bearish'
            }
        }
        
        # Determine market sentiment
        market_sentiment = sentiment_map.get(
            sentiment_result['label'], 
            {True: 'Neutral'}
        )
        market_sentiment = next(
            sentiment for condition, sentiment in market_sentiment.items() if condition
        )

        return {
            'summary': summary,
            'market_sentiment': market_sentiment,
            'total_headlines': len(headlines)
        }
    
    except Exception as e:
        logging.error(f"AI analysis error for {symbol}: {e}")
        return {
            'summary': f'Analysis error for {symbol}.',
            'market_sentiment': 'Error',
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
            try:
                # Fetch news for the specific stock
                news_articles = fetch_stock_news(symbol, api_key)
                
                # Analyze headlines
                ai_analysis = analyze_headlines_with_ai(news_articles, symbol)
                
                # Write report section
                report.write(f"Stock: {symbol}\n")
                report.write(f"Total Headlines: {ai_analysis['total_headlines']}\n")
                report.write(f"Market Sentiment: {ai_analysis['market_sentiment']}\n\n")
                report.write("AI Summary:\n")
                report.write(f"{ai_analysis['summary']}\n\n")
                report.write("=" * 50 + "\n\n")
            
            except Exception as e:
                logging.error(f"Error processing {symbol}: {e}")
                report.write(f"Stock: {symbol}\n")
                report.write("Unable to generate analysis.\n\n")
                report.write("=" * 50 + "\n\n")
    
    logging.info(f"AI Sentiment report generated: {report_path}")
    return report_path

def main():
    # List of stocks to analyze
    stocks = ['JBLU', 'AAL', 'SORL', 'PTON', 'AAPL', 'GOOGL', 'MSFT', 'AMZN', 'NVDA', 'META']
    
    # Generate report
    generate_daily_report(stocks, API_KEY)

if __name__ == "__main__":
    main()