# ****************************************************************************
# Script: fetch_stock_news.py
#
# Purpose:
# This script fetches the latest financial news articles for a specified stock 
# ticker symbol using the Finnhub API. It is a utility script intended to be 
# used within a broader stock sentiment analysis pipeline. The fetched news 
# articles are stored locally in JSON format for further processing.
#
# Scope:
# - Input: 
#   1. Stock ticker symbol (e.g., "AAPL", "GS").
#   2. Finnhub API key for accessing financial news data.
# - Process: 
#   1. Send a request to the Finnhub API for news articles related to the 
#      specified stock ticker.
#   2. Save the fetched news data to a local JSON file.
# - Output:
#   - A JSON file containing news articles fetched for the given stock symbol.
#
# Logic:
# 1. Construct an API request URL using the given stock ticker symbol and API key.
# 2. Send a GET request to the Finnhub API to retrieve relevant news articles.
# 3. Check if the response contains valid data:
#    - If successful, save the news articles to a file in the `./data` directory.
#    - If no data is available or the request fails, notify the user.
# 4. Return the news articles as a list for further processing by other scripts.
#
# Dependencies:
# - Python 3.8+
# - Finnhub API (requires an API key)
# - Libraries: `requests`, `json`, `os`
#
# Usage:
# - This script is not meant to be run directly. Instead, it should be called 
#   by other scripts in the pipeline (e.g., analyze_sentiment_with_user_input.py).
# - Ensure you have a valid Finnhub API key and network access for the API call.
#
# Example Workflow:
# 1. Another script (e.g., analyze_sentiment_with_user_input.py) calls this 
#    script's `fetch_news` function with the stock symbol and API key.
# 2. This script fetches news articles and saves them locally.
# 3. The saved news file can then be used for sentiment analysis or other 
#    processing tasks.
#
# ****************************************************************************

'''
import requests
import json
import os

def fetch_news(symbol, api_key):
    """
    Fetch news articles for the given stock symbol using Finnhub API.
    
    Args:
        symbol (str): Stock ticker symbol.
        api_key (str): Finnhub API key.
    
    Returns:
        list: List of news articles for the stock symbol.
    """
    print(f"Fetching news for {symbol}...")
    url = f'https://finnhub.io/api/v1/news?category=general&symbol={symbol}&token={api_key}'
    response = requests.get(url)
    if response.status_code == 200:
        news_data = response.json()
        if news_data:
            # Save the news data to a file
            data_folder = './data'
            os.makedirs(data_folder, exist_ok=True)
            news_file = f'{data_folder}/{symbol}_news.json'
            with open(news_file, 'w') as f:
                json.dump(news_data, f, indent=4)
            print(f"News data for {symbol} fetched and saved to {news_file}.")
            return news_data
        else:
            print(f"No news data found for {symbol}.")
            return []
    else:
        print(f"Failed to fetch news for {symbol}. HTTP Status: {response.status_code}")
        return []

if __name__ == "__main__":
    # This script is designed to be called from another script, like analyze_sentiment_with_user_input.py.
    print("This script is not meant to be run directly. Please call it from another script.")
'''

import feedparser

import requests
import json

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
    # Set your API key for NewsAPI
    news_api_key = 'X8BYJR32247PQFN8'  # Replace with your NewsAPI key
    
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

