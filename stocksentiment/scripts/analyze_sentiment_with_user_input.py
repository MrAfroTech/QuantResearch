import requests
import json
import os

def fetch_stock_news(symbol, api_key):
    """
    Fetches stock-related news from a news API (e.g., NewsAPI).
    """
    # NewsAPI URL
    url = 'https://newsapi.org/v2/everything'
    
    # Parameters for fetching stock-related news
    params = {
        'q': symbol,  # Searching for news related to the stock symbol
        'apiKey': api_key,  # NewsAPI Key
        'pageSize': 5,  # Limit to top 5 news articles
    }
    
    # Send the request to NewsAPI
    response = requests.get(url, params=params)
    
    # Parse the JSON response
    data = response.json()
    
    # Check if articles are available
    if data.get('status') == 'ok' and 'articles' in data:
        articles = data['articles']
        news_info = []
        for article in articles:
            news_info.append({
                'title': article['title'],
                'link': article['url'],
                'published': article['publishedAt']
            })
        return news_info
    else:
        print(f"Error fetching news: {data.get('message', 'Unknown error')}")
        return None

if __name__ == "__main__":
    # Hard-coded API key for NewsAPI
    news_api_key = 'X8BYJR32247PQFN8'  # Replace with your actual NewsAPI key
    
    # Set the stock symbol you are interested in
    stock_symbol = 'AAPL'  # For example, Apple
    
    # Fetch and display stock-related news articles
    stock_news = fetch_stock_news(stock_symbol, news_api_key)
    
    if stock_news:
        print(f"Latest {stock_symbol} Stock News Articles:\n")
        for article in stock_news:
            print(f"Title: {article['title']}")
            print(f"Link: {article['link']}")
            print(f"Published: {article['published']}\n")
