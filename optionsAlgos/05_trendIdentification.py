import yfinance as yf
import pandas as pd
import numpy as np
import talib
import matplotlib.pyplot as plt
from datetime import datetime

# Function to fetch stock data
def fetch_stock_data(stock_symbol, start_date, end_date):
    stock_data = yf.download(stock_symbol, start=start_date, end=end_date)
    return stock_data

# Function for trend identification and analysis
def trend_identification(stock_data):
    # Calculate the short-term and long-term moving averages
    stock_data['SMA20'] = stock_data['Close'].rolling(window=20).mean()  # Short-term moving average (20 days)
    stock_data['SMA50'] = stock_data['Close'].rolling(window=50).mean()  # Long-term moving average (50 days)
    stock_data['EMA20'] = stock_data['Close'].ewm(span=20, adjust=False).mean()
    stock_data['EMA50'] = stock_data['Close'].ewm(span=50, adjust=False).mean()

    # Signal based on moving average crossovers
    stock_data['Signal'] = np.where(stock_data['SMA20'] > stock_data['SMA50'], 1, 0)

    # RSI calculation
    stock_data['RSI'] = talib.RSI(stock_data['Close'].values, timeperiod=14)

    # Check for crossovers (Golden Cross / Death Cross)
    stock_data['GoldenCross'] = np.where((stock_data['SMA20'] > stock_data['SMA50']) & (stock_data['SMA20'].shift(1) <= stock_data['SMA50'].shift(1)), 1, 0)
    stock_data['DeathCross'] = np.where((stock_data['SMA20'] < stock_data['SMA50']) & (stock_data['SMA20'].shift(1) >= stock_data['SMA50'].shift(1)), 1, 0)

    # RSI overbought/oversold conditions
    stock_data['Overbought'] = np.where(stock_data['RSI'] > 70, 1, 0)
    stock_data['Oversold'] = np.where(stock_data['RSI'] < 30, 1, 0)

    # Return the updated DataFrame with trend signals
    return stock_data

# Function to plot and visualize trends
def plot_trends(stock_data, stock_symbol):
    plt.figure(figsize=(14,7))
    plt.plot(stock_data.index, stock_data['Close'], label='Close Price', color='blue')
    plt.plot(stock_data.index, stock_data['SMA20'], label='SMA 20', color='orange')
    plt.plot(stock_data.index, stock_data['SMA50'], label='SMA 50', color='green')
    plt.title(f'Trend Identification for {stock_symbol}')
    plt.legend()
    plt.show()

    # Plot RSI
    plt.figure(figsize=(14,7))
    plt.plot(stock_data.index, stock_data['RSI'], label='RSI', color='purple')
    plt.axhline(70, color='red', linestyle='--', label='Overbought')
    plt.axhline(30, color='green', linestyle='--', label='Oversold')
    plt.title(f'RSI for {stock_symbol}')
    plt.legend()
    plt.show()

# Main execution
if __name__ == '__main__':
    # Parameters (replace with your stock and date range)
    stock_symbol = 'AAPL'  # Example: Apple stock
    start_date = '2023-01-01'
    end_date = datetime.today().strftime('%Y-%m-%d')  # Current date
    
    # Fetch data
    stock_data = fetch_stock_data(stock_symbol, start_date, end_date)

    # Perform trend identification
    stock_data = trend_identification(stock_data)

    # Visualize trends
    plot_trends(stock_data, stock_symbol)

    # Print recent trend signals for review
    print(stock_data[['Close', 'SMA20', 'SMA50', 'GoldenCross', 'DeathCross', 'RSI', 'Overbought', 'Oversold']].tail(10))
    
    # Add your email notification code here if necessary

