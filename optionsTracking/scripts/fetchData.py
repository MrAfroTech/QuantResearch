# fetch_data.py

import yfinance as yf

def fetch_data(ticker):
    # Fetch stock data
    stock = yf.Ticker(ticker)
    stock_info = stock.history(period="1d")  # Get the most recent 1 day's worth of data
    
    # Fetch options chain (if available)
    options_chain = stock.option_chain()
    
    return {
        'price': stock_info['Close'].iloc[-1],  # Last closing price of the stock
        'options': options_chain.calls,         # Call options data
    }

# Test fetching data for one ticker
print(fetch_data("AAL"))
