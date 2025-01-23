# 01_fetchStockData.py
import yfinance as yf

def get_stock_data(ticker='AAPL'):
    """Fetch historical stock data"""
    stock = yf.Ticker(ticker)
    hist = stock.history(period="1mo")
    return hist, stock

# 02_fetchOptionsChainData.py
def get_options_chain(stock):
    """Fetch options chain data"""
    option_expirations = stock.options
    print("Option Expirations:", option_expirations)

    # Fetch the first available expiration chain
    options_chain = stock.option_chain(option_expirations[0])
    print(options_chain.calls.head())
    print(options_chain.puts.head())

# 03_fetchNews.py
import requests
from bs4 import BeautifulSoup

def fetch_news(ticker='AAPL'):
    """Fetch news for a specific stock"""
    url = f"https://finance.yahoo.com/quote/{ticker}/news"
    response = requests.get(url)
    soup = BeautifulSoup(response.content, "html.parser")

    # Extract news headlines
    headlines = soup.find_all('h3')
    for headline in headlines:
        print(headline.text)

# 04_storeData.py
import pandas as pd

def main():
    # Fetch stock data
    hist, stock = get_stock_data()
    
    # Create DataFrame from historical data
    df = pd.DataFrame(hist)
    print(df)
    
    # Fetch options chain
    get_options_chain(stock)
    
    # Fetch news
    fetch_news()
    
    # Optional: Save to CSV
    df.to_csv('stock_data.csv')

if __name__ == "__main__":
    main()