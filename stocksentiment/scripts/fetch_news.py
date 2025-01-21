import requests
import json

def fetch_news(symbol, api_key):
    url = f'https://finnhub.io/api/v1/news?category=general&symbol={symbol}&token={api_key}'
    response = requests.get(url)
    news_data = response.json()
    return news_data

if __name__ == "__main__":
    symbol = 'AAPL'  # Example: Fetch news for Apple
    api_key = 'cu7gu51r01qkuccsvq50cu7gu51r01qkuccsvq5g'  # Replace with your Finnhub API key
    news_data = fetch_news(symbol, api_key)
    with open(f'./data/{symbol}_news.json', 'w') as f:
        json.dump(news_data, f, indent=4)
    print(f"News data for {symbol} fetched successfully.")
