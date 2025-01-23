import pandas as pd
import yfinance as yf  # Added yfinance import for stock data fetching

def get_stock_data(ticker='AAPL'):
    """
    Fetch historical stock data for a given ticker.
    
    Args:
        ticker (str, optional): Stock ticker symbol. Defaults to 'AAPL'.
    
    Returns:
        pandas.DataFrame: Historical stock price data
    """
    stock = yf.Ticker(ticker)
    hist = stock.history(period="1mo")  # Fetch 1 month of historical data
    return hist

# Fetch the data using the defined function
df = get_stock_data()

# Now you can work with the DataFrame
print(df)

# Optional: Save to CSV if needed
df.to_csv('stock_data.csv')