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
import requests
import json

def fetch_stock_news(symbol, api_key):
    """
    Diagnostic version to troubleshoot Alpha Vantage news fetching
    """
    url = 'https://www.alphavantage.co/query'
    
    params = {
        'function': 'NEWS_SENTIMENT',
        'tickers': symbol,
        'apikey': api_key
    }
    
    try:
        response = requests.get(url, params=params)
        response.raise_for_status()  # Raise exception for HTTP errors
        
        # Print raw response for debugging
        print("Full API Response:")
        print(json.dumps(response.json(), indent=2))
        
        data = response.json()
        
        # Diagnose specific potential issues
        if 'Information' in data:
            print("API Usage Limit Reached:", data['Information'])
        
        if 'feed' in data:
            articles = data['feed']
            print(f"Number of articles found: {len(articles)}")
            
            for article in articles[:3]:  # Print first 3 articles details
                print("\nArticle Details:")
                print(f"Title: {article.get('title', 'No Title')}")
                print(f"URL: {article.get('url', 'No URL')}")
        
        return data
    
    except requests.RequestException as e:
        print(f"Request Error: {e}")
        return None

# Example usage
api_key = input("Enter Alpha Vantage API Key: ")
symbol = input("Enter Stock Symbol (e.g., AAPL): ")
fetch_stock_news(symbol, api_key)