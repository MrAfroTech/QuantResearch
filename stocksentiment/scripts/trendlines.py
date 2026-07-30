# ****************************************************************************
# Script: trendlines.py
#
# Purpose:
# This script analyzes stock price data to calculate and visualize support and 
# resistance trendlines. It selects a random stock ticker, fetches historical 
# price data, identifies key levels using local minima and maxima, and plots 
# the data with trendlines for better analysis.
#
# Scope:
# - Input: Stock data fetched from Yahoo Finance for a random stock ticker.
# - Process:
#   1. Randomly select a stock ticker from a predefined list.
#   2. Fetch stock price data for the past 7 days with an interval of 1 hour.
#   3. Identify support and resistance levels using rolling window analysis.
#   4. Fit a linear regression model to calculate trendlines.
#   5. Plot the stock data with the trendlines overlaid.
# - Output: A line chart displaying stock price trends with diagonal trendlines.
#
# Logic:
# 1. Select a random stock ticker from the predefined list.
# 2. Fetch historical stock data using the Yahoo Finance API.
# 3. Identify local minima (support) and maxima (resistance) with rolling windows.
# 4. Fit linear regression models to calculate trendlines for support and resistance.
# 5. Generate a chart showing stock prices with overlaid trendlines.
#
# Dependencies:
# - Python 3.8+
# - yfinance library for fetching stock data
# - pandas and numpy for data manipulation
# - matplotlib for data visualization
# - scipy for linear regression
#
# Usage:
# 1. Ensure the required libraries are installed:
#    pip install yfinance pandas numpy matplotlib scipy
# 2. Run the script with `python trendlines.py`.
# 3. The script will display a chart for a randomly selected stock ticker.
#
# Example:
# Running the script will:
# - Fetch stock data for a random ticker (e.g., AAPL).
# - Calculate and plot support and resistance trendlines.
# - Display the chart with key price trends visualized.
#
# ****************************************************************************

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from scipy.signal import find_peaks
from sklearn.linear_model import LinearRegression

# Sample data (replace with your actual data)
dates = pd.date_range(start="2025-01-16", periods=50, freq="4H")
prices = np.cumsum(np.random.normal(0, 1, len(dates))) + 425

# Create a DataFrame
data = pd.DataFrame({'Date': dates, 'Close': prices})

# Identify support and resistance points
def identify_support_resistance(data, distance=5):
    # Find peaks (resistance) and troughs (support)
    resistance_indices, _ = find_peaks(data['Close'], distance=distance)
    support_indices, _ = find_peaks(-data['Close'], distance=distance)
    
    resistance = data.iloc[resistance_indices]
    support = data.iloc[support_indices]
    return support, resistance

support, resistance = identify_support_resistance(data)

# Fit trendlines using linear regression
def fit_trendline(indices, prices):
    if len(indices) > 1:
        reg = LinearRegression().fit(indices.reshape(-1, 1), prices)
        slope, intercept = reg.coef_[0], reg.intercept_
        return slope, intercept
    else:
        return None, None

# Support trendline
support_indices = np.array(support.index)
support_prices = np.array(support['Close'])
support_slope, support_intercept = fit_trendline(support_indices, support_prices)

# Resistance trendline
resistance_indices = np.array(resistance.index)
resistance_prices = np.array(resistance['Close'])
resistance_slope, resistance_intercept = fit_trendline(resistance_indices, resistance_prices)

# Generate trendline data
def generate_trendline(start, end, slope, intercept):
    if slope is not None:
        x = np.arange(start, end)
        y = slope * x + intercept
        return x, y
    return None, None

x_support, y_support = generate_trendline(0, len(data), support_slope, support_intercept)
x_resistance, y_resistance = generate_trendline(0, len(data), resistance_slope, resistance_intercept)

# Plot the chart
plt.figure(figsize=(12, 6))
plt.plot(data['Date'], data['Close'], label='AAPL Close Price', color='blue')

# Plot support trendline
if x_support is not None:
    plt.plot(data['Date'][x_support], y_support, '--', label='Support Trendline', color='green')

# Plot resistance trendline
if x_resistance is not None:
    plt.plot(data['Date'][x_resistance], y_resistance, '--', label='Resistance Trendline', color='red')

# Plot support and resistance points
plt.scatter(data['Date'][support_indices], support_prices, color='green', label='Support Points')
plt.scatter(data['Date'][resistance_indices], resistance_prices, color='red', label='Resistance Points')

# Final touches
plt.title("AAPL - Improved Chart with Support and Resistance Trendlines")
plt.xlabel("Date")
plt.ylabel("Price")
plt.legend()
plt.grid()
plt.show()