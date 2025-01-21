import yfinance as yf
import random
import requests
import pandas as pd
from datetime import datetime, timedelta

# List of some S&P 500 stock tickers (can expand this list)
sp500_stocks = ["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA", "META", "NVDA", "BRK-B", "JNJ", "WMT"]

# API key for NewsAPI (Sign up for an API key at https://newsapi.org/)
API_KEY = "your_api_key"
BASE_URL = "https://newsapi.org/v2/everything"

# Function to get 10 random stocks from the S&P 500 list
def get_random_stocks(stock_list, num_stocks=10):
    return random.sample(stock_list, num_stocks)

# Function to fetch news for a stock ticker
def fetch_stock_news(ticker):
    params = {
        "q": ticker,
        "apiKey": API_KEY,
        "language": "en",
        "sortBy": "publishedAt",
        "pageSize": 5,  # Get the latest 5 news articles
    }
    response = requests.get(BASE_URL, params=params)
    if response.status_code == 200:
        return response.json().get('articles', [])
    else:
        return []

# Function to analyze the sentiment of a news article (simplified)
def analyze_sentiment(news_title):
    negative_keywords = ["scandal", "crash", "decline", "loss", "lawsuit", "down", "drop", "plummet"]
    positive_keywords = ["growth", "rise", "surge", "gain", "record", "positive", "expansion"]
    
    # Simple keyword-based sentiment analysis
    news_title = news_title.lower()
    negative_score = sum(1 for word in negative_keywords if word in news_title)
    positive_score = sum(1 for word in positive_keywords if word in news_title)
    
    return negative_score, positive_score

# Class to track the stock scores for 31 trading days
class StockTracker:
    def __init__(self, stocks):
        self.stocks = {stock: {"score": 0, "history": []} for stock in stocks}

    def track_news(self, ticker, news_articles):
        for article in news_articles:
            negative_score, positive_score = analyze_sentiment(article["title"])
            if negative_score > positive_score:
                self.stocks[ticker]["score"] -= 1
            elif positive_score > negative_score:
                self.stocks[ticker]["score"] += 1

    def daily_update(self, current_date):
        # Record the score history for the day
        for ticker in self.stocks:
            self.stocks[ticker]["history"].append({"date": current_date, "score": self.stocks[ticker]["score"]})

    def display_scores(self):
        for ticker, data in self.stocks.items():
            print(f"Stock: {ticker} | Current Score: {data['score']} | History: {data['history']}")

# Function to get the last 31 trading days
def get_last_31_trading_days():
    end_date = pd.to_datetime(datetime.today())  # Today's date
    start_date = end_date - pd.DateOffset(days=90)  # Arbitrary range for a large enough window

    # Use pandas bdate_range to get trading days (business days)
    trading_days = pd.bdate_range(start=start_date, end=end_date, freq='B')
    
    # Return the last 31 trading days
    return trading_days[-31:]

# Function to simulate tracking over 31 trading days
def simulate_tracking():
    random_stocks = get_random_stocks(sp500_stocks)
    stock_tracker = StockTracker(random_stocks)
    
    # Get the last 31 trading days
    last_31_trading_days = get_last_31_trading_days()
    
    for trading_day in last_31_trading_days:
        print(f"Tracking day {trading_day.strftime('%Y-%m-%d')}")
        
        for stock in random_stocks:
            news_articles = fetch_stock_news(stock)
            stock_tracker.track_news(stock, news_articles)
        stock_tracker.daily_update(trading_day.strftime('%Y-%m-%d'))
        print("-" * 50)
    
    # Display the final scores
    stock_tracker.display_scores()

if __name__ == "__main__":
    simulate_tracking()
